import type { ProblemDetailsException } from '@ecoairlines/shared';
import type { BookingRecord, PassengerItem, PaymentRecord } from '../domain/model.js';
import { issueTickets, pendingTickets } from '../domain/rules.js';
import type { BookingsStore, BookingsTx } from '../repositories/bookings.store.js';
import { BookingsService, type CreateBookingCommand } from './bookings.service.js';

/**
 * PU-2 (Informacion_General/Pruebas.md §5.1.2): BookingsService con el repositorio reemplazado por dobles de prueba.
 * - Stub: cada método de la transacción devuelve lo que la prueba necesita (`mockResolvedValue`).
 * - Spy: se verifica QUÉ guardó, borró o liberó el servicio (`toHaveBeenCalledWith`, `not.toHaveBeenCalled`).
 * Nada de NestJS ni base de datos: si una prueba falla, el error está en el servicio.
 */

const AHORA = Date.parse('2026-12-01T12:00:00Z');
const OWNER = 'cliente-1';
const PARTNER_OWNER = 'partner:BOOKING_PROTOTIPO:u-9';

const problemOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem;
  }
};
const codeOf = async (promise: Promise<unknown>) => (await problemOf(promise))?.code;

function txStub() {
  return {
    booking: vi.fn().mockResolvedValue(undefined),
    bookingByHold: vi.fn().mockResolvedValue(undefined),
    insertBooking: vi.fn().mockResolvedValue('ok'),
    saveBooking: vi.fn().mockResolvedValue(undefined),
    listBookings: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    flightBookings: vi.fn().mockResolvedValue([]),
    bookingsCreatedBetween: vi.fn().mockResolvedValue([]),
    payment: vi.fn().mockResolvedValue(undefined),
    insertPayment: vi.fn().mockResolvedValue(true),
    savePayment: vi.fn().mockResolvedValue(undefined),
    deletePayment: vi.fn().mockResolvedValue(undefined),
    paymentsOf: vi.fn().mockResolvedValue([]),
    documentHolders: vi.fn().mockResolvedValue([]),
    claimDocuments: vi.fn().mockResolvedValue([]),
    releaseDocuments: vi.fn().mockResolvedValue(undefined),
    assistance: vi.fn().mockResolvedValue([]),
    saveAssistance: vi.fn().mockResolvedValue(undefined),
    deleteAssistance: vi.fn().mockResolvedValue(undefined),
  } satisfies Record<keyof BookingsTx, unknown>;
}

let tx: ReturnType<typeof txStub>;
let service: BookingsService;
beforeEach(() => {
  tx = txStub();
  const store = { kind: 'memory', transaction: vi.fn((work: (t: BookingsTx) => unknown) => work(tx as unknown as BookingsTx)) } as unknown as BookingsStore;
  service = new BookingsService(store);
  service.now = () => AHORA;
});

const pasajero = (over: Partial<PassengerItem> = {}): PassengerItem => ({
  passengerId: 'P1',
  passengerType: 'ADULT',
  firstName: 'Ana',
  lastName: 'Pérez',
  documentType: 'NATIONAL_ID',
  documentNumber: '1710034065',
  nationality: 'EC',
  birthDate: '1990-05-01',
  gender: 'F',
  contact: { email: 'ana@example.com', phone: '+593999999999' },
  ...over,
});
const segmento = (segmentId: string, at: string) => ({ segmentId, flightNumber: segmentId.slice(0, 5), departure: { iataCode: 'UIO', at }, arrival: { iataCode: 'GYE', at } });

