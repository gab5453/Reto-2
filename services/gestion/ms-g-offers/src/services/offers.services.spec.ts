import type { ProblemDetailsException } from '@ecoairlines/shared';
import type { OffersConfig } from '../config/config.js';
import { DEFAULT_PRICING_SETTINGS, type BookingSeatRecord, type FlightRecord, type HoldRecord, type InventoryRecord, type StockSyncRecord } from '../domain/model.js';
import type { OffersStore, OffersTx } from '../repositories/offers.store.js';
import { HoldsService, type PassengerSeatRequest } from './holds.service.js';
import { InventoryService } from './inventory.service.js';
import { StockSyncService } from './stock-sync.service.js';

/**
 * PU-2 (Informacion_General/Pruebas.md §5.1.2): servicios de MS.G.Offers con el repositorio como doble.
 * Stubs: vuelos, inventario y holds que devuelve la "base". Spies: qué cupos movió, qué guardó y qué eventos dejó en el outbox.
 * El envío de stock a Booking usa un `fetch` simulado: nada sale a la red.
 */

const AHORA = Date.parse('2026-12-01T12:00:00Z');
const SEG = 'EA100-20261210';
const SEG2 = 'EA101-20261215';

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
};
/** Para los métodos que validan ANTES de devolver la promesa (lanzan al llamarlos, no al esperar): mismo efecto con `await`. */
const codeOfCall = async (call: () => Promise<unknown>) => {
  try {
    await call();
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
};
const problemOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem;
  }
};

const vuelo = (over: Partial<FlightRecord> = {}): FlightRecord => ({
  segmentId: SEG,
  flightNumber: 'EA100',
  date: '2026-12-10',
  routeId: 'UIO-GYE',
  origin: 'UIO',
  destination: 'GYE',
  departureAt: '2026-12-10T08:00:00-05:00',
  arrivalAt: '2026-12-10T08:50:00-05:00',
  aircraftType: 'Airbus A220-300',
  registration: 'HC-J01',
  onSale: true,
  ...over,
});
const cupos = (segmentId = SEG, cabinClass: 'ECONOMY' | 'BUSINESS' = 'ECONOMY', total = 110, held = 0): InventoryRecord => ({
  segmentId,
  cabinClass,
  total,
  counts: { HELD: held, BOOKED: 0, TICKETED: 0, CHECKED_IN: 0, BOARDED: 0 },
});

function txStub() {
  return {
    flight: vi.fn(async (segmentId: string) => (segmentId === SEG ? vuelo() : segmentId === SEG2 ? vuelo({ segmentId: SEG2, flightNumber: 'EA101', date: '2026-12-15' }) : undefined)),
    flightsOn: vi.fn().mockResolvedValue([]),
    flightsInRange: vi.fn().mockResolvedValue([]),
    flightsByNumbers: vi.fn().mockResolvedValue([]),
    saveFlight: vi.fn().mockResolvedValue(undefined),
    deleteFlight: vi.fn().mockResolvedValue(undefined),
    inventory: vi.fn(async (segmentId: string) => [cupos(segmentId)]),
    saveInventory: vi.fn().mockResolvedValue(undefined),
    moveCupos: vi.fn().mockResolvedValue(true),
    bookingSeats: vi.fn().mockResolvedValue([]),
    assignedSeats: vi.fn().mockResolvedValue([]),
    insertBookingSeat: vi.fn().mockResolvedValue(true),
    updateBookingSeat: vi.fn().mockResolvedValue(undefined),
    deleteBookingSeats: vi.fn().mockResolvedValue(undefined),
    hold: vi.fn().mockResolvedValue(undefined),
    insertHold: vi.fn().mockResolvedValue(undefined),
    updateHoldIf: vi.fn().mockResolvedValue(true),
    activeHoldsOn: vi.fn().mockResolvedValue([]),
    farePrices: vi.fn().mockResolvedValue([]),
    replaceFarePrices: vi.fn().mockResolvedValue(undefined),
    pricingSettings: vi.fn().mockResolvedValue(DEFAULT_PRICING_SETTINGS),
    replacePricingSettings: vi.fn().mockResolvedValue(undefined),
    airportCatalog: vi.fn().mockResolvedValue([]),
    replaceAirportCatalog: vi.fn().mockResolvedValue(undefined),
    aircraftTypeCatalog: vi.fn().mockResolvedValue([]),
    saveAircraftTypeCatalog: vi.fn().mockResolvedValue(undefined),
    promotionRule: vi.fn().mockResolvedValue(undefined),
    replacePromotionRules: vi.fn().mockResolvedValue(undefined),
    sagaResult: vi.fn().mockResolvedValue(undefined),
    saveSagaResult: vi.fn().mockResolvedValue(undefined),
    addOutbox: vi.fn().mockResolvedValue(undefined),
    markStock: vi.fn().mockResolvedValue(undefined),
  } satisfies Record<keyof OffersTx, unknown>;
}

