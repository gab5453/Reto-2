import {
  AIRCRAFT_LAYOUTS,
  AIRPORTS,
  type AircraftType,
  type CabinClass,
  countsByType,
  distanceKm,
  type MoneyAmount,
  moneyFromCents,
  type PassengerCounts,
  type PassengerType,
  scaleMoney,
  sumMoney,
} from '@ecoairlines/shared';
import { type CabinPricing, DEFAULT_PRICING_SETTINGS, type FarePriceRecord, type FlightRecord, type FlightSegment, type ItineraryOption, type PricingSettingsRecord, type SeatCharacteristic } from './model.js';

/**
 * Catálogo: identificadores, conexiones, precios y mapa de asientos. Copiado de `MockGdsService`, `gds-ids.ts` y `network.ts`
 * del monolito (mismas fórmulas); los vuelos ahora vienen de la copia publicada por Schedule y los multiplicadores de la copia
 * `fare_prices` (D35).
 */
export const AIRLINE = { code: 'EA', name: 'EcoAirlines' } as const;
/** Terminales conocidas; el resto de aeropuertos opera con terminal única. */
export const TERMINALS: Readonly<Record<string, string>> = { BOG: '1', MAD: '4S', MIA: 'N', MEX: '1' };

const MIN_LAYOVER_MINUTES = 60;
const MAX_LAYOVER_MINUTES = 600;
const MAX_DETOUR_FACTOR = 1.6;
export const MAX_OPTIONS_PER_ROUTE = 6;
/** No se venden vuelos que salen en menos de este tiempo. */
export const MIN_SALE_LEAD_MINUTES = 60;
const PASSENGER_FARE_FACTOR: Record<PassengerType, number> = { ADULT: 1, YOUTH: 1, CHILD: 0.75, INFANT: 0.1 };

// ------------------------------------------------------------------------------------------------ identificadores

const SEGMENT_ID = /^(EA\d{3,4})-(\d{4})(\d{2})(\d{2})$/;

/** `EA100-20261025`: vuelo + fecha local de salida (reconstruible, sin caché). */
export const buildSegmentId = (flightNumber: string, date: string): string => `${flightNumber}-${date.replaceAll('-', '')}`;
export function parseSegmentId(segmentId: string): { flightNumber: string; date: string } | undefined {
  const match = SEGMENT_ID.exec(segmentId);
  return match ? { flightNumber: match[1], date: `${match[2]}-${match[3]}-${match[4]}` } : undefined;
}
/** Itinerario = segmentos unidos por `.`; oferta = itinerarios unidos por `~`. */
export const buildItineraryId = (segmentIds: string[]): string => segmentIds.join('.');
export const parseItineraryId = (itineraryId: string): string[] => itineraryId.split('.');
export const buildOfferId = (itineraryIds: string[]): string => itineraryIds.join('~');
export const parseOfferId = (offerId: string): string[] => offerId.split('~');

// ------------------------------------------------------------------------------------------------ familias tarifarias

export interface FareBrandDefinition {
  fareBrand: string;
  cabinClass: CabinClass;
  isRefundable: boolean;
  isChangeable: boolean;
  personalItemIncluded: boolean;
  carryOnIncluded: number;
  checkedBaggageIncluded: number;
  /** Multiplicador de referencia (se usa hasta que el ESB publique los de Schedule). */
  referenceMultiplier: number;
}

/** Familias de EcoAirlines (de la semilla al dosel del bosque). Las reglas son de Offers; el multiplicador, de Schedule. */
export const FARE_BRANDS: readonly FareBrandDefinition[] = [
  { fareBrand: 'SEMILLA', cabinClass: 'ECONOMY', referenceMultiplier: 1, isRefundable: false, isChangeable: false, personalItemIncluded: true, carryOnIncluded: 0, checkedBaggageIncluded: 0 },
  { fareBrand: 'BROTE', cabinClass: 'ECONOMY', referenceMultiplier: 1.35, isRefundable: false, isChangeable: true, personalItemIncluded: true, carryOnIncluded: 1, checkedBaggageIncluded: 1 },
  { fareBrand: 'BOSQUE', cabinClass: 'ECONOMY', referenceMultiplier: 1.8, isRefundable: true, isChangeable: true, personalItemIncluded: true, carryOnIncluded: 1, checkedBaggageIncluded: 2 },
  { fareBrand: 'DOSEL', cabinClass: 'BUSINESS', referenceMultiplier: 3.2, isRefundable: true, isChangeable: true, personalItemIncluded: true, carryOnIncluded: 2, checkedBaggageIncluded: 2 },
];

