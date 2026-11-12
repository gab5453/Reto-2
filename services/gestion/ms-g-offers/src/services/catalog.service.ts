import { Inject, Injectable } from '@nestjs/common';
import { type CabinClass, type MoneyAmount, type PassengerCounts, resolvePassengerCounts, seatsRequired, sumMoney, toCents } from '@ecoairlines/shared';
import {
  addDays,
  AIRLINE,
  buildOfferId,
  FARE_BRANDS,
  findFare,
  findItineraries,
  type Itinerary,
  priceRuleOf,
  parseItineraryId,
  parseOfferId,
  priceItinerary,
  seatsOf,
  toItineraryOption,
} from '../domain/catalog.js';
import { available, type FarePriceRecord, type FlightOffer, type ItineraryOption, type PricingSettingsRecord, type SeatStatus } from '../domain/model.js';
import { OFFERS_STORE, type OffersStore } from '../repositories/offers.store.js';
import { offerGone, problem, TxReader, validation } from './common.js';

const MAX_OFFERS = 20;
/** Tiempo mínimo entre la llegada de un tramo y la salida del siguiente (ida y vuelta, multidestino). */
const MIN_MINUTES_BETWEEN_LEGS = 120;
const MAX_ALTERNATIVES = 10;
const IATA = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface SearchLeg {
  origin: string;
  destination: string;
  departureDate: string;
}

/** Valida el desglose de pasajeros (contrato v2: ≤ 9 con asiento; infantes ≤ adultos → INFANT_WITHOUT_ADULT). */
export function checkPassengers(breakdown: Partial<PassengerCounts> | undefined, field = 'passengers'): PassengerCounts {
  const counts = resolvePassengerCounts(breakdown);
  if (Object.values(counts).some((count) => !Number.isInteger(count) || count < 0) || counts.adults < 1) {
    throw validation('El desglose de pasajeros no es válido (adults ≥ 1).', field, 'adults ≥ 1 y el resto ≥ 0');
  }
  if (seatsRequired(counts) > 9) throw validation('Máximo 9 pasajeros con asiento.', field, 'máximo 9 con asiento');
  if (counts.infants > counts.adults) {
    throw problem(422, 'INFANT_WITHOUT_ADULT', 'Cada infante viaja en el regazo de un adulto: no puede haber más infantes que adultos.', {
      invalidParams: [{ name: `${field}.infants`, reason: 'no puede superar a adults' }],
    });
  }
  return counts;
}

/** Búsqueda, mapa de asientos y alternativas (`CatalogService` del proto). Solo lee: nunca cambia cupos. */
@Injectable()
export class CatalogService {
  constructor(@Inject(OFFERS_STORE) private readonly store: OffersStore) {}

  now = (): number => Date.now();

  async search(legs: SearchLeg[], breakdown: Partial<PassengerCounts> | undefined): Promise<{ totalOffers: number; offers: FlightOffer[] }> {
    if (legs.length < 1 || legs.length > 6) throw validation('Entre 1 y 6 itinerarios.', 'itineraries', 'entre 1 y 6');
    legs.forEach((leg, index) => {
      if (!IATA.test(leg.origin) || !IATA.test(leg.destination) || !DATE.test(leg.departureDate)) {
        throw validation('Itinerario inválido.', `itineraries[${index}]`, 'origin/destination IATA y departureDate YYYY-MM-DD');
      }
    });
    const counts = checkPassengers(breakdown);
    return this.store.transaction(async (tx) => {
      const reader = new TxReader(tx);
      const prices = await tx.farePrices();
      const pricing = await tx.pricingSettings();
      const optionsPerLeg: Itinerary[][] = [];
      for (const leg of legs) {
        const options = await this.itinerariesFor(reader, leg.origin, leg.destination, leg.departureDate);
        if (!options.length) return { totalOffers: 0, offers: [] };
        optionsPerLeg.push(options);
      }
      const offers: FlightOffer[] = [];
      for (const itineraries of combineLegs(optionsPerLeg).filter(isChronological)) {
        const offer = await this.toOffer(reader, itineraries, counts, prices, pricing);
        if (offer) offers.push(offer);
      }
      offers.sort((a, b) => toCents(a.grandTotal.total) - toCents(b.grandTotal.total));
      return { totalOffers: Math.min(offers.length, MAX_OFFERS), offers: offers.slice(0, MAX_OFFERS) };
    });
  }