let tx: ReturnType<typeof txStub>;
let store: OffersStore & { dueHolds: ReturnType<typeof vi.fn>; pendingStock: ReturnType<typeof vi.fn>; markStockPushed: ReturnType<typeof vi.fn>; markStockFailed: ReturnType<typeof vi.fn> };
let holds: HoldsService;
let inventory: InventoryService;
beforeEach(() => {
  tx = txStub();
  store = {
    kind: 'memory',
    transaction: vi.fn((work: (t: OffersTx) => unknown) => work(tx as unknown as OffersTx)),
    dueHolds: vi.fn().mockResolvedValue([]),
    pendingStock: vi.fn().mockResolvedValue([]),
    markStockPushed: vi.fn().mockResolvedValue(undefined),
    markStockFailed: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof store;
  holds = new HoldsService(store);
  holds.now = () => AHORA;
  inventory = new InventoryService(store, holds);
  inventory.now = () => AHORA;
});

const hold = (over: Partial<HoldRecord> = {}): HoldRecord =>
  ({
    holdId: 'h-1',
    ownerId: 'cliente-1',
    channel: 'WEB',
    status: 'HELD',
    offerId: SEG,
    counts: { adults: 2, youths: 0, children: 0, infants: 1 },
    selections: [
      {
        itineraryId: SEG,
        cabinClass: 'ECONOMY',
        fareBrand: 'SEMILLA',
        segmentIds: [SEG],
        itinerary: { segments: [{ departure: { iataCode: 'UIO' }, arrival: { iataCode: 'GYE' } }] },
        price: { currency: 'USD', total: '79.85' },
      },
    ],
    lockedPrice: { currency: 'USD', baseFare: '100.00', taxes: '0.00', total: '100.00' },
    ttlMinutes: 15,
    createdAt: new Date(AHORA).toISOString(),
    expiresAt: new Date(AHORA + 15 * 60_000).toISOString(),
    bookingId: null,
    ...over,
  }) as HoldRecord;

// ================================================================================================ holds
describe('HoldsService.create: retener cupos y congelar el precio', () => {
  const crear = (over = {}) =>
    holds.create({ offerId: SEG, selections: [{ itineraryId: SEG, cabinClass: 'ECONOMY', fareBrand: 'SEMILLA' }], passengers: { adults: 1 }, ownerId: 'cliente-1', ...over });

  it('mueve los cupos AVAILABLE → HELD, guarda el hold con el precio y deja el evento y el stock', async () => {
    const creado = await crear();
    expect(tx.moveCupos).toHaveBeenCalledWith(SEG, 'ECONOMY', 'AVAILABLE', 'HELD', 1);
    expect(creado).toMatchObject({ status: 'HELD', channel: 'WEB', ttlMinutes: 15, lockedPrice: { total: '79.85' } });
    expect(creado.expiresAt).toBe(new Date(AHORA + 15 * 60_000).toISOString());
    expect(tx.insertHold).toHaveBeenCalledWith(creado);
    expect(tx.addOutbox).toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringContaining('hold.created'), ownerId: 'cliente-1' }));
    expect(tx.markStock).toHaveBeenCalledWith(expect.objectContaining({ segmentId: SEG, cabinClass: 'ECONOMY', units: 110 }));
  });
  it('los infantes no ocupan cupo', async () => {
    await crear({ passengers: { adults: 1, infants: 1 } });
    expect(tx.moveCupos).toHaveBeenCalledWith(SEG, 'ECONOMY', 'AVAILABLE', 'HELD', 1);
  });
  it('el dueño partner:… es del canal BOOKING', async () => expect((await crear({ ownerId: 'partner:BOOKING_PROTOTIPO:u' })).channel).toBe('BOOKING'));
  it.each([4, 31, 10.5])('ttlMinutes %s fuera de 5–30 → VALIDATION_FAILED, sin abrir transacción', async (ttlMinutes) => {
    expect(await codeOf(crear({ ttlMinutes }))).toBe('VALIDATION_FAILED');
    expect(store.transaction).not.toHaveBeenCalled();
  });
  it('sin dueño (D29) → VALIDATION_FAILED', async () => expect(await codeOf(crear({ ownerId: '' }))).toBe('VALIDATION_FAILED'));
  it('sin cupos suficientes → OFFER_NO_LONGER_AVAILABLE y no guarda el hold', async () => {
    tx.moveCupos.mockResolvedValue(false);
    expect(await codeOf(crear())).toBe('OFFER_NO_LONGER_AVAILABLE');
    expect(tx.insertHold).not.toHaveBeenCalled();
  });
  it('un vuelo cerrado → OFFER_NO_LONGER_AVAILABLE (410)', async () => {
    tx.flight.mockResolvedValue(vuelo({ onSale: false }));
    expect(await problemOf(crear())).toMatchObject({ status: 410, code: 'OFFER_NO_LONGER_AVAILABLE' });
  });
  it('un vuelo que sale en menos de una hora ya no se retiene', async () => {
    holds.now = () => Date.parse('2026-12-10T12:30:00Z');
    expect(await codeOf(crear())).toBe('OFFER_NO_LONGER_AVAILABLE');
  });
  it('una selección que no cubre los itinerarios de la oferta → VALIDATION_FAILED', async () =>
    expect(await codeOf(crear({ offerId: `${SEG}~${SEG2}` }))).toBe('VALIDATION_FAILED'));
  it('una familia tarifaria que no existe → VALIDATION_FAILED', async () =>
    expect(await codeOf(crear({ selections: [{ itineraryId: SEG, cabinClass: 'ECONOMY', fareBrand: 'DOSEL' }] }))).toBe('VALIDATION_FAILED'));
});