function reserva(over: Partial<BookingRecord> = {}): BookingRecord {
  const base = {
    bookingId: 'b-1',
    pnr: 'ABC234',
    ownerId: OWNER,
    channel: 'WEB',
    partnerId: null,
    status: 'CONFIRMED',
    holdId: 'h-1',
    offerId: 'o-1',
    sagaId: 's-1',
    passengersBreakdown: { adults: 2, youths: 0, children: 0, infants: 1 },
    passengers: [
      pasajero({ assignedSeats: [{ segmentId: 'EA100-20261210', seatNumber: '3C' }] }),
      pasajero({ passengerId: 'P2', firstName: 'Luis', documentNumber: '0912345675' }),
      pasajero({ passengerId: 'I1', passengerType: 'INFANT', birthDate: '2026-01-01', documentNumber: '3000000004', associatedAdultId: 'P1' }),
    ],
    itineraries: [
      { itineraryId: 'IDA', segments: [segmento('EA100-20261210', '2026-12-10T08:00:00-05:00')] },
      { itineraryId: 'VUELTA', segments: [segmento('EA101-20261215', '2026-12-15T10:00:00-05:00')] },
    ],
    fares: [{ itineraryId: 'IDA', cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', segmentIds: ['EA100-20261210'], price: { currency: 'USD', total: '79.85' }, isRefundable: false, isChangeable: false }],
    grandTotal: { currency: 'USD', baseFare: '100.00', taxes: '27.00', total: '127.00' },
    payment: { paymentReference: 'pay_123456', provider: 'AIRLINE_DIRECT' },
    changes: [],
    refunds: [],
    checkedIn: [],
    createdAt: '2026-11-11T15:00:00.000Z',
    updatedAt: '2026-11-11T15:00:00.000Z',
    ...over,
  } as Omit<BookingRecord, 'tickets'> & Partial<Pick<BookingRecord, 'tickets'>>;
  const tickets = over.tickets ?? issueTickets({ ...base, tickets: pendingTickets(base) }, 'antes').tickets;
  return { ...base, tickets };
}
const pago = (over: Partial<PaymentRecord> = {}): PaymentRecord => ({
  paymentReference: 'pay_123456',
  provider: 'AIRLINE_DIRECT',
  operation: 'BOOKING',
  amount: { currency: 'USD', total: '127.00' },
  bookingId: null,
  sagaId: 's-1',
  claimedAt: 'antes',
  ...over,
});

// ------------------------------------------------------------------------------------------------ pasajeros
describe('validatePassengers', () => {
  const segmentos = [{ segmentId: 'EA100-20261210', departureAt: '2026-12-10T08:00:00-05:00', international: false }];
  it('consulta si cada documento ya viaja en cada vuelo', async () => {
    await service.validatePassengers({ passengers: [pasajero()], passengersBreakdown: { adults: 1 }, segments: segmentos });
    expect(tx.documentHolders).toHaveBeenCalledWith([{ segmentId: 'EA100-20261210', identityKey: 'EC:1710034065', bookingId: '' }]);
  });
  it('si el documento ya viaja en ese vuelo → PASSENGER_ALREADY_ON_FLIGHT', async () => {
    tx.documentHolders.mockResolvedValue([{ segmentId: 'EA100-20261210', identityKey: 'EC:1710034065', bookingId: 'otra' }]);
    expect(await codeOf(service.validatePassengers({ passengers: [pasajero()], passengersBreakdown: { adults: 1 }, segments: segmentos }))).toBe('PASSENGER_ALREADY_ON_FLIGHT');
  });
  it('si las reglas fallan no consulta la base', async () => {
    expect(await codeOf(service.validatePassengers({ passengers: [pasajero()], passengersBreakdown: { adults: 2 }, segments: segmentos }))).toBe('PASSENGER_COUNT_MISMATCH');
    expect(tx.documentHolders).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------ pagos
describe('claimPayment: una referencia de pago se usa una sola vez', () => {
  const claim = (over: Partial<Parameters<BookingsService['claimPayment']>[0]> = {}) =>
    service.claimPayment({ sagaId: 's-1', paymentReference: 'PAY-ORDEN-123', provider: 'BOOKING_PROTOTIPO', operation: 'BOOKING', expectedAmount: { currency: 'USD', total: '127.00' }, ...over });

  it('una referencia de Booking sin el formato PAY-… se rechaza sin tocar la base', async () => {
    expect(await codeOf(claim({ paymentReference: 'pay_123456' }))).toBe('PAYMENT_REFERENCE_INVALID');
    expect(tx.insertPayment).not.toHaveBeenCalled();
  });
  it('el monto distinto al esperado → AMOUNT_MISMATCH', async () =>
    expect(await codeOf(claim({ amount: { currency: 'USD', total: '126.99' } }))).toBe('AMOUNT_MISMATCH'));
  it('una referencia nueva se registra (created) con el monto esperado si no vino otro', async () => {
    const result = await claim();
    expect(result.created).toBe(true);
    expect(tx.insertPayment).toHaveBeenCalledWith(expect.objectContaining({ paymentReference: 'PAY-ORDEN-123', amount: { currency: 'USD', total: '127.00' }, bookingId: null, sagaId: 's-1' }));
  });
  it('el reintento de la misma saga devuelve el registro existente (no es un error)', async () => {
    tx.insertPayment.mockResolvedValue(false);
    tx.payment.mockResolvedValue(pago({ paymentReference: 'PAY-ORDEN-123' }));
    expect(await claim()).toMatchObject({ created: false, record: { sagaId: 's-1' } });
  });
  it('la misma referencia en otra saga → PAYMENT_REFERENCE_INVALID', async () => {
    tx.insertPayment.mockResolvedValue(false);
    tx.payment.mockResolvedValue(pago({ sagaId: 'otra-saga' }));
    expect(await codeOf(claim())).toBe('PAYMENT_REFERENCE_INVALID');
  });
  it('la misma referencia para otra operación → PAYMENT_REFERENCE_INVALID', async () => {
    tx.insertPayment.mockResolvedValue(false);
    tx.payment.mockResolvedValue(pago({ operation: 'SEATS' }));
    expect(await codeOf(claim())).toBe('PAYMENT_REFERENCE_INVALID');
  });
});

describe('releasePayment (compensación)', () => {
  it('libera la referencia que creó esa saga y no tiene reserva', async () => {
    tx.payment.mockResolvedValue(pago());
    await service.releasePayment('pay_123456', 's-1');
    expect(tx.deletePayment).toHaveBeenCalledWith('pay_123456');
  });
  it('no toca la referencia de otra saga', async () => {
    tx.payment.mockResolvedValue(pago({ sagaId: 'otra' }));
    await service.releasePayment('pay_123456', 's-1');
    expect(tx.deletePayment).not.toHaveBeenCalled();
  });
  it('no hace nada si la referencia no existe (idempotente)', async () => {
    await service.releasePayment('pay_123456', 's-1');
    expect(tx.deletePayment).not.toHaveBeenCalled();
  });
  it('nunca libera la referencia de una reserva confirmada → BOOKING_NOT_CANCELLABLE', async () => {
    tx.payment.mockResolvedValue(pago({ bookingId: 'b-1' }));
    tx.booking.mockResolvedValue(reserva());
    expect(await codeOf(service.releasePayment('pay_123456', 's-1'))).toBe('BOOKING_NOT_CANCELLABLE');
    expect(tx.deletePayment).not.toHaveBeenCalled();
  });
  it('sí libera la referencia de una reserva fallida', async () => {
    tx.payment.mockResolvedValue(pago({ bookingId: 'b-1' }));
    tx.booking.mockResolvedValue(reserva({ status: 'FAILED' }));
    await service.releasePayment('pay_123456', 's-1');
    expect(tx.deletePayment).toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------ crear
describe('create: crear la reserva', () => {
  const comando = (over: Partial<CreateBookingCommand> = {}): CreateBookingCommand => {
    const r = reserva();
    return {
      bookingId: 'B-1',
      sagaId: 's-1',
      holdId: 'H-1',
      offerId: 'o-1',
      passengersBreakdown: r.passengersBreakdown,
      passengers: r.passengers,
      itineraries: r.itineraries,
      fares: r.fares,
      grandTotal: r.grandTotal,
      payment: r.payment,
      ...over,
    };
  };
  beforeEach(() => tx.payment.mockResolvedValue(pago()));

  it('crea en TICKET_ISSUING, con ids en minúsculas, canal del dueño y boletos pendientes', async () => {
    const { booking, created } = await service.create(comando(), PARTNER_OWNER);
    expect(created).toBe(true);
    expect(booking).toMatchObject({ bookingId: 'b-1', holdId: 'h-1', status: 'TICKET_ISSUING', channel: 'BOOKING', partnerId: 'BOOKING_PROTOTIPO' });
    expect(booking.tickets.every((t) => t.status === 'PENDING')).toBe(true);
    expect(tx.insertBooking).toHaveBeenCalledTimes(1);
  });
  it('une la referencia de pago a la reserva y reserva los documentos en cada vuelo', async () => {
    await service.create(comando(), OWNER);
    expect(tx.savePayment).toHaveBeenCalledWith(expect.objectContaining({ paymentReference: 'pay_123456', bookingId: 'b-1' }));
    expect(tx.claimDocuments.mock.calls[0][0]).toHaveLength(3 * 2); // 3 pasajeros × 2 vuelos
  });
  it('guarda la asistencia pedida', async () => {
    await service.create(comando({ assistance: [{ passengerId: 'P2', type: 'WCHR' }] }), OWNER);
    expect(tx.saveAssistance).toHaveBeenCalledWith(expect.objectContaining({ bookingId: 'b-1', passengerId: 'P2', type: 'WCHR', needsCompanion: false, status: 'REQUESTED' }));
  });
  it('asistencia de un pasajero que no está en la reserva → VALIDATION_FAILED', async () =>
    expect(await codeOf(service.create(comando({ assistance: [{ passengerId: 'NADIE', type: 'WCHR' }] }), OWNER))).toBe('VALIDATION_FAILED'));
  it('idempotente: la misma reserva con el mismo hold devuelve la existente sin insertar', async () => {
    tx.booking.mockResolvedValue(reserva());
    expect((await service.create(comando(), OWNER)).created).toBe(false);
    expect(tx.insertBooking).not.toHaveBeenCalled();
  });
  it('el mismo bookingId con otro hold → BOOKING_ID_CONFLICT', async () => {
    tx.booking.mockResolvedValue(reserva({ holdId: 'otro' }));
    expect(await codeOf(service.create(comando(), OWNER))).toBe('BOOKING_ID_CONFLICT');
  });
  it('un hold ya usado por otra reserva → HOLD_ALREADY_CONSUMED', async () => {
    tx.bookingByHold.mockResolvedValue(reserva({ bookingId: 'otra' }));
    expect(await codeOf(service.create(comando(), OWNER))).toBe('HOLD_ALREADY_CONSUMED');
  });
  it('sin la referencia de pago registrada por esa saga → PAYMENT_REFERENCE_INVALID', async () => {
    tx.payment.mockResolvedValue(pago({ sagaId: 'otra' }));
    expect(await codeOf(service.create(comando(), OWNER))).toBe('PAYMENT_REFERENCE_INVALID');
    tx.payment.mockResolvedValue(undefined);
    expect(await codeOf(service.create(comando(), OWNER))).toBe('PAYMENT_REFERENCE_INVALID');
  });
  it('si el PNR generado ya existe, prueba con otro', async () => {
    tx.insertBooking.mockResolvedValueOnce('pnr-taken').mockResolvedValueOnce('ok');
    await service.create(comando(), OWNER);
    expect(tx.insertBooking).toHaveBeenCalledTimes(2);
  });
  it('tras 5 PNR repetidos se rinde → INTERNAL_ERROR', async () => {
    tx.insertBooking.mockResolvedValue('pnr-taken');
    expect(await codeOf(service.create(comando(), OWNER))).toBe('INTERNAL_ERROR');
    expect(tx.insertBooking).toHaveBeenCalledTimes(5);
  });
  it('dos reintentos simultáneos de la saga: el segundo devuelve la que creó el primero', async () => {
    tx.insertBooking.mockResolvedValue('id-exists');
    tx.booking.mockResolvedValueOnce(undefined).mockResolvedValueOnce(reserva());
    expect((await service.create(comando(), OWNER)).created).toBe(false);
  });
  it('un pasajero que ya viaja en ese vuelo → PASSENGER_ALREADY_ON_FLIGHT, sin unir el pago', async () => {
    tx.claimDocuments.mockResolvedValue([{ segmentId: 'EA100-20261210', identityKey: 'EC:1710034065', bookingId: 'otra' }]);
    expect(await codeOf(service.create(comando(), OWNER))).toBe('PASSENGER_ALREADY_ON_FLIGHT');
    expect(tx.savePayment).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------ consultar
describe('get y list: quién ve qué', () => {
  beforeEach(() => tx.booking.mockResolvedValue(reserva()));
  it('el dueño ve su reserva (con su asistencia, sin los pagos)', async () => {
    const view = await service.get('B-1', { ownerId: OWNER });
    expect(view.pnr).toBe('ABC234');
    expect(view).toHaveProperty('assistance');
    expect(view).not.toHaveProperty('payments');
    expect(tx.booking).toHaveBeenCalledWith('b-1');
  });
  it('otro dueño recibe 404, nunca 403 (no revela que existe)', async () => {
    const problem = await problemOf(service.get('b-1', { ownerId: 'otro' }));
    expect(problem).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
  it('el administrador ve cualquier reserva y sus pagos', async () => {
    tx.paymentsOf.mockResolvedValue([pago()]);
    expect(await service.get('b-1', { ownerId: 'otro', actorId: 'admin-1' })).toHaveProperty('payments', [pago()]);
  });
  it('un paso de saga (sin usuario) no recibe la asistencia: es un dato de salud', async () => {
    expect(await service.fail('b-1', 'X').catch(() => undefined)).toBeUndefined(); // CONFIRMED no se marca fallida
    tx.booking.mockResolvedValue(reserva({ status: 'TICKET_ISSUING' }));
    expect(await service.fail('b-1', 'PAYMENT_DECLINED')).not.toHaveProperty('assistance');
    expect(tx.assistance).not.toHaveBeenCalled();
  });

  it('list exige X-Owner-Id o X-Actor-Id', async () => expect(await codeOf(service.list({}, {}, 10))).toBe('VALIDATION_FAILED'));
  it('un cliente solo lista lo suyo y no puede filtrar por canal ni referencia', async () => {
    await service.list({ ownerId: OWNER }, { channel: 'BOOKING', reference: 'X' }, 10);
    expect(tx.listBookings).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, channel: undefined, reference: undefined }), 10, 0);
  });
  it('el administrador filtra por referencia y ve el resumen del canal', async () => {
    tx.listBookings.mockResolvedValue({ items: [reserva()], hasMore: true });
    const page = await service.list({ actorId: 'admin-1' }, { reference: 'ABC234' }, 1);
    expect(tx.listBookings).toHaveBeenCalledWith(expect.objectContaining({ reference: 'ABC234' }), 1, 0);
    expect(page.items[0]).toMatchObject({ origin: 'UIO', destination: 'GYE', channel: 'WEB', passengerCount: 3, refundTotal: null });
    expect(page.nextCursor).not.toBeNull();
  });
  it('sin más páginas no hay cursor', async () => expect((await service.list({ ownerId: OWNER }, {}, 10)).nextCursor).toBeNull());
});

// ------------------------------------------------------------------------------------------------ fallar y emitir
describe('fail: pago fallido o compensación', () => {
  it('pasa a FAILED, marca los boletos, libera documentos y la referencia de esta reserva', async () => {
    tx.booking.mockResolvedValue(reserva({ status: 'TICKET_ISSUING' }));
    tx.payment.mockResolvedValue(pago({ bookingId: 'b-1' }));
    await service.fail('b-1', 'PAYMENT_DECLINED', 'tarjeta rechazada');
    const saved = tx.saveBooking.mock.calls[0][0] as BookingRecord;
    expect(saved).toMatchObject({ status: 'FAILED', failure: { errorCode: 'PAYMENT_DECLINED', reason: 'tarjeta rechazada' } });
    expect(saved.tickets.every((t) => t.status === 'FAILED')).toBe(true);
    expect(tx.releaseDocuments).toHaveBeenCalledWith('b-1');
    expect(tx.deletePayment).toHaveBeenCalledWith('pay_123456');
  });
  it('no borra una referencia que pertenece a otra reserva', async () => {
    tx.booking.mockResolvedValue(reserva({ status: 'TICKET_ISSUING' }));
    tx.payment.mockResolvedValue(pago({ bookingId: 'otra' }));
    await service.fail('b-1', 'X');
    expect(tx.deletePayment).not.toHaveBeenCalled();
  });
  it('ya FAILED: no vuelve a guardar (idempotente)', async () => {
    tx.booking.mockResolvedValue(reserva({ status: 'FAILED' }));
    await service.fail('b-1', 'X');
    expect(tx.saveBooking).not.toHaveBeenCalled();
  });
  it('una cancelada → ALREADY_CANCELLED; una confirmada → BOOKING_NOT_CANCELLABLE', async () => {
    tx.booking.mockResolvedValue(reserva({ status: 'CANCELLED' }));
    expect(await codeOf(service.fail('b-1', 'X'))).toBe('ALREADY_CANCELLED');
    tx.booking.mockResolvedValue(reserva());
    expect(await codeOf(service.fail('b-1', 'X'))).toBe('BOOKING_NOT_CANCELLABLE');
  });
});

describe('issueTickets', () => {
  it('emite los pendientes y la reserva pasa a CONFIRMED', async () => {
    tx.booking.mockResolvedValue(reserva({ status: 'TICKET_ISSUING', tickets: pendingTickets(reserva()) }));
    const result = await service.issueTickets('b-1', {});
    expect(result.issued).toBe(3);
    expect(tx.saveBooking).toHaveBeenCalledWith(expect.objectContaining({ status: 'CONFIRMED' }));
  });
  it('si ya estaban emitidos no guarda nada (issued 0)', async () => {
    tx.booking.mockResolvedValue(reserva());
    expect((await service.issueTickets('b-1', {})).issued).toBe(0);
    expect(tx.saveBooking).not.toHaveBeenCalled();
  });
  it('una reserva fallida no emite → BOOKING_NOT_CONFIRMED', async () => {
    tx.booking.mockResolvedValue(reserva({ status: 'FAILED' }));
    expect(await codeOf(service.issueTickets('b-1', {}))).toBe('BOOKING_NOT_CONFIRMED');
  });
  it('un boleto que no existe → 404', async () => {
    tx.booking.mockResolvedValue(reserva());
    expect(await codeOf(service.ticket('b-1', 'TKT-NO', {}))).toBe('NOT_FOUND');
  });
});

// ------------------------------------------------------------------------------------------------ asientos
describe('asientos', () => {
  beforeEach(() => tx.booking.mockResolvedValue(reserva()));
  const cambio = (over = {}) => ({ passengerId: 'P1', segmentId: 'EA100-20261210', seatNumber: '7F', ...over });

  it('el plan dice el asiento anterior, el nuevo y que queda TICKETED (boletos emitidos)', async () =>
    expect((await service.planSeats('b-1', [cambio()], {})).changes[0]).toMatchObject({ previousSeatNumber: '3C', seatNumber: '7F', cabinClass: 'ECONOMY', targetStatus: 'TICKETED' }));
  it('planificar no guarda nada', async () => {
    await service.planSeats('b-1', [cambio()], {});
    expect(tx.saveBooking).not.toHaveBeenCalled();
  });
  it('un infante no tiene asiento', async () => expect(await codeOf(service.planSeats('b-1', [cambio({ passengerId: 'I1' })], {}))).toBe('INFANT_SEAT_NOT_ALLOWED'));
  it('dos asientos para el mismo pasajero y vuelo', async () => expect(await codeOf(service.planSeats('b-1', [cambio(), cambio({ seatNumber: '8F' })], {}))).toBe('VALIDATION_FAILED'));
  it('un vuelo que ya salió', async () => {
    service.now = () => Date.parse('2026-12-10T13:00:00Z');
    expect(await codeOf(service.planSeats('b-1', [cambio()], {}))).toBe('FLIGHT_ALREADY_DEPARTED');
  });
  it('el cliente no cambia el asiento de un pasajero con check-in → CUTOFF_PASSED', async () => {
    tx.booking.mockResolvedValue(reserva({ checkedIn: [{ segmentId: 'EA100-20261210', passengerId: 'P1' }] }));
    expect(await codeOf(service.applySeats('b-1', { reason: 'CUSTOMER_CHANGE', seats: [cambio()] }, {}))).toBe('CUTOFF_PASSED');
  });
  it('el check-in automático guarda el asiento, marca el check-in y reemite el cupón', async () => {
    const result = await service.applySeats('b-1', { reason: 'CHECK_IN_AUTO', seats: [cambio()] }, {});
    expect(result.seats[0].status).toBe('CHECKED_IN');
    const saved = tx.saveBooking.mock.calls[0][0] as BookingRecord;
    expect(saved.checkedIn).toEqual([{ segmentId: 'EA100-20261210', passengerId: 'P1' }]);
    expect(saved.tickets[0].segments[0].seatNumber).toBe('7F');
  });
  it('con pago, la referencia debe estar registrada para asientos', async () => {
    tx.payment.mockResolvedValue(pago({ operation: 'BAGGAGE' }));
    expect(await codeOf(service.applySeats('b-1', { reason: 'CUSTOMER_CHANGE', seats: [cambio()], paymentReference: 'pay_123456' }, {}))).toBe('PAYMENT_REFERENCE_INVALID');
  });
});

// ------------------------------------------------------------------------------------------------ postventa
describe('applyBaggage', () => {
  const maletas = (over = {}) => ({ passengerId: 'P1', itineraryId: 'IDA', quantity: 2, amountCharged: { currency: 'USD', total: '70.00' }, paymentReference: 'pay_bags', ...over });
  beforeEach(() => {
    tx.booking.mockResolvedValue(reserva());
    tx.payment.mockResolvedValue(pago({ paymentReference: 'pay_bags', operation: 'BAGGAGE' }));
  });
  it('suma las maletas, une el pago y deja constancia en el historial', async () => {
    expect(await service.applyBaggage('b-1', maletas(), {})).toEqual({ passengerId: 'P1', itineraryId: 'IDA', totalBaggage: 2 });
    expect(tx.savePayment).toHaveBeenCalledWith(expect.objectContaining({ bookingId: 'b-1' }));
    expect((tx.saveBooking.mock.calls[0][0] as BookingRecord).changes.at(-1)!.description).toContain('2 maleta(s) extra (70.00 USD)');
  });
  it('más de 3 en total → VALIDATION_FAILED, sin guardar', async () => {
    tx.booking.mockResolvedValue(reserva({ passengers: [pasajero({ extraBaggage: [{ itineraryId: 'IDA', quantity: 2 }] })] }));
    expect(await codeOf(service.applyBaggage('b-1', maletas(), {}))).toBe('VALIDATION_FAILED');
    expect(tx.saveBooking).not.toHaveBeenCalled();
  });
  it('un infante no lleva maletas', async () => expect(await codeOf(service.applyBaggage('b-1', maletas({ passengerId: 'I1' }), {}))).toBe('VALIDATION_FAILED'));
  it('después del check-in las maletas ya no se bloquean (D56, 12/11: revoca D55)', async () => {
    tx.booking.mockResolvedValue(reserva({ checkedIn: [{ segmentId: 'EA100-20261210', passengerId: 'P2' }] }));
    expect(await codeOf(service.applyBaggage('b-1', maletas(), {}))).not.toBe('CUTOFF_PASSED');
  });
  it('una reserva no confirmada → BOOKING_NOT_CONFIRMED', async () => {
    tx.booking.mockResolvedValue(reserva({ status: 'TICKET_ISSUING' }));
    expect(await codeOf(service.applyBaggage('b-1', maletas(), {}))).toBe('BOOKING_NOT_CONFIRMED');
  });
  it('un itinerario que ya salió → FLIGHT_ALREADY_DEPARTED', async () => {
    service.now = () => Date.parse('2026-12-12T00:00:00Z');
    expect(await codeOf(service.applyBaggage('b-1', maletas(), {}))).toBe('FLIGHT_ALREADY_DEPARTED');
  });
});

describe('applyCancellation', () => {
  const cancelar = (reasonCode = 'CUSTOMER_REQUEST', reason?: string) =>
    service.applyCancellation('b-1', { reasonCode, reason, refund: { refundId: 'r-1', amount: '27.00', penaltyAmount: '100.00', currency: 'USD', status: 'SETTLED' }, seatsReleased: 2 }, {});
  beforeEach(() => tx.booking.mockResolvedValue(reserva()));

  it('anula los boletos, guarda el reembolso con la referencia original y libera los documentos', async () => {
    const result = await cancelar('CUSTOMER_REQUEST', 'cambio de planes');
    expect(result).toMatchObject({ status: 'CANCELLED', ticketsVoided: expect.any(Array), refund: { originalPaymentReference: 'pay_123456' }, message: 'Reembolso de 27.00 USD acreditado.' });
    const saved = tx.saveBooking.mock.calls[0][0] as BookingRecord;
    expect(saved.tickets.every((t) => t.status === 'VOIDED')).toBe(true);
    expect(saved.changes.at(-1)!.description).toBe('Reserva cancelada a pedido del cliente: «cambio de planes».');
    expect(tx.releaseDocuments).toHaveBeenCalledWith('b-1');
  });
  it('ya cancelada → ALREADY_CANCELLED sin guardar', async () => {
    tx.booking.mockResolvedValue(reserva({ status: 'CANCELLED' }));
    expect(await codeOf(cancelar())).toBe('ALREADY_CANCELLED');
    expect(tx.saveBooking).not.toHaveBeenCalled();
  });
  it('una reserva fallida no se cancela', async () => {
    tx.booking.mockResolvedValue(reserva({ status: 'FAILED' }));
    expect(await codeOf(cancelar())).toBe('BOOKING_NOT_CANCELLABLE');
  });
  it('con check-in, el cliente SÍ cancela (D56, 12/11: revoca D55)', async () => {
    tx.booking.mockResolvedValue(reserva({ checkedIn: [{ segmentId: 'EA100-20261210', passengerId: 'P1' }] }));
    expect((await cancelar()).status).toBe('CANCELLED');
  });
  it('con check-in, la aerolínea sí cancela si el vuelo se cancela', async () => {
    tx.booking.mockResolvedValue(reserva({ checkedIn: [{ segmentId: 'EA100-20261210', passengerId: 'P1' }] }));
    expect((await cancelar('FLIGHT_CANCELLED')).status).toBe('CANCELLED');
  });
});

// ------------------------------------------------------------------------------------------------ indicadores
describe('summary y salesReport: ingresos = cobrado − reembolsado', () => {
  it('una cancelada aporta lo que retuvo; una fallida no cuenta', async () => {
    tx.bookingsCreatedBetween.mockResolvedValue([
      reserva({ bookingId: 'v', grandTotal: { currency: 'USD', baseFare: '100.00', taxes: '27.00', total: '127.00' } }),
      reserva({ bookingId: 'c', status: 'CANCELLED', refunds: [{ refundId: 'r', amount: '27.00', penaltyAmount: '100.00', currency: 'USD', status: 'SETTLED' }] }),
      reserva({ bookingId: 'f', status: 'FAILED' }),
    ]);
    const summary = await service.summary();
    expect(summary.revenue.total).toBe('227.00'); // 127 + (127 − 27); la fallida no se cobró
    expect(summary.totalBookings).toBe(3);
    expect(summary.byStatus).toEqual({ CONFIRMED: 1, CANCELLED: 1, FAILED: 1 });
  });
  it('lo cobrado es la suma de las referencias de pago registradas (reserva + maletas)', async () => {
    tx.bookingsCreatedBetween.mockResolvedValue([reserva()]);
    tx.paymentsOf.mockResolvedValue([pago(), pago({ paymentReference: 'pay_bags', operation: 'BAGGAGE', amount: { currency: 'USD', total: '70.00' } })]);
    expect((await service.summary()).revenue.total).toBe('197.00');
  });
  it('salesReport rechaza un rango al revés o de más de un año', async () => {
    expect(await codeOf(service.salesReport('2026-11-12', '2026-11-11'))).toBe('VALIDATION_FAILED');
    expect(await codeOf(service.salesReport('2025-01-01', '2026-11-11'))).toBe('VALIDATION_FAILED');
  });
  it('salesReport cuenta el día en hora de Ecuador: 03:00 UTC del 12 es todavía el 11', async () => {
    tx.bookingsCreatedBetween.mockResolvedValue([reserva({ createdAt: '2026-11-12T03:00:00.000Z' }), reserva({ bookingId: 'b-2', createdAt: '2026-11-12T06:00:00.000Z' })]);
    const report = await service.salesReport('2026-11-11', '2026-11-11');
    expect(report.totals.bookings).toBe(1);
    expect(report.byDay).toEqual([{ date: '2026-11-11', channel: 'WEB', bookings: 1, charged: '127.00' }]);
  });
  it('salesReport: la liquidación con Booking separa lo del canal BOOKING', async () => {
    tx.bookingsCreatedBetween.mockResolvedValue([reserva(), reserva({ bookingId: 'b-2', channel: 'BOOKING', partnerId: 'BOOKING_PROTOTIPO' })]);
    const report = await service.salesReport('2026-11-11', '2026-11-11');
    expect(report.bookingSettlement).toMatchObject({ bookings: 1, charged: '127.00', net: '127.00' });
    expect(report.totals.charged).toBe('254.00');
  });
});

// ------------------------------------------------------------------------------------------------ asistencia
describe('asistencia', () => {
  beforeEach(() => tx.booking.mockResolvedValue(reserva()));
  it('pedirla la deja REQUESTED', async () => expect((await service.saveAssistance('b-1', 'P2', { type: 'WCHR' }, { ownerId: OWNER })).status).toBe('REQUESTED'));
  it('guardar el mismo tipo conserva READY; cambiar de tipo vuelve a REQUESTED', async () => {
    tx.assistance.mockResolvedValue([{ bookingId: 'b-1', passengerId: 'P2', type: 'WCHR', needsCompanion: false, status: 'READY', updatedAt: 'x' }]);
    expect((await service.saveAssistance('b-1', 'P2', { type: 'WCHR' }, { ownerId: OWNER })).status).toBe('READY');
    expect((await service.saveAssistance('b-1', 'P2', { type: 'BLND' }, { ownerId: OWNER })).status).toBe('REQUESTED');
  });
  it('después del check-in del pasajero la asistencia SÍ se pide (D56, 12/11: revoca D55)', async () => {
    tx.booking.mockResolvedValue(reserva({ checkedIn: [{ segmentId: 'EA100-20261210', passengerId: 'P2' }] }));
    expect(await codeOf(service.saveAssistance('b-1', 'P2', { type: 'WCHR' }, { ownerId: OWNER }))).toBeUndefined();
  });
  it('un pasajero que no es de la reserva → 404', async () => expect(await codeOf(service.deleteAssistance('b-1', 'NADIE', { ownerId: OWNER }))).toBe('NOT_FOUND'));
  it('marcar lista una asistencia que no existe → 404', async () => expect(await codeOf(service.setAssistanceStatus('b-1', 'P1', 'READY'))).toBe('NOT_FOUND'));
});
