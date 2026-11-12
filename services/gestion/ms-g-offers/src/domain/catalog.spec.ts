import type { PassengerCounts } from '@ecoairlines/shared';
import {
  addDays,
  buildItineraryId,
  buildOfferId,
  buildSegmentId,
  durationMinutes,
  extraBagPrice,
  FARE_BRANDS,
  findFare,
  findItineraries,
  isSellable,
  isValidConnection,
  localDate,
  MAX_OPTIONS_PER_ROUTE,
  multiplierOf,
  parseItineraryId,
  parseOfferId,
  parseSegmentId,
  priceFor,
  priceItinerary,
  priceRuleOf,
  seatsOf,
  toFlightSegment,
  toItinerary,
  toItineraryOption,
} from './catalog.js';
import { available, DEFAULT_PRICING_SETTINGS, type FlightRecord, type InventoryRecord, type PricingSettingsRecord } from './model.js';

/**
 * PU-1 (Informacion_General/Pruebas.md §5.1.1): catálogo de MS.G.Offers — identificadores, conexiones, precios y asientos.
 * Los precios esperados se calcularon a mano con la fórmula (UIO–GYE = 282 km, UIO–CUE = 315 km, CUE–GYE = 129 km):
 * base = round(35 + km × 0,085) × multiplicador; impuestos = 15 % de la base + US$ 12 por tramo.
 */

const NOW = Date.parse('2026-12-01T12:00:00Z');
const vuelo = (over: Partial<FlightRecord> & Pick<FlightRecord, 'origin' | 'destination' | 'departureAt' | 'arrivalAt'>): FlightRecord => ({
  segmentId: `${over.flightNumber ?? 'EA100'}-20261210`,
  flightNumber: 'EA100',
  date: '2026-12-10',
  routeId: `${over.origin}-${over.destination}`,
  aircraftType: 'Airbus A220-300',
  registration: 'HC-J01',
  onSale: true,
  ...over,
});
const UIO_GYE = vuelo({ origin: 'UIO', destination: 'GYE', departureAt: '2026-12-10T08:00:00-05:00', arrivalAt: '2026-12-10T08:55:00-05:00' });
const UIO_CUE = vuelo({ flightNumber: 'EA110', origin: 'UIO', destination: 'CUE', departureAt: '2026-12-10T07:00:00-05:00', arrivalAt: '2026-12-10T08:00:00-05:00' });
const CUE_GYE = vuelo({ flightNumber: 'EA120', origin: 'CUE', destination: 'GYE', departureAt: '2026-12-10T09:30:00-05:00', arrivalAt: '2026-12-10T10:10:00-05:00' });

const SEMILLA = FARE_BRANDS.find((fare) => fare.fareBrand === 'SEMILLA')!;
const DOSEL = FARE_BRANDS.find((fare) => fare.fareBrand === 'DOSEL')!;
const regla = (fare = SEMILLA, pricing: PricingSettingsRecord = DEFAULT_PRICING_SETTINGS) => priceRuleOf(fare, [], pricing);
const counts = (over: Partial<PassengerCounts> = {}): PassengerCounts => ({ adults: 1, youths: 0, children: 0, infants: 0, ...over });

describe('identificadores', () => {
  it('segmento = vuelo + fecha sin guiones', () => expect(buildSegmentId('EA100', '2026-12-10')).toBe('EA100-20261210'));
  it('parseSegmentId recupera vuelo y fecha', () => expect(parseSegmentId('EA1234-20261210')).toEqual({ flightNumber: 'EA1234', date: '2026-12-10' }));
  it.each(['XX100-20261210', 'EA100-2026121', 'EA10-20261210', 'EA100_20261210'])('%s no es un segmento', (id) => expect(parseSegmentId(id)).toBeUndefined());
  it('itinerario y oferta se arman y se separan sin perder el orden', () => {
    const itinerario = buildItineraryId(['A', 'B']);
    expect(parseItineraryId(itinerario)).toEqual(['A', 'B']);
    expect(parseOfferId(buildOfferId([itinerario, 'C']))).toEqual(['A.B', 'C']);
  });
});