describe('HoldsService: leer, liberar y vencer', () => {
  it('un hold de otro dueño → NOT_FOUND (no revela que existe)', async () => {
    tx.hold.mockResolvedValue(hold());
    expect(await codeOf(holds.get('h-1', 'otro'))).toBe('NOT_FOUND');
  });
  it('al leer un hold vencido se marca EXPIRED, devuelve los cupos y avisa hold.expired', async () => {
    tx.hold.mockResolvedValue(hold({ expiresAt: new Date(AHORA - 1).toISOString() }));
    expect((await holds.get('h-1')).status).toBe('EXPIRED');
    expect(tx.updateHoldIf).toHaveBeenCalledWith('h-1', 'HELD', { status: 'EXPIRED' });
    expect(tx.moveCupos).toHaveBeenCalledWith(SEG, 'ECONOMY', 'HELD', 'AVAILABLE', 2);
    expect(tx.addOutbox).toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringContaining('hold.expired') }));
  });
  it('si otro proceso ya lo venció, no devuelve los cupos dos veces', async () => {
    tx.hold.mockResolvedValue(hold({ expiresAt: new Date(AHORA - 1).toISOString() }));
    tx.updateHoldIf.mockResolvedValue(false);
    await holds.get('h-1');
    expect(tx.moveCupos).not.toHaveBeenCalled();
    expect(tx.addOutbox).not.toHaveBeenCalled();
  });
  it('liberar: HELD → RELEASED y devuelve los cupos', async () => {
    tx.hold.mockResolvedValue(hold());
    expect((await holds.release('h-1')).status).toBe('RELEASED');
    expect(tx.moveCupos).toHaveBeenCalledWith(SEG, 'ECONOMY', 'HELD', 'AVAILABLE', 2);
  });
  it('liberar uno ya liberado no es error ni mueve cupos (idempotente)', async () => {
    tx.hold.mockResolvedValue(hold({ status: 'RELEASED' }));
    expect((await holds.release('h-1')).status).toBe('RELEASED');
    expect(tx.moveCupos).not.toHaveBeenCalled();
  });
  it('liberar uno ya convertido en reserva → HOLD_ALREADY_CONSUMED', async () => {
    tx.hold.mockResolvedValue(hold({ status: 'CONSUMED' }));
    expect(await codeOf(holds.release('h-1'))).toBe('HOLD_ALREADY_CONSUMED');
  });
  it('el barrido cuenta solo los que venció él', async () => {
    store.dueHolds.mockResolvedValue(['h-1', 'h-2']);
    tx.hold.mockImplementation(async (id: string) => hold({ holdId: id, expiresAt: new Date(AHORA - 1).toISOString() }));
    expect(await holds.sweep()).toBe(2);
  });
});

