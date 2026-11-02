import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { createResponseApp, CUSTOMER_SUB, FakeEsb, newKey, PARTNER_ID, tokens } from '../../../../tests/support/response-service.js';
import { definition } from '../src/service.js';

/** MS.Reservas (V2.12) contra un ESB falso: holds, reservas, boletos, asientos, check-in, pases y asistencia. */
const expectContract = contractValidator('vuelos-openapi-v2.yaml');
const expectOwn = contractValidator('ms-reservas.openapi.yaml');
const esb = new FakeEsb();
let app: NestExpressApplication;
const http = () => request(app.getHttpServer());

const HOLD_ID = '19df841d-2ba8-4081-ac82-e9815d23847b';
const BOOKING_ID = '7bc123b6-ec50-4676-8b88-8f82a8c00ac7';
const SAGA_ID = 'b1c2d3e4-1111-4222-8333-944455556666';
const OWNER = `partner:${PARTNER_ID}:usr-1`;
const money = (total: string) => ({ currency: 'USD', baseFare: '59.00', taxes: '20.85', total });
const PROTO_HOLD = {
  holdId: HOLD_ID,
  status: 'HOLD_STATUS_HELD',
  expiresAt: '2026-10-26T01:42:21.305Z',
  ttlMinutes: 15,
  remainingSeconds: 899,
  lockedPrice: money('79.85'),
  offerId: 'EA100-20261106',
  channel: 'SALES_CHANNEL_BOOKING',
  passengersBreakdown: { adults: 1, youths: 0, children: 0, infants: 0 },
  selections: [],
  createdAt: '2026-10-26T01:27:21.305Z',
};
const HOLD_REQUEST = { offerId: 'EA100-20261106', itinerarySelections: [{ itineraryId: 'EA100-20261106', cabinClass: 'ECONOMY', fareBrand: 'SEMILLA' }], passengersBreakdown: { adults: 1 } };
const PASSENGER = {
  passengerId: 'PAX-1',
  passengerType: 'ADULT',
  firstName: 'Ana',
  lastName: 'Paz',
  documentType: 'NATIONAL_ID',
  documentNumber: '1710034065',
  nationality: 'EC',
  birthDate: '1990-05-02',
  gender: 'F',
  contact: { email: 'ana@ecoairlines.test', phone: '+593991112244' },
};
const BOOKING_REQUEST = { holdId: HOLD_ID, passengers: [PASSENGER], payment: { paymentReference: 'PAY-BKP-20261025-000001', amount: { currency: 'USD', total: '79.85' } } };
/** `BookingView` de MS.G.Bookings: el contrato v2 más los datos internos que el MS quita. */
const BOOKING_VIEW = {
  bookingId: BOOKING_ID,
  pnr: 'BKG001',
  status: 'CONFIRMED',
  grandTotal: money('79.85'),
  createdAt: '2026-10-25T19:20:20.813Z',
  holdId: HOLD_ID,
  paymentReference: 'PAY-BKP-20261025-000001',
  itineraries: [],
  passengers: [PASSENGER],
  tickets: [],
  ownerId: OWNER,
  channel: 'BOOKING',
  fares: [{ itineraryId: 'EA100-20261106', cabinClass: 'ECONOMY', fareBrand: 'SEMILLA' }],
  refunds: [],
  assistance: [{ passengerId: 'PAX-1', type: 'WCHR', needsCompanion: false, status: 'REQUESTED', updatedAt: '2026-10-25T19:20:20.813Z' }],
};

beforeAll(async () => {
  await esb.start();
  app = await createResponseApp(definition(), esb, { RATE_LIMIT_LIMIT: '1000' });
});
afterAll(async () => {
  await app.close();
  await esb.stop();
});
beforeEach(() => esb.reset());

const asPartner = (call: request.Test, userId = 'usr-1') => call.set('Authorization', tokens.partner()).set('X-User-Id', userId);