describe('familias tarifarias', () => {
  it('hay 3 de Economy y 1 de Business, con multiplicadores crecientes', () => {
    expect(FARE_BRANDS.map((fare) => `${fare.cabinClass}/${fare.fareBrand}`)).toEqual(['ECONOMY/SEMILLA', 'ECONOMY/BROTE', 'ECONOMY/BOSQUE', 'BUSINESS/DOSEL']);
    const multiplicadores = FARE_BRANDS.map((fare) => fare.referenceMultiplier);
    expect([...multiplicadores].sort((a, b) => a - b)).toEqual(multiplicadores);
  });
  it('SEMILLA no se cambia ni se reembolsa; BOSQUE y DOSEL sí', () => {
    expect(findFare('ECONOMY', 'SEMILLA')).toMatchObject({ isRefundable: false, isChangeable: false });
    expect(findFare('ECONOMY', 'BOSQUE')).toMatchObject({ isRefundable: true, isChangeable: true });
    expect(findFare('BUSINESS', 'DOSEL')).toMatchObject({ isRefundable: true, isChangeable: true });
  });
  it('una familia en la cabina equivocada no existe', () => expect(findFare('BUSINESS', 'SEMILLA')).toBeUndefined());
  it('multiplierOf usa el publicado por Schedule', () => expect(multiplierOf(SEMILLA, [{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 1.1 }])).toBe(1.1));
  it('multiplierOf sin publicación usa el de referencia', () => expect(multiplierOf(DOSEL, [{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 1.1 }])).toBe(3.2));
});

describe('itinerarios y conexiones', () => {
  it('toItinerary suma la distancia y mide la duración de punta a punta', () => {
    const itinerario = toItinerary([UIO_CUE, CUE_GYE]);
    expect(itinerario).toMatchObject({ itineraryId: `${UIO_CUE.segmentId}.${CUE_GYE.segmentId}`, distanceKm: 315 + 129, totalDurationMinutes: 190 });
  });
  it('durationMinutes respeta los desfases horarios', () =>
    expect(durationMinutes({ departureAt: '2026-12-10T22:00:00-05:00', arrivalAt: '2026-12-11T14:00:00+01:00' })).toBe(600));

  it('UIO → CUE → GYE con 90 min de escala es una conexión válida', () => expect(isValidConnection(UIO_CUE, CUE_GYE)).toBe(true));
  it('escala de menos de 60 min no es válida', () =>
    expect(isValidConnection(UIO_CUE, { ...CUE_GYE, departureAt: '2026-12-10T08:59:00-05:00' })).toBe(false));
  it('escala de exactamente 60 min sí es válida', () =>
    expect(isValidConnection(UIO_CUE, { ...CUE_GYE, departureAt: '2026-12-10T09:00:00-05:00' })).toBe(true));
  it('escala de más de 10 h no es válida', () =>
    expect(isValidConnection(UIO_CUE, { ...CUE_GYE, departureAt: '2026-12-10T18:01:00-05:00' })).toBe(false));
  it('los vuelos no se unen en el mismo aeropuerto', () => expect(isValidConnection(UIO_CUE, { ...CUE_GYE, origin: 'GYE' })).toBe(false));
  it('ida y vuelta al mismo origen no es una conexión', () => expect(isValidConnection(UIO_CUE, { ...CUE_GYE, destination: 'UIO' })).toBe(false));
  it('un rodeo absurdo (UIO → BOG → GYE) no es válido', () => {
    const uioBog = vuelo({ origin: 'UIO', destination: 'BOG', departureAt: '2026-12-10T07:00:00-05:00', arrivalAt: '2026-12-10T08:30:00-05:00' });
    const bogGye = vuelo({ origin: 'BOG', destination: 'GYE', departureAt: '2026-12-10T10:00:00-05:00', arrivalAt: '2026-12-10T11:45:00-05:00' });
    expect(isValidConnection(uioBog, bogGye)).toBe(false);
  });

  it('isSellable: a la venta y sale en más de 60 min', () => expect(isSellable(toItinerary([UIO_GYE]), NOW)).toBe(true));
  it('isSellable: sale en menos de 60 min', () => expect(isSellable(toItinerary([UIO_GYE]), Date.parse(UIO_GYE.departureAt) - 59 * 60_000)).toBe(false));
  it('isSellable: un tramo cerrado cierra todo el itinerario', () => expect(isSellable(toItinerary([UIO_CUE, { ...CUE_GYE, onSale: false }]), NOW)).toBe(false));
});