describe('HoldsService.validate: monto a cobrar y asientos pedidos (T-1)', () => {
  beforeEach(() => tx.hold.mockResolvedValue(hold()));
  const regla = (over = {}) => ({ partnerId: 'BOOKING_PROTOTIPO', allowsPromotions: true, maxDiscountPercentage: 20, routes: [], cabins: [], validUntil: null, ...over });

  it('sin promoción, el monto es el precio congelado', async () => expect((await holds.validate('h-1', 'cliente-1')).expectedAmount.total).toBe('100.00'));
  it('con un descuento dentro del acuerdo se aplica', async () => {
    tx.promotionRule.mockResolvedValue(regla());
    expect((await holds.validate('h-1', 'cliente-1', { partnerId: 'BOOKING_PROTOTIPO', discountPercentage: 20 })).expectedAmount.total).toBe('80.00');
  });
  it.each([
    ['sin acuerdo', undefined],
    ['acuerdo sin promociones', { allowsPromotions: false }],
    ['descuento mayor al máximo', { maxDiscountPercentage: 10 }],
    ['acuerdo vencido', { validUntil: '2026-11-30' }],
    ['cabina no habilitada', { cabins: ['BUSINESS'] }],
    ['ruta no habilitada', { routes: ['UIO-MAD'] }],
  ])('%s → PROMOTION_DISCOUNT_OUT_OF_RANGE', async (_caso, over) => {
    tx.promotionRule.mockResolvedValue(over === undefined ? undefined : regla(over));
    expect(await codeOf(holds.validate('h-1', 'cliente-1', { partnerId: 'BOOKING_PROTOTIPO', discountPercentage: 20 }))).toBe('PROMOTION_DISCOUNT_OUT_OF_RANGE');
  });
  it('un hold vencido → HOLD_EXPIRED (410)', async () => {
    tx.hold.mockResolvedValue(hold({ status: 'EXPIRED' }));
    expect(await problemOf(holds.validate('h-1', 'cliente-1'))).toMatchObject({ status: 410, code: 'HOLD_EXPIRED' });
  });
  it('un asiento pedido que ya está tomado → SEAT_TAKEN con el formato que pidió Booking, ANTES de cobrar', async () => {
    tx.assignedSeats.mockResolvedValue([{ seatNumber: '12A' }]);
    expect(await problemOf(holds.validate('h-1', 'cliente-1', undefined, [{ segmentId: SEG, seatNumber: '12A' }]))).toMatchObject({
      status: 409,
      code: 'SEAT_TAKEN',
      title: 'Asiento no disponible',
      detail: `El asiento 12A del segmento ${SEG} ya fue tomado.`,
    });
  });
  it('revisar un asiento libre no lo ocupa', async () => {
    await holds.validate('h-1', 'cliente-1', undefined, [{ segmentId: SEG, seatNumber: '12A' }]);
    expect(tx.insertBookingSeat).not.toHaveBeenCalled();
  });
  it('un asiento de Business con tarifa Economy → SEAT_CABIN_MISMATCH', async () =>
    expect(await codeOf(holds.validate('h-1', 'cliente-1', undefined, [{ segmentId: SEG, seatNumber: '1A' }]))).toBe('SEAT_CABIN_MISMATCH'));
  it('un asiento que no existe en el avión', async () => expect(await codeOf(holds.validate('h-1', 'cliente-1', undefined, [{ segmentId: SEG, seatNumber: '99Z' }]))).toBe('VALIDATION_FAILED'));
  it('dos pasajeros pidiendo el mismo asiento', async () =>
    expect(await codeOf(holds.validate('h-1', 'cliente-1', undefined, [{ segmentId: SEG, seatNumber: '12A' }, { segmentId: SEG, seatNumber: '12A' }]))).toBe('VALIDATION_FAILED'));
  it('un asiento de un vuelo que no es del hold', async () => expect(await codeOf(holds.validate('h-1', 'cliente-1', undefined, [{ segmentId: SEG2, seatNumber: '12A' }]))).toBe('VALIDATION_FAILED'));
});

describe('HoldsService.consume: el hold se convierte en reserva', () => {
  const pasajeros: PassengerSeatRequest[] = [
    { passengerId: 'P1', passengerType: 'ADULT', requestedSeats: [{ segmentId: SEG, seatNumber: '12A' }] },
    { passengerId: 'P2', passengerType: 'ADULT', requestedSeats: [] },
    { passengerId: 'I1', passengerType: 'INFANT', requestedSeats: [] },
  ];
  const consumir = (passengers = pasajeros) => holds.consume({ holdId: 'h-1', bookingId: 'b-1', ownerId: 'cliente-1', passengers });
  beforeEach(() => tx.hold.mockResolvedValue(hold()));

  it('HELD → CONSUMED, cupos HELD → BOOKED, asiento pedido y el primero libre para el otro', async () => {
    tx.assignedSeats.mockResolvedValue([{ seatNumber: '4A' }]);
    const result = await consumir();
    expect(tx.updateHoldIf).toHaveBeenCalledWith('h-1', 'HELD', { status: 'CONSUMED', bookingId: 'b-1' });
    expect(tx.moveCupos).toHaveBeenCalledWith(SEG, 'ECONOMY', 'HELD', 'BOOKED', 2);
    expect(result.seats.map((s) => [s.passengerId, s.seatNumber])).toEqual([
      ['P1', '12A'],
      ['P2', '4C'], // 4A ya estaba tomado
    ]);
    expect(tx.saveSagaResult).toHaveBeenCalledWith('consume:b-1', result);
  });
  it('repetirlo devuelve el mismo resultado sin volver a mover cupos', async () => {
    tx.sagaResult.mockResolvedValue({ hold: hold({ status: 'CONSUMED' }), seats: [] });
    await consumir();
    expect(tx.moveCupos).not.toHaveBeenCalled();
  });
  it('si el asiento pedido lo toma otro en ese instante → SEAT_TAKEN', async () => {
    tx.insertBookingSeat.mockResolvedValueOnce(false);
    expect(await codeOf(consumir())).toBe('SEAT_TAKEN');
  });
  it('si otro asiento libre se toma a la vez, prueba con el siguiente', async () => {
    tx.insertBookingSeat.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true);
    expect((await consumir()).seats[1].seatNumber).toBe('4C');
  });
  it('pasajeros distintos a los del hold → PASSENGER_COUNT_MISMATCH', async () => expect(await codeOf(consumir(pasajeros.slice(0, 2)))).toBe('PASSENGER_COUNT_MISMATCH'));
  it('un infante con asiento → INFANT_SEAT_NOT_ALLOWED', async () =>
    expect(await codeOf(consumir([pasajeros[0], pasajeros[1], { ...pasajeros[2], requestedSeats: [{ segmentId: SEG, seatNumber: '20A' }] }]))).toBe('INFANT_SEAT_NOT_ALLOWED'));
  it('si dos sagas lo consumen a la vez, la segunda → HOLD_ALREADY_CONSUMED', async () => {
    tx.updateHoldIf.mockResolvedValue(false);
    expect(await codeOf(consumir())).toBe('HOLD_ALREADY_CONSUMED');
  });
  it('un hold liberado → HOLD_EXPIRED', async () => {
    tx.hold.mockResolvedValue(hold({ status: 'RELEASED' }));
    expect(await codeOf(consumir())).toBe('HOLD_EXPIRED');
  });
  it('sin bookingId no hay idempotencia → VALIDATION_FAILED', async () =>
    expect(await codeOf(holds.consume({ holdId: 'h-1', bookingId: '', ownerId: 'cliente-1', passengers: pasajeros }))).toBe('VALIDATION_FAILED'));
});

