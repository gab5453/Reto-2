import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AIRPORTS, removeAirport, SEED_AIRPORTS, signWebhook } from '@ecoairlines/shared';
import { contractValidator } from '../../../tests/support/openapi-contract.js';
import { EsbModule, setupApp } from '../src/app.module.js';
import { Upstreams } from '../src/clients/upstreams.js';
import { localDate } from '../src/composition/dates.js';
import { InMemoryEventsPublisher } from '../src/inbound/events-publisher.js';
import { InboundService } from '../src/inbound/inbound.service.js';
import { InMemoryEsbStore, type SagaRecord } from '../src/repositories/esb.store.js';
import { SagaEngine } from '../src/sagas/engine.js';
import { SagasService } from '../src/sagas/sagas.service.js';
import { FakeMsg, FakeOffers, FakePostSale, FixedToken, OffersProblem, PostSaleProblem, type Received, testConfig, testVerifier } from './fakes.js';

/**
 * Las sagas del orquestador (V2.10) contra MS.G falsos (REST, gRPC y un SOAP armado con el WSDL real). Verificación del plan:
 * cada saga en su camino feliz **y con un fallo simulado en cada paso**: se comprueba que se compensan, en orden inverso,
 * exactamente los pasos hechos (y que los pasos después del punto sin retorno se reintentan en vez de compensarse).
 *
 * Cada MS.G falso anota sus llamadas en `log` (con un nombre legible) y puede fallar UNA vez en la llamada `failure.key`.
 */
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const expectContract = contractValidator('esb.openapi.yaml');

const msg = new FakeMsg();
const offers = new FakeOffers();
const postSale = new FakePostSale();
const store = new InMemoryEsbStore();
const publisher = new InMemoryEventsPublisher();
let app: NestExpressApplication;
let engine: SagaEngine;
let sagas: SagasService;
let inbound: InboundService;

const OWNER = 'partner:BOOKING_PROTOTIPO:usr-v210';
const WEB_OWNER = '9d2c6a3e-1111-4222-8333-444455556666';
const ADMIN = '6b0f1c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const REF = 'PAY-BKP-20261023-000981';
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const HOLD = '3f1c2a9e-8b7d-4c21-9f0a-6e5d4c3b2a10';
const DEP = new Date(Date.now() + 6 * 3_600_000);
const DAY = localDate(DEP);
const SEG = `EA100-${DAY.replace(/-/g, '')}`;
const ITI = `EA100-${DAY}`;
const NEW_DAY = localDate(new Date(DEP.getTime() + 2 * 86_400_000));
const NEW_SEG = `EA100-${NEW_DAY.replace(/-/g, '')}`;
const NEW_ITI = `EA100-${NEW_DAY}`;
const money = (total: string) => ({ currency: 'USD', total });

// ------------------------------------------------------------------------------------------------------------- el mundo

const log: string[] = [];
let failure: { key: string; status: number; code: string; detail?: string } | undefined;
/** Orden que capturó el pago en la Payment API falsa (como la real: el `orderId` de la captura). */
let capturedBy: string | null = null;
/** Anota la llamada; si es la elegida para fallar, devuelve la falla (una sola vez). */
const hit = (key: string) => {
  log.push(key);
  if (failure?.key === key) {
    const f = failure;
    failure = undefined;
    return f;
  }
  return undefined;
};
const problemBody = (f: { status: number; code: string; detail?: string }) => ({ type: 'about:blank', title: 'Falla simulada', status: f.status, code: f.code, ...(f.detail ? { detail: f.detail } : {}) });
const grpcCode = (status: number) => (status === 503 ? grpc.status.UNAVAILABLE : status === 404 ? grpc.status.NOT_FOUND : grpc.status.FAILED_PRECONDITION);

function rest(service: string, method: string, path: string | RegExp, key: string, body: (r: Received) => unknown = () => ({}), status = 200) {
  msg.on(service, method, path, (r) => {
    const f = hit(key);
    if (f) return { status: f.status, body: problemBody(f) };
    return { status, body: body(r) };
  });
}
function rpc(name: string, key: (r: Any) => string, body: (r: Any) => Any = () => ({})) {
  offers.handlers.set(name, (r) => {
    const f = hit(key(r));
    if (f) throw new OffersProblem({ status: f.status, code: f.code, title: 'Falla simulada' }, grpcCode(f.status));
    return body(r);
  });
}
function soap(operation: string, body: (args: Any) => Any) {
  postSale.handlers.set(operation, (args) => {
    const f = hit(`post-sale ${operation}`);
    if (f) throw new PostSaleProblem(f.status, f.code, 'Falla simulada');
    return body(args);
  });
}

const segment = (segmentId: string, at: Date) => ({ segmentId, flightNumber: 'EA100', departure: { iataCode: 'UIO', at: at.toISOString() }, arrival: { iataCode: 'GYE', at: new Date(at.getTime() + 50 * 60_000).toISOString() } });
const itinerary = (itineraryId: string, segmentId: string, at: Date) => ({
  itineraryId,
  totalDurationMinutes: 50,
  stopsCount: 0,
  segments: [{ ...segment(segmentId, at), marketingCarrier: 'EA', operatingCarrier: 'EA', status: 'SCHEDULED' }],
  pricingOptions: [{ cabinClass: 'ECONOMY', fareBrand: 'BROTE', availableSeats: 100, fareRules: { isRefundable: false, isChangeable: true }, baggageAllowance: { personalItemIncluded: true, carryOnIncluded: 1, checkedBaggageIncluded: 0 }, extraCheckedBaggagePrice: money('35.00'), pricePerPassengerType: [] }],
});
const fullPassenger = { passengerId: 'PAX-1', passengerType: 'ADULT', firstName: 'Ana', lastName: 'Paz', documentType: 'NATIONAL_ID', documentNumber: '1712345678', nationality: 'EC', birthDate: '1990-05-02', gender: 'F', contact: { email: 'ana@ecoairlines.test', phone: '+593991112244' } };
const fare = { itineraryId: ITI, cabinClass: 'ECONOMY', fareBrand: 'BROTE', segmentIds: [SEG], price: { currency: 'USD', baseFare: '100.00', taxes: '19.50', total: '119.50' }, isRefundable: false, isChangeable: true };
const protoItinerary = (itineraryId: string, segmentId: string, at: Date) => ({
  itineraryId,
  totalDurationMinutes: 50,
  stopsCount: 0,
  segments: [{ ...segment(segmentId, at), marketingCarrier: 'EA', operatingCarrier: 'EA', status: 'FLIGHT_OPERATIONAL_STATUS_SCHEDULED' }],
  pricingOptions: [{ cabinClass: 'CABIN_CLASS_ECONOMY', fareBrand: 'BROTE', availableSeats: 100, fareRules: { isRefundable: false, isChangeable: true }, baggageAllowance: { personalItemIncluded: true, carryOnIncluded: 1, checkedBaggageIncluded: 0 }, extraCheckedBaggagePrice: { currency: 'USD', baseFare: '', taxes: '', total: '35.00' }, pricePerPassengerType: [] }],
});

/** Reserva que ve el ESB en Bookings (BookingView). */
let booking: Any;
let created = false;
const view = (id = B, over: Any = {}) => ({
  bookingId: id,
  pnr: 'XK7P2Q',
  status: 'CONFIRMED',
  ownerId: OWNER,
  channel: 'BOOKING',
  grandTotal: money('119.50'),
  paymentReference: REF,
  salesChannel: { partnerId: 'BOOKING_PROTOTIPO', partnerOrderId: 'ORD-1', packageId: 'PKG-UIO-GYE-1' },
  itineraries: [itinerary(ITI, SEG, DEP)],
  passengers: [{ ...fullPassenger, assignedSeats: [{ segmentId: SEG, seatNumber: '12A' }] }],
  tickets: [{ ticketId: 'T1', bookingId: id, passengerId: 'PAX-1', status: 'ISSUED', eTicketNumber: '9990000000001' }],
  createdAt: '2026-10-20T10:00:00.000Z',
  fares: [fare],
  assistance: [],
  ...over,
});
const fares = (id = B) => ({ bookingId: id, status: 'CONFIRMED', channel: 'BOOKING', partnerId: 'BOOKING_PROTOTIPO', fares: [fare], unflownItineraryIds: [ITI], baggage: [{ passengerId: 'PAX-1', itineraryId: ITI, included: 0, purchased: 0 }], paymentReference: REF });
const quote = (refund = '19.50') => ({ quote: { quoteId: randomUUID(), bookingId: B, isRefundable: false, refundAmount: refund, penaltyAmount: '100.00', penaltyWaived: false, percentage: '16.32', currency: 'USD', unflownItineraryId: [ITI], expiresAt: new Date(Date.now() + 900_000).toISOString() } });
const changeOffer = (id: string) => ({
  changeOfferId: id,
  bookingId: B,
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
  replacement: [{ replacedItineraryId: ITI, newItineraryId: NEW_ITI, segmentId: [NEW_SEG], price: money('129.50') }],
  priceDifference: { fareDifference: '10.00', taxDifference: '0.00', changeFee: '0.00', totalToPay: '10.00', currency: 'USD' },
});
const routeDto = (routeId = 'EA300-EA301') => ({
  routeId, origin: 'UIO', destination: 'CUE', outbound: { flightNumber: 'EA300', origin: 'UIO', destination: 'CUE', departureLocal: '08:00', arrivalLocal: '08:45', arrivalDayOffset: 0 },
  inbound: { flightNumber: 'EA301', origin: 'CUE', destination: 'UIO', departureLocal: '10:00', arrivalLocal: '10:45', arrivalDayOffset: 0 }, weekdays: ['MON', 'WED'], aircraftType: 'Airbus A320neo', aircraft: ['HC-N01'], distanceKm: 300, durationMinutes: 45, source: 'ADMIN',
  createdAt: '2026-10-25T10:00:00.000Z', updatedAt: '2026-10-25T10:00:00.000Z', updatedBy: '6b0f1c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
});