describe('findItineraries', () => {
  const desde = (vuelos: FlightRecord[]) => (hub: string) => vuelos.filter((v) => v.origin === hub);

  it('devuelve el directo primero y luego la conexión', () => {
    const opciones = findItineraries('UIO', 'GYE', [UIO_CUE, UIO_GYE], desde([CUE_GYE]), NOW);
    expect(opciones.map((o) => o.flights.length)).toEqual([1, 2]);
  });
  it('entre directos, el más corto primero', () => {
    const lento = { ...UIO_GYE, segmentId: 'EA102-20261210', arrivalAt: '2026-12-10T09:30:00-05:00' };
    expect(findItineraries('UIO', 'GYE', [lento, UIO_GYE], desde([]), NOW).map((o) => o.itineraryId)).toEqual([UIO_GYE.segmentId, 'EA102-20261210']);
  });
  it('ignora vuelos de otro origen, cerrados o que salen ya', () => {
    const cerrado = { ...UIO_GYE, onSale: false };
    const yaSale = { ...UIO_GYE, segmentId: 'EA103-20261210' };
    expect(findItineraries('UIO', 'GYE', [cerrado, CUE_GYE], desde([]), NOW)).toEqual([]);
    expect(findItineraries('UIO', 'GYE', [yaSale], desde([]), Date.parse(UIO_GYE.departureAt))).toEqual([]);
  });
  it('una conexión con el segundo tramo cerrado no aparece', () =>
    expect(findItineraries('UIO', 'GYE', [UIO_CUE], desde([{ ...CUE_GYE, onSale: false }]), NOW)).toEqual([]));
  it(`como máximo ${MAX_OPTIONS_PER_ROUTE} opciones`, () => {
    const muchos = Array.from({ length: 10 }, (_, i) => ({ ...UIO_GYE, segmentId: `EA1${i}0-20261210` }));
    expect(findItineraries('UIO', 'GYE', muchos, desde([]), NOW)).toHaveLength(MAX_OPTIONS_PER_ROUTE);
  });
});

describe('priceFor: precio de un pasajero', () => {
  const directo = toItinerary([UIO_GYE]);

  it('adulto en SEMILLA UIO–GYE: base 59,00 + impuestos 20,85', () =>
    expect(priceFor(directo, regla(), 'ADULT')).toEqual({ currency: 'USD', baseFare: '59.00', taxes: '20.85', total: '79.85' }));
  it('el joven paga igual que el adulto', () => expect(priceFor(directo, regla(), 'YOUTH')).toEqual(priceFor(directo, regla(), 'ADULT')));
  it('el niño paga el 75 % de la base (redondeado al dólar) y los mismos impuestos', () =>
    expect(priceFor(directo, regla(), 'CHILD')).toEqual({ currency: 'USD', baseFare: '44.00', taxes: '20.85', total: '64.85' }));
  it('el infante paga el 10 % de la base y no paga impuestos', () =>
    expect(priceFor(directo, regla(), 'INFANT')).toEqual({ currency: 'USD', baseFare: '6.00', taxes: '0.00', total: '6.00' }));
  it('DOSEL (× 3,2): base 189,00 + impuestos 40,35', () =>
    expect(priceFor(directo, regla(DOSEL), 'ADULT')).toEqual({ currency: 'USD', baseFare: '189.00', taxes: '40.35', total: '229.35' }));
  it('con escala: 10 % menos en la base y US$ 12 de impuesto por cada tramo', () =>
    expect(priceFor(toItinerary([UIO_CUE, CUE_GYE]), regla(), 'ADULT')).toEqual({ currency: 'USD', baseFare: '97.00', taxes: '38.55', total: '135.55' }));
  it('el multiplicador publicado por Schedule cambia el precio', () =>
    expect(priceFor(directo, priceRuleOf(SEMILLA, [{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 2 }]), 'ADULT').baseFare).toBe('118.00'));
  it('la tarifa base editable (P-1): cargo fijo 40 y 0,10 por km', () =>
    expect(priceFor(directo, regla(SEMILLA, { fixedCharge: 40, perKm: 0.1, routePrices: {} }), 'ADULT').baseFare).toBe('68.00'));
  it('un precio exacto por ruta (P-1) reemplaza la fórmula y no se multiplica', () =>
    expect(priceFor(directo, regla(SEMILLA, { ...DEFAULT_PRICING_SETTINGS, routePrices: { 'UIO-GYE': { SEMILLA: 50 } } }), 'ADULT')).toEqual({
      currency: 'USD',
      baseFare: '50.00',
      taxes: '19.50',
      total: '69.50',
    }));
  it('el precio exacto de otro paquete no afecta a este', () =>
    expect(priceFor(directo, regla(SEMILLA, { ...DEFAULT_PRICING_SETTINGS, routePrices: { 'UIO-GYE': { DOSEL: 500 } } }), 'ADULT').baseFare).toBe('59.00'));
  it('el total es siempre base + impuestos, al centavo', () => {
    for (const type of ['ADULT', 'CHILD', 'INFANT'] as const) {
      const price = priceFor(toItinerary([UIO_CUE, CUE_GYE]), regla(DOSEL), type);
      expect(Math.round(Number(price.total) * 100)).toBe(Math.round(Number(price.baseFare) * 100) + Math.round(Number(price.taxes) * 100));
    }
  });
});