// ================================================================================================ inventario
const asiento = (over: Partial<BookingSeatRecord> = {}): BookingSeatRecord => ({
  id: 'bs-1',
  bookingId: 'b-1',
  segmentId: SEG,
  cabinClass: 'ECONOMY',
  status: 'TICKETED',
  passengerId: 'P1',
  seatNumber: '12A',
  ...over,
});

describe('InventoryService: operaciones de saga idempotentes', () => {
  it('sin sagaId → VALIDATION_FAILED', async () => expect(await codeOf(inventory.release({ bookingId: 'b-1', sagaId: '', segmentIds: [], reason: 'x' }))).toBe('VALIDATION_FAILED'));
  it('repetir una operación devuelve lo guardado sin tocar nada', async () => {
    tx.sagaResult.mockResolvedValue({ seatsReleased: 2, newSeatStatus: 'AVAILABLE' });
    expect(await inventory.release({ bookingId: 'b-1', sagaId: 's-1', segmentIds: [], reason: 'x' })).toEqual({ seatsReleased: 2, newSeatStatus: 'AVAILABLE' });
    expect(tx.deleteBookingSeats).not.toHaveBeenCalled();
  });
  it('release: cada cupo vuelve a AVAILABLE desde su estado, se borran y se avisa el stock', async () => {
    tx.bookingSeats.mockResolvedValue([asiento(), asiento({ id: 'bs-2', passengerId: 'P2', seatNumber: null, status: 'BOOKED' })]);
    expect(await inventory.release({ bookingId: 'b-1', sagaId: 's-1', segmentIds: [], reason: 'CANCEL' })).toEqual({ seatsReleased: 2, newSeatStatus: 'AVAILABLE' });
    expect(tx.moveCupos).toHaveBeenCalledWith(SEG, 'ECONOMY', 'TICKETED', 'AVAILABLE', 1);
    expect(tx.moveCupos).toHaveBeenCalledWith(SEG, 'ECONOMY', 'BOOKED', 'AVAILABLE', 1);
    expect(tx.deleteBookingSeats).toHaveBeenCalledWith(['bs-1', 'bs-2']);
    expect(tx.saveSagaResult).toHaveBeenCalledWith('release:s-1', expect.anything());
  });
  it('release de algunos segmentos solo toca esos', async () => {
    tx.bookingSeats.mockResolvedValue([asiento(), asiento({ id: 'bs-2', segmentId: SEG2 })]);
    expect((await inventory.release({ bookingId: 'b-1', sagaId: 's-1', segmentIds: [SEG2], reason: 'x' })).seatsReleased).toBe(1);
  });

  it('transition: solo un paso de la máquina de estados', async () =>
    expect(await codeOfCall(() => inventory.transition({ bookingId: 'b-1', sagaId: 's', from: 'BOOKED', to: 'BOARDED', segmentIds: [], passengerIds: [] }))).toBe('VALIDATION_FAILED'));
  it('transition: TICKETED → CHECKED_IN del pasajero pedido, en cupos y asientos', async () => {
    tx.bookingSeats.mockResolvedValue([asiento(), asiento({ id: 'bs-2', passengerId: 'P2', seatNumber: '12B' })]);
    const result = await inventory.transition({ bookingId: 'b-1', sagaId: 's', from: 'TICKETED', to: 'CHECKED_IN', segmentIds: [SEG], passengerIds: ['P2'] });
    expect(result.seatsAffected).toBe(1);
    expect(tx.updateBookingSeat).toHaveBeenCalledWith(expect.objectContaining({ id: 'bs-2', status: 'CHECKED_IN' }));
  });
  it('transition: la inversa también vale (compensación)', async () =>
    expect(await codeOf(inventory.transition({ bookingId: 'b-1', sagaId: 's', from: 'CHECKED_IN', to: 'TICKETED', segmentIds: [], passengerIds: [] }))).toBeUndefined());
  it('transition: si los conteos no cuadran → INTERNAL_ERROR', async () => {
    tx.bookingSeats.mockResolvedValue([asiento()]);
    tx.moveCupos.mockResolvedValue(false);
    expect(await codeOf(inventory.transition({ bookingId: 'b-1', sagaId: 's', from: 'TICKETED', to: 'CHECKED_IN', segmentIds: [], passengerIds: [] }))).toBe('INTERNAL_ERROR');
  });

  it('reserveSeats: cambia el asiento y dice cuál tenía', async () => {
    tx.bookingSeats.mockResolvedValue([asiento()]);
    const result = await inventory.reserveSeats({
      bookingId: 'b-1',
      sagaId: 's',
      seats: [{ passengerId: 'P1', segmentId: SEG, seatNumber: '14F' }],
      purchasedCabins: [{ passengerId: 'P1', segmentId: SEG, cabinClass: 'ECONOMY' }],
      targetStatus: 'TICKETED',
    });
    expect(result.seats[0]).toEqual({ passengerId: 'P1', segmentId: SEG, seatNumber: '14F', previousSeatNumber: '12A', status: 'TICKETED' });
  });
  it('reserveSeats: un asiento de otra cabina → SEAT_CABIN_MISMATCH', async () => {
    tx.bookingSeats.mockResolvedValue([asiento()]);
    expect(
      await codeOf(
        inventory.reserveSeats({ bookingId: 'b-1', sagaId: 's', seats: [{ passengerId: 'P1', segmentId: SEG, seatNumber: '1A' }], purchasedCabins: [{ passengerId: 'P1', segmentId: SEG, cabinClass: 'ECONOMY' }], targetStatus: 'TICKETED' }),
      ),
    ).toBe('SEAT_CABIN_MISMATCH');
  });

  it('reserveInventory: retiene cupos sin asiento en los vuelos nuevos', async () => {
    const result = await inventory.reserveInventory({ bookingId: 'b-1', sagaId: 's', segments: [{ segmentId: SEG2, cabinClass: 'ECONOMY', count: 2 }], targetStatus: 'BOOKED' });
    expect(result.seatsAffected).toBe(2);
    expect(tx.insertBookingSeat).toHaveBeenCalledTimes(2);
    expect(tx.insertBookingSeat).toHaveBeenCalledWith(expect.objectContaining({ passengerId: null, seatNumber: null, status: 'BOOKED' }));
  });
  it('reserveInventory: un vuelo cerrado → OFFER_NO_LONGER_AVAILABLE', async () => {
    tx.flight.mockResolvedValue(vuelo({ onSale: false }));
    expect(await codeOf(inventory.reserveInventory({ bookingId: 'b-1', sagaId: 's', segments: [{ segmentId: SEG, cabinClass: 'ECONOMY', count: 1 }], targetStatus: 'BOOKED' }))).toBe(
      'OFFER_NO_LONGER_AVAILABLE',
    );
  });

  it('setSales(false): cierra la venta, libera los holds del vuelo y avisa stock 0', async () => {
    tx.activeHoldsOn.mockResolvedValue([hold(), hold({ holdId: 'h-2' })]);
    const result = await inventory.setSales({ flightNumber: 'EA100', date: '2026-12-10', sagaId: 's', reason: 'FLIGHT_CANCELLED' }, false);
    expect(result).toEqual({ flightNumber: 'EA100', date: '2026-12-10', onSale: false, activeHoldsReleased: 2 });
    expect(tx.saveFlight).toHaveBeenCalledWith(expect.objectContaining({ onSale: false, closedReason: 'FLIGHT_CANCELLED' }));
  });
  it('setSales(true) reabre sin tocar holds', async () => {
    await inventory.setSales({ flightNumber: 'EA100', date: '2026-12-10', sagaId: 's', reason: '' }, true);
    expect(tx.activeHoldsOn).not.toHaveBeenCalled();
    expect(tx.saveFlight).toHaveBeenCalledWith(expect.objectContaining({ onSale: true, closedReason: null }));
  });

  it('countSoldSeats suma lo ocupado de todos los estados', async () => {
    tx.flightsByNumbers.mockResolvedValue([vuelo()]);
    tx.inventory.mockResolvedValue([cupos(SEG, 'ECONOMY', 110, 5), cupos(SEG, 'BUSINESS', 12, 2)]);
    expect(await inventory.countSoldSeats(['EA100'], '2026-12-01')).toBe(7);
  });
  it('occupancy: porcentaje de ocupación con un decimal', async () => {
    tx.flightsOn.mockResolvedValue([vuelo()]);
    tx.inventory.mockResolvedValue([cupos(SEG, 'ECONOMY', 110, 11), cupos(SEG, 'BUSINESS', 12, 0)]);
    expect((await inventory.occupancy('2026-12-10')).flights[0]).toMatchObject({ totalSeats: 122, loadFactor: 9, activeHolds: 0 });
  });
});

