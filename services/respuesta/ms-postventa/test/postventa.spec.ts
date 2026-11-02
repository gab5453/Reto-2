import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { createResponseApp, CUSTOMER_SUB, FakeEsb, newKey, PARTNER_ID, tokens } from '../../../../tests/support/response-service.js';
import { definition } from '../src/service.js';

/** MS.Postventa (V2.12) contra un ESB falso: maletas, cambio de fecha y cancelación. */
const expectContract = contractValidator('vuelos-openapi-v2.yaml');
const esb = new FakeEsb();
let app: NestExpressApplication;
const http = () => request(app.getHttpServer());

const BOOKING_ID = '7bc123b6-ec50-4676-8b88-8f82a8c00ac7';
const SAGA_ID = 'c1d2e3f4-1111-4222-8333-944455556666';
const OWNER = `partner:${PARTNER_ID}:usr-1`;
const BOOKING = { bookingId: BOOKING_ID, pnr: 'BKG001', status: 'CONFIRMED', grandTotal: { currency: 'USD', total: '79.85' }, createdAt: '2026-10-25T19:20:20.813Z', ownerId: OWNER, channel: 'BOOKING', fares: [] };
const PAYMENT = { paymentReference: 'PAY-BKP-20261025-000002' };
const asPartner = (call: request.Test) => call.set('Authorization', tokens.partner()).set('X-User-Id', 'usr-1');

beforeAll(async () => {
  await esb.start();
  app = await createResponseApp(definition(), esb);
});
afterAll(async () => {
  await app.close();
  await esb.stop();
});
beforeEach(() => esb.reset());