describe('priceItinerary y equipaje', () => {
  const directo = toItinerary([UIO_GYE]);
  it('suma por cantidad de pasajeros de cada tipo', () =>
    expect(priceItinerary(directo, regla(), counts({ adults: 2, children: 1, infants: 1 }))).toEqual({
      currency: 'USD',
      baseFare: '168.00', // 59 × 2 + 44 + 6
      taxes: '62.55', // 20,85 × 3 (el infante no paga)
      total: '230.55',
    }));
  it('maleta extra: 35 bajo 1 000 km, 45 bajo 3 000 km, 60 desde 3 000 km', () => {
    expect(extraBagPrice(directo).total).toBe('35.00');
    expect(extraBagPrice(toItinerary([vuelo({ origin: 'UIO', destination: 'MIA', departureAt: '2026-12-10T08:00:00-05:00', arrivalAt: '2026-12-10T12:00:00-05:00' })])).total).toBe('45.00');
    expect(extraBagPrice(toItinerary([vuelo({ origin: 'UIO', destination: 'MAD', departureAt: '2026-12-10T20:00:00-05:00', arrivalAt: '2026-12-11T14:00:00+01:00' })])).total).toBe('60.00');
  });
});

describe('forma del contrato: toFlightSegment y toItineraryOption', () => {
  it('el segmento lleva aerolínea, avión, duración y la escala hasta el siguiente', () =>
    expect(toFlightSegment(UIO_CUE, CUE_GYE)).toMatchObject({
      departure: { iataCode: 'UIO', at: UIO_CUE.departureAt },
      arrival: { iataCode: 'CUE', at: UIO_CUE.arrivalAt },
      layoverMinutes: 90,
      marketingCarrier: 'EA',
      operatingCarrier: 'EA',
      aircraft: 'Airbus A220-300',
      durationMinutes: 60,
      status: 'SCHEDULED',
    }));
  it('el último tramo no tiene escala', () => expect(toFlightSegment(CUE_GYE)).not.toHaveProperty('layoverMinutes'));
  it('los aeropuertos con terminal conocida la incluyen', () =>
    expect(toFlightSegment(vuelo({ origin: 'UIO', destination: 'BOG', departureAt: '2026-12-10T07:00:00-05:00', arrivalAt: '2026-12-10T08:30:00-05:00' })).arrival).toEqual({
      iataCode: 'BOG',
      at: '2026-12-10T08:30:00-05:00',
      terminal: '1',
    }));
  it('un vuelo cerrado por cancelación sale CANCELLED; cerrado por otra razón sigue SCHEDULED', () => {
    expect(toFlightSegment({ ...UIO_GYE, onSale: false, closedReason: 'FLIGHT_CANCELLED' }).status).toBe('CANCELLED');
    expect(toFlightSegment({ ...UIO_GYE, onSale: false, closedReason: 'SALES_CLOSED' }).status).toBe('SCHEDULED');
  });
  it('ofrece los 4 paquetes del avión con su precio por tipo de pasajero y los cupos', () => {
    const opcion = toItineraryOption(toItinerary([UIO_GYE]), counts({ children: 1 }), { prices: [], availableSeats: (cabin) => (cabin === 'BUSINESS' ? 3 : 40) });
    expect(opcion.stopsCount).toBe(0);
    expect(opcion.pricingOptions.map((p) => [p.fareBrand, p.availableSeats])).toEqual([
      ['SEMILLA', 40],
      ['BROTE', 40],
      ['BOSQUE', 40],
      ['DOSEL', 3],
    ]);
    expect(opcion.pricingOptions[0].pricePerPassengerType.map((p) => [p.passengerType, p.price.total])).toEqual([
      ['ADULT', '79.85'],
      ['CHILD', '64.85'],
    ]);
  });
  it('con `only` deja solo la tarifa elegida', () => {
    const opcion = toItineraryOption(toItinerary([UIO_GYE]), counts(), { prices: [], availableSeats: () => 1 }, { cabinClass: 'BUSINESS', fareBrand: 'DOSEL' });
    expect(opcion.pricingOptions.map((p) => p.fareBrand)).toEqual(['DOSEL']);
  });
});