/** Todos los MS.G responden el camino feliz. */
function happy() {
  // Bookings
  rest('bookings', 'GET', new RegExp(`^/bookings/[0-9a-f-]{36}$`), 'bookings GET booking', (r) => (r.path === `/bookings/${booking.bookingId}` ? booking : view(r.path.split('/')[2], { channel: r.path.endsWith('3') ? 'WEB' : 'BOOKING', ownerId: r.path.endsWith('3') ? WEB_OWNER : OWNER })));
  rest('bookings', 'GET', new RegExp(`^/bookings/[0-9a-f-]{36}/fares$`), 'bookings GET fares', (r) => fares(r.path.split('/')[2]));
  rest('bookings', 'POST', '/passengers/validate', 'bookings POST validate', () => ({ valid: true }));
  rest('bookings', 'POST', '/payment-references/claim', 'bookings POST claim', (r) => ({ record: JSON.parse(r.body), created: true }), 201);
  rest('bookings', 'DELETE', /^\/payment-references\//, 'bookings DELETE claim', () => undefined, 204);
  rest('bookings', 'POST', '/bookings', 'bookings POST create', (r) => {
    created = true;
    booking = view(JSON.parse(r.body).bookingId, { status: 'TICKET_ISSUING', tickets: [{ ticketId: 'T1', bookingId: JSON.parse(r.body).bookingId, passengerId: 'PAX-1', status: 'PENDING', eTicketNumber: null }] });
    return booking;
  }, 201);
  msg.on('bookings', 'POST', /^\/bookings\/[0-9a-f-]{36}\/fail$/, () => {
    log.push('bookings POST fail');
    return created ? { status: 200, body: { ...booking, status: 'FAILED' } } : { status: 404, body: problemBody({ status: 404, code: 'NOT_FOUND' }) };
  });
  rest('bookings', 'POST', /^\/bookings\/[0-9a-f-]{36}\/tickets$/, 'bookings POST tickets', (r) => {
    // Bookings deja la reserva CONFIRMED con sus boletos (la respuesta final de "Crear reserva" la relee).
    const id = r.path.split('/')[2];
    const tickets = [{ ticketId: 'T1', bookingId: id, passengerId: 'PAX-1', status: 'ISSUED', eTicketNumber: '9990000000001' }];
    if (booking.bookingId === id) booking = { ...booking, status: 'CONFIRMED', tickets };
    return { bookingId: id, pnr: 'XK7P2Q', status: 'CONFIRMED', issued: 1, tickets };
  });
  rest('bookings', 'POST', `/bookings/${B}/seats/plan`, 'bookings POST plan', () => ({ bookingId: B, changes: [{ passengerId: 'PAX-1', segmentId: SEG, previousSeatNumber: '12A', seatNumber: '14C', cabinClass: 'ECONOMY', targetStatus: 'TICKETED' }] }));
  rest('bookings', 'PUT', `/bookings/${B}/seats`, 'bookings PUT seats', (r) => ({ bookingId: B, seats: JSON.parse(r.body).seats }));
  rest('bookings', 'POST', `/bookings/${B}/baggage`, 'bookings POST baggage', () => ({ passengerId: 'PAX-1', itineraryId: ITI, totalBaggage: 1 }));
  rest('bookings', 'POST', `/bookings/${B}/date-change`, 'bookings POST date-change', () => view(B, { itineraries: [itinerary(NEW_ITI, NEW_SEG, new Date(DEP.getTime() + 2 * 86_400_000))] }));
  // Con estado, como Bookings: la segunda cancelación de la misma reserva responde ALREADY_CANCELLED con la primera en `detail`.
  const cancellations = new Map<string, Any>();
  msg.on('bookings', 'POST', new RegExp('^/bookings/[0-9a-f-]{36}/cancellation$'), (r) => {
    const f = hit('bookings POST cancellation');
    if (f) return { status: f.status, body: problemBody(f) };
    const id = r.path.split('/')[2];
    if (cancellations.has(id)) return { status: 409, body: { ...problemBody({ status: 409, code: 'ALREADY_CANCELLED' }), detail: JSON.stringify(cancellations.get(id)) } };
    const result = { bookingId: id, pnr: 'XK7P2Q', status: 'CANCELLED', refund: JSON.parse(r.body).refund, ticketsVoided: ['T1'] };
    cancellations.set(id, result);
    if (id === booking.bookingId) booking = { ...booking, status: 'CANCELLED' };
    return { status: 200, body: result };
  });
  rest('bookings', 'GET', `/flights/EA100/${DAY}/bookings`, 'bookings GET flight-bookings', () => ({
    flightNumber: 'EA100', date: DAY, total: 3,
    items: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'].map((id, i) => ({ bookingId: id, pnr: `PNR00${i}`, status: 'CONFIRMED', channel: i === 2 ? 'WEB' : 'BOOKING', passengers: 1 })),
  }));
  rest('bookings', 'PUT', /\/assistance\/status$/, 'bookings PUT assistance-status', (r) => ({ status: JSON.parse(r.body).status }));
  // FlightStatus
  rest('flight-status', 'GET', /^\/flights\/EA100\/status\?date=/, 'flight-status GET status', () => ({ flightNumber: 'EA100', date: DAY, status: 'SCHEDULED', departure: { iataCode: 'UIO', scheduledAt: DEP.toISOString(), gate: 'B2' }, arrival: { iataCode: 'GYE', scheduledAt: DEP.toISOString() } }));
  rest('flight-status', 'PATCH', '/flights/EA100/status', 'flight-status PATCH status', (r) => ({ changeId: 'aaaaaaaa-0000-4000-8000-000000000001', previousStatus: 'SCHEDULED', flight: { flightNumber: 'EA100', date: DAY, marketingCarrier: 'EA', operatingCarrier: 'EA', status: JSON.parse(r.body).status, departure: { iataCode: 'UIO', scheduledAt: DEP.toISOString() }, arrival: { iataCode: 'GYE', scheduledAt: DEP.toISOString() } } }));
  rest('flight-status', 'POST', /^\/status-changes\/.+\/revert$/, 'flight-status POST revert', () => ({ changeId: 'x', previousStatus: 'CANCELLED', flight: {} }));
  // CheckIn
  msg.on('check-in', 'GET', `/check-ins/${B}`, () => {
    const f = hit('check-in GET current');
    return f ? { status: f.status, body: problemBody(f) } : { status: 404, body: problemBody({ status: 404, code: 'NOT_FOUND' }) };
  });
  rest('check-in', 'POST', `/check-ins/${B}`, 'check-in POST register', () => ({ bookingId: B, status: 'COMPLETED', checkedInPassengers: [{ passengerId: 'PAX-1', status: 'CHECKED_IN', segments: [{ segmentId: SEG, seat: '7C', status: 'CHECKED_IN' }] }] }));
  rest('check-in', 'DELETE', /^\/check-ins\/.+\?sagaId=/, 'check-in DELETE register', () => undefined, 204);
  rest('check-in', 'POST', /^\/check-ins\/[^/]+\/void$/, 'check-in POST void', (r) => ({ bookingId: r.path.split('/')[2], voided: 1 }));
  msg.on('check-in', 'PUT', `/check-ins/${B}/assistance-ready`, (r) => {
    const f = hit(`check-in PUT ready=${JSON.parse(r.body).ready}`);
    return f ? { status: f.status, body: problemBody(f) } : { status: 200, body: { bookingId: B, ready: JSON.parse(r.body).ready } };
  });
  // Schedule
  rest('schedule', 'GET', '/fare-prices', 'schedule GET prices', () => ({ items: [{ cabinClass: 'ECONOMY', fareBrand: 'BROTE', multiplier: 1 }], updatedAt: new Date().toISOString() }));
  rest('schedule', 'PUT', '/fare-prices', 'schedule PUT prices', (r) => ({ items: JSON.parse(r.body).items, updatedAt: new Date().toISOString() }));
  rest('schedule', 'GET', '/promotion-agreements/BOOKING_PROTOTIPO', 'schedule GET agreement', () => ({ permite_promociones: false, porcentaje_descuento_maximo: 0 }));
  rest('schedule', 'PUT', '/promotion-agreements/BOOKING_PROTOTIPO', 'schedule PUT agreement', (r) => JSON.parse(r.body));
  rest('schedule', 'POST', /^\/routes(\?.*)?$/, 'schedule POST route', () => routeDto(), 201);
  rest('schedule', 'GET', '/routes/EA300-EA301', 'schedule GET route', () => routeDto());
  rest('schedule', 'PUT', '/routes/EA300-EA301', 'schedule PUT route', () => routeDto());
  rest('schedule', 'DELETE', /^\/routes\/EA300-EA301\?soldSeats=/, 'schedule DELETE route', () => undefined, 204);
  rest('schedule', 'GET', /^\/timetable\?/, 'schedule GET timetable', () => ({
    from: DAY, to: DAY, generatedAt: new Date().toISOString(),
    flights: [{ flightNumber: 'EA300', date: DAY, routeId: 'EA300-EA301', origin: 'UIO', destination: 'CUE', departureAt: DEP.toISOString(), arrivalAt: DEP.toISOString(), aircraftType: 'Airbus A320neo', registration: 'HC-N01' }, { flightNumber: 'EA100', date: DAY, routeId: 'EA100-EA101', origin: 'UIO', destination: 'GYE', departureAt: DEP.toISOString(), arrivalAt: DEP.toISOString(), aircraftType: 'Airbus A320neo', registration: 'HC-N01' }],
  }));
  // Payment API (canal web)
  rest('payment', 'POST', /^\/payments\/.+\/capture$/, 'payment POST capture', (r) => {
    capturedBy = JSON.parse(r.body).orderId;
    return { paymentReference: r.path.split('/')[2], status: 'CAPTURED', amount: money('119.50'), card: { brand: 'VISA', last4: '4242' }, orderId: capturedBy, createdAt: new Date().toISOString() };
  });
  rest('payment', 'POST', /^\/payments\/.+\/void$/, 'payment POST void', () => ({ status: 'VOIDED' }));
  rest('payment', 'GET', /^\/payments\/[^/]+$/, 'payment GET payment', () => ({ paymentReference: 'pay_x', status: 'CAPTURED', amount: money('119.50'), card: { brand: 'VISA', last4: '4242' }, orderId: capturedBy, createdAt: new Date().toISOString() }));
  rest('payment', 'POST', '/refunds', 'payment POST refunds', (r) => ({ refundId: 're_000000000001', paymentReference: JSON.parse(r.body).paymentReference, amount: JSON.parse(r.body).amount, status: 'SETTLED', createdAt: new Date().toISOString() }));

  // Offers
  const hold = { holdId: HOLD, status: 'HOLD_STATUS_HELD', offerId: 'OFF-1', passengersBreakdown: { adults: 1, youths: 0, children: 0, infants: 0 }, lockedPrice: fare.price, selections: [{ itineraryId: ITI, cabinClass: 'CABIN_CLASS_ECONOMY', fareBrand: 'BROTE', segmentIds: [SEG], itinerary: protoItinerary(ITI, SEG, DEP), price: fare.price }] };
  rpc('ValidateHold', () => 'offers ValidateHold', () => ({ hold, expectedAmount: fare.price }));
  rpc('ConsumeHold', () => 'offers ConsumeHold', () => ({ hold: { ...hold, status: 'HOLD_STATUS_CONSUMED' }, seats: [{ passengerId: 'PAX-1', segmentId: SEG, seatNumber: '12A', status: 'SEAT_STATUS_BOOKED' }] }));
  rpc('TransitionBookingSeats', (r) => `offers Transition ${String(r['fromStatus']).replace('SEAT_STATUS_', '')}>${String(r['toStatus']).replace('SEAT_STATUS_', '')}`, (r) => ({ result: { bookingId: r['bookingId'], seats: [], seatsAffected: 1 } }));
  rpc('ReleaseBookingInventory', () => 'offers ReleaseBookingInventory', () => ({ seatsReleased: 1, newSeatStatus: 'SEAT_STATUS_AVAILABLE' }));
  rpc('ReserveSeats', (r) => `offers ReserveSeats ${r['seats'][0]['seatNumber']}`, (r) => ({ result: { bookingId: r['bookingId'], seats: [], seatsAffected: 1 } }));
  rpc('AutoAssignSeats', () => 'offers AutoAssignSeats', (r) => ({ result: { bookingId: r['bookingId'], seats: [{ passengerId: 'PAX-1', segmentId: SEG, seatNumber: '7C', status: 'SEAT_STATUS_CHECKED_IN' }], seatsAffected: 1 } }));
  rpc('ReserveInventory', () => 'offers ReserveInventory', (r) => ({ result: { bookingId: r['bookingId'], seats: [], seatsAffected: 1 } }));
  rpc('CloseFlightSales', () => 'offers CloseFlightSales', () => ({ state: { flightNumber: 'EA100', date: DAY, onSale: false, activeHoldsReleased: 0 } }));
  rpc('ReopenFlightSales', () => 'offers ReopenFlightSales', () => ({ state: { flightNumber: 'EA100', date: DAY, onSale: true, activeHoldsReleased: 0 } }));
  rpc('CountSoldSeats', () => 'offers CountSoldSeats', () => ({ soldSeats: 0 }));
  rpc('PublishTimetable', () => 'offers PublishTimetable', (r) => ({ result: { publishId: r['publishId'], added: r['flights'].length, updated: 0, removed: 0, keptWithSales: 0, publishedAt: new Date().toISOString() } }));
  rpc('PublishFarePrices', () => 'offers PublishFarePrices', (r) => ({ result: { publishId: r['publishId'], added: 0, updated: 1, removed: 0, keptWithSales: 0, publishedAt: new Date().toISOString() } }));
  rpc('FindAlternatives', () => 'offers FindAlternatives', () => ({ alternatives: [{ replacedItineraryId: ITI, itinerary: protoItinerary(NEW_ITI, NEW_SEG, new Date(DEP.getTime() + 2 * 86_400_000)), price: money('129.50') }] }));
  // PostSale (SOAP)
  soap('CreateCancellationQuote', () => quote());
  soap('ConsumeCancellationQuote', () => quote());
  soap('CalculateCompensationRefund', (args) => ({ quote: { ...quote().quote, bookingId: args['booking']['bookingId'], refundAmount: '119.50', penaltyAmount: '0.00', penaltyWaived: true, percentage: '100.00' } }));
  soap('CreateDateChangeOffers', () => ({ offer: [changeOffer('11111111-1111-4111-8111-111111111111')] }));
  soap('ConsumeDateChangeOffer', (args) => ({ offer: changeOffer(String(args['changeOfferId'])) }));
  soap('ReleaseDateChangeOffer', () => ({ released: true }));
  soap('GetBaggageOptions', () => ({ option: [{ passengerId: 'PAX-1', itineraryId: ITI, price: money('35.00'), maxAllowed: 3, alreadyPurchased: 0 }] }));
  soap('ValidateBaggagePurchase', () => ({ amountToCharge: money('35.00') }));
}

beforeAll(async () => {
  const base = await msg.start();
  const address = await offers.start();
  const soapBase = await postSale.start();
  // Plazo de 2,5 s (no 1 s): con toda la suite v2 en paralelo, los pasos de una saga sana pasaban de 1 s y respondía 202.
  const config = testConfig(base, address, { POST_SALE_URL: soapBase, PAYMENT_API_URL: `${base}/payment`, PAYMENT_API_SECRET_KEY: 'sk_test_clave_de_prueba', SAGA_DEADLINE_MS: '2500', PAYMENT_PENDING_WAIT_MS: '500', SAGA_RECOVERY_MS: '3600000', UPSTREAM_TIMEOUT_MS: '3000' });
  const upstreams = new Upstreams(config, new FixedToken());
  const moduleRef = await Test.createTestingModule({ imports: [EsbModule.register(config, { store, verifier: testVerifier, upstreams, publisher })] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, rawBody: true, bodyParser: false });
  setupApp(app);
  await app.init();
  engine = app.get(SagaEngine);
  sagas = app.get(SagasService);
  inbound = app.get(InboundService);
}, 60_000);
afterAll(async () => {
  await app.close();
  await msg.stop();
  await offers.stop();
  await postSale.stop();
});
beforeEach(() => {
  msg.reset();
  offers.reset();
  postSale.reset();
  log.length = 0;
  failure = undefined;
  capturedBy = null;
  created = false;
  booking = view();
  publisher.published.length = 0;
  happy();
});

const http = () => request(app.getHttpServer());
const as = (call: request.Test, headers: { owner?: string; actor?: string } = { owner: OWNER }) => {
  call.set('Authorization', 'Bearer svc').set('X-Correlation-Id', 'corr-sagas-v210');
  if (headers.owner) call.set('X-Owner-Id', headers.owner);
  if (headers.actor) call.set('X-Actor-Id', headers.actor);
  return call;
};
const types = () => publisher.published.map((p) => p.event.type.split('.').slice(-2).join('.'));
const sagaOf = async (type: string): Promise<SagaRecord> => (await store.listSagas({ type, limit: 1 }))[0];

interface Step {
  key: string;
  /** La compensación usa el resultado del paso (p. ej. el `changeId`): si el paso mismo falló, no hay nada que deshacer. */
  undoIfDone?: true;
  /** Llamadas de su compensación, en el orden en que la hace. */
  undo?: string[];
}

/**
 * Para cada paso: lo hace fallar con un error de negocio y comprueba que, después de la falla, el log tiene EXACTAMENTE las
 * compensaciones de los pasos ya hechos (incluido el que falló, porque su resultado es incierto) en orden inverso.
 */
async function failEachStep(steps: Step[], run: () => Promise<request.Response>, prepare: () => void = () => undefined) {
  for (const [index, step] of steps.entries()) {
    msg.reset();
    offers.reset();
    postSale.reset();
    log.length = 0;
    created = false;
    booking = view();
    happy();
    prepare();
    failure = { key: step.key, status: 409, code: 'FALLA_SIMULADA' };
    const response = await run();
    expect.soft(response.status, `falla en "${step.key}"`).toBe(409);
    expect.soft(response.body.code).toBe('FALLA_SIMULADA');
    const at = log.indexOf(step.key);
    const expected = steps.slice(0, index + 1).reverse().flatMap((s, i) => (i === 0 && s.undoIfDone ? [] : (s.undo ?? [])));
    expect(log.slice(at + 1), `compensaciones tras fallar "${step.key}"`).toEqual(expected);
  }
}

// =============================================================================================================== Reservas

const passenger = { passengerId: 'PAX-1', passengerType: 'ADULT', firstName: 'Ana', lastName: 'Paz', documentType: 'NATIONAL_ID', documentNumber: '1712345678', nationality: 'EC', birthDate: '1990-05-02', gender: 'F', contact: { email: 'ana@ecoairlines.test', phone: '+593991112244' } };
const bookingRequest = (payment: Any = { paymentReference: REF, amount: fare.price }) => ({ holdId: HOLD, passengers: [passenger], payment, salesChannel: { partnerId: 'OTRO_PARTNER', partnerOrderId: 'ORD-1', packageId: 'PKG-UIO-GYE-1' } });
const createBooking = (body: Any = bookingRequest(), headers = { owner: OWNER }) => as(http().post('/sagas/bookings'), headers).send(body);

describe('Crear reserva', () => {
  const steps: Step[] = [
    { key: 'offers ValidateHold' },
    { key: 'bookings POST validate' },
    { key: 'bookings POST claim', undo: ['bookings DELETE claim'] },
    { key: 'offers ConsumeHold', undo: ['offers ReleaseBookingInventory'] },
    { key: 'bookings POST create', undo: ['bookings POST fail'] },
    { key: 'offers Transition BOOKED>TICKETED', undo: ['offers Transition TICKETED>BOOKED'] },
    { key: 'bookings POST tickets' },
  ];

  it('camino feliz (canal Booking): 201 CONFIRMED, el partner sale del token y los itinerarios con los nombres del contrato v2', async () => {
    const response = await createBooking();
    expect(response.status, JSON.stringify(response.body) + ' ' + log.join(' | ')).toBe(201);
    expect(response.headers['location']).toMatch(/^\/bookings\//);
    expectContract('POST', '/sagas/bookings', response);
    expect(log).toEqual([...steps.map((s) => s.key), 'bookings GET booking']);
    const sent = JSON.parse(msg.calls('bookings', 'POST', '/bookings')[0].body);
    expect(sent.salesChannel.partnerId).toBe('BOOKING_PROTOTIPO'); // nunca del cuerpo (D29)
    expect(sent.itineraries[0].segments[0].status).toBe('SCHEDULED');
    expect(sent.itineraries[0].pricingOptions[0].cabinClass).toBe('ECONOMY');
    expect(sent.passengers[0].assignedSeats).toEqual([{ segmentId: SEG, seatNumber: '12A' }]);
    expect(sent.payment).toEqual({ paymentReference: REF, provider: 'BOOKING_PROTOTIPO' });
    expect(JSON.parse(msg.calls('bookings', 'POST', '/payment-references/claim')[0].body)).toMatchObject({ provider: 'BOOKING_PROTOTIPO', operation: 'BOOKING', expectedAmount: fare.price });
    expect(types()).toEqual(['booking.confirmed', 'booking.ticket_issued']);
    expect(publisher.published[0].ownerId).toBe(OWNER);
    expect(publisher.published[0].event.correlationid).toBe('corr-sagas-v210');
    // BKG-16: Booking solo acepta webhooks con un id UUID versión 4 (antes salían v5 y respondía 400).
    for (const { event } of publisher.published) expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const saga = await sagaOf('CREATE_BOOKING');
    expect(saga.status).toBe('COMPLETED');
    expect(saga.steps.every((s) => s.status === 'DONE')).toBe(true);
  });

  it('★ con un fallo en cada paso se compensan, en orden inverso, exactamente los pasos hechos', async () => {
    await failEachStep(steps, () => createBooking());
  });

  it('Offers recibe todos los pasajeros (también los infantes) con los asientos que pidieron (assignedSeats)', async () => {
    const infant = { ...passenger, passengerId: 'PAX-2', passengerType: 'INFANT', associatedAdultId: 'PAX-1', birthDate: '2026-01-10' };
    const body = { ...bookingRequest(), passengers: [{ ...passenger, assignedSeats: [{ segmentId: SEG, seatNumber: '3C' }] }, infant] };
    await createBooking(body);
    expect(offers.calls.find((c) => c.rpc === 'ConsumeHold')!.request['passengers']).toEqual([
      { passengerId: 'PAX-1', passengerType: 'PASSENGER_TYPE_ADULT', requestedSeats: [{ passengerId: 'PAX-1', segmentId: SEG, seatNumber: '3C' }] },
      { passengerId: 'PAX-2', passengerType: 'PASSENGER_TYPE_INFANT', requestedSeats: [] },
    ]);
  });

  it('si falla después de crear la reserva: Bookings la marca FAILED y se publica booking.failed; la saga queda COMPENSATED', async () => {
    failure = { key: 'bookings POST tickets', status: 409, code: 'BOOKING_NOT_CONFIRMED' };
    const response = await createBooking();
    expect(response.status).toBe(409);
    expect(types()).toEqual(['booking.failed']);
    const saga = await sagaOf('CREATE_BOOKING');
    expect(saga.status).toBe('COMPENSATED');
    expect(saga.error).toMatchObject({ code: 'BOOKING_NOT_CONFIRMED' });
  });

  it('una referencia de pago de otro formato o un monto distinto no llegan a Bookings (422)', async () => {
    expect((await createBooking(bookingRequest({ paymentReference: 'PAGO-1' }))).body.code).toBe('PAYMENT_REFERENCE_INVALID');
    expect((await createBooking(bookingRequest({ paymentReference: REF, amount: money('1.00') }))).body.code).toBe('AMOUNT_MISMATCH');
    expect(log.filter((k) => k.startsWith('bookings POST claim'))).toEqual([]);
  });

  it('canal web: captura en la Payment API; si falla después de capturar, se reembolsa y se anula la autorización', async () => {
    const web = { ...bookingRequest({ paymentReference: 'pay_7Hq2mX9cLk4Z', provider: 'AIRLINE_DIRECT' }), salesChannel: undefined };
    failure = { key: 'offers ConsumeHold', status: 409, code: 'SEAT_TAKEN' };
    const response = await createBooking(web, { owner: WEB_OWNER });
    expect(response.body.code).toBe('SEAT_TAKEN');
    expect(log).toEqual([
      'offers ValidateHold', 'bookings POST validate', 'payment POST capture', 'bookings POST claim', 'offers ConsumeHold',
      // compensaciones (LIFO): asientos, referencia, cobro (consulta + reembolso) y autorización
      'offers ReleaseBookingInventory', 'bookings DELETE claim', 'payment GET payment', 'payment POST refunds', 'payment POST void',
    ]);
    expect(msg.calls('payment', 'POST', /capture$/)[0].headers['authorization']).toBe('Bearer sk_test_clave_de_prueba');
    expect(JSON.parse(msg.calls('bookings', 'POST', '/payment-references/claim')[0].body).provider).toBe('AIRLINE_DIRECT');
  });

  it('★ T-1: el asiento pedido se revisa ANTES del pago: tomado → SEAT_TAKEN sin capturar (web) ni reclamar la referencia (Booking)', async () => {
    const seated = { ...passenger, assignedSeats: [{ segmentId: SEG, seatNumber: '12A' }] };
    const web = { ...bookingRequest({ paymentReference: 'pay_7Hq2mX9cLk4Z', provider: 'AIRLINE_DIRECT' }), passengers: [seated], salesChannel: undefined };
    failure = { key: 'offers ValidateHold', status: 409, code: 'SEAT_TAKEN' };
    const response = await createBooking(web, { owner: WEB_OWNER });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SEAT_TAKEN');
    expect(log).toEqual(['offers ValidateHold']); // ni captura, ni reembolso, ni anulación: no se cobró
    expect(offers.calls.find((c) => c.rpc === 'ValidateHold')!.request['requestedSeats']).toEqual([{ passengerId: 'PAX-1', segmentId: SEG, seatNumber: '12A' }]);

    log.length = 0;
    failure = { key: 'offers ValidateHold', status: 409, code: 'SEAT_TAKEN' };
    const partner = await createBooking({ ...bookingRequest(), passengers: [seated] });
    expect(partner.body.code).toBe('SEAT_TAKEN');
    expect(log).toEqual(['offers ValidateHold']); // canal Booking: la referencia de pago ni se reclama
  });

  it('★ V2.15: una referencia ya capturada por OTRA orden (ALREADY_CAPTURED) no se reembolsa al compensar (era el dinero de otra compra)', async () => {
    const web = { ...bookingRequest({ paymentReference: 'pay_7Hq2mX9cLk4Z', provider: 'AIRLINE_DIRECT' }), salesChannel: undefined };
    capturedBy = 'saga-de-otra-compra';
    failure = { key: 'payment POST capture', status: 409, code: 'ALREADY_CAPTURED' };
    const response = await createBooking(web, { owner: WEB_OWNER });
    expect(response.body.code).toBe('ALREADY_CAPTURED');
    expect(log).toContain('payment GET payment');
    expect(log).not.toContain('payment POST refunds');
  });

  it('V2.17: tarjeta PENDING al capturar → la saga espera a que la pasarela la autorice y captura (la reserva se crea)', async () => {
    const web = { ...bookingRequest({ paymentReference: 'pay_7Hq2mX9cLk4Z', provider: 'AIRLINE_DIRECT' }), salesChannel: undefined };
    failure = { key: 'payment POST capture', status: 409, code: 'PAYMENT_NOT_CAPTURABLE', detail: 'Estado actual PENDING.' };
    const response = await createBooking(web, { owner: WEB_OWNER });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(log.filter((key) => key === 'payment POST capture')).toHaveLength(2);
    expect(log.indexOf('payment GET payment')).toBeGreaterThan(log.indexOf('payment POST capture'));
  });

  it('V2.17: si la tarjeta sigue PENDING pasado el plazo → 409 PAYMENT_NOT_AUTHORIZED y la autorización se anula', async () => {
    const web = { ...bookingRequest({ paymentReference: 'pay_7Hq2mX9cLk4Z', provider: 'AIRLINE_DIRECT' }), salesChannel: undefined };
    msg.on('payment', 'POST', /^\/payments\/.+\/capture$/, () => {
      log.push('payment POST capture');
      return { status: 409, body: problemBody({ status: 409, code: 'PAYMENT_NOT_CAPTURABLE', detail: 'Estado actual PENDING.' }) };
    });
    msg.on('payment', 'GET', /^\/payments\/[^/]+$/, () => ({ status: 200, body: { paymentReference: 'pay_7Hq2mX9cLk4Z', status: 'PENDING', amount: money('119.50'), card: { brand: 'VISA', last4: '3220' }, createdAt: new Date().toISOString() } }));
    const response = await createBooking(web, { owner: WEB_OWNER });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'PAYMENT_NOT_AUTHORIZED', title: 'El pago todavía no está autorizado.' });
    expect(log).toContain('payment POST void');
  });

  it.each([
    ['DECLINED', 'El pago no está autorizado.', 'Use otra tarjeta'],
    ['EXPIRED', 'El pago no está autorizado.', 'Use otra tarjeta'],
  ])('V2.15: pago %s al capturar → 409 PAYMENT_NOT_AUTHORIZED con el mensaje que corresponde', async (state, title, hint) => {
    const web = { ...bookingRequest({ paymentReference: 'pay_7Hq2mX9cLk4Z', provider: 'AIRLINE_DIRECT' }), salesChannel: undefined };
    failure = { key: 'payment POST capture', status: 409, code: 'PAYMENT_NOT_CAPTURABLE', detail: `Estado actual ${state}.` };
    const response = await createBooking(web, { owner: WEB_OWNER });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'PAYMENT_NOT_AUTHORIZED', title });
    expect(response.body.detail).toContain(hint);
  });

  it('respeta los 5 s de Booking: si la emisión tarda, responde 202 TICKET_ISSUING y la saga termina en segundo plano', async () => {
    msg.on('bookings', 'POST', /^\/bookings\/[0-9a-f-]{36}\/tickets$/, () => ({ status: 200, delayMs: 2900, body: { bookingId: B, pnr: 'XK7P2Q', status: 'CONFIRMED', issued: 1, tickets: [] } }));
    const response = await createBooking();
    expect(response.status).toBe(202);
    expect(response.body.status).toBe('TICKET_ISSUING');
    expectContract('POST', '/sagas/bookings', response);
    expect(response.headers['x-saga-id']).toBeDefined();
    expect(types()).toContain('booking.ticket_issuing'); // compatibilidad con v1: la emisión quedó en curso
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await store.saga(response.headers['x-saga-id']))!.status).toBe('COMPLETED');
  });

  it('con la misma Idempotency-Key no se inicia otra saga', async () => {
    const key = randomUUID();
    const first = await createBooking().set('Idempotency-Key', key);
    const again = await as(http().post('/sagas/bookings')).set('Idempotency-Key', key).send(bookingRequest());
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(log.filter((k) => k === 'offers ValidateHold')).toHaveLength(1);
  });
});