export const findFare = (cabinClass: string, fareBrand: string) => FARE_BRANDS.find((fare) => fare.cabinClass === cabinClass && fare.fareBrand === fareBrand);

/** Todo lo que define el precio de un paquete (P-1): su multiplicador, la tarifa base y los precios exactos por ruta. */
export interface PriceRule {
  fareBrand: string;
  multiplier: number;
  pricing: PricingSettingsRecord;
}

export const priceRuleOf = (fare: FareBrandDefinition, prices: FarePriceRecord[], pricing: PricingSettingsRecord = DEFAULT_PRICING_SETTINGS): PriceRule => ({
  fareBrand: fare.fareBrand,
  multiplier: multiplierOf(fare, prices),
  pricing,
});

/** Multiplicador vigente: el publicado por Schedule o, si no hay, el de referencia. */
export function multiplierOf(fare: FareBrandDefinition, prices: FarePriceRecord[]): number {
  return prices.find((price) => price.cabinClass === fare.cabinClass && price.fareBrand === fare.fareBrand)?.multiplier ?? fare.referenceMultiplier;
}

// ------------------------------------------------------------------------------------------------ itinerarios

export interface Itinerary {
  itineraryId: string;
  flights: FlightRecord[];
  totalDurationMinutes: number;
  distanceKm: number;
}

const utc = (iso: string) => Date.parse(iso);
const flightDistance = (flight: Pick<FlightRecord, 'origin' | 'destination'>) => distanceKm(AIRPORTS[flight.origin], AIRPORTS[flight.destination]);
export const durationMinutes = (flight: Pick<FlightRecord, 'departureAt' | 'arrivalAt'>) => (utc(flight.arrivalAt) - utc(flight.departureAt)) / 60_000;

export function toItinerary(flights: FlightRecord[]): Itinerary {
  return {
    itineraryId: buildItineraryId(flights.map((flight) => flight.segmentId)),
    flights,
    totalDurationMinutes: (utc(flights.at(-1)!.arrivalAt) - utc(flights[0].departureAt)) / 60_000,
    distanceKm: flights.reduce((total, flight) => total + flightDistance(flight), 0),
  };
}

/** Conexión válida: mismo aeropuerto, escala de 1–10 h y sin rodeos absurdos (≤ 1,6 × la distancia directa). */
export function isValidConnection(first: FlightRecord, second: FlightRecord): boolean {
  const layover = (utc(second.departureAt) - utc(first.arrivalAt)) / 60_000;
  const direct = distanceKm(AIRPORTS[first.origin], AIRPORTS[second.destination]);
  return (
    first.destination === second.origin &&
    first.origin !== second.destination &&
    layover >= MIN_LAYOVER_MINUTES &&
    layover <= MAX_LAYOVER_MINUTES &&
    flightDistance(first) + flightDistance(second) <= direct * MAX_DETOUR_FACTOR
  );
}

/** Se vende si todos sus vuelos están a la venta y el primero sale en más de 60 minutos. */
export const isSellable = (itinerary: Itinerary, now: number): boolean =>
  itinerary.flights.every((flight) => flight.onSale) && utc(itinerary.flights[0].departureAt) >= now + MIN_SALE_LEAD_MINUTES * 60_000;