describe('InventoryService: publicar horario y precios', () => {
  const entrante = (over = {}) => {
    const { segmentId: _s, onSale: _o, closedReason: _c, ...rest } = vuelo(over);
    return rest;
  };
  it('un vuelo nuevo se guarda a la venta con sus cupos por cabina', async () => {
    const result = await inventory.publishTimetable({ publishId: 'p', from: '2026-12-01', to: '2026-12-31', flights: [entrante()] });
    expect(result).toMatchObject({ added: 1, updated: 0, removed: 0, keptWithSales: 0 });
    expect(tx.saveInventory).toHaveBeenCalledWith(expect.objectContaining({ cabinClass: 'BUSINESS', total: 12 }));
    expect(tx.saveInventory).toHaveBeenCalledWith(expect.objectContaining({ cabinClass: 'ECONOMY', total: 110 }));
  });
  it('un vuelo que ya no está y nadie compró se quita (stock 0 para Booking)', async () => {
    tx.flightsInRange.mockResolvedValue([vuelo()]);
    const result = await inventory.publishTimetable({ publishId: 'p', from: '2026-12-01', to: '2026-12-31', flights: [] });
    expect(result.removed).toBe(1);
    expect(tx.deleteFlight).toHaveBeenCalledWith(SEG);
    expect(tx.markStock).toHaveBeenCalledWith(expect.objectContaining({ units: 0 }));
  });
  it('un vuelo que ya no está pero tiene ventas se conserva', async () => {
    tx.flightsInRange.mockResolvedValue([vuelo()]);
    tx.inventory.mockResolvedValue([cupos(SEG, 'ECONOMY', 110, 3)]);
    expect((await inventory.publishTimetable({ publishId: 'p', from: '2026-12-01', to: '2026-12-31', flights: [] })).keptWithSales).toBe(1);
    expect(tx.deleteFlight).not.toHaveBeenCalled();
  });
  it('un vuelo sin cambios no se toca', async () => {
    tx.flightsInRange.mockResolvedValue([vuelo()]);
    expect(await inventory.publishTimetable({ publishId: 'p', from: '2026-12-01', to: '2026-12-31', flights: [entrante()] })).toMatchObject({ added: 0, updated: 0 });
    expect(tx.saveFlight).not.toHaveBeenCalled();
  });
  it('los vuelos fuera del rango publicado se ignoran', async () =>
    expect((await inventory.publishTimetable({ publishId: 'p', from: '2026-12-11', to: '2026-12-31', flights: [entrante()] })).added).toBe(0));
  it('guarda las copias de los catálogos que llegan con el horario (M-1, M-2)', async () => {
    const airport = { code: 'UIO', city: 'Quito', name: 'x', country: 'EC', lat: 0, lon: 0, utcOffsetMinutes: -300 };
    await inventory.publishTimetable({ publishId: 'p', from: '2026-12-01', to: '2026-12-31', flights: [], airports: [airport] });
    expect(tx.replaceAirportCatalog).toHaveBeenCalledWith([airport]);
  });

  it('publishFarePrices reemplaza precios, promociones y la tarifa base (P-1)', async () => {
    tx.farePrices.mockResolvedValue([{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 1 }]);
    const result = await inventory.publishFarePrices({
      publishId: 'p',
      prices: [{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 1.2 }, { cabinClass: 'BUSINESS', fareBrand: 'DOSEL', multiplier: 3 }],
      promotions: [],
      pricing: { fixedCharge: 40, perKm: 0.1, routePrices: {} },
    });
    expect(result).toMatchObject({ added: 1, updated: 1, removed: 0 });
    expect(tx.replacePricingSettings).toHaveBeenCalledWith({ fixedCharge: 40, perKm: 0.1, routePrices: {} });
  });
  it('sin tarifa base (publicador anterior a P-1) se conserva la vigente', async () => {
    await inventory.publishFarePrices({ publishId: 'p', prices: [], promotions: [] });
    expect(tx.replacePricingSettings).not.toHaveBeenCalled();
  });
  it('un multiplicador fuera de rango o un descuento > 50 % se rechazan antes de la transacción', async () => {
    expect(await codeOfCall(() => inventory.publishFarePrices({ publishId: 'p', prices: [{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 11 }], promotions: [] }))).toBe('VALIDATION_FAILED');
    expect(
      await codeOfCall(() =>
        inventory.publishFarePrices({ publishId: 'p', prices: [], promotions: [{ partnerId: 'X', allowsPromotions: true, maxDiscountPercentage: 60, routes: [], cabins: [] }] }),
      ),
    ).toBe('PROMOTION_DISCOUNT_OUT_OF_RANGE');
    expect(store.transaction).not.toHaveBeenCalled();
  });
});