describe('Emitir boletos', () => {
  const steps: Step[] = [{ key: 'bookings GET booking' }, { key: 'offers Transition BOOKED>TICKETED', undo: ['offers Transition TICKETED>BOOKED'] }, { key: 'bookings POST tickets' }];
  const issue = () => as(http().post(`/sagas/bookings/${B}/tickets`)).send();

  it('camino feliz y fallo en cada paso; si falla se publica booking.ticket_failed', async () => {
    booking = view(B, { status: 'TICKET_ISSUING' });
    const response = await issue();
    expect(response.status).toBe(200);
    expectContract('POST', '/sagas/bookings/{bookingId}/tickets', response);
    expect(response.body.issued).toBe(1);
    expect(types()).toEqual(['booking.ticket_issued']);
    await failEachStep(steps, issue);
    publisher.published.length = 0;
    failure = { key: 'bookings POST tickets', status: 409, code: 'TICKET_ISSUANCE_FAILED' };
    await issue();
    expect(types()).toEqual(['booking.ticket_failed']);
  });
});

describe('Cambiar asientos', () => {
  const steps: Step[] = [
    { key: 'bookings GET booking' },
    { key: 'bookings POST plan' },
    { key: 'offers ReserveSeats 14C', undo: ['offers ReserveSeats 12A'] },
    { key: 'bookings POST claim', undo: ['bookings DELETE claim'] },
    { key: 'bookings PUT seats' },
  ];
  const change = () => as(http().put(`/sagas/bookings/${B}/seats`)).send({ seats: [{ passengerId: 'PAX-1', segmentId: SEG, seatNumber: '14C' }], payment: { paymentReference: 'PAY-BKP-20261024-000111', amount: money('5.00') } });

  it('camino feliz: todos los asientos o ninguno, con el pago si tiene costo, y booking.seat_changed', async () => {
    const response = await change();
    expect(response.status).toBe(200);
    expectContract('PUT', '/sagas/bookings/{bookingId}/seats', response);
    expect(log).toEqual(steps.map((s) => s.key));
    expect(offers.calls.find((c) => c.rpc === 'ReserveSeats')!.request).toMatchObject({ targetStatus: 'SEAT_STATUS_TICKETED', purchasedCabins: [{ cabinClass: 'CABIN_CLASS_ECONOMY' }] });
    expect(types()).toEqual(['booking.seat_changed']);
  });

  it('★ fallo en cada paso: el asiento nuevo se libera volviendo al anterior', async () => {
    await failEachStep(steps, change);
  });

  it('sin monto no se cobra ni se registra pago (los asientos de EcoAirlines no tienen costo)', async () => {
    await as(http().put(`/sagas/bookings/${B}/seats`)).send({ seats: [{ passengerId: 'PAX-1', segmentId: SEG, seatNumber: '14C' }] });
    expect(log).not.toContain('bookings POST claim');
  });
});