describe('seatsOf: mapa de asientos', () => {
  const a220 = seatsOf('Airbus A220-300');
  it('A220-300: 12 en Business (2-2, filas 1–3) y 110 en Economy (2-3, filas 4–25)', () => {
    expect(a220.filter((s) => s.cabinClass === 'BUSINESS')).toHaveLength(12);
    expect(a220.filter((s) => s.cabinClass === 'ECONOMY')).toHaveLength(110);
    expect(a220[0].seatNumber).toBe('1A');
  });
  it('ventana en A y F; pasillo en C y D', () => {
    const fila5 = a220.filter((s) => s.rowNumber === 5);
    expect(fila5.map((s) => [s.seatNumber, s.characteristics])).toEqual([
      ['5A', ['WINDOW']],
      ['5C', ['AISLE']],
      ['5D', ['AISLE']],
      ['5E', []],
      ['5F', ['WINDOW']],
    ]);
  });
  it('la fila 13 es salida de emergencia con más espacio; la 4, solo más espacio', () => {
    expect(a220.find((s) => s.seatNumber === '13E')!.characteristics).toEqual(['EXTRA_LEGROOM', 'EMERGENCY_EXIT']);
    expect(a220.find((s) => s.seatNumber === '4E')!.characteristics).toEqual(['EXTRA_LEGROOM']);
  });
  it('787-9 (3-3-3): ventana en A y J, pasillo en C, D, F y G; no hay fila 8', () => {
    const b787 = seatsOf('Boeing 787-9');
    const conCaracteristica = (c: string) => b787.filter((s) => s.rowNumber === 15 && s.characteristics.includes(c as never)).map((s) => s.seatNumber);
    expect(conCaracteristica('WINDOW')).toEqual(['15A', '15J']);
    expect(conCaracteristica('AISLE')).toEqual(['15C', '15D', '15F', '15G']);
    expect(b787.some((s) => s.rowNumber === 8)).toBe(false);
  });
  it('un tipo que no existe no tiene asientos', () => expect(seatsOf('Avión de papel')).toEqual([]));
  it('los números de asiento no se repiten', () => expect(new Set(a220.map((s) => s.seatNumber)).size).toBe(a220.length));
});

describe('fechas', () => {
  it('localDate: las 22:00 de Ecuador del 11/11 ya son 12/11 en UTC, pero localmente es 11/11', () =>
    expect(localDate(Date.parse('2026-11-12T03:00:00Z'))).toBe('2026-11-11'));
  it('localDate con otro desfase (Madrid, +60)', () => expect(localDate(Date.parse('2026-11-11T23:30:00Z'), 60)).toBe('2026-11-12'));
  it('addDays cruza fin de mes, de año y el 29 de febrero', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('inventario (model.ts)', () => {
  it('disponibles = total − todos los estados que ocupan un cupo', () => {
    const inv: InventoryRecord = { segmentId: 'S', cabinClass: 'ECONOMY', total: 100, counts: { HELD: 5, BOOKED: 10, TICKETED: 20, CHECKED_IN: 3, BOARDED: 2 } };
    expect(available(inv)).toBe(60);
  });
});