/** Directos y con una escala, ordenados por paradas y duración. `departing(origin, date)` = vuelos a la venta de ese día. */
export function findItineraries(
  origin: string,
  destination: string,
  firstLegs: FlightRecord[],
  connectionsFrom: (hub: string) => FlightRecord[],
  now: number,
): Itinerary[] {
  const options: FlightRecord[][] = [];
  for (const first of firstLegs) {
    if (first.origin !== origin || !first.onSale || utc(first.departureAt) < now + MIN_SALE_LEAD_MINUTES * 60_000) continue;
    if (first.destination === destination) {
      options.push([first]);
      continue;
    }
    for (const second of connectionsFrom(first.destination)) {
      if (second.destination === destination && second.onSale && isValidConnection(first, second)) options.push([first, second]);
    }
  }
  return options
    .map(toItinerary)
    .sort((a, b) => a.flights.length - b.flights.length || a.totalDurationMinutes - b.totalDurationMinutes)
    .slice(0, MAX_OPTIONS_PER_ROUTE);
}

// ------------------------------------------------------------------------------------------------ precios

/**
 * Precio de un pasajero: por cada vuelo, (cargo fijo + precio por km × km) × multiplicador del paquete, o el precio exacto del
 * paquete en esa ruta si lo hay (P-1, D-T12); 10 % menos con escala; impuestos 15 % + 12 por tramo. Con la tarifa base por
 * defecto (35 y 0,085) y sin precios por ruta, el cálculo es el mismo que antes, operación por operación.
 */
export function priceFor(itinerary: Itinerary, rule: PriceRule, passengerType: PassengerType): MoneyAmount {
  const connectionDiscount = itinerary.flights.length > 1 ? 0.9 : 1;
  let routeBase = 0;
  let exact = 0;
  for (const flight of itinerary.flights) {
    const fixed = rule.pricing.routePrices[flight.routeId]?.[rule.fareBrand];
    if (fixed !== undefined) exact += fixed;
    else routeBase += rule.pricing.fixedCharge + flightDistance(flight) * rule.pricing.perKm;
  }
  const adultBaseCents = Math.round(routeBase * connectionDiscount * rule.multiplier + exact * connectionDiscount) * 100;
  const baseCents = Math.round((adultBaseCents * PASSENGER_FARE_FACTOR[passengerType]) / 100) * 100;
  const taxesCents = passengerType === 'INFANT' ? 0 : Math.round(adultBaseCents * 0.15) + 1_200 * itinerary.flights.length;
  return moneyFromCents(baseCents, taxesCents);
}

export const priceItinerary = (itinerary: Itinerary, rule: PriceRule, counts: PassengerCounts): MoneyAmount =>
  sumMoney(countsByType(counts).map(([type, count]) => scaleMoney(priceFor(itinerary, rule, type), count)));

export function extraBagPrice(itinerary: Itinerary): MoneyAmount {
  const usd = itinerary.distanceKm < 1_000 ? 35 : itinerary.distanceKm < 3_000 ? 45 : 60;
  return moneyFromCents(usd * 100, 0);
}

export function toFlightSegment(flight: FlightRecord, next?: FlightRecord): FlightSegment {
  return {
    segmentId: flight.segmentId,
    flightNumber: flight.flightNumber,
    departure: { iataCode: flight.origin, at: flight.departureAt, ...(TERMINALS[flight.origin] ? { terminal: TERMINALS[flight.origin] } : {}) },
    arrival: { iataCode: flight.destination, at: flight.arrivalAt, ...(TERMINALS[flight.destination] ? { terminal: TERMINALS[flight.destination] } : {}) },
    ...(next ? { layoverMinutes: (utc(next.departureAt) - utc(flight.arrivalAt)) / 60_000 } : {}),
    marketingCarrier: AIRLINE.code,
    operatingCarrier: AIRLINE.code,
    aircraft: flight.aircraftType,
    durationMinutes: durationMinutes(flight),
    status: flight.onSale || flight.closedReason !== 'FLIGHT_CANCELLED' ? 'SCHEDULED' : 'CANCELLED',
  };
}

/**
 * Itinerario con la forma del contrato. `availableSeats(cabin)` = cupos AVAILABLE del itinerario (el mínimo de sus vuelos).
 * Con `only`, `pricingOptions` se limita a la tarifa elegida.
 */