  /**
   * Mapa del segmento con el estado de cada asiento (contrato v2 §10). Un asiento asignado muestra su estado; uno sin asignar
   * se ve AVAILABLE mientras su cabina tenga cupos, y HELD si la cabina se agotó (lo comprometen holds o reservas sin asiento).
   */
  async seatMap(offerId: string, segmentId: string) {
    const belongs = parseOfferId(offerId).some((itineraryId) => parseItineraryId(itineraryId).includes(segmentId));
    if (!belongs) throw problem(404, 'NOT_FOUND', 'El segmento no pertenece a la oferta.');
    return this.store.transaction(async (tx) => {
      const flight = await tx.flight(segmentId);
      if (!flight || !flight.onSale) throw offerGone();
      const inventory = await tx.inventory(segmentId);
      const assigned = new Map((await tx.assignedSeats(segmentId)).map((seat) => [seat.seatNumber!, seat.status]));
      const seats = seatsOf(flight.aircraftType);
      const cabins = [...new Set(seats.map((seat) => seat.cabinClass))];
      return {
        segmentId,
        cabins: cabins.map((cabinClass) => {
          const free = available(inventory.find((row) => row.cabinClass === cabinClass) ?? { segmentId, cabinClass, total: 0, counts: { HELD: 0, BOOKED: 0, TICKETED: 0, CHECKED_IN: 0, BOARDED: 0 } });
          const rows = new Map<number, { seatNumber: string; isAvailable: boolean; status: SeatStatus; characteristics: string[] }[]>();
          for (const seat of seats.filter((candidate) => candidate.cabinClass === cabinClass)) {
            const status: SeatStatus = assigned.get(seat.seatNumber) ?? (free > 0 ? 'AVAILABLE' : 'HELD');
            if (!rows.has(seat.rowNumber)) rows.set(seat.rowNumber, []);
            rows.get(seat.rowNumber)!.push({ seatNumber: seat.seatNumber, isAvailable: status === 'AVAILABLE', status, characteristics: seat.characteristics });
          }
          return { cabinClass, rows: [...rows.entries()].map(([rowNumber, rowSeats]) => ({ rowNumber, seats: rowSeats })) };
        }),
      };
    });
  }

  /**
   * Saga "Cambiar fecha": vuelos alternativos de la misma ruta en la fecha nueva, con la misma cabina y familia, cupos para el
   * grupo y el precio vigente. PostSale arma después la oferta de cambio con la diferencia.
   */
  async alternatives(input: {
    currentItineraries: { itineraryId: string; origin: string; destination: string }[];
    purchasedFares: { itineraryId: string; cabinClass: CabinClass; fareBrand: string }[];
    changes: { itineraryId: string; newDepartureDate: string }[];
    passengers: Partial<PassengerCounts> | undefined;
  }) {
    const counts = checkPassengers(input.passengers);
    return this.store.transaction(async (tx) => {
      const reader = new TxReader(tx);
      const prices = await tx.farePrices();
      const pricing = await tx.pricingSettings();
      const alternatives: { replacedItineraryId: string; itinerary: ItineraryOption; price: MoneyAmount }[] = [];
      for (const change of input.changes) {
        const current = input.currentItineraries.find((itinerary) => itinerary.itineraryId === change.itineraryId);
        const fare = input.purchasedFares.find((purchased) => purchased.itineraryId === change.itineraryId);
        if (!current || !fare) throw validation('El itinerario a cambiar no está en la reserva.', 'changes', `${change.itineraryId} desconocido`);
        if (!DATE.test(change.newDepartureDate)) throw validation('Fecha inválida.', 'changes.newDepartureDate', 'YYYY-MM-DD');
        const definition = findFare(fare.cabinClass, fare.fareBrand);
        if (!definition) throw validation('Tarifa desconocida.', 'purchasedFares', `${fare.cabinClass}/${fare.fareBrand}`);
        const options = await this.itinerariesFor(reader, current.origin, current.destination, change.newDepartureDate);
        for (const option of options.filter((candidate) => candidate.itineraryId !== change.itineraryId)) {
          const seats = await reader.availableSeats(option, fare.cabinClass);
          if (seats < seatsRequired(counts)) continue;
          alternatives.push({
            replacedItineraryId: change.itineraryId,
            itinerary: toItineraryOption(option, counts, { prices, pricing, availableSeats: () => seats }, fare),
            price: priceItinerary(option, priceRuleOf(definition, prices, pricing), counts),
          });
          if (alternatives.filter((alternative) => alternative.replacedItineraryId === change.itineraryId).length >= MAX_ALTERNATIVES) break;
        }
      }
      return { alternatives };
    });
  }