describe('holds (Offers por el ESB)', () => {
  it('201 con Location y _links; el dueño viaja en la cabecera Y en el mensaje (Offers prefiere el del mensaje)', async () => {
    esb.on('POST', '/router/offers/CreateHold', { body: { hold: PROTO_HOLD } });
    const response = await asPartner(http().post('/api/v2/vuelos/offers/hold').set('Idempotency-Key', newKey())).send(HOLD_REQUEST).expect(201);
    expectContract('post', '/vuelos/offers/hold', response);
    expect(response.headers['location']).toBe(`/api/v2/vuelos/offers/hold/${HOLD_ID}`);
    expect(response.body).toEqual({ holdId: HOLD_ID, status: 'HELD', expiresAt: PROTO_HOLD.expiresAt, ttlMinutes: 15, lockedPrice: money('79.85'), _links: expect.objectContaining({ self: { href: `/api/v2/vuelos/offers/hold/${HOLD_ID}`, method: 'GET' } }) });
    const call = esb.last()!;
    expect(call.headers['x-owner-id']).toBe(OWNER);
    expect(call.json).toMatchObject({ ownerId: OWNER, itinerarySelections: [{ cabinClass: 'CABIN_CLASS_ECONOMY' }], ttlMinutes: 15 });
  });

  it('★ un ownerId en el cuerpo (HoldRequest no cierra additionalProperties) no llega a Offers: el dueño es el del token', async () => {
    esb.on('POST', '/router/offers/CreateHold', { body: { hold: PROTO_HOLD } });
    await asPartner(http().post('/api/v2/vuelos/offers/hold').set('Idempotency-Key', newKey())).send({ ...HOLD_REQUEST, ownerId: 'partner:BOOKING_PROTOTIPO:victima' }).expect(201);
    expect(esb.last()!.json.ownerId).toBe(OWNER);
  });

  it('un reintento con la misma Idempotency-Key responde 200 con Idempotent-Replayed', async () => {
    esb.on('POST', '/router/offers/CreateHold', { body: { hold: PROTO_HOLD }, headers: { 'idempotent-replayed': 'true' } });
    const response = await asPartner(http().post('/api/v2/vuelos/offers/hold').set('Idempotency-Key', newKey())).send(HOLD_REQUEST).expect(200);
    expectContract('post', '/vuelos/offers/hold', response);
    expect(response.headers['idempotent-replayed']).toBe('true');
  });

  it('getHold y releaseHold con el dueño; un hold de otro dueño es 404', async () => {
    esb.on('POST', '/router/offers/GetHold', (call) => (call.json.ownerId === OWNER ? { body: { hold: PROTO_HOLD } } : { status: 404, body: { type: 'about:blank', title: 'Hold no encontrado.', status: 404, code: 'NOT_FOUND' } }));
    const mine = await asPartner(http().get(`/api/v2/vuelos/offers/hold/${HOLD_ID}`)).expect(200);
    expectContract('get', '/vuelos/offers/hold/{holdId}', mine);
    expect(mine.body).toMatchObject({ status: 'HELD', remainingSeconds: 899 });
    expectContract('get', '/vuelos/offers/hold/{holdId}', await asPartner(http().get(`/api/v2/vuelos/offers/hold/${HOLD_ID}`), 'usr-2').expect(404));
    esb.on('POST', '/router/offers/ReleaseHold', { body: { hold: { ...PROTO_HOLD, status: 'HOLD_STATUS_RELEASED' } } });
    await asPartner(http().delete(`/api/v2/vuelos/offers/hold/${HOLD_ID}`)).expect(204);
    expect(esb.last()!.json).toEqual({ holdId: HOLD_ID, ownerId: OWNER });
  });

  it('400 si el holdId no es UUID (sin llamar al ESB)', async () => {
    const response = await asPartner(http().get('/api/v2/vuelos/offers/hold/no-es-uuid')).expect(400);
    expect(response.body.invalidParams[0].name).toBe('holdId');
    expect(esb.calls).toHaveLength(0);
  });
});