export function toItineraryOption(
  itinerary: Itinerary,
  counts: PassengerCounts,
  context: { prices: FarePriceRecord[]; pricing?: PricingSettingsRecord; availableSeats: (cabinClass: CabinClass) => number },
  only?: { cabinClass: string; fareBrand: string },
): ItineraryOption {
  const cabins = new Set(itinerary.flights.flatMap((flight) => (AIRCRAFT_LAYOUTS[flight.aircraftType] ?? []).map((cabin) => cabin.cabinClass)));
  const fares = FARE_BRANDS.filter((fare) => cabins.has(fare.cabinClass) && (!only || (fare.cabinClass === only.cabinClass && fare.fareBrand === only.fareBrand)));
  return {
    itineraryId: itinerary.itineraryId,
    totalDurationMinutes: itinerary.totalDurationMinutes,
    stopsCount: itinerary.flights.length - 1,
    segments: itinerary.flights.map((flight, index) => toFlightSegment(flight, itinerary.flights[index + 1])),
    pricingOptions: fares.map(
      (fare): CabinPricing => ({
        cabinClass: fare.cabinClass,
        fareBrand: fare.fareBrand,
        availableSeats: context.availableSeats(fare.cabinClass),
        fareRules: { isRefundable: fare.isRefundable, isChangeable: fare.isChangeable },
        baggageAllowance: {
          personalItemIncluded: fare.personalItemIncluded,
          carryOnIncluded: fare.carryOnIncluded,
          checkedBaggageIncluded: fare.checkedBaggageIncluded,
        },
        extraCheckedBaggagePrice: extraBagPrice(itinerary),
        pricePerPassengerType: countsByType(counts).map(([passengerType]) => ({
          passengerType,
          price: priceFor(itinerary, priceRuleOf(fare, context.prices, context.pricing), passengerType),
        })),
      }),
    ),
  };
}

// ------------------------------------------------------------------------------------------------ asientos

export interface SeatDefinition {
  seatNumber: string;
  cabinClass: CabinClass;
  rowNumber: number;
  characteristics: SeatCharacteristic[];
}

/** Por la ficha del tipo (no por su nombre): el catálogo la reemplaza al cambiar, y el mapa se vuelve a armar (M-2). */
const layoutCache = new WeakMap<object, SeatDefinition[]>();

/** Asientos de un tipo de avión, en orden de filas y letras (el primero libre es el que se asigna automáticamente). */
export function seatsOf(aircraftType: AircraftType): SeatDefinition[] {
  const layouts = AIRCRAFT_LAYOUTS[aircraftType] ?? [];
  const cached = layoutCache.get(layouts);
  if (cached) return cached;
  const seats = layouts.flatMap((cabin) => {
    const groups = cabin.layout.split('-');
    const windowLetters = new Set([groups[0][0], groups.at(-1)!.at(-1)]);
    const aisleLetters = new Set(groups.flatMap((group, index) => [...(index > 0 ? [group[0]] : []), ...(index < groups.length - 1 ? [group.at(-1)] : [])]));
    const letters = groups.join('').split('');
    const rows: SeatDefinition[] = [];
    for (let row = cabin.firstRow; row <= cabin.lastRow; row++) {
      for (const letter of letters) {
        const characteristics: SeatCharacteristic[] = [];
        if (windowLetters.has(letter)) characteristics.push('WINDOW');
        if (aisleLetters.has(letter)) characteristics.push('AISLE');
        if (cabin.extraLegroomRows?.includes(row)) characteristics.push('EXTRA_LEGROOM');
        if (cabin.exitRows?.includes(row)) characteristics.push('EMERGENCY_EXIT');
        rows.push({ seatNumber: `${row}${letter}`, cabinClass: cabin.cabinClass, rowNumber: row, characteristics });
      }
    }
    return rows;
  });
  layoutCache.set(layouts, seats);
  return seats;
}

/** Fecha local de hoy en un desfase fijo (UTC−5 = Ecuador). */
export function localDate(now: number, utcOffsetMinutes = -300): string {
  return new Date(now + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