describe('Check-in', () => {
  const noSeat = () => (booking = view(B, { passengers: [fullPassenger], assistance: [{ passengerId: 'PAX-1' }] }));
  const steps: Step[] = [
    { key: 'bookings GET booking' },
    { key: 'flight-status GET status' },
    { key: 'check-in GET current' },
    { key: 'offers AutoAssignSeats', undo: ['offers Transition CHECKED_IN>TICKETED'] },
    { key: 'offers Transition TICKETED>CHECKED_IN', undo: ['offers Transition CHECKED_IN>TICKETED'] },
    { key: 'check-in POST register', undo: ['check-in DELETE register'] },
    { key: 'bookings PUT seats' },
  ];
  const checkIn = () => as(http().post(`/sagas/bookings/${B}/check-in`)).send();

  it('camino feliz: asiento automático, puerta de FlightStatus, marca de asistencia (sin el tipo) y booking.checked_in', async () => {
    noSeat();
    const response = await checkIn();
    expect(response.status).toBe(200);
    expectContract('POST', '/sagas/bookings/{bookingId}/check-in', response);
    expect(log).toEqual(steps.map((s) => s.key));
    const registered = JSON.parse(msg.calls('check-in', 'POST')[0].body);
    expect(registered.passengers[0].segments[0]).toMatchObject({ seat: '7C', gate: 'B2', needsAssistance: true, cabinClass: 'ECONOMY' });
    expect(JSON.parse(msg.calls('bookings', 'PUT')[0].body)).toEqual({ reason: 'CHECK_IN_AUTO', seats: [{ passengerId: 'PAX-1', segmentId: SEG, seatNumber: '7C' }] });
    expect(types()).toEqual(['booking.checked_in']);
  });

  it('★ D57: check-in en mostrador (el administrador, sin dueño): el mismo resultado, Bookings sabe que fue un administrador y booking.checked_in lleva el DUEÑO de la reserva (así le llega a Booking si es suya)', async () => {
    noSeat();
    const response = await as(http().post(`/sagas/bookings/${B}/check-in`), { actor: ADMIN }).send();
    expect(response.status).toBe(200);
    expect(log).toEqual(steps.map((s) => s.key));
    const seats = msg.calls('bookings', 'PUT')[0];
    expect(seats.headers['x-actor-id']).toBe(ADMIN);
    expect(seats.headers['x-owner-id']).toBeUndefined();
    expect(types()).toEqual(['booking.checked_in']);
    expect(publisher.published[0].ownerId).toBe(OWNER); // el dueño de la reserva, no el administrador
    expect(publisher.published[0].event.data).toMatchObject({ bookingId: B, passengersCheckedIn: 1 });
  });

  it('★ fallo en cada paso antes del punto sin retorno: los asientos vuelven a TICKETED y se deshace el check-in', async () => {
    // El último paso (Bookings) está después del punto sin retorno: se reintenta (prueba aparte).
    await failEachStep(steps.slice(0, -1), checkIn, noSeat);
  });

  it('vuelo cancelado → 409 FLIGHT_CANCELLED; fuera de la ventana de 48 h → CHECK_IN_NOT_AVAILABLE', async () => {
    msg.on('flight-status', 'GET', /^\/flights\/EA100\/status\?date=/, () => ({ status: 200, body: { status: 'CANCELLED' } }));
    expect((await checkIn()).body.code).toBe('FLIGHT_CANCELLED');
    booking = view(B, { itineraries: [itinerary(ITI, SEG, new Date(Date.now() + 5 * 86_400_000))] });
    expect((await checkIn()).body.code).toBe('CHECK_IN_NOT_AVAILABLE');
  });

  it('★ R-1 (D-T11): pasada la hora programada, un vuelo DELAYED sigue abierto hasta su salida estimada; sin retraso, cerrado', async () => {
    const passed = new Date(Date.now() - 30 * 60_000); // salía hace 30 min
    noSeat();
    booking = { ...booking, itineraries: [itinerary(ITI, SEG, passed)] };
    const delayed = (estimatedAt: Date) => ({ status: 200, body: { flightNumber: 'EA100', date: localDate(passed), status: 'DELAYED', departure: { iataCode: 'UIO', scheduledAt: passed.toISOString(), estimatedAt: estimatedAt.toISOString(), gate: 'B4' }, arrival: { iataCode: 'GYE', scheduledAt: passed.toISOString() } } });
    msg.on('flight-status', 'GET', /^\/flights\/EA100\/status\?date=/, () => delayed(new Date(Date.now() + 60 * 60_000)));
    const open = await checkIn();
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(JSON.parse(msg.calls('check-in', 'POST')[0].body).passengers[0].segments[0].gate).toBe('B4');

    // Ya pasó también la salida estimada → cerrado.
    msg.on('flight-status', 'GET', /^\/flights\/EA100\/status\?date=/, () => delayed(new Date(Date.now() - 5 * 60_000)));
    expect((await checkIn()).body.code).toBe('CHECK_IN_NOT_AVAILABLE');
    // A tiempo (sin retraso) y ya pasó su hora → cerrado, como antes.
    msg.on('flight-status', 'GET', /^\/flights\/EA100\/status\?date=/, () => ({ status: 200, body: { status: 'SCHEDULED', departure: { iataCode: 'UIO', scheduledAt: passed.toISOString(), estimatedAt: null } } }));
    expect((await checkIn()).body.code).toBe('CHECK_IN_NOT_AVAILABLE');
  });
});