describe('reservas', () => {
  it('createBooking 201: Location, _links y sin los campos internos (ownerId, channel, fares, refunds, assistance)', async () => {
    esb.on('POST', '/sagas/bookings', { status: 201, body: BOOKING_VIEW, headers: { 'x-saga-id': SAGA_ID } });
    const response = await asPartner(http().post('/api/v2/vuelos/bookings').set('Idempotency-Key', newKey())).send(BOOKING_REQUEST).expect(201);
    expectContract('post', '/vuelos/bookings', response);
    expect(response.headers['location']).toBe(`/api/v2/vuelos/bookings/${BOOKING_ID}`);
    for (const internal of ['ownerId', 'channel', 'fares', 'refunds', 'assistance']) expect(response.body).not.toHaveProperty(internal);
    expect(response.body._links.cancel).toEqual({ href: `/api/v2/vuelos/bookings/${BOOKING_ID}/cancel`, method: 'POST' });
    // Exacto al contrato, con sus valores por defecto (`provider`).
    expect(esb.last()!.json).toEqual({ ...BOOKING_REQUEST, payment: { ...BOOKING_REQUEST.payment, provider: 'BOOKING_PROTOTIPO' } });
  });

  it('createBooking 202 TICKET_ISSUING y, si la reserva aún no existe, 503 para reintentar con la misma clave', async () => {
    esb.on('POST', '/sagas/bookings', { status: 202, body: { ...BOOKING_VIEW, status: 'TICKET_ISSUING' } });
    expectContract('post', '/vuelos/bookings', await asPartner(http().post('/api/v2/vuelos/bookings').set('Idempotency-Key', newKey())).send(BOOKING_REQUEST).expect(202));

    esb.on('POST', '/sagas/bookings', { status: 202, body: { sagaId: SAGA_ID, bookingId: BOOKING_ID, status: 'PENDING' } });
    esb.on('GET', `/sagas/${SAGA_ID}`, { body: { sagaId: SAGA_ID, status: 'RUNNING', result: null, error: null } });
    esb.on('GET', `/router/bookings/bookings/${BOOKING_ID}`, { status: 404, body: { type: 'about:blank', title: 'No existe.', status: 404, code: 'NOT_FOUND' } });
    const pending = await asPartner(http().post('/api/v2/vuelos/bookings').set('Idempotency-Key', newKey())).send(BOOKING_REQUEST).expect(503);
    expect(pending.headers['retry-after']).toBe('5');
    expect(pending.body.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('createBooking repetido (Idempotent-Replayed): 200 con la reserva como está ahora', async () => {
    esb.on('POST', '/sagas/bookings', { status: 202, body: { ...BOOKING_VIEW, status: 'TICKET_ISSUING' }, headers: { 'idempotent-replayed': 'true' } });
    esb.on('GET', `/router/bookings/bookings/${BOOKING_ID}`, { body: BOOKING_VIEW });
    const response = await asPartner(http().post('/api/v2/vuelos/bookings').set('Idempotency-Key', newKey())).send(BOOKING_REQUEST).expect(200);
    expectContract('post', '/vuelos/bookings', response);
    expect(response.body.status).toBe('CONFIRMED');
  });

  it('una saga que falló devuelve su error (el del paso que falló), no 202', async () => {
    esb.on('POST', '/sagas/bookings', { status: 202, headers: { 'idempotent-replayed': 'true' }, body: { sagaId: SAGA_ID, bookingId: BOOKING_ID, status: 'PENDING' } });
    esb.on('GET', `/sagas/${SAGA_ID}`, { body: { sagaId: SAGA_ID, status: 'COMPENSATED', result: null, error: { type: 'about:blank', title: 'Monto distinto.', status: 422, code: 'AMOUNT_MISMATCH' } } });
    const response = await asPartner(http().post('/api/v2/vuelos/bookings').set('Idempotency-Key', newKey())).send(BOOKING_REQUEST).expect(422);
    expectContract('post', '/vuelos/bookings', response);
    expect(response.body.code).toBe('AMOUNT_MISMATCH');
  });

  it('PaymentReference cierra additionalProperties: una tarjeta en payment → 400 (como el monolito)', async () => {
    const response = await asPartner(http().post('/api/v2/vuelos/bookings').set('Idempotency-Key', newKey()))
      .send({ ...BOOKING_REQUEST, payment: { paymentReference: 'pay_1', cardNumber: '4111111111111111' } })
      .expect(400);
    expect(response.body.invalidParams).toEqual([{ name: 'payment.cardNumber', reason: 'propiedad no permitida' }]);
    expect(esb.calls).toHaveLength(0);
  });

  it('listBookings con filtros y _links por reserva; getBooking de otro dueño → 404', async () => {
    esb.on('GET', '/router/bookings/bookings', { body: { items: [{ bookingId: BOOKING_ID, pnr: 'BKG001', status: 'CONFIRMED', grandTotal: money('79.85'), ownerId: OWNER }], nextCursor: null } });
    const list = await asPartner(http().get('/api/v2/vuelos/bookings').query({ status: 'CONFIRMED', limit: 5 })).expect(200);
    expectContract('get', '/vuelos/bookings', list);
    expect(list.body.items[0]).not.toHaveProperty('ownerId');
    expect(list.body.items[0]._links.self.href).toBe(`/api/v2/vuelos/bookings/${BOOKING_ID}`);
    expect(esb.last()!.path).toBe('/router/bookings/bookings?status=CONFIRMED&limit=5');
    esb.on('GET', `/router/bookings/bookings/${BOOKING_ID}`, (call) => (call.headers['x-owner-id'] === OWNER ? { body: BOOKING_VIEW } : { status: 404, body: { type: 'about:blank', title: 'Reserva no encontrada.', status: 404, code: 'NOT_FOUND' } }));
    expectContract('get', '/vuelos/bookings/{bookingId}', await asPartner(http().get(`/api/v2/vuelos/bookings/${BOOKING_ID}`)).expect(200));
    expectContract('get', '/vuelos/bookings/{bookingId}', await asPartner(http().get(`/api/v2/vuelos/bookings/${BOOKING_ID}`), 'usr-2').expect(404));
  });
});

describe('boletos, asientos, check-in y pases', () => {
  const TICKET = { ticketId: 'TKT-1', bookingId: BOOKING_ID, passengerId: 'PAX-1', status: 'ISSUED', eTicketNumber: '0012345678901', issuedAt: '2026-10-25T19:20:21.000Z', segments: [{ segmentId: 'EA100-20261106', status: 'ISSUED' }] };

  it('issueTickets: 200 con issued; si sigue en curso, la reserva en TICKET_ISSUING con issued 0', async () => {
    esb.on('POST', `/sagas/bookings/${BOOKING_ID}/tickets`, { body: { bookingId: BOOKING_ID, pnr: 'BKG001', status: 'CONFIRMED', tickets: [TICKET], issued: 1 } });
    expectContract('post', '/vuelos/bookings/{bookingId}/tickets', await asPartner(http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/tickets`)).expect(200));
    esb.on('POST', `/sagas/bookings/${BOOKING_ID}/tickets`, { status: 202, body: { sagaId: SAGA_ID, status: 'RUNNING' } });
    esb.on('GET', `/sagas/${SAGA_ID}`, { body: { sagaId: SAGA_ID, status: 'RUNNING', result: null, error: null } });
    esb.on('GET', `/router/bookings/bookings/${BOOKING_ID}`, { body: { ...BOOKING_VIEW, status: 'TICKET_ISSUING' } });
    const pending = await asPartner(http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/tickets`)).expect(200);
    expectContract('post', '/vuelos/bookings/{bookingId}/tickets', pending);
    expect(pending.body).toMatchObject({ status: 'TICKET_ISSUING', issued: 0 });
  });

  it('listTickets y getTicket por el enrutador, con el dueño', async () => {
    esb.on('GET', `/router/bookings/bookings/${BOOKING_ID}/tickets`, { body: { bookingId: BOOKING_ID, tickets: [TICKET] } });
    esb.on('GET', `/router/bookings/bookings/${BOOKING_ID}/tickets/TKT-1`, { body: TICKET });
    expectContract('get', '/vuelos/bookings/{bookingId}/tickets', await asPartner(http().get(`/api/v2/vuelos/bookings/${BOOKING_ID}/tickets`)).expect(200));
    expectContract('get', '/vuelos/bookings/{bookingId}/tickets/{ticketId}', await asPartner(http().get(`/api/v2/vuelos/bookings/${BOOKING_ID}/tickets/TKT-1`)).expect(200));
    expect(esb.last()!.headers['x-owner-id']).toBe(OWNER);
  });

  it('changeSeats y checkIn: sagas con Idempotency-Key; SEAT_TAKEN del ESB se publica tal cual', async () => {
    esb.on('PUT', `/sagas/bookings/${BOOKING_ID}/seats`, { body: { bookingId: BOOKING_ID, seats: [{ passengerId: 'PAX-1', segmentId: 'EA100-20261106', previousSeatNumber: null, seatNumber: '7C', status: 'BOOKED' }] } });
    const seats = await asPartner(http().put(`/api/v2/vuelos/bookings/${BOOKING_ID}/seats`).set('Idempotency-Key', newKey())).send({ seats: [{ passengerId: 'PAX-1', segmentId: 'EA100-20261106', seatNumber: '7C' }] }).expect(200);
    expectContract('put', '/vuelos/bookings/{bookingId}/seats', seats);
    esb.on('PUT', `/sagas/bookings/${BOOKING_ID}/seats`, { status: 409, body: { type: 'about:blank', title: 'Asiento ocupado.', status: 409, code: 'SEAT_TAKEN' } });
    const taken = await asPartner(http().put(`/api/v2/vuelos/bookings/${BOOKING_ID}/seats`).set('Idempotency-Key', newKey())).send({ seats: [{ passengerId: 'PAX-1', segmentId: 'EA100-20261106', seatNumber: '7C' }] }).expect(409);
    expectContract('put', '/vuelos/bookings/{bookingId}/seats', taken);
    expect(taken.body.code).toBe('SEAT_TAKEN');

    esb.on('POST', `/sagas/bookings/${BOOKING_ID}/check-in`, { body: { bookingId: BOOKING_ID, status: 'COMPLETED', checkedInPassengers: [{ passengerId: 'PAX-1', status: 'CHECKED_IN', segments: [{ segmentId: 'EA100-20261106', seat: '7C', status: 'CHECKED_IN' }] }] } });
    expectContract('post', '/vuelos/bookings/{bookingId}/check-in', await asPartner(http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/check-in`)).expect(200));
  });

  it('listBoardingPasses por la composición del ESB (dueño comprobado en Bookings, puerta vigente)', async () => {
    esb.on('GET', `/composition/bookings/${BOOKING_ID}/boarding-passes`, { body: { bookingId: BOOKING_ID, boardingPasses: [{ passengerId: 'PAX-1', segmentId: 'EA100-20261106', seat: '7C', gate: 'B4', barcode: 'M1PAZ/ANA', barcodeType: 'PDF417' }] } });
    expectContract('get', '/vuelos/bookings/{bookingId}/boarding-passes', await asPartner(http().get(`/api/v2/vuelos/bookings/${BOOKING_ID}/boarding-passes`)).expect(200));
    expect(esb.last()!.headers['x-owner-id']).toBe(OWNER);
  });
});

describe('propias de la web: reserva con asistencia y asistencia médica', () => {
  it('createWebBooking: solo token de usuario; la asistencia va a la misma saga y el dueño es el sub', async () => {
    esb.on('POST', '/sagas/bookings', { status: 201, body: { ...BOOKING_VIEW, ownerId: CUSTOMER_SUB, channel: 'WEB' } });
    const assistance = [{ passengerId: 'PAX-1', type: 'WCHR', needsCompanion: true }];
    const response = await http().post('/api/v2/ecoairlines/bookings').set('Authorization', tokens.customer()).set('Idempotency-Key', newKey()).send({ booking: BOOKING_REQUEST, assistance }).expect(201);
    expectOwn('post', '/ecoairlines/bookings', response);
    expect(esb.last()!.headers['x-owner-id']).toBe(CUSTOMER_SUB);
    expect(esb.last()!.json).toEqual({ ...BOOKING_REQUEST, payment: { ...BOOKING_REQUEST.payment, provider: 'BOOKING_PROTOTIPO' }, assistance });
    const partner = await asPartner(http().post('/api/v2/ecoairlines/bookings').set('Idempotency-Key', newKey())).send({ booking: BOOKING_REQUEST }).expect(403);
    expectOwn('post', '/ecoairlines/bookings', partner);
  });

  it('listAssistance (de la reserva del dueño), saveAssistance y deleteAssistance', async () => {
    esb.on('GET', `/router/bookings/bookings/${BOOKING_ID}`, { body: BOOKING_VIEW });
    const list = await http().get(`/api/v2/ecoairlines/bookings/${BOOKING_ID}/assistance`).set('Authorization', tokens.customer()).expect(200);
    expectOwn('get', '/ecoairlines/bookings/{bookingId}/assistance', list);
    expect(list.body).toHaveLength(1);
    esb.on('PUT', `/router/bookings/bookings/${BOOKING_ID}/passengers/PAX-1/assistance`, { body: BOOKING_VIEW.assistance[0] });
    expectOwn('put', '/ecoairlines/bookings/{bookingId}/passengers/{passengerId}/assistance', await http().put(`/api/v2/ecoairlines/bookings/${BOOKING_ID}/passengers/PAX-1/assistance`).set('Authorization', tokens.customer()).send({ type: 'WCHR' }).expect(200));
    esb.on('DELETE', `/router/bookings/bookings/${BOOKING_ID}/passengers/PAX-1/assistance`, { status: 204 });
    await http().delete(`/api/v2/ecoairlines/bookings/${BOOKING_ID}/passengers/PAX-1/assistance`).set('Authorization', tokens.customer()).expect(204);
  });

  it('listRefunds (V2.13): los reembolsos de la reserva del dueño; vacío si no se canceló; un partner → 403', async () => {
    const refund = { refundId: 'REF-1', amount: '94.50', penaltyAmount: '25.00', penaltyWaived: false, currency: 'USD', percentage: 79, originalPaymentReference: null, status: 'CALCULATED' };
    esb.on('GET', `/router/bookings/bookings/${BOOKING_ID}`, { body: { ...BOOKING_VIEW, refunds: [refund] } });
    const list = await http().get(`/api/v2/ecoairlines/bookings/${BOOKING_ID}/refunds`).set('Authorization', tokens.customer()).expect(200);
    expectOwn('get', '/ecoairlines/bookings/{bookingId}/refunds', list);
    expect(list.body).toEqual([refund]);
    expect(esb.last()!.headers['x-owner-id']).toBe(CUSTOMER_SUB);
    esb.on('GET', `/router/bookings/bookings/${BOOKING_ID}`, { body: BOOKING_VIEW });
    expect((await http().get(`/api/v2/ecoairlines/bookings/${BOOKING_ID}/refunds`).set('Authorization', tokens.customer()).expect(200)).body).toEqual([]);
    await http().get(`/api/v2/ecoairlines/bookings/${BOOKING_ID}/refunds`).set('Authorization', tokens.partner()).set('X-User-Id', 'u1').expect(403);
  });
});