// ================================================================================================ stock a Booking
describe('StockSyncService: stock a Booking por REST (D53)', () => {
  const config = { bookingServiceId: 'NODE_VUE_EQ5', bookingStockUrl: 'https://booking.example/api/v2/inventory/stock', bookingDeadlineMs: 2_000, stockIntervalMs: 1_000 } as OffersConfig;
  const pendiente = (over: Partial<StockSyncRecord> = {}): StockSyncRecord => ({
    segmentId: SEG,
    cabinClass: 'ECONOMY',
    flightNumber: 'EA100',
    date: '2026-12-10',
    timeSlot: '08:00',
    units: 37,
    version: 4,
    pending: true,
    attempts: 0,
    nextAttemptAt: '',
    correlationId: 'corr-1',
    ...over,
  });
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let sync: StockSyncService;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AHORA);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    sync = new StockSyncService(store, config);
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });
  const responde = (status: number, body: unknown) => fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it('envía el mensaje del contrato con el correlation ID y lo marca enviado con su versión', async () => {
    store.pendingStock.mockResolvedValueOnce([pendiente()]).mockResolvedValue([]);
    responde(200, { success: true });
    expect(await sync.flush()).toBe(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(config.bookingStockUrl);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ service_id: 'NODE_VUE_EQ5', item_id: 'EA100-ECONOMY', date: '2026-12-10', time_slot: '08:00', available_units: 37 });
    expect((init as RequestInit).headers).toMatchObject({ 'x-correlation-id': 'corr-1' });
    expect(store.markStockPushed).toHaveBeenCalledWith(SEG, 'ECONOMY', 4, expect.any(String));
  });
  it('si Booking responde 200 sin success: true, no cuenta como enviado', async () => {
    store.pendingStock.mockResolvedValueOnce([pendiente()]).mockResolvedValue([]);
    responde(200, { success: false, message: 'no' });
    expect(await sync.flush()).toBe(0);
    expect(store.markStockFailed).toHaveBeenCalled();
  });
  it('si falla, reintenta con espera creciente: 1 s, 2 s, 4 s… hasta 60 s', async () => {
    store.pendingStock.mockResolvedValueOnce([pendiente({ attempts: 0 }), pendiente({ attempts: 3, cabinClass: 'BUSINESS' }), pendiente({ attempts: 10, flightNumber: 'EA9' })]).mockResolvedValue([]);
    responde(503, { detail: 'caído' });
    await sync.flush();
    const esperas = store.markStockFailed.mock.calls.map((call) => Date.parse(call[4] as string) - AHORA);
    expect(esperas).toEqual([1_000, 8_000, 60_000]);
    expect(store.markStockFailed.mock.calls[0][3]).toContain('HTTP 503 caído');
  });
  it('CI-2: si Booking responde el detalle como lista (errores de validación), se guarda legible, no «[object Object]»', async () => {
    store.pendingStock.mockResolvedValueOnce([pendiente()]).mockResolvedValue([]);
    responde(422, { detail: [{ loc: ['body', 'date'], msg: 'invalid date' }] });
    await sync.flush();
    const motivo = store.markStockFailed.mock.calls[0][3] as string;
    expect(motivo).toContain('HTTP 422');
    expect(motivo).toContain('invalid date');
    expect(motivo).not.toContain('[object Object]');
  });
  it('un vuelo que ya salió no se envía y queda cerrado', async () => {
    store.pendingStock.mockResolvedValueOnce([pendiente({ date: '2026-11-30' })]).mockResolvedValue([]);
    await sync.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.markStockPushed).toHaveBeenCalled();
  });
  it('pide más mientras vengan lotes completos de 50', async () => {
    store.pendingStock.mockResolvedValueOnce(Array.from({ length: 50 }, () => pendiente())).mockResolvedValueOnce([pendiente()]).mockResolvedValue([]);
    responde(200, { success: true });
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(await sync.flush()).toBe(51);
  });
});