describe('maletas', () => {
  it('getBaggageOptions por la composición del ESB, con el dueño', async () => {
    esb.on('GET', `/composition/bookings/${BOOKING_ID}/baggage-options`, { body: [{ passengerId: 'PAX-1', itineraryId: 'EA100-20261106', price: { currency: 'USD', total: '35.00' }, maxAllowed: 3, alreadyPurchased: 0 }] });
    expectContract('get', '/vuelos/bookings/{bookingId}/baggage-options', await asPartner(http().get(`/api/v2/vuelos/bookings/${BOOKING_ID}/baggage-options`)).expect(200));
    expect(esb.last()!.headers['x-owner-id']).toBe(OWNER);
  });

  it('addBaggage: 200; si la saga sigue en curso, 202 sin cuerpo (como el contrato)', async () => {
    const body = { passengerId: 'PAX-1', itineraryId: 'EA100-20261106', quantity: 1, payment: PAYMENT };
    esb.on('POST', `/sagas/bookings/${BOOKING_ID}/baggage`, { body: { passengerId: 'PAX-1', itineraryId: 'EA100-20261106', totalBaggage: 2 } });
    expectContract('post', '/vuelos/bookings/{bookingId}/baggage', await asPartner(http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/baggage`).set('Idempotency-Key', newKey())).send(body).expect(200));
    esb.on('POST', `/sagas/bookings/${BOOKING_ID}/baggage`, { status: 202, body: { sagaId: SAGA_ID, status: 'RUNNING' } });
    esb.on('GET', `/sagas/${SAGA_ID}`, { body: { sagaId: SAGA_ID, status: 'RUNNING', result: null, error: null } });
    const pending = await asPartner(http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/baggage`).set('Idempotency-Key', newKey())).send(body).expect(202);
    expect(pending.text).toBe('');
  });

  it('una tarjeta dentro de payment → 400 (PaymentReference cierra additionalProperties)', async () => {
    const response = await asPartner(http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/baggage`).set('Idempotency-Key', newKey()))
      .send({ passengerId: 'PAX-1', itineraryId: 'EA100-20261106', quantity: 1, payment: { paymentReference: 'pay_2xyz', cvv: '123' } })
      .expect(400);
    expect(response.body.invalidParams).toEqual([{ name: 'payment.cvv', reason: 'propiedad no permitida' }]);
  });
});

describe('cambio de fecha', () => {
  it('searchDateChange (composición) y confirmDateChange (saga) con _links', async () => {
    esb.on('POST', `/composition/bookings/${BOOKING_ID}/date-change/search`, { body: [{ changeOfferId: 'CHG-1', expiresAt: '2026-10-26T02:00:00Z', segments: [], priceDifference: { fareDifference: '0.00', taxDifference: '0.00', changeFee: '25.00', totalToPay: '25.00' } }] });
    const search = await asPartner(http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/date-change/search`)).send({ changes: [{ itineraryId: 'EA100-20261106', newDepartureDate: '2026-11-10' }] }).expect(200);
    expectContract('post', '/vuelos/bookings/{bookingId}/date-change/search', search);
    esb.on('POST', `/sagas/bookings/${BOOKING_ID}/date-change`, { body: BOOKING });
    const confirmed = await asPartner(http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/date-change`).set('Idempotency-Key', newKey())).send({ changeOfferId: 'CHG-1', payment: PAYMENT }).expect(200);
    expectContract('post', '/vuelos/bookings/{bookingId}/date-change', confirmed);
    expect(confirmed.body).not.toHaveProperty('ownerId');
    expect(confirmed.body._links.self.href).toBe(`/api/v2/vuelos/bookings/${BOOKING_ID}`);
  });

  it('confirmDateChange en curso → 202 con la reserva (CHANGE_PENDING); CHANGE_OFFER_EXPIRED → 410', async () => {
    esb.on('POST', `/sagas/bookings/${BOOKING_ID}/date-change`, { status: 202, body: { sagaId: SAGA_ID, status: 'RUNNING' } });
    esb.on('GET', `/sagas/${SAGA_ID}`, { body: { sagaId: SAGA_ID, status: 'RUNNING', result: null, error: null } });
    esb.on('GET', `/router/bookings/bookings/${BOOKING_ID}`, { body: { ...BOOKING, status: 'CHANGE_PENDING' } });
    const pending = await asPartner(http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/date-change`).set('Idempotency-Key', newKey())).send({ changeOfferId: 'CHG-1' }).expect(202);
    expectContract('post', '/vuelos/bookings/{bookingId}/date-change', pending);
    expect(pending.body.status).toBe('CHANGE_PENDING');
    esb.on('POST', `/sagas/bookings/${BOOKING_ID}/date-change`, { status: 410, body: { type: 'about:blank', title: 'La oferta de cambio venció.', status: 410, code: 'CHANGE_OFFER_EXPIRED' } });
    const expired = await asPartner(http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/date-change`).set('Idempotency-Key', newKey())).send({ changeOfferId: 'CHG-1' }).expect(410);
    expectContract('post', '/vuelos/bookings/{bookingId}/date-change', expired);
  });
});

describe('cancelación', () => {
  const RESULT = { bookingId: BOOKING_ID, pnr: 'BKG001', status: 'CANCELLED', cancelledAt: '2026-10-26T01:00:00Z', reasonCode: 'CUSTOMER_REQUEST', refund: { refundId: 'RF-1', amount: '50.00', penaltyAmount: '29.85', currency: 'USD', percentage: 62.6, originalPaymentReference: PAYMENT.paymentReference, status: 'CALCULATED' }, ticketsVoided: [], inventoryRestoration: { status: 'RESTORED', seatsReleased: 1, newSeatStatus: 'AVAILABLE' } };

  it('getCancellationQuote y cancelBooking (200 con el reembolso calculado)', async () => {
    esb.on('GET', `/composition/bookings/${BOOKING_ID}/cancellation-quote`, { body: { quoteId: 'Q-1', isRefundable: true, refundAmount: '50.00', penaltyAmount: '29.85', currency: 'USD', expiresAt: '2026-10-26T02:00:00Z' } });
    expectContract('get', '/vuelos/bookings/{bookingId}/cancellation-quote', await asPartner(http().get(`/api/v2/vuelos/bookings/${BOOKING_ID}/cancellation-quote`)).expect(200));
    esb.on('POST', `/sagas/bookings/${BOOKING_ID}/cancel`, { body: RESULT });
    const response = await asPartner(http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/cancel`).set('Idempotency-Key', newKey())).send({ quoteId: 'Q-1' }).expect(200);
    expectContract('post', '/vuelos/bookings/{bookingId}/cancel', response);
    expect(esb.last()!.json).toEqual({ quoteId: 'Q-1', reasonCode: 'CUSTOMER_REQUEST' });
  });

  it('en curso → 202 CANCELLATION_PENDING con el pnr', async () => {
    esb.on('POST', `/sagas/bookings/${BOOKING_ID}/cancel`, { status: 202, body: { bookingId: BOOKING_ID, status: 'CANCELLATION_PENDING', sagaId: SAGA_ID } });
    esb.on('GET', `/sagas/${SAGA_ID}`, { body: { sagaId: SAGA_ID, status: 'RUNNING', result: null, error: null } });
    esb.on('GET', `/router/bookings/bookings/${BOOKING_ID}`, { body: { ...BOOKING, status: 'CANCELLATION_PENDING' } });
    const response = await asPartner(http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/cancel`).set('Idempotency-Key', newKey())).send({ quoteId: 'Q-1' }).expect(202);
    expectContract('post', '/vuelos/bookings/{bookingId}/cancel', response);
    expect(response.body).toMatchObject({ pnr: 'BKG001', status: 'CANCELLATION_PENDING' });
  });

  it('★ SAGA_COMPENSATION (100 % sin penalidad, D42) solo lo pide Booking; FLIGHT_CANCELLED nadie desde afuera', async () => {
    esb.on('POST', `/sagas/bookings/${BOOKING_ID}/cancel`, { body: { ...RESULT, reasonCode: 'SAGA_COMPENSATION' } });
    await asPartner(http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/cancel`).set('Idempotency-Key', newKey())).send({ reasonCode: 'SAGA_COMPENSATION' }).expect(200);
    const calls = esb.calls.length;

    const web = await http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/cancel`).set('Authorization', tokens.customer()).set('Idempotency-Key', newKey()).send({ reasonCode: 'SAGA_COMPENSATION' }).expect(400);
    expectContract('post', '/vuelos/bookings/{bookingId}/cancel', web);
    expect(web.body.invalidParams[0].name).toBe('reasonCode');
    for (const caller of [tokens.partner(), tokens.customer()]) {
      await http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/cancel`).set('Authorization', caller).set('X-User-Id', 'usr-1').set('Idempotency-Key', newKey()).send({ reasonCode: 'FLIGHT_CANCELLED' }).expect(400);
    }
    expect(esb.calls).toHaveLength(calls);
  });

  it('con token de usuario el dueño es su sub (la web); sin Idempotency-Key → 400', async () => {
    esb.on('POST', `/sagas/bookings/${BOOKING_ID}/cancel`, { body: { ...RESULT, refund: { ...RESULT.refund, status: 'SETTLED' } } });
    await http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/cancel`).set('Authorization', tokens.customer()).set('Idempotency-Key', newKey()).send({ quoteId: 'Q-1' }).expect(200);
    expect(esb.last()!.headers['x-owner-id']).toBe(CUSTOMER_SUB);
    const missing = await http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/cancel`).set('Authorization', tokens.customer()).send({ quoteId: 'Q-1' }).expect(400);
    expect(missing.body.invalidParams).toEqual([{ name: 'Idempotency-Key', reason: 'obligatorio' }]);
  });

  it('cancelar requiere flights:cancel', async () => {
    await http().post(`/api/v2/vuelos/bookings/${BOOKING_ID}/cancel`).set('Authorization', tokens.partner('flights:read flights:book')).set('Idempotency-Key', newKey()).send({ quoteId: 'Q-1' }).expect(403);
  });
});