describe('Cancelar (no se deshace: después de PostSale se reintenta)', () => {
  const cancel = (body: Any = { quoteId: randomUUID(), reasonCode: 'CUSTOMER_REQUEST' }) => as(http().post(`/sagas/bookings/${B}/cancel`)).send(body);

  it('camino feliz (cliente, canal Booking): reembolso CALCULATED (lo ejecuta Booking) y booking.cancelled', async () => {
    const response = await cancel();
    expect(response.status).toBe(200);
    expectContract('POST', '/sagas/bookings/{bookingId}/cancel', response);
    expect(log).toEqual(['bookings GET booking', 'bookings GET fares', 'post-sale ConsumeCancellationQuote', 'offers ReleaseBookingInventory', 'check-in POST void', 'bookings POST cancellation']);
    expect(JSON.parse(msg.calls('bookings', 'POST', /cancellation$/)[0].body).refund).toMatchObject({ amount: '19.50', penaltyAmount: '100.00', status: 'CALCULATED', originalPaymentReference: REF });
    expect(types()).toEqual(['booking.cancelled']);
  });

  it('un fallo ANTES de PostSale no cambia nada (no hay qué compensar)', async () => {
    for (const key of ['bookings GET booking', 'bookings GET fares', 'post-sale ConsumeCancellationQuote']) {
      log.length = 0;
      failure = { key, status: 409, code: 'QUOTE_EXPIRED' };
      expect((await cancel()).body.code).toBe('QUOTE_EXPIRED');
      expect(log.at(-1)).toBe(key);
    }
  });

  it('★ un fallo DESPUÉS del punto sin retorno no compensa: 202 CANCELLATION_PENDING y la saga se retoma hasta terminar', async () => {
    failure = { key: 'offers ReleaseBookingInventory', status: 503, code: 'PROVIDER_UNAVAILABLE' };
    const response = await cancel();
    expect(response.status).toBe(202);
    expect(response.body.status).toBe('CANCELLATION_PENDING');
    expectContract('POST', '/sagas/bookings/{bookingId}/cancel', response);
    const pending = (await store.saga(response.body.sagaId))!;
    expect(pending).toMatchObject({ status: 'RUNNING', error: { code: 'PROVIDER_UNAVAILABLE' } });
    await store.saveSaga({ ...pending, nextAttemptAt: new Date(Date.now() - 1).toISOString(), leaseUntil: new Date(Date.now() - 1).toISOString() });
    await engine.recover();
    expect((await store.saga(response.body.sagaId))!.status).toBe('COMPLETED');
    // PostSale no se repitió (paso guardado); Offers sí, porque falló.
    expect(log.filter((k) => k === 'post-sale ConsumeCancellationQuote')).toHaveLength(1);
    expect(log.filter((k) => k === 'bookings POST cancellation')).toHaveLength(1);
  });

  it('sin quoteId (cliente) → 400; SAGA_COMPENSATION no la necesita y es 100 % sin penalidad', async () => {
    expect((await cancel({ reasonCode: 'CUSTOMER_REQUEST' })).status).toBe(400);
    const response = await cancel({ reasonCode: 'SAGA_COMPENSATION' });
    expect(response.status).toBe(200);
    expect(postSale.calls.find((c) => c.operation === 'CalculateCompensationRefund')!.args).toMatchObject({ reasonCode: 'SAGA_COMPENSATION' });
    expect(JSON.parse(msg.calls('bookings', 'POST', /cancellation$/)[0].body).refund).toMatchObject({ amount: '119.50', penaltyAmount: '0.00', penaltyWaived: true });
  });

  it('un error de NEGOCIO después del punto sin retorno no se reintenta para siempre: la saga queda FAILED (revisión)', async () => {
    failure = { key: 'bookings POST cancellation', status: 422, code: 'VALIDATION_FAILED' };
    const response = await cancel();
    expect(response.status).toBe(422);
    expect((await sagaOf('CANCEL_BOOKING')).status).toBe('FAILED');
  });

  it('dos cancelaciones simultáneas de la misma reserva: una sola cancela y publica booking.cancelled', async () => {
    const [first, second] = await Promise.all([cancel({ reasonCode: 'SAGA_COMPENSATION' }), cancel({ reasonCode: 'SAGA_COMPENSATION' })]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body.alreadyCancelled, second.body.alreadyCancelled].filter(Boolean)).toHaveLength(1);
    expect(types()).toEqual(['booking.cancelled']);
  });

  it('una reserva ya cancelada → 409 ALREADY_CANCELLED', async () => {
    booking = view(B, { status: 'CANCELLED' });
    expect((await cancel()).body.code).toBe('ALREADY_CANCELLED');
  });

  it('★ D56 (12/11, revoca D55): con check-in hecho el cliente SÍ cancela, y el check-in se anula (los pases dejan de ser válidos)', async () => {
    msg.on('check-in', 'GET', `/check-ins/${B}`, () => ({ status: 200, body: { bookingId: B, items: [{ passengerId: 'PAX-1', segmentId: SEG, status: 'CHECKED_IN' }] } }));
    const response = await cancel();
    expect(response.status).toBe(200);
    expect(log).toContain('post-sale ConsumeCancellationQuote');
    const voids = msg.calls('check-in', 'POST', `/check-ins/${B}/void`);
    expect(voids).toHaveLength(1);
    expect(JSON.parse(voids[0].body)).toMatchObject({ reason: 'BOOKING_CANCELLED', sagaId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(JSON.parse(voids[0].body)).not.toHaveProperty('segmentIds'); // toda la reserva
    expect(types()).toEqual(['booking.cancelled']);
  });

  it.each(['SAGA_COMPENSATION', 'FLIGHT_CANCELLED'])('★ D56: la cancelación %s (administrador o vuelo cancelado) también anula el check-in (antes el pase quedaba válido)', async (reasonCode) => {
    expect((await cancel({ reasonCode })).status).toBe(200);
    expect(msg.calls('check-in', 'POST', `/check-ins/${B}/void`)).toHaveLength(1);
  });
});

describe('Cambiar fecha', () => {
  const OFFER = '11111111-1111-4111-8111-111111111111';
  const search = () => as(http().post(`/composition/bookings/${B}/date-change/search`)).send({ changes: [{ itineraryId: ITI, newDepartureDate: NEW_DAY }] });
  const confirm = () => as(http().post(`/sagas/bookings/${B}/date-change`)).send({ changeOfferId: OFFER, payment: { paymentReference: 'PAY-BKP-20261024-000222', amount: money('10.00') } });
  const steps: Step[] = [
    { key: 'bookings GET booking' },
    { key: 'bookings GET fares' },
    { key: 'post-sale ConsumeDateChangeOffer', undo: ['post-sale ReleaseDateChangeOffer'] },
    { key: 'bookings POST claim', undo: ['bookings DELETE claim'] },
    { key: 'offers ReserveInventory', undo: ['offers ReleaseBookingInventory'] },
    { key: 'bookings POST date-change' },
  ];

  it('búsqueda: Offers busca alternativas, PostSale arma la oferta y el ESB recuerda los itinerarios', async () => {
    const response = await search();
    expect(response.status).toBe(200);
    expectContract('POST', '/composition/bookings/{bookingId}/date-change/search', response);
    expect(response.body[0]).toMatchObject({ changeOfferId: OFFER, segments: [{ segmentId: NEW_SEG }], priceDifference: { totalToPay: '10.00' } });
    expect(((await store.changeOffer(OFFER))!.data as Any)['replacements'][0].itinerary.itineraryId).toBe(NEW_ITI);
  });

  it('camino feliz: cupos nuevos, Bookings cambia los itinerarios y luego se liberan los viejos; booking.changed', async () => {
    await search();
    log.length = 0;
    const response = await confirm();
    expect(response.status).toBe(200);
    expectContract('POST', '/sagas/bookings/{bookingId}/date-change', response);
    expect(log).toEqual([...steps.map((s) => s.key), 'offers ReleaseBookingInventory', 'check-in POST void']);
    expect(offers.calls.filter((c) => c.rpc === 'ReleaseBookingInventory').at(-1)!.request).toMatchObject({ segmentIds: [SEG], reason: 'DATE_CHANGE' });
    expect(types()).toEqual(['booking.changed']);
  });

  it('★ fallo en cada paso: se liberan los cupos nuevos, la referencia y la oferta', async () => {
    await search();
    await failEachStep(steps, confirm);
  });

  it('★ D56 (12/11, revoca D55): con check-in hecho SÍ se cambia la fecha, y se anula el check-in SOLO de los vuelos viejos', async () => {
    await search();
    msg.on('check-in', 'GET', `/check-ins/${B}`, () => ({ status: 200, body: { bookingId: B, items: [{ passengerId: 'PAX-1', segmentId: SEG, status: 'CHECKED_IN' }] } }));
    const response = await confirm();
    expect(response.status).toBe(200);
    const voids = msg.calls('check-in', 'POST', `/check-ins/${B}/void`);
    expect(voids).toHaveLength(1);
    expect(JSON.parse(voids[0].body)).toMatchObject({ reason: 'DATE_CHANGED', segmentIds: [SEG] });
    expect(types()).toEqual(['booking.changed']);
  });
});

describe('Agregar maletas', () => {
  const steps: Step[] = [
    { key: 'bookings GET booking' },
    { key: 'bookings GET fares' },
    { key: 'post-sale ValidateBaggagePurchase' },
    { key: 'bookings POST claim', undo: ['bookings DELETE claim'] },
    { key: 'bookings POST baggage' },
  ];
  const add = () => as(http().post(`/sagas/bookings/${B}/baggage`)).send({ passengerId: 'PAX-1', itineraryId: ITI, quantity: 1, payment: { paymentReference: 'PAY-BKP-20261024-000333', amount: money('35.00') } });

  it('camino feliz (monto de PostSale = precio de Offers × cantidad) y fallo en cada paso', async () => {
    const response = await add();
    expect(response.status).toBe(200);
    expectContract('POST', '/sagas/bookings/{bookingId}/baggage', response);
    expect(postSale.calls[0].args).toMatchObject({ line: { passengerId: 'PAX-1', itineraryId: ITI, unitPrice: { total: '35.00' } } });
    expect(types()).toEqual(['booking.baggage_added']);
    await failEachStep(steps, add);
  });

  it('★ D56 (12/11, revoca D55): con check-in hecho SÍ se agregan maletas, y el check-in no se toca', async () => {
    msg.on('check-in', 'GET', `/check-ins/${B}`, () => ({ status: 200, body: { bookingId: B, items: [{ passengerId: 'PAX-1', segmentId: SEG, status: 'CHECKED_IN' }] } }));
    const response = await add();
    expect(response.status).toBe(200);
    expect(types()).toEqual(['booking.baggage_added']);
    expect(msg.calls('check-in', 'POST', /\/void$/)).toHaveLength(0);
  });

  it('consultas de postventa: opciones de maletas y cotización de cancelación', async () => {
    const options = await as(http().get(`/composition/bookings/${B}/baggage-options`));
    expectContract('GET', '/composition/bookings/{bookingId}/baggage-options', options);
    expect(options.body).toEqual([{ passengerId: 'PAX-1', itineraryId: ITI, price: money('35.00'), maxAllowed: 3, alreadyPurchased: 0 }]);
    const quoteResponse = await as(http().get(`/composition/bookings/${B}/cancellation-quote`));
    expectContract('GET', '/composition/bookings/{bookingId}/cancellation-quote', quoteResponse);
    expect(quoteResponse.body).toMatchObject({ refundAmount: '19.50', penaltyAmount: '100.00', currency: 'USD', isRefundable: false });
  });
});

describe('Marcar asistencia lista (administrador)', () => {
  it('CheckIn y luego Bookings; si Bookings falla se desmarca en CheckIn', async () => {
    const mark = () => as(http().put(`/sagas/bookings/${B}/assistance-ready`), { actor: ADMIN }).send({ passengerId: 'PAX-1', segmentId: SEG, ready: true });
    expect((await mark()).status).toBe(200);
    expect(types()).toEqual(['booking.assistance_requested']);
    await failEachStep([{ key: 'check-in PUT ready=true', undo: ['check-in PUT ready=false'] }, { key: 'bookings PUT assistance-status' }], mark);
  });
});

// ============================================================================================================== Operación

describe('Cambiar estado de vuelo (D37)', () => {
  const patch = (status: string) => as(http().patch('/sagas/flights/EA100/status'), { actor: ADMIN }).send({ date: DAY, status, reason: 'Falla técnica' });

  it('★ CANCELLED con 3 reservas: cierra la venta y deja 3 reembolsos calculados (100 %, sin penalidad) y los asientos liberados', async () => {
    const response = await patch('CANCELLED');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ previousStatus: 'SCHEDULED', affectedBookings: 3 });
    expectContract('PATCH', '/sagas/flights/{flightNumber}/status', response);
    expect(response.body.cancellations.map((c: Any) => c.status)).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
    expect(log.filter((k) => k === 'offers CloseFlightSales')).toHaveLength(1);
    expect(postSale.calls.filter((c) => c.operation === 'CalculateCompensationRefund').map((c) => c.args['reasonCode'])).toEqual(['FLIGHT_CANCELLED', 'FLIGHT_CANCELLED', 'FLIGHT_CANCELLED']);
    expect(log.filter((k) => k === 'offers ReleaseBookingInventory')).toHaveLength(3);
    const refunds = msg.calls('bookings', 'POST', /cancellation$/).map((c) => JSON.parse(c.body).refund);
    expect(refunds.map((r) => [r.status, r.penaltyWaived])).toEqual([['CALCULATED', true], ['CALCULATED', true], ['SETTLED', true]]); // la de la web se ejecuta
    // D40: el evento solo lleva los ids de las reservas de Booking.
    const changed = publisher.published.find((p) => p.event.type.endsWith('flight.status_changed'))!;
    expect(changed.event.data['affectedBookingIds']).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
    expect(types()).toContain('flight.cancelled');
    const children = await store.listSagas({ parentSagaId: (await sagaOf('UPDATE_FLIGHT_STATUS')).sagaId, limit: 10 });
    expect(children.map((c) => c.status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED']);
  });

  it('★ fallo en cada paso antes de cancelar reservas: se reabre la venta y se restaura el estado anterior', async () => {
    await failEachStep(
      [{ key: 'flight-status PATCH status', undo: ['flight-status POST revert'], undoIfDone: true }, { key: 'bookings GET flight-bookings' }, { key: 'offers CloseFlightSales', undo: ['offers ReopenFlightSales'] }],
      () => patch('CANCELLED'),
    );
  });

  it('DEPARTED: los asientos CHECKED_IN pasan a BOARDED; una transición inválida vuelve tal cual (INVALID_STATUS_TRANSITION)', async () => {
    publisher.published.length = 0;
    expect((await patch('DELAYED')).status).toBe(200);
    expect(types()).toEqual(['flight.status_changed', 'flight.schedule_changed']); // compatibilidad con v1
        expect((await patch('DEPARTED')).status).toBe(200);
    expect(log.filter((k) => k === 'offers Transition CHECKED_IN>BOARDED')).toHaveLength(3);
    msg.on('flight-status', 'PATCH', '/flights/EA100/status', () => ({ status: 409, body: problemBody({ status: 409, code: 'INVALID_STATUS_TRANSITION' }) }));
    expect((await patch('ARRIVED')).body.code).toBe('INVALID_STATUS_TRANSITION');
    expect((await as(http().patch('/sagas/flights/EA100/status')).send({ date: DAY, status: 'DELAYED' })).status).toBe(400); // sin X-Actor-Id
  });
});

describe('Guardar precios y descuento máximo', () => {
  const save = () => as(http().put('/sagas/fare-prices'), { actor: ADMIN }).send({ items: [{ cabinClass: 'ECONOMY', fareBrand: 'BROTE', multiplier: 1.2 }] });

  it('camino feliz: Schedule guarda, Offers recibe la copia con las reglas de promoción y pricing.changed (interno)', async () => {
    expect((await save()).status).toBe(200);
    expect(offers.calls.find((c) => c.rpc === 'PublishFarePrices')!.request).toMatchObject({ prices: [{ cabinClass: 'CABIN_CLASS_ECONOMY', fareBrand: 'BROTE', multiplier: 1 }], promotions: [{ partnerId: 'BOOKING_PROTOTIPO', allowsPromotions: false }] });
    expect(publisher.published[0].event).toMatchObject({ type: 'ec.ecoairlines.internal.pricing.changed', data: { changedPrices: [{ oldMultiplier: 1, newMultiplier: 1.2 }] } });
  });

  it('★ fallo en cada paso: Schedule vuelve a los valores anteriores', async () => {
    await failEachStep(
      [{ key: 'schedule GET prices' }, { key: 'schedule GET agreement' }, { key: 'schedule PUT prices', undo: ['schedule PUT prices'] }, { key: 'offers PublishFarePrices' }],
      save,
    );
    const restored = msg.calls('schedule', 'PUT', '/fare-prices').at(-1)!;
    expect(JSON.parse(restored.body)).toEqual({ items: [{ cabinClass: 'ECONOMY', fareBrand: 'BROTE', multiplier: 1 }] });
  });

  it('el acuerdo de promociones: un descuento > 50 % lo rechaza Schedule (PROMOTION_DISCOUNT_OUT_OF_RANGE) y Offers no recibe nada', async () => {
    msg.on('schedule', 'PUT', '/promotion-agreements/BOOKING_PROTOTIPO', () => ({ status: 422, body: problemBody({ status: 422, code: 'PROMOTION_DISCOUNT_OUT_OF_RANGE' }) }));
    const response = await as(http().put('/sagas/promotion-agreements/BOOKING_PROTOTIPO'), { actor: ADMIN }).send({ permite_promociones: true, porcentaje_descuento_maximo: 60 });
    expect(response.body.code).toBe('PROMOTION_DISCOUNT_OUT_OF_RANGE');
    expect(offers.calls.filter((c) => c.rpc === 'PublishFarePrices')).toHaveLength(0);
  });

  it('★ P-1: tarifa base y precio exacto por ruta: Schedule recibe el estado completo, Offers la copia; quitar la ruta; si Offers falla, Schedule vuelve atrás', async () => {
    const four = (base: number) => ['SEMILLA', 'BROTE', 'BOSQUE', 'DOSEL'].map((fareBrand, i) => ({ fareBrand, amount: base + i * 10 }));
    const existing = { routeId: 'EA100-EA101', prices: four(60) };
    let stored: Any = { fixedCharge: 35, perKm: 0.085, routePrices: [existing], updatedAt: null, updatedBy: null, history: [] };
    msg.on('schedule', 'GET', '/pricing', () => ({ status: 200, body: stored }));
    msg.on('schedule', 'PUT', '/pricing', (r) => {
      stored = { ...JSON.parse(r.body), updatedAt: new Date().toISOString(), updatedBy: ADMIN, history: [] };
      return { status: 200, body: stored };
    });
    const pricing = (body: Any) => as(http().put('/sagas/pricing'), { actor: ADMIN }).send(body);

    const loja = { routeId: 'EA324-EA325', prices: four(70) };
    const saved = await pricing({ perKm: 0.09, route: loja });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(JSON.parse(msg.calls('schedule', 'PUT', '/pricing')[0].body)).toEqual({ fixedCharge: 35, perKm: 0.09, routePrices: [existing, loja] });
    const published = offers.calls.filter((c) => c.rpc === 'PublishFarePrices').at(-1)!.request;
    expect(published['pricing']).toEqual({ fixedCharge: 35, perKm: 0.09 });
    expect(published['routePrices']).toHaveLength(8);
    expect(published['routePrices']).toContainEqual({ routeId: 'EA324-EA325', fareBrand: 'DOSEL', amount: 100 });
    expect(publisher.published.at(-1)!.event).toMatchObject({ data: { pricingUpdated: true } });

    // Quitar el precio exacto de una ruta (prices vacío) conserva las demás.
    await pricing({ route: { routeId: 'EA100-EA101', prices: [] } });
    expect(JSON.parse(msg.calls('schedule', 'PUT', '/pricing').at(-1)!.body).routePrices).toEqual([loja]);

    // Si Offers no recibe la copia, Schedule vuelve exactamente al estado anterior.
    const before = { fixedCharge: stored.fixedCharge, perKm: stored.perKm, routePrices: stored.routePrices };
    failure = { key: 'offers PublishFarePrices', status: 422, code: 'VALIDATION_FAILED' };
    expect((await pricing({ fixedCharge: 50 })).status).toBe(422);
    expect(JSON.parse(msg.calls('schedule', 'PUT', '/pricing').at(-1)!.body)).toEqual(before);
    expect((await pricing({})).status).toBe(400);
  });
});

describe('Publicar horario', () => {
  const route = { origin: 'UIO', destination: 'CUE', outboundDepartureLocal: '08:00', inboundDepartureLocal: '10:00', weekdays: ['MON', 'WED'] };

  it('crear ruta: Schedule guarda, Offers recibe solo los vuelos de esa ruta y schedule.published (interno) para FlightStatus', async () => {
    const response = await as(http().post('/sagas/routes'), { actor: ADMIN }).send(route);
    expect(response.status).toBe(201);
    expectContract('POST', '/sagas/routes', response);
    expect(offers.calls.find((c) => c.rpc === 'PublishTimetable')!.request).toMatchObject({ routeId: 'EA300-EA301', flights: [{ flightNumber: 'EA300' }] });
    expect(publisher.published[0].event).toMatchObject({ type: 'ec.ecoairlines.internal.schedule.published', subject: 'EA300-EA301', data: { routeId: 'EA300-EA301' } });
  });

  it('★ fallo en cada paso: se restaura la ruta (crear → borrar; modificar → la definición anterior; borrar → restaurar)', async () => {
    const post = () => as(http().post('/sagas/routes'), { actor: ADMIN }).send(route);
    await failEachStep([{ key: 'schedule POST route', undo: ['schedule DELETE route'], undoIfDone: true }, { key: 'schedule GET timetable' }, { key: 'offers PublishTimetable' }], post);
    const put = () => as(http().put('/sagas/routes/EA300-EA301'), { actor: ADMIN }).send(route);
    await failEachStep([{ key: 'schedule GET route' }, { key: 'offers CountSoldSeats' }, { key: 'schedule PUT route', undo: ['schedule PUT route'] }, { key: 'schedule GET timetable' }, { key: 'offers PublishTimetable' }], put);
    const del = () => as(http().delete('/sagas/routes/EA300-EA301'), { actor: ADMIN }).send();
    await failEachStep([{ key: 'schedule GET route' }, { key: 'offers CountSoldSeats' }, { key: 'schedule DELETE route', undo: ['schedule POST route'] }, { key: 'schedule GET timetable' }, { key: 'offers PublishTimetable' }], del);
    expect(msg.calls('schedule', 'POST').at(-1)!.path).toBe('/routes?restoreRouteId=EA300-EA301');
  });

  it('★ M-1: antes de publicar, el ESB pide el catálogo a Schedule y Offers lo recibe con el horario (si Schedule no responde, va el que tiene)', async () => {
    const jipijapa = { code: 'JPJ', city: 'Jipijapa', name: 'Aeródromo de Jipijapa', country: 'EC', province: 'Manabí', lat: -1.3486, lon: -80.5786, utcOffsetMinutes: -300, active: true };
    try {
      msg.on('schedule', 'GET', '/airports', () => ({ status: 200, body: [...Object.values(SEED_AIRPORTS).map((item) => ({ ...item, active: true })), jipijapa] }));
      expect((await as(http().post('/sagas/routes'), { actor: ADMIN }).send(route)).status).toBe(201);
      const airports = offers.calls.find((c) => c.rpc === 'PublishTimetable')!.request['airports'] as { code: string; utcOffsetMinutes: number }[];
      expect(airports).toHaveLength(35);
      expect(airports.find((item) => item.code === 'JPJ')).toMatchObject({ city: 'Jipijapa', country: 'EC', utcOffsetMinutes: -300 });
      expect(AIRPORTS['JPJ']).toBeDefined();
      // M-2: también los tipos de avión con su mapa de cabinas; los vuelos a Offers no llevan el tiempo en tierra (va aparte).
      const request = offers.calls.find((c) => c.rpc === 'PublishTimetable')!.request;
      expect((request['aircraftTypes'] as { name: string }[]).map((type) => type.name)).toEqual(['Airbus A220-300', 'Airbus A320neo', 'Boeing 787-9']);
      expect((request['aircraftTypes'] as { name: string; turnaroundMinutes: number; cabins: { layout: string }[] }[])[1]).toMatchObject({ turnaroundMinutes: 45, cabins: [{ layout: 'AC-DF' }, { layout: 'ABC-DEF' }] });
    } finally {
      removeAirport('JPJ');
    }
  });

  it('publicar todo: la ventana completa y los precios (reemplaza al script de desarrollo)', async () => {
    expect((await as(http().post('/sagas/timetable/publish'), { actor: ADMIN }).send()).status).toBe(200);
    expect(offers.calls.find((c) => c.rpc === 'PublishTimetable')!.request['flights']).toHaveLength(2);
    expect(offers.calls.find((c) => c.rpc === 'PublishTimetable')!.request['routeId']).toBeUndefined();
    expect(log).toContain('offers PublishFarePrices');
  });
});

// ======================================================================================================== Motor y eventos

describe('motor de sagas: reanudar tras un reinicio', () => {
  const record = (over: Partial<SagaRecord>): SagaRecord => ({
    sagaId: randomUUID(), type: 'ISSUE_TICKETS', status: 'RUNNING', input: { bookingId: B }, steps: [], result: null, error: null, ownerId: OWNER, actorId: null,
    correlationId: 'corr-reanudar', parentSagaId: null, attempts: 1, leaseUntil: new Date(Date.now() - 1).toISOString(), nextAttemptAt: new Date(Date.now() - 1).toISOString(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
  });

  it('una saga RUNNING abandonada se retoma: los pasos hechos NO se repiten', async () => {
    booking = view(B, { status: 'TICKET_ISSUING' });
    const saga = record({ steps: [{ name: 'bookings.get', status: 'DONE', result: booking, at: '' }, { name: 'offers.ticket-seats', status: 'DONE', result: {}, at: '' }] });
    await store.insertSaga(saga);
    await engine.recover();
    expect(log).toEqual(['bookings POST tickets']);
    expect((await store.saga(saga.sagaId))!).toMatchObject({ status: 'COMPLETED', attempts: 2 });
  });

  it('una saga que quedó COMPENSATING termina de compensar (incluido el paso que había empezado)', async () => {
    const saga = record({ status: 'COMPENSATING', error: { status: 409, code: 'X', title: 'x' }, steps: [{ name: 'bookings.get', status: 'DONE', result: view(), at: '' }, { name: 'offers.ticket-seats', status: 'STARTED', at: '' }] });
    await store.insertSaga(saga);
    await engine.recover();
    expect(log).toEqual(['offers Transition TICKETED>BOOKED']);
    expect((await store.saga(saga.sagaId))!.status).toBe('COMPENSATED');
  });

  it('una compensación con el MS.G caído queda pendiente; una rechazada por regla de negocio deja la saga FAILED (revisión)', async () => {
    failure = { key: 'offers Transition TICKETED>BOOKED', status: 503, code: 'PROVIDER_UNAVAILABLE' };
    const pending = record({ status: 'COMPENSATING', error: { status: 409, code: 'X', title: 'x' }, steps: [{ name: 'bookings.get', status: 'DONE', result: view(), at: '' }, { name: 'offers.ticket-seats', status: 'DONE', at: '' }] });
    await store.insertSaga(pending);
    await engine.recover();
    expect((await store.saga(pending.sagaId))!.status).toBe('COMPENSATING');
    failure = { key: 'offers Transition TICKETED>BOOKED', status: 409, code: 'REGLA' };
    await store.saveSaga({ ...(await store.saga(pending.sagaId))!, leaseUntil: new Date(Date.now() - 1).toISOString(), nextAttemptAt: new Date(Date.now() - 1).toISOString() });
    await engine.recover();
    expect((await store.saga(pending.sagaId))!).toMatchObject({ status: 'FAILED', error: { compensationFailed: { step: 'offers.ticket-seats' } } });
  });

  it('GET /sagas/{id}: sin la entrada (datos personales) y solo para su dueño o un administrador', async () => {
    const response = await createBooking();
    const sagaId = response.headers['x-saga-id'];
    const own = await as(http().get(`/sagas/${sagaId}`));
    expect(own.status).toBe(200);
    expectContract('GET', '/sagas/{sagaId}', own);
    expect(own.body.input).toBeUndefined();
    expect(JSON.stringify(own.body)).not.toContain('1712345678');
    expect((await as(http().get(`/sagas/${sagaId}`), { owner: 'partner:BOOKING_PROTOTIPO:otro' })).status).toBe(404);
    expect((await as(http().get(`/sagas/${sagaId}`), { actor: ADMIN })).status).toBe(200);
  });
});

describe('entrada de eventos de Booking → sagas', () => {
  const deliver = (event: unknown) => {
    const body = JSON.stringify(event);
    return http().post('/integraciones/booking/eventos').set('Content-Type', 'application/cloudevents+json').set('X-Webhook-Signature', signWebhook('secreto-de-prueba-eventos-booking', body)).send(body);
  };
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await inbound.processDue();
  };

  it('★ package.cancelled → "Cancelar" con SAGA_COMPENSATION (100 % sin penalidad); repetido no se cancela dos veces', async () => {
    const event = { specversion: '1.0', type: 'ec.edu.epn.booking.paquetes.package.cancelled', source: '/booking-prototipo', id: randomUUID(), time: new Date().toISOString(), datacontenttype: 'application/json', correlationid: 'corr-combo-77', data: { packageId: 'PKG-UIO-GYE-1', bookingId: B, reason: 'Falló el hotel' } };
    booking = view(B, { status: 'TICKET_ISSUING' }); // el combo falló antes de emitir los boletos
    await deliver(event);
    await settle();
    await deliver(event); // el mismo evento otra vez: no se procesa
    await deliver({ ...event, id: randomUUID() }); // otro id, mismo combo: la reserva ya está cancelada
    await settle();
    expect(postSale.calls.filter((c) => c.operation === 'CalculateCompensationRefund')).toHaveLength(1);
    expect(msg.calls('bookings', 'POST', /cancellation$/)).toHaveLength(1);
    expect((await store.inbound(event.id))!).toMatchObject({ status: 'PROCESSED', outcome: { action: 'cancel', refund: { penaltyWaived: true } } });
    expect(publisher.published.find((p) => p.event.type.endsWith('booking.cancelled'))!.event.correlationid).toBe('corr-combo-77');
  });

  it('un combo que no es el de la reserva se rechaza', async () => {
    const event = { specversion: '1.0', type: 'ec.edu.epn.booking.paquetes.package.cancelled', source: '/booking-prototipo', id: randomUUID(), time: new Date().toISOString(), datacontenttype: 'application/json', correlationid: 'c', data: { packageId: 'PKG-OTRO', bookingId: B } };
    await deliver(event);
    await settle();
    expect((await store.inbound(event.id))!).toMatchObject({ status: 'REJECTED', outcome: { problem: { code: 'VALIDATION_FAILED' } } });
  });
});

it('las 11 sagas del plan (más "Asistencia lista") están registradas en el motor', () => {
  expect(Object.keys(sagas).length).toBeGreaterThan(0);
  const registered = [...(engine as unknown as { definitions: Map<string, unknown> }).definitions.keys()].sort();
  expect(registered).toEqual(['ADD_BAGGAGE', 'ASSISTANCE_READY', 'CANCEL_BOOKING', 'CHANGE_DATE', 'CHANGE_SEATS', 'CHECK_IN', 'CREATE_BOOKING', 'ISSUE_TICKETS', 'PAYMENT_FAILED', 'PUBLISH_TIMETABLE', 'SAVE_PRICES', 'UPDATE_FLIGHT_STATUS']);
});