  private async itinerariesFor(reader: TxReader, origin: string, destination: string, date: string): Promise<Itinerary[]> {
    if (origin === destination) return [];
    const firstLegs = await reader.flightsOn(date);
    // Conexiones el mismo día o el siguiente (llegadas nocturnas).
    const connections = [...(await reader.flightsOn(date)), ...(await reader.flightsOn(addDays(date, 1)))];
    return findItineraries(origin, destination, firstLegs, (hub) => connections.filter((flight) => flight.origin === hub), this.now());
  }

  /** `grandTotal` = la tarifa más barata con cupos para todo el grupo en cada itinerario; sin cupos no hay oferta. */
  private async toOffer(reader: TxReader, itineraries: Itinerary[], counts: PassengerCounts, prices: FarePriceRecord[], pricing: PricingSettingsRecord): Promise<FlightOffer | undefined> {
    const totals: MoneyAmount[] = [];
    const options: ItineraryOption[] = [];
    for (const itinerary of itineraries) {
      const seatsByCabin = new Map<CabinClass, number>();
      for (const cabinClass of new Set(FARE_BRANDS.map((fare) => fare.cabinClass))) seatsByCabin.set(cabinClass, await reader.availableSeats(itinerary, cabinClass));
      const cheapest = FARE_BRANDS.find((fare) => (seatsByCabin.get(fare.cabinClass) ?? 0) >= seatsRequired(counts));
      if (!cheapest) return undefined;
      totals.push(priceItinerary(itinerary, priceRuleOf(cheapest, prices, pricing), counts));
      options.push(toItineraryOption(itinerary, counts, { prices, pricing, availableSeats: (cabinClass) => seatsByCabin.get(cabinClass) ?? 0 }));
    }
    return {
      offerId: buildOfferId(itineraries.map((itinerary) => itinerary.itineraryId)),
      airline: { code: AIRLINE.code, name: AIRLINE.name },
      itineraries: options,
      grandTotal: sumMoney(totals),
    };
  }
}

/** Ida y vuelta (≤ 2 tramos): todas las combinaciones. Multidestino: se emparejan por posición (no miles de combinaciones). */
function combineLegs(optionsPerLeg: Itinerary[][]): Itinerary[][] {
  if (optionsPerLeg.length <= 2) {
    return optionsPerLeg.reduce<Itinerary[][]>((combinations, options) => combinations.flatMap((combination) => options.map((option) => [...combination, option])), [[]]);
  }
  const size = Math.max(...optionsPerLeg.map((options) => options.length));
  return Array.from({ length: size }, (_, index) => optionsPerLeg.map((options) => options[index % options.length]));
}

function isChronological(itineraries: Itinerary[]): boolean {
  return itineraries.every((itinerary, index) => {
    const previous = itineraries[index - 1];
    return !previous || Date.parse(itinerary.flights[0].departureAt) >= Date.parse(previous.flights.at(-1)!.arrivalAt) + MIN_MINUTES_BETWEEN_LEGS * 60_000;
  });
}
