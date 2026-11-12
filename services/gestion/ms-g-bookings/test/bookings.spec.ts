import 'reflect-metadata';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JsonLogger, signJwt, verifyJwt } from '@ecoairlines/shared';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { BookingsModule, setupApp } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { isValidEcuadorianId } from '../src/domain/rules.js';

/** Pruebas de MS.G.Bookings (V2.6) contra contract/ms-g-bookings.openapi.yaml, con el almacén en memoria. */
const expectContract = contractValidator('ms-g-bookings.openapi.yaml');
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TOKEN_OPTIONS = { issuer: 'ecoairlines-identity', audience: 'ecoairlines' };
const ESB = signJwt({ sub: 'ECOAIRLINES_ESB', token_use: 'service', scope: 'ecoairlines:internal' }, privateKey, { ...TOKEN_OPTIONS, ttlSeconds: 600 }).token;
const ADMIN = '6b0f1c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const WEB_OWNER = '9d2c6a3e-1111-4222-8333-444455556666';
const PARTNER_OWNER = 'partner:BOOKING_PROTOTIPO:usr-4f9a2c';

/** Cédula ecuatoriana válida a partir de 9 dígitos (calcula el verificador). */
const cedula = (prefix: string) => `${prefix}${[...Array(10).keys()].find((digit) => isValidEcuadorianId(`${prefix}${digit}`))}`;
const day = (offset: number) => new Date(Date.now() - 5 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
const DAY = day(3);
const compact = (date: string) => date.replaceAll('-', '');

const itinerary = (flightNumber: string, origin: string, destination: string, date = DAY, dep = '07:00', arr = '07:50') => ({
  itineraryId: `${flightNumber}-${compact(date)}`,
  totalDurationMinutes: 50,
  stopsCount: 0,
  segments: [{ segmentId: `${flightNumber}-${compact(date)}`, flightNumber, departure: { iataCode: origin, at: `${date}T${dep}:00-05:00` }, arrival: { iataCode: destination, at: `${date}T${arr}:00-05:00` }, marketingCarrier: 'EA', operatingCarrier: 'EA', status: 'SCHEDULED' }],
  pricingOptions: [{
    cabinClass: 'ECONOMY', fareBrand: 'BROTE', availableSeats: 100,
    fareRules: { isRefundable: false, isChangeable: true },
    baggageAllowance: { personalItemIncluded: true, carryOnIncluded: 1, checkedBaggageIncluded: 1 },
    pricePerPassengerType: [{ passengerType: 'ADULT', price: { currency: 'USD', baseFare: '100.00', taxes: '19.50', total: '119.50' } }],
  }],
});
const fareOf = (it: Any, price = '119.50') => ({ itineraryId: it.itineraryId, cabinClass: 'ECONOMY', fareBrand: 'BROTE', segmentIds: [it.segments[0].segmentId], price: { currency: 'USD', baseFare: '100.00', taxes: '19.50', total: price }, isRefundable: false, isChangeable: true, changeFeeUsd: '50.00' });
const passenger = (id: string, overrides: Any = {}) => ({
  passengerId: id,
  passengerType: 'ADULT',
  firstName: 'María',
  lastName: 'Torres',
  documentType: 'NATIONAL_ID',
  documentNumber: cedula('171003406'),
  nationality: 'EC',
  documentExpiryDate: day(400),
  birthDate: '1990-05-14',
  gender: 'F',
  contact: { email: 'maria@ecoairlines.test', phone: '+593991234567' },
  ...overrides,
});

const UIO_GYE = itinerary('EA100', 'UIO', 'GYE');
const UIO_BOG = itinerary('EA102', 'UIO', 'BOG', DAY, '13:00', '14:25');

let app: NestExpressApplication;
const esb = (method: 'get' | 'post' | 'put' | 'delete', path: string, headers: Record<string, string> = {}) => {
  let call = request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${ESB}`);
  for (const [key, value] of Object.entries(headers)) call = call.set(key, value);
  return call;
};
const owner = (id = WEB_OWNER) => ({ 'X-Owner-Id': id });

/** Saga "Crear reserva" en Bookings: claim del pago → crear. */
async function book(opts: { passengers?: Any[]; itineraries?: Any[]; ownerId?: string; reference?: string; provider?: string; assistance?: Any[] } = {}) {
  const sagaId = randomUUID();
  const bookingId = randomUUID();
  const holdId = randomUUID();
  const itineraries = opts.itineraries ?? [UIO_GYE];
  const passengers = opts.passengers ?? [passenger('PAX-1')];
  const provider = opts.provider ?? (opts.ownerId?.startsWith('partner:') ? 'BOOKING_PROTOTIPO' : 'AIRLINE_DIRECT');
  const reference = opts.reference ?? (provider === 'BOOKING_PROTOTIPO' ? `PAY-BKP-${randomUUID().slice(0, 8).toUpperCase()}` : `pi_${randomUUID().slice(0, 12)}`);
  const total = { currency: 'USD', baseFare: '100.00', taxes: '19.50', total: '119.50' };
  const claim = await esb('post', '/payment-references/claim').send({ sagaId, paymentReference: reference, provider, operation: 'BOOKING', expectedAmount: total });
  const counts = { adults: passengers.filter((p) => p.passengerType === 'ADULT').length, infants: passengers.filter((p) => p.passengerType === 'INFANT').length };
  const created = await esb('post', '/bookings', owner(opts.ownerId)).send({
    bookingId, sagaId, holdId, offerId: itineraries.map((it) => it.itineraryId).join('~'), passengersBreakdown: counts, passengers, itineraries,
    fares: itineraries.map((it) => fareOf(it)), grandTotal: total, payment: { paymentReference: reference, provider },
    ...(opts.ownerId?.startsWith('partner:') ? { salesChannel: { partnerId: 'BOOKING_PROTOTIPO', partnerOrderId: 'ORD-1', promotionApplied: false } } : {}),
    ...(opts.assistance ? { assistance: opts.assistance } : {}),
  });
  return { claim, created, bookingId, sagaId, holdId, reference, body: { bookingId, sagaId, holdId, itineraries, passengers, counts, reference, provider, total } };
}

async function createApp(): Promise<NestExpressApplication> {
  const verifier = { verify: async (jwt: string) => verifyJwt(jwt, () => publicKey, TOKEN_OPTIONS) };
  const moduleRef = await Test.createTestingModule({ imports: [BookingsModule.register(loadConfig({ NODE_ENV: 'test' }), { verifier })] }).compile();
  const created = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  setupApp(created);
  await created.init();
  return created;
}

beforeAll(async () => {
  app = await createApp();
});
afterAll(() => app.close());

describe('validar pasajeros (paso de "Crear reserva")', () => {
  const validate = (passengers: Any[], segments: Any[] = [{ segmentId: UIO_GYE.segments[0].segmentId, flightNumber: 'EA100', departureAt: `${DAY}T07:00:00-05:00`, international: false }], breakdown: Any = { adults: passengers.filter((p) => p.passengerType === 'ADULT').length, infants: passengers.filter((p) => p.passengerType === 'INFANT').length }) =>
    esb('post', '/passengers/validate').send({ passengers, passengersBreakdown: breakdown, segments });

  it('pasajeros correctos → 200 { valid: true }', async () => {
    const response = await validate([passenger('PAX-1'), passenger('PAX-2', { passengerType: 'INFANT', associatedAdultId: 'PAX-1', documentNumber: cedula('171003407'), birthDate: day(-200) })]);
    expect(response.status).toBe(200);
    expectContract('post', '/passengers/validate', response);
    expect(response.body).toEqual({ valid: true });
  });

  it.each([
    ['cantidad distinta al hold', () => validate([passenger('PAX-1')], undefined, { adults: 2 }), 'PASSENGER_COUNT_MISMATCH'],
    ['infante sin adulto asociado', () => validate([passenger('PAX-1'), passenger('PAX-2', { passengerType: 'INFANT', documentNumber: cedula('171003407'), birthDate: day(-200) })]), 'INFANT_WITHOUT_ADULT'],
    ['documento vencido antes del vuelo', () => validate([passenger('PAX-1', { documentExpiryDate: day(1) })]), 'DOCUMENT_EXPIRED'],
    ['cédula en un vuelo internacional', () => validate([passenger('PAX-1')], [{ segmentId: UIO_BOG.segments[0].segmentId, flightNumber: 'EA102', departureAt: `${DAY}T13:00:00-05:00`, international: true }]), 'PASSPORT_REQUIRED_INTERNATIONAL'],
  ])('%s → 422 %s', async (_, run, code) => {
    const response = await run();
    expect(response.status).toBe(422);
    expect(response.body.code).toBe(code);
    expectContract('post', '/passengers/validate', response);
  });

  it('documento repetido en la reserva o cédula inválida → 400', async () => {
    expect((await validate([passenger('PAX-1'), passenger('PAX-2')], undefined, { adults: 2 })).status).toBe(400);
    const invalid = await validate([passenger('PAX-1', { documentNumber: '1710034060' === cedula('171003406') ? '1710034061' : '1710034060' })]);
    expect(invalid.status).toBe(400);
    expectContract('post', '/passengers/validate', invalid);
  });
});

describe('referencia de pago: uso único (D34)', () => {
  const total = { currency: 'USD', total: '119.50' };
  const claim = (body: Any) => esb('post', '/payment-references/claim').send({ sagaId: randomUUID(), provider: 'BOOKING_PROTOTIPO', operation: 'BOOKING', expectedAmount: total, ...body });

  it('Booking: formato PAY-… (BKG-02) y monto igual al esperado', async () => {
    const bad = await claim({ paymentReference: 'pago-123' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('PAYMENT_REFERENCE_INVALID');
    expectContract('post', '/payment-references/claim', bad);
    const mismatch = await claim({ paymentReference: 'PAY-BKP-MISMATCH', amount: { currency: 'USD', total: '100.00' } });
    expect(mismatch.body.code).toBe('AMOUNT_MISMATCH');
  });

  it('una referencia repetida se rechaza; el reintento de la MISMA saga devuelve el registro', async () => {
    const sagaId = randomUUID();
    const first = await claim({ sagaId, paymentReference: 'PAY-BKP-20261023-000981', amount: total });
    expect(first.status).toBe(201);
    expectContract('post', '/payment-references/claim', first);
    const retry = await claim({ sagaId, paymentReference: 'PAY-BKP-20261023-000981', amount: total });
    expect(retry.status).toBe(200);
    expect(retry.body.claimedAt).toBe(first.body.claimedAt);
    const other = await claim({ paymentReference: 'PAY-BKP-20261023-000981', amount: total });
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('PAYMENT_REFERENCE_INVALID');
  });

  it('dos sagas a la vez con la misma referencia: una sola la registra', async () => {
    const results = await Promise.all([1, 2, 3].map(() => claim({ paymentReference: 'PAY-BKP-CONCURRENTE-1' })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 422, 422]);
  });
});

describe('crear y consultar reservas', () => {
  it('crea en TICKET_ISSUING con PNR, canal y boletos pendientes; el reintento devuelve la misma', async () => {
    const { created, body } = await book({ ownerId: PARTNER_OWNER });
    expect(created.status).toBe(201);
    expectContract('post', '/bookings', created);
    expect(created.headers['location']).toBe(`/bookings/${body.bookingId}`);
    expect(created.body).toMatchObject({ status: 'TICKET_ISSUING', channel: 'BOOKING', ownerId: PARTNER_OWNER, paymentReference: body.reference });
    expect(created.body.pnr).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(created.body.tickets[0]).toMatchObject({ status: 'PENDING', eTicketNumber: null });
    const retry = await esb('post', '/bookings', owner(PARTNER_OWNER)).send({
      bookingId: body.bookingId, sagaId: body.sagaId, holdId: body.holdId, offerId: UIO_GYE.itineraryId, passengersBreakdown: body.counts, passengers: body.passengers,
      itineraries: body.itineraries, fares: [fareOf(UIO_GYE)], grandTotal: body.total, payment: { paymentReference: body.reference, provider: body.provider },
    });
    expect(retry.status).toBe(200);
    expect(retry.body.pnr).toBe(created.body.pnr);
  });

  it('sin referencia registrada → 422; mismo bookingId con otro hold → 409 BOOKING_ID_CONFLICT; mismo hold → HOLD_ALREADY_CONSUMED', async () => {
    const { body } = await book({ passengers: [passenger('PAX-1', { documentNumber: cedula('171003408') })] });
    const send = (changes: Any) =>
      esb('post', '/bookings', owner()).send({
        bookingId: body.bookingId, sagaId: body.sagaId, holdId: body.holdId, offerId: UIO_GYE.itineraryId, passengersBreakdown: body.counts, passengers: body.passengers,
        itineraries: body.itineraries, fares: [fareOf(UIO_GYE)], grandTotal: body.total, payment: { paymentReference: body.reference, provider: body.provider }, ...changes,
      });
    const conflict = await send({ holdId: randomUUID() });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('BOOKING_ID_CONFLICT');
    expectContract('post', '/bookings', conflict);
    expect((await send({ bookingId: randomUUID() })).body.code).toBe('HOLD_ALREADY_CONSUMED');
    const unclaimed = await send({ bookingId: randomUUID(), holdId: randomUUID(), payment: { paymentReference: 'pi_sin_registrar', provider: 'AIRLINE_DIRECT' } });
    expect(unclaimed.body.code).toBe('PAYMENT_REFERENCE_INVALID');
  });

  it('el mismo documento no viaja dos veces en un vuelo (otra reserva → PASSENGER_ALREADY_ON_FLIGHT)', async () => {
    const doc = cedula('171003409');
    expect((await book({ passengers: [passenger('PAX-1', { documentNumber: doc })] })).created.status).toBe(201);
    const second = await book({ passengers: [passenger('PAX-1', { documentNumber: doc })] });
    expect(second.created.status).toBe(422);
    expect(second.created.body.code).toBe('PASSENGER_ALREADY_ON_FLIGHT');
    const validate = await esb('post', '/passengers/validate').send({ passengers: [passenger('PAX-1', { documentNumber: doc })], passengersBreakdown: { adults: 1 }, segments: [{ segmentId: UIO_GYE.segments[0].segmentId, flightNumber: 'EA100', departureAt: `${DAY}T07:00:00-05:00`, international: false }] });
    expect(validate.body.code).toBe('PASSENGER_ALREADY_ON_FLIGHT');
  });

  it('de otro dueño → 404 (nunca 403); la asistencia solo la ve el dueño o el administrador', async () => {
    const { bookingId } = await book({ passengers: [passenger('PAX-1', { documentNumber: cedula('171003410') })], assistance: [{ passengerId: 'PAX-1', type: 'WCHR', needsCompanion: true }] });
    const other = await esb('get', `/bookings/${bookingId}`, owner('11111111-2222-4333-8444-555555555555'));
    expect(other.status).toBe(404);
    expectContract('get', '/bookings/{bookingId}', other);
    const mine = await esb('get', `/bookings/${bookingId}`, owner());
    expectContract('get', '/bookings/{bookingId}', mine);
    expect(mine.body.assistance).toEqual([expect.objectContaining({ passengerId: 'PAX-1', type: 'WCHR', status: 'REQUESTED' })]);
    const saga = await esb('get', `/bookings/${bookingId}`);
    expect(saga.body).not.toHaveProperty('assistance');
  });

  it('listado: exige dueño o administrador; filtra por dueño y, para el administrador, por canal', async () => {
    expect((await esb('get', '/bookings')).status).toBe(400);
    const mine = await esb('get', '/bookings?limit=50', owner());
    expectContract('get', '/bookings', mine);
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items[0]).toMatchObject({ origin: 'UIO', destination: 'GYE', departureDate: DAY });
    const partner = await esb('get', '/bookings?channel=BOOKING&limit=50', { 'X-Actor-Id': ADMIN });
    expect(partner.body.items.length).toBe(1);
  });

  it('panel (O-1): el administrador busca por PNR, orden de Booking o referencia de pago y ve canal, salida y pasajeros', async () => {
    const { bookingId, reference } = await book({ ownerId: 'partner:BOOKING_PROTOTIPO:usr-panel', passengers: [passenger('PAX-1', { documentNumber: cedula('171003420') })] });
    const pnr = (await esb('get', `/bookings/${bookingId}`, { 'X-Actor-Id': ADMIN })).body.pnr as string;
    for (const value of [pnr, pnr.toLowerCase(), reference]) {
      const found = await esb('get', `/bookings?reference=${encodeURIComponent(value)}`, { 'X-Actor-Id': ADMIN });
      expectContract('get', '/bookings', found);
      expect(found.body.items.map((item: Any) => item.bookingId)).toEqual([bookingId]);
    }
    const byOrder = await esb('get', '/bookings?reference=ORD-1&channel=BOOKING', { 'X-Actor-Id': ADMIN });
    expect(byOrder.body.items.map((item: Any) => item.bookingId)).toContain(bookingId);
    expect(byOrder.body.items.find((item: Any) => item.bookingId === bookingId)).toMatchObject({
      channel: 'BOOKING', partnerId: 'BOOKING_PROTOTIPO', partnerOrderId: 'ORD-1', passengerCount: 1, refundTotal: null, departureAt: `${DAY}T07:00:00-05:00`,
    });
    // El dueño no busca por referencia (se ignora) ni recibe los campos del panel.
    const mine = await esb('get', `/bookings?reference=${reference}&limit=50`, owner());
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items.every((item: Any) => item.bookingId !== bookingId && item.channel === undefined)).toBe(true);
  });

  it('panel (O-1): el detalle trae los pagos registrados solo para el administrador', async () => {
    const { bookingId, reference } = await book({ passengers: [passenger('PAX-1', { documentNumber: cedula('171003421') })] });
    const admin = await esb('get', `/bookings/${bookingId}`, { 'X-Actor-Id': ADMIN });
    expectContract('get', '/bookings/{bookingId}', admin);
    expect(admin.body.payments).toEqual([expect.objectContaining({ paymentReference: reference, provider: 'AIRLINE_DIRECT', operation: 'BOOKING', bookingId })]);
    expect((await esb('get', `/bookings/${bookingId}`, owner())).body).not.toHaveProperty('payments');
  });
});

describe('emisión de boletos y estados', () => {
  it('emitir: un boleto por pasajero con cupón por segmento → CONFIRMED; repetir → issued: 0', async () => {
    const { bookingId } = await book({ passengers: [passenger('PAX-1', { documentNumber: cedula('171003411'), assignedSeats: [{ segmentId: UIO_GYE.segments[0].segmentId, seatNumber: '12A' }] })] });
    const issued = await esb('post', `/bookings/${bookingId}/tickets`);
    expect(issued.status).toBe(200);
    expectContract('post', '/bookings/{bookingId}/tickets', issued);
    expect(issued.body).toMatchObject({ status: 'CONFIRMED', issued: 1 });
    expect(issued.body.tickets[0]).toMatchObject({ status: 'ISSUED', eTicketNumber: expect.stringMatching(/^999\d{10}$/) });
    expect(issued.body.tickets[0].segments[0]).toMatchObject({ couponNumber: '1', flightNumber: 'EA100', seatNumber: '12A', status: 'ISSUED' });
    const again = await esb('post', `/bookings/${bookingId}/tickets`);
    expect(again.body.issued).toBe(0);
    expect(again.body.tickets[0].eTicketNumber).toBe(issued.body.tickets[0].eTicketNumber);
    const list = await esb('get', `/bookings/${bookingId}/tickets`);
    expectContract('get', '/bookings/{bookingId}/tickets', list);
    const one = await esb('get', `/bookings/${bookingId}/tickets/${issued.body.tickets[0].ticketId}`);
    expectContract('get', '/bookings/{bookingId}/tickets/{ticketId}', one);
    const confirmedFail = await esb('post', `/bookings/${bookingId}/fail`).send({ errorCode: 'SAGA_COMPENSATED' });
    expect(confirmedFail.status).toBe(409);
    expectContract('post', '/bookings/{bookingId}/fail', confirmedFail);
  });

  it('pago fallido → FAILED: libera la referencia y los documentos; luego no se emite (BOOKING_NOT_CONFIRMED)', async () => {
    const doc = cedula('171003412');
    const { bookingId, reference } = await book({ passengers: [passenger('PAX-1', { documentNumber: doc })] });
    const failed = await esb('post', `/bookings/${bookingId}/fail`).send({ errorCode: 'PAYMENT_NOT_AUTHORIZED', reason: 'Fondos insuficientes' });
    expect(failed.status).toBe(200);
    expectContract('post', '/bookings/{bookingId}/fail', failed);
    expect(failed.body.status).toBe('FAILED');
    expect((await esb('post', `/bookings/${bookingId}/fail`).send({ errorCode: 'PAYMENT_NOT_AUTHORIZED' })).status).toBe(200);
    const issue = await esb('post', `/bookings/${bookingId}/tickets`);
    expect(issue.body.code).toBe('BOOKING_NOT_CONFIRMED');
    expectContract('post', '/bookings/{bookingId}/tickets', issue);
    // La referencia y el documento quedaron libres: se puede reintentar la compra.
    expect((await book({ passengers: [passenger('PAX-1', { documentNumber: doc })], reference })).created.status).toBe(201);
  });

  it('compensación: liberar una referencia; si ya está en una reserva confirmada → 409', async () => {
    const { bookingId, sagaId, reference } = await book({ passengers: [passenger('PAX-1', { documentNumber: cedula('171003413') })] });
    await esb('post', `/bookings/${bookingId}/tickets`);
    const blocked = await esb('delete', `/payment-references/${reference}?sagaId=${sagaId}`);
    expect(blocked.status).toBe(409);
    expectContract('delete', '/payment-references/{paymentReference}', blocked);
    const loose = await esb('post', '/payment-references/claim').send({ sagaId, paymentReference: 'pi_suelta_000001', provider: 'AIRLINE_DIRECT', operation: 'SEATS', expectedAmount: { currency: 'USD', total: '10.00' } });
    expect(loose.status).toBe(201);
    expect((await esb('delete', `/payment-references/pi_suelta_000001?sagaId=${sagaId}`)).status).toBe(204);
    expect((await esb('delete', `/payment-references/pi_suelta_000001?sagaId=${sagaId}`)).status).toBe(204);
  });
});

describe('asientos, check-in y asistencia', () => {
  let bookingId: string;
  const segmentId = UIO_GYE.segments[0].segmentId;

  beforeAll(async () => {
    ({ bookingId } = await book({
      passengers: [passenger('PAX-1', { documentNumber: cedula('171003414') }), passenger('PAX-2', { passengerType: 'INFANT', associatedAdultId: 'PAX-1', documentNumber: cedula('171003415'), birthDate: day(-200) })],
    }));
    await esb('post', `/bookings/${bookingId}/tickets`);
  });

  it('plan de cambio: asiento anterior, cabina comprada y estado destino; infante → 422', async () => {
    const plan = await esb('post', `/bookings/${bookingId}/seats/plan`).send({ seats: [{ passengerId: 'PAX-1', segmentId, seatNumber: '14C' }] });
    expect(plan.status).toBe(200);
    expectContract('post', '/bookings/{bookingId}/seats/plan', plan);
    expect(plan.body.changes[0]).toMatchObject({ previousSeatNumber: null, cabinClass: 'ECONOMY', targetStatus: 'TICKETED' });
    const infant = await esb('post', `/bookings/${bookingId}/seats/plan`).send({ seats: [{ passengerId: 'PAX-2', segmentId, seatNumber: '14D' }] });
    expect(infant.status).toBe(422);
    expect(infant.body.code).toBe('INFANT_SEAT_NOT_ALLOWED');
    expectContract('post', '/bookings/{bookingId}/seats/plan', infant);
  });

  it('cambio pedido por el cliente con su pago; los cupones se reemiten con el asiento nuevo', async () => {
    await esb('post', '/payment-references/claim').send({ sagaId: randomUUID(), paymentReference: 'pi_asiento_00001', provider: 'AIRLINE_DIRECT', operation: 'SEATS', expectedAmount: { currency: 'USD', total: '15.00' } });
    const applied = await esb('put', `/bookings/${bookingId}/seats`).send({ reason: 'CUSTOMER_CHANGE', seats: [{ passengerId: 'PAX-1', segmentId, seatNumber: '14C' }], amountCharged: { currency: 'USD', total: '15.00' }, paymentReference: 'pi_asiento_00001' });
    expect(applied.status).toBe(200);
    expectContract('put', '/bookings/{bookingId}/seats', applied);
    expect(applied.body.seats[0]).toMatchObject({ seatNumber: '14C', previousSeatNumber: null, status: 'TICKETED' });
    const tickets = (await esb('get', `/bookings/${bookingId}/tickets`)).body.tickets;
    expect(tickets[0].segments[0].seatNumber).toBe('14C');
  });

  it('asistencia: pedir, ver y marcar READY (administrador)', async () => {
    const saved = await esb('put', `/bookings/${bookingId}/passengers/PAX-1/assistance`, owner()).send({ type: 'WCHS', notes: 'Prótesis de cadera' });
    expect(saved.status).toBe(200);
    expectContract('put', '/bookings/{bookingId}/passengers/{passengerId}/assistance', saved);
    expect(saved.body).toMatchObject({ type: 'WCHS', status: 'REQUESTED', needsCompanion: false });
    const ready = await esb('put', `/bookings/${bookingId}/passengers/PAX-1/assistance/status`, { 'X-Actor-Id': ADMIN }).send({ status: 'READY' });
    expectContract('put', '/bookings/{bookingId}/passengers/{passengerId}/assistance/status', ready);
    expect(ready.body.status).toBe('READY');
    const list = await esb('get', `/flights/EA100/${DAY}/assistance`, { 'X-Actor-Id': ADMIN });
    expectContract('get', '/flights/{flightNumber}/{date}/assistance', list);
    expect(list.body.find((item: Any) => item.bookingId === bookingId)).toMatchObject({ passengerId: 'PAX-1', seatNumber: '14C', passengerName: 'María Torres', assistance: { type: 'WCHS' } });
    expect((await esb('get', `/flights/EA100/${DAY}/assistance`)).status).toBe(400);
  });

  it('check-in (CHECK_IN_AUTO) marca a los pasajeros: después no se cambia el asiento ni la asistencia (CUTOFF_PASSED)', async () => {
    const checkIn = await esb('put', `/bookings/${bookingId}/seats`).send({ reason: 'CHECK_IN_AUTO', seats: [{ passengerId: 'PAX-1', segmentId, seatNumber: '14C' }] });
    expect(checkIn.body.seats[0].status).toBe('CHECKED_IN');
    const plan = await esb('post', `/bookings/${bookingId}/seats/plan`).send({ seats: [{ passengerId: 'PAX-1', segmentId, seatNumber: '20A' }] });
    expect(plan.status).toBe(409);
    expect(plan.body.code).toBe('CUTOFF_PASSED');
    const assistance = await esb('put', `/bookings/${bookingId}/passengers/PAX-1/assistance`, owner()).send({ type: 'WCHR' });
    expect(assistance.status).toBe(409);
    expectContract('put', '/bookings/{bookingId}/passengers/{passengerId}/assistance', assistance);
  });
});

describe('postventa', () => {
  it('maletas extra con su pago (máximo 3 por pasajero e itinerario)', async () => {
    const { bookingId } = await book({ passengers: [passenger('PAX-1', { documentNumber: cedula('171003416') })] });
    await esb('post', `/bookings/${bookingId}/tickets`);
    await esb('post', '/payment-references/claim').send({ sagaId: randomUUID(), paymentReference: 'pi_maletas_00001', provider: 'AIRLINE_DIRECT', operation: 'BAGGAGE', expectedAmount: { currency: 'USD', total: '70.00' } });
    const added = await esb('post', `/bookings/${bookingId}/baggage`).send({ passengerId: 'PAX-1', itineraryId: UIO_GYE.itineraryId, quantity: 2, amountCharged: { currency: 'USD', total: '70.00' }, paymentReference: 'pi_maletas_00001' });
    expect(added.status).toBe(200);
    expectContract('post', '/bookings/{bookingId}/baggage', added);
    expect(added.body.totalBaggage).toBe(2);
    const fares = await esb('get', `/bookings/${bookingId}/fares`);
    expectContract('get', '/bookings/{bookingId}/fares', fares);
    expect(fares.body.baggage[0]).toMatchObject({ included: 1, purchased: 2 });
    expect(fares.body.unflownItineraryIds).toEqual([UIO_GYE.itineraryId]);
  });

  it('cambio de fecha: itinerario y tarifa nuevos, cupones reemitidos y documentos movidos al vuelo nuevo', async () => {
    const doc = cedula('171003417');
    const { bookingId } = await book({ passengers: [passenger('PAX-1', { documentNumber: doc })] });
    await esb('post', `/bookings/${bookingId}/tickets`);
    const next = itinerary('EA100', 'UIO', 'GYE', day(4));
    const changed = await esb('post', `/bookings/${bookingId}/date-change`).send({
      changeOfferId: 'CHG-1', replacedItineraryIds: [UIO_GYE.itineraryId], newItineraries: [next], newFares: [fareOf(next, '130.00')],
      priceDifference: { currency: 'USD', total: '60.50' }, paymentReference: null, assignedSeats: [{ passengerId: 'PAX-1', segmentId: next.segments[0].segmentId, seatNumber: '9F' }],
    });
    expect(changed.status).toBe(200);
    expectContract('post', '/bookings/{bookingId}/date-change', changed);
    expect(changed.body.itineraries.map((it: Any) => it.itineraryId)).toEqual([next.itineraryId]);
    expect(changed.body.tickets[0].segments[0]).toMatchObject({ segmentId: next.segments[0].segmentId, seatNumber: '9F', status: 'ISSUED' });
    // El vuelo original quedó libre para ese documento.
    expect((await book({ passengers: [passenger('PAX-1', { documentNumber: doc })] })).created.status).toBe(201);
  });

  it('cancelar: CANCELLED, boletos VOIDED, reembolso CALCULATED (canal Booking); repetir → ALREADY_CANCELLED con el resultado', async () => {
    const { bookingId } = await book({ ownerId: 'partner:BOOKING_PROTOTIPO:usr-otro', passengers: [passenger('PAX-1', { documentNumber: cedula('171003418') })] });
    await esb('post', `/bookings/${bookingId}/tickets`);
    const refund = { refundId: 'REF-VUE-3302', amount: '94.50', penaltyAmount: '25.00', currency: 'USD', percentage: 79, status: 'CALCULATED' };
    const cancelled = await esb('post', `/bookings/${bookingId}/cancellation`).send({ reasonCode: 'CUSTOMER_REQUEST', refund, seatsReleased: 1 });
    expect(cancelled.status).toBe(200);
    expectContract('post', '/bookings/{bookingId}/cancellation', cancelled);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', ticketsVoided: [expect.stringMatching(/^TKT-/)], inventoryRestoration: { status: 'RESTORED', seatsReleased: 1 }, refund: { status: 'CALCULATED' } });
    expect(cancelled.body.message).toContain('BOOKING_PROTOTIPO');
    const again = await esb('post', `/bookings/${bookingId}/cancellation`).send({ reasonCode: 'CUSTOMER_REQUEST', refund, seatsReleased: 1 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_CANCELLED');
    expect(JSON.parse(again.body.detail)).toMatchObject({ refund: { refundId: 'REF-VUE-3302' } });
    expectContract('post', '/bookings/{bookingId}/cancellation', again);
    expect((await esb('get', `/bookings/${bookingId}/tickets`)).body.tickets[0].status).toBe('VOIDED');
  });
});

describe('vuelos e indicadores', () => {
  it('reservas activas de un vuelo y totales del panel', async () => {
    const flight = await esb('get', `/flights/EA100/${DAY}/bookings`);
    expectContract('get', '/flights/{flightNumber}/{date}/bookings', flight);
    expect(flight.body.total).toBeGreaterThan(0);
    expect(flight.body.items.every((item: Any) => !['CANCELLED', 'FAILED'].includes(item.status))).toBe(true);
    const summary = await esb('get', '/indicators', { 'X-Actor-Id': ADMIN });
    expectContract('get', '/indicators', summary);
    expect(summary.body.byChannel.BOOKING).toBeGreaterThanOrEqual(2);
    expect(Number(summary.body.refundsCalculated.total)).toBeCloseTo(94.5);
  });
});

describe('reporte de ventas y liquidación con Booking (panel O-3)', () => {
  it('★ cuadra: cada venta de Booking con cobrado − reembolsado = neto, y los totales igualan la suma por canal y por día', async () => {
    const { bookingId, reference } = await book({ ownerId: 'partner:BOOKING_PROTOTIPO:usr-reporte', passengers: [passenger('PAX-1', { documentNumber: cedula('171003422') })] });
    await esb('post', `/bookings/${bookingId}/tickets`);
    const refund = { refundId: 'REF-O3-1', amount: '94.50', penaltyAmount: '25.00', currency: 'USD', percentage: 79, status: 'CALCULATED' };
    await esb('post', `/bookings/${bookingId}/cancellation`).send({ reasonCode: 'CUSTOMER_REQUEST', refund, seatsReleased: 1 });
    const today = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

    const report = await esb('get', `/reports/sales?from=${today}&to=${today}`, { 'X-Actor-Id': ADMIN });
    expect(report.status).toBe(200);
    expectContract('get', '/reports/sales', report);
    const item = report.body.bookingSettlement.items.find((row: Any) => row.bookingId === bookingId);
    expect(item).toMatchObject({ paymentReference: reference, partnerOrderId: 'ORD-1', status: 'CANCELLED', charged: '119.50', refunded: '94.50', penalty: '25.00', net: '25.00' });

    const cents = (value: string) => Math.round(Number(value) * 100);
    const { totals, byChannel, byDay, bookingSettlement } = report.body;
    expect(byChannel.reduce((sum: number, row: Any) => sum + cents(row.charged), 0)).toBe(cents(totals.charged));
    expect(byChannel.reduce((sum: number, row: Any) => sum + row.bookings, 0)).toBe(totals.bookings);
    expect(byDay.reduce((sum: number, row: Any) => sum + cents(row.charged), 0)).toBe(cents(totals.charged));
    expect(cents(totals.net)).toBe(cents(totals.charged) - cents(totals.refunded));
    expect(bookingSettlement.items.reduce((sum: number, row: Any) => sum + cents(row.net), 0)).toBe(cents(bookingSettlement.net));
    expect(bookingSettlement.pendingRefunds.count).toBeGreaterThanOrEqual(1);
    expect(bookingSettlement.items.every((row: Any) => row.status !== 'FAILED')).toBe(true);
  });

  it('rango: obligatorio, desde ≤ hasta y máximo un año; solo el administrador', async () => {
    expect((await esb('get', '/reports/sales?from=2026-11-08', { 'X-Actor-Id': ADMIN })).status).toBe(400);
    expect((await esb('get', '/reports/sales?from=2026-11-09&to=2026-11-08', { 'X-Actor-Id': ADMIN })).status).toBe(400);
    expect((await esb('get', '/reports/sales?from=2025-01-01&to=2026-11-08', { 'X-Actor-Id': ADMIN })).status).toBe(400);
    expect((await esb('get', '/reports/sales?from=2026-11-01&to=2026-11-08')).status).toBe(400);
  });
});

describe('correcciones de la prueba de usuario (PLAN_Correccion C-2)', () => {
  const refund = (id: string) => ({ refundId: id, amount: '94.50', penaltyAmount: '25.00', currency: 'USD', percentage: 79, status: 'SETTLED' });

  it('★ error 6: el historial guarda el motivo que escribió el cliente, en español', async () => {
    const { bookingId } = await book({ passengers: [passenger('PAX-1', { documentNumber: cedula('171003430') })] });
    await esb('post', `/bookings/${bookingId}/tickets`);
    const cancelled = await esb('post', `/bookings/${bookingId}/cancellation`).send({ reasonCode: 'CUSTOMER_REQUEST', reason: 'Cambio de planes', refund: refund('REF-C2-1'), seatsReleased: 1 });
    expect(cancelled.status).toBe(200);
    const view = await esb('get', `/bookings/${bookingId}`, owner());
    expect(view.body.changes.at(-1).description).toBe('Reserva cancelada a pedido del cliente: «Cambio de planes».');
  });

  it('★ error 8 (D-C3): los ingresos suman lo cobrado − lo reembolsado: una cancelada aporta la penalidad retenida', async () => {
    const before = await esb('get', '/indicators', { 'X-Actor-Id': ADMIN });
    const { bookingId } = await book({ passengers: [passenger('PAX-1', { documentNumber: cedula('171003431') })] });
    await esb('post', `/bookings/${bookingId}/tickets`);
    const active = await esb('get', '/indicators', { 'X-Actor-Id': ADMIN });
    expectContract('get', '/indicators', active);
    const cents = (value: string) => Math.round(Number(value) * 100);
    expect(cents(active.body.revenue.total) - cents(before.body.revenue.total)).toBe(11950);
    await esb('post', `/bookings/${bookingId}/cancellation`).send({ reasonCode: 'CUSTOMER_REQUEST', refund: refund('REF-C2-2'), seatsReleased: 1 });
    const after = await esb('get', '/indicators', { 'X-Actor-Id': ADMIN });
    // 119,50 cobrados − 94,50 devueltos = 25,00 que se quedan (antes desaparecía todo al cancelar).
    expect(cents(after.body.revenue.total) - cents(before.body.revenue.total)).toBe(2500);
    expect(cents(after.body.revenue.baseFare) + cents(after.body.revenue.taxes)).toBe(cents(after.body.revenue.total));
  });

  it('★ D55: después del check-in no se agregan maletas, no se cambia la fecha ni se cancela a pedido del cliente; el vuelo cancelado sí', async () => {
    const { bookingId } = await book({ passengers: [passenger('PAX-1', { documentNumber: cedula('171003432') })] });
    await esb('post', `/bookings/${bookingId}/tickets`);
    const segmentId = UIO_GYE.segments[0].segmentId;
    await esb('put', `/bookings/${bookingId}/seats`).send({ reason: 'CHECK_IN_AUTO', seats: [{ passengerId: 'PAX-1', segmentId, seatNumber: '15C' }] });

    const baggage = await esb('post', `/bookings/${bookingId}/baggage`).send({ passengerId: 'PAX-1', itineraryId: UIO_GYE.itineraryId, quantity: 1, amountCharged: { currency: 'USD', total: '35.00' }, paymentReference: 'pi_maletas_c2_0001' });
    expect(baggage.status).toBe(409);
    expect(baggage.body.code).toBe('CUTOFF_PASSED');
    const next = itinerary('EA100', 'UIO', 'GYE', day(4));
    const dateChange = await esb('post', `/bookings/${bookingId}/date-change`).send({
      changeOfferId: 'CHG-C2', replacedItineraryIds: [UIO_GYE.itineraryId], newItineraries: [next], newFares: [fareOf(next, '130.00')], priceDifference: { currency: 'USD', total: '0.00' }, paymentReference: null,
    });
    expect(dateChange.body.code).toBe('CUTOFF_PASSED');
    const byCustomer = await esb('post', `/bookings/${bookingId}/cancellation`).send({ reasonCode: 'CUSTOMER_REQUEST', refund: refund('REF-C2-3'), seatsReleased: 1 });
    expect(byCustomer.body.code).toBe('CUTOFF_PASSED');
    const byFlight = await esb('post', `/bookings/${bookingId}/cancellation`).send({ reasonCode: 'FLIGHT_CANCELLED', refund: refund('REF-C2-4'), seatsReleased: 1 });
    expect(byFlight.status).toBe(200);
    const view = await esb('get', `/bookings/${bookingId}`, owner());
    expect(view.body.changes.at(-1).description).toBe('Reserva cancelada por cancelación del vuelo.');
  });
});

describe('la asistencia (dato de salud) no aparece en los logs', () => {
  it('con el log de peticiones y el logger JSON encendidos, ni el tipo ni las notas llegan a stdout/stderr', async () => {
    process.env['HTTP_REQUEST_LOG'] = 'true';
    const logged = await createApp();
    logged.useLogger(new JsonLogger('ms-g-bookings'));
    const lines: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => (lines.push(String(chunk)), true));
    process.stderr.write = ((chunk: unknown) => (lines.push(String(chunk)), true));
    try {
      const server = logged.getHttpServer();
      const call = (method: 'post' | 'put' | 'get', path: string) => request(server)[method](path).set('Authorization', `Bearer ${ESB}`);
      const sagaId = randomUUID();
      await call('post', '/payment-references/claim').send({ sagaId, paymentReference: 'pi_logs_000001', provider: 'AIRLINE_DIRECT', operation: 'BOOKING', expectedAmount: { currency: 'USD', total: '119.50' } });
      const bookingId = randomUUID();
      const secret = 'Cirugía de rodilla reciente';
      await call('post', '/bookings').set('X-Owner-Id', WEB_OWNER).send({
        bookingId, sagaId, holdId: randomUUID(), offerId: UIO_GYE.itineraryId, passengersBreakdown: { adults: 1 }, passengers: [passenger('PAX-1', { documentNumber: cedula('171003419') })],
        itineraries: [UIO_GYE], fares: [fareOf(UIO_GYE)], grandTotal: { currency: 'USD', total: '119.50' }, payment: { paymentReference: 'pi_logs_000001', provider: 'AIRLINE_DIRECT' },
        assistance: [{ passengerId: 'PAX-1', type: 'MEDA', notes: secret }],
      });
      await call('put', `/bookings/${bookingId}/passengers/PAX-1/assistance`).set('X-Owner-Id', WEB_OWNER).send({ type: 'MEDA', notes: secret });
      await call('put', `/bookings/${bookingId}/passengers/PAX-9/assistance`).send({ type: 'MEDA', notes: secret }); // 404
      await call('put', `/bookings/${bookingId}/passengers/PAX-1/assistance`).send({ type: 'MEDA', notes: secret, extra: 1 }); // 400
      await call('get', `/bookings/${bookingId}`).set('X-Owner-Id', WEB_OWNER);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
      delete process.env['HTTP_REQUEST_LOG'];
      await logged.close();
    }
    const log = lines.join('');
    expect(lines.filter((line) => line.includes('"type":"api_request"')).length).toBeGreaterThanOrEqual(5); // el log sí se escribió
    expect(log).not.toMatch(/rodilla|MEDA|WCH|needsCompanion/);
  });
});
