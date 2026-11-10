import type { NestExpressApplication } from '@nestjs/platform-express';
import { buildSchema, parse, validate } from 'graphql';
import request from 'supertest';
import { ADMIN_SUB, CUSTOMER_SUB, tokens } from '../../../tests/support/response-service.js';
import { depthLimit } from '../src/graphql/limits.js';
import { createGatewayApp, type FakeServices, problem, resetFakeServices, startFakeServices, stopFakeServices } from './support.js';

/**
 * GraphQL del gateway (V2.13, contrato `gateway.graphql`): solo tokens de usuario, `@auth(scopes)`, ProblemDetails en
 * `errors[].extensions`, `@constraint`, profundidad y complejidad, y cada campo hacia su operación REST del MS de respuesta.
 */
let fakes: FakeServices;
let app: NestExpressApplication;
const BOOKING_ID = '7bc123b6-ec50-4676-8b88-8f82a8c00ac7';
const HOLD_ID = '2f1d1a0e-0f5b-4c8a-9d1e-3b2a1c0d9e8f';
const MONEY = { currency: 'USD', baseFare: '80.00', taxes: '20.00', total: '100.00' };
const BOOKING = { bookingId: BOOKING_ID, pnr: 'ABC123', status: 'CONFIRMED', grandTotal: MONEY, createdAt: '2026-10-26T10:00:00Z', itineraries: [], passengers: [{ passengerId: 'PAX-1', passengerType: 'ADULT', firstName: 'Ana', lastName: 'Paz', documentType: 'NATIONAL_ID', documentNumber: '1710034065', nationality: 'EC', birthDate: '1995-03-14', gender: 'F', contact: { email: 'ana@x.test', phone: '+593987654321' } }], tickets: [] };

const gql = (query: string, variables: Record<string, unknown> = {}, authorization?: string, headers: Record<string, string> = {}) => {
  const call = request(app.getHttpServer()).post('/api/graphql').set('Content-Type', 'application/json').set(headers);
  if (authorization) call.set('Authorization', authorization);
  return call.send({ query, variables });
};

beforeAll(async () => {
  fakes = await startFakeServices();
  ({ app } = await createGatewayApp(fakes, { RATE_LIMIT_SEARCH_LIMIT: '2' }));
});
afterAll(async () => {
  await app.close();
  await stopFakeServices(fakes);
});
beforeEach(() => resetFakeServices(fakes));

describe('autenticación (solo tokens de usuario)', () => {
  it('★ una operación protegida sin token → HTTP 401 con UNAUTHENTICATED y el ProblemDetails en extensions', async () => {
    const response = await gql('{ bookings { items { pnr } } }').set('X-Correlation-Id', 'corr-web-1').expect(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.headers['x-correlation-id']).toBe('corr-web-1');
    expect(response.body.errors[0]).toMatchObject({
      message: expect.stringContaining('token'),
      path: ['bookings'],
      extensions: { code: 'UNAUTHENTICATED', status: 401, type: 'about:blank', instance: '/api/graphql', correlation_id: 'corr-web-1', timestamp: expect.any(String) },
    });
    expect(fakes['MS.Reservas'].calls).toHaveLength(0);
  });

  it.each([
    ['de partner', tokens.partner()],
    ['de servicio', tokens.service()],
    ['vencido', tokens.expired()],
  ])('un token %s → 401 UNAUTHENTICATED (GraphQL es solo de la web)', async (_label, token) => {
    const response = await gql('{ bookings { items { pnr } } }', {}, token).expect(401);
    expect(response.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('sin el scope → FORBIDDEN (HTTP 200: es un error de negocio) y no se llama al MS', async () => {
    const response = await gql('{ users { items { email } } }', {}, tokens.customer()).expect(200);
    expect(response.body.errors[0].extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(response.body.errors[0].message).toContain('ecoairlines:admin');
    expect(fakes['MS.Admin'].calls).toHaveLength(0);
  });

  it('me: los datos del token sin llamar a ningún servicio (scopes como enum)', async () => {
    const response = await gql('{ me { sub fullName email role scopes } }', {}, tokens.customer()).expect(200);
    expect(response.body.data.me).toEqual({ sub: CUSTOMER_SUB, fullName: 'Ana Paz', email: 'ana.paz@ecoairlines.test', role: 'CUSTOMER', scopes: ['FLIGHTS_READ', 'FLIGHTS_HOLD', 'FLIGHTS_BOOK', 'FLIGHTS_CANCEL', 'ECOAIRLINES_PROFILE'] });
    expect(Object.values(fakes).every((fake) => fake.calls.length === 0)).toBe(true);
  });

  it('las operaciones públicas no piden token; el token del usuario viaja al MS (que vuelve a verificarlo)', async () => {
    fakes['MS.Vuelos'].on('GET', /\/api\/v2\/vuelos\/flights\/EA101\/status/, { body: { flightNumber: 'EA101', date: '2026-11-04', marketingCarrier: 'EA', operatingCarrier: 'EA', departure: { iataCode: 'UIO', scheduledAt: '2026-11-04T08:00:00Z', gate: 'A3' }, arrival: { iataCode: 'GYE', scheduledAt: '2026-11-04T09:00:00Z' }, status: 'SCHEDULED' } });
    const anonymous = await gql('{ flightStatus(flightNumber: "EA101", date: "2026-11-04") { status departure { gate } } }').expect(200);
    expect(anonymous.body.data.flightStatus).toEqual({ status: 'SCHEDULED', departure: { gate: 'A3' } });
    expect(fakes['MS.Vuelos'].last()!.path).toBe('/api/v2/vuelos/flights/EA101/status?date=2026-11-04');
    const customer = tokens.customer();
    fakes['MS.Reservas'].on('GET', '/api/v2/vuelos/bookings', { body: { items: [], nextCursor: null } });
    await gql('{ bookings { nextCursor } }', {}, customer).expect(200);
    expect(fakes['MS.Reservas'].last()!.headers['authorization']).toBe(customer);
  });
});

describe('errores del MS → errors[].extensions', () => {
  it('★ NOT_FOUND del MS (recurso ajeno o inexistente) con su title; el resto de la respuesta sigue (data parcial)', async () => {
    fakes['MS.Reservas'].on('GET', `/api/v2/vuelos/bookings/${BOOKING_ID}`, { status: 404, body: problem(404, 'NOT_FOUND', 'Reserva no encontrada.') });
    const response = await gql(`{ booking(bookingId: "${BOOKING_ID}") { pnr } me { sub } }`, {}, tokens.customer()).expect(200);
    expect(response.body.data).toBeNull(); // booking es no nulo: el null sube hasta data
    expect(response.body.errors[0]).toMatchObject({ message: 'Reserva no encontrada.', extensions: { code: 'NOT_FOUND', status: 404 } });
  });

  it('★ un código propio (type urn:ecoairlines:problema:X) recupera su nombre del enum ProblemCode', async () => {
    fakes['MS.Clientes'].on('POST', '/api/v2/ecoairlines/auth/register', { status: 409, body: problem(409, 'VALIDATION_FAILED', 'El correo ya está registrado.', { type: 'urn:ecoairlines:problema:EMAIL_ALREADY_REGISTERED' }) });
    const response = await gql('mutation($i: RegisterInput!) { register(input: $i) { accessToken } }', { i: { fullName: 'Ana', email: 'ana@x.test', password: 'Clave-segura-1' } }).expect(200);
    expect(response.body.errors[0].extensions).toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED', status: 409, type: 'urn:ecoairlines:problema:EMAIL_ALREADY_REGISTERED' });
  });

  it('VALIDATION_FAILED del MS con invalidParams; 503 con retryAfter', async () => {
    fakes['MS.Postventa'].on('POST', `/api/v2/vuelos/bookings/${BOOKING_ID}/date-change/search`, { status: 400, body: problem(400, 'VALIDATION_FAILED', 'La petición no cumple el contrato.', { invalidParams: [{ name: 'changes[0].newDepartureDate', reason: 'fecha pasada' }] }) });
    const invalid = await gql(`{ dateChangeOptions(bookingId: "${BOOKING_ID}", input: { changes: [{ itineraryId: "IT-1", newDepartureDate: "2026-01-01" }] }) { changeOfferId } }`, {}, tokens.customer()).expect(200);
    expect(invalid.body.errors[0].extensions).toMatchObject({ code: 'VALIDATION_FAILED', invalidParams: [{ name: 'changes[0].newDepartureDate', reason: 'fecha pasada' }] });
    fakes['MS.Admin'].on('GET', '/api/v2/ecoairlines/admin/telemetry/queues', { status: 503, body: problem(503, 'PROVIDER_UNAVAILABLE', 'Disponible en V2.16.'), headers: { 'retry-after': '30' } });
    const unavailable = await gql('{ telemetry { queues { queue } } }', {}, tokens.admin()).expect(200);
    expect(unavailable.body.errors[0].extensions).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503, retryAfter: 30 });
  });

  it('el MS no responde → PROVIDER_UNAVAILABLE con retryAfter', async () => {
    fakes['MS.Reservas'].down = true;
    const response = await gql('{ bookings { nextCursor } }', {}, tokens.customer()).expect(200);
    expect(response.body.errors[0].extensions).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryAfter: 5 });
  });
});

describe('documento: escalares, @constraint, profundidad y complejidad', () => {
  it('un escalar inválido (UUID) → 400 VALIDATION_FAILED antes de llamar al MS', async () => {
    const response = await gql('{ booking(bookingId: "no-es-uuid") { pnr } }', {}, tokens.customer()).expect(400);
    expect(response.body.errors[0].extensions).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    expect(fakes['MS.Reservas'].calls).toHaveLength(0);
  });

  it('★ @constraint: limit fuera de rango y listas vacías → VALIDATION_FAILED con los nombres de GraphQL', async () => {
    const limit = await gql('{ bookings(limit: 51) { nextCursor } }', {}, tokens.customer()).expect(200);
    expect(limit.body.errors[0].extensions).toMatchObject({ code: 'VALIDATION_FAILED', invalidParams: [{ name: 'limit', reason: 'máximo 50' }] });
    const search = await gql('query($i: SearchFlightsInput!) { searchFlights(input: $i) { totalOffers } }', { i: { itineraries: [], passengers: { adults: 0 } } }, undefined, { 'X-Device-Fingerprint': 'fp-c' }).expect(200);
    expect(search.body.errors[0].extensions.invalidParams).toEqual([
      { name: 'input.itineraries', reason: 'al menos 1 elemento(s)' },
      { name: 'input.passengers.adults', reason: 'mínimo 1' },
    ]);
    expect(fakes['MS.Vuelos'].calls).toHaveLength(0);
  });

  it('profundidad: la regla rechaza más de 10 niveles (con fragmentos); en gateway.graphql ningún camino válido pasa de 8', () => {
    const recursive = buildSchema('type Query { n: N } type N { n: N v: Int }');
    const levels = (depth: number) => `{ ${'n { '.repeat(depth - 1)}v${' }'.repeat(depth - 1)} }`;
    expect(validate(recursive, parse(levels(10)), [depthLimit()])).toHaveLength(0);
    expect(validate(recursive, parse(levels(11)), [depthLimit()])[0]!.message).toContain('profundidad 11');
    const viaFragment = `{ n { ...F } } fragment F on N { ${'n { '.repeat(9)}v${' }'.repeat(9)} }`;
    expect(validate(recursive, parse(viaFragment), [depthLimit()])).toHaveLength(1);
  });

  it('★ complejidad > 1000 → HTTP 400 VALIDATION_FAILED sin llamar al MS (una lista con limit multiplica)', async () => {
    const complex = await gql('{ users(limit: 100) { items { sub email fullName role status createdAt createdBy updatedAt lastLoginAt } nextCursor } }', {}, tokens.admin()).expect(400);
    expect(complex.body.errors[0].extensions).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    expect(complex.body.errors[0].message).toContain('complejidad');
    expect(fakes['MS.Admin'].calls).toHaveLength(0);
    fakes['MS.Admin'].on('GET', /\/api\/v2\/ecoairlines\/admin\/users/, { body: { items: [] } });
    await gql('{ users(limit: 20) { items { sub email fullName role status createdAt createdBy updatedAt lastLoginAt } nextCursor } }', {}, tokens.admin()).expect(200);
  });

  it('introspección permitida en desarrollo (en producción se desactiva: GRAPHQL_INTROSPECTION)', async () => {
    const response = await gql('{ __schema { queryType { name } } }').expect(200);
    expect(response.body.data.__schema.queryType.name).toBe('Query');
  });
});

describe('cada campo → su operación REST', () => {
  it('searchFlights: X-Device-Fingerprint al MS y límite por huella (RATE_LIMIT_EXCEEDED)', async () => {
    fakes['MS.Vuelos'].on('POST', '/api/v2/vuelos/search', { body: { totalOffers: 0, offers: [] } });
    const variables = { i: { itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: '2026-11-20' }], passengers: { adults: 1 } } };
    const search = () => gql('query($i: SearchFlightsInput!) { searchFlights(input: $i) { totalOffers } }', variables, undefined, { 'X-Device-Fingerprint': 'fp-web-1' });
    expect((await search().expect(200)).body.data.searchFlights.totalOffers).toBe(0);
    expect(fakes['MS.Vuelos'].last()!.headers['x-device-fingerprint']).toBe('fp-web-1');
    expect(fakes['MS.Vuelos'].last()!.json).toEqual({ itineraries: variables.i.itineraries, passengers: { adults: 1, youths: 0, children: 0, infants: 0 } });
    await search().expect(200);
    const limited = await search().expect(200);
    expect(limited.body.errors[0].extensions).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', status: 429 });
  });

  it('★ createBooking: POST /ecoairlines/bookings con provider AIRLINE_DIRECT e Idempotency-Key; 201 → COMPLETED, 202 → ACCEPTED', async () => {
    const key = crypto.randomUUID();
    const passenger = { passengerId: 'PAX-1', passengerType: 'ADULT', firstName: 'Ana', lastName: 'Paz', documentType: 'NATIONAL_ID', documentNumber: '1710034065', nationality: 'EC', birthDate: '1995-03-14', gender: 'F', contact: { email: 'ana@x.test', phone: '+593987654321' }, associatedAdultId: null };
    const input = { holdId: HOLD_ID, passengers: [passenger], payment: { paymentReference: 'pay_123' }, assistance: [{ passengerId: 'PAX-1', type: 'WCHR' }] };
    const mutation = 'mutation($k: UUID!, $i: CreateBookingInput!) { createBooking(idempotencyKey: $k, input: $i) { outcome booking { pnr status passengers { assignedSeats { seatNumber } } } } }';
    fakes['MS.Reservas'].on('POST', '/api/v2/ecoairlines/bookings', { status: 201, body: BOOKING });
    const created = await gql(mutation, { k: key, i: input }, tokens.customer()).expect(200);
    expect(created.body.data.createBooking).toEqual({ outcome: 'COMPLETED', booking: { pnr: 'ABC123', status: 'CONFIRMED', passengers: [{ assignedSeats: [] }] } });
    const call = fakes['MS.Reservas'].last()!;
    expect(call.headers['idempotency-key']).toBe(key);
    const { associatedAdultId: _null, ...withoutNull } = passenger;
    expect(call.json).toEqual({ booking: { holdId: HOLD_ID, passengers: [withoutNull], payment: { paymentReference: 'pay_123', provider: 'AIRLINE_DIRECT' } }, assistance: [{ passengerId: 'PAX-1', type: 'WCHR', needsCompanion: false }] });
    fakes['MS.Reservas'].on('POST', '/api/v2/ecoairlines/bookings', { status: 202, body: { ...BOOKING, status: 'TICKET_ISSUING' } });
    expect((await gql(mutation, { k: crypto.randomUUID(), i: input }, tokens.customer())).body.data.createBooking.outcome).toBe('ACCEPTED');
  });

  it('holdInventory (remainingSeconds calculado) y hold (getHold); cancelBooking siempre CUSTOMER_REQUEST', async () => {
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    fakes['MS.Reservas'].on('POST', '/api/v2/vuelos/offers/hold', { status: 201, body: { holdId: HOLD_ID, status: 'HELD', expiresAt, ttlMinutes: 15, lockedPrice: MONEY } });
    const hold = await gql('mutation($k: UUID!) { holdInventory(idempotencyKey: $k, input: { offerId: "OF-1", itinerarySelections: [{ itineraryId: "IT-1", cabinClass: ECONOMY, fareBrand: "SEMILLA" }], passengersBreakdown: { adults: 1 } }) { holdId remainingSeconds ttlMinutes } }', { k: crypto.randomUUID() }, tokens.customer()).expect(200);
    expect(hold.body.data.holdInventory).toMatchObject({ holdId: HOLD_ID, ttlMinutes: 15 });
    expect(hold.body.data.holdInventory.remainingSeconds).toBeGreaterThan(590);
    fakes['MS.Postventa'].on('POST', `/api/v2/vuelos/bookings/${BOOKING_ID}/cancel`, { body: { bookingId: BOOKING_ID, pnr: 'ABC123', status: 'CANCELLED', refund: { refundId: 'R-1', amount: '75.00', penaltyAmount: '25.00', currency: 'USD', status: 'SETTLED' }, inventoryRestoration: { status: 'RESTORED', seatsReleased: 1 } } });
    const cancel = await gql(`mutation($k: UUID!) { cancelBooking(idempotencyKey: $k, bookingId: "${BOOKING_ID}", input: { quoteId: "Q-1" }) { outcome status seatsReleased refund { amount status } } }`, { k: crypto.randomUUID() }, tokens.customer()).expect(200);
    expect(cancel.body.data.cancelBooking).toEqual({ outcome: 'COMPLETED', status: 'CANCELLED', seatsReleased: 1, refund: { amount: '75.00', status: 'SETTLED' } });
    expect(fakes['MS.Postventa'].last()!.json).toEqual({ quoteId: 'Q-1', reasonCode: 'CUSTOMER_REQUEST' });
  });

  it('Booking: tickets de la propia reserva; refunds y assistance por sus operaciones propias (con el mismo token)', async () => {
    fakes['MS.Reservas'].on('GET', `/api/v2/vuelos/bookings/${BOOKING_ID}`, { body: BOOKING });
    fakes['MS.Reservas'].on('GET', `/api/v2/ecoairlines/bookings/${BOOKING_ID}/refunds`, { body: [{ refundId: 'R-1', amount: '75.00', penaltyAmount: '25.00', currency: 'USD', status: 'CALCULATED' }] });
    fakes['MS.Reservas'].on('GET', `/api/v2/ecoairlines/bookings/${BOOKING_ID}/assistance`, { body: [{ passengerId: 'PAX-1', type: 'WCHR', needsCompanion: false, status: 'REQUESTED', updatedAt: '2026-10-26T10:00:00Z' }] });
    const response = await gql(`{ booking(bookingId: "${BOOKING_ID}") { tickets { ticketId } refunds { refundId status } assistance { type status } } }`, {}, tokens.customer()).expect(200);
    expect(response.body.data.booking).toEqual({ tickets: [], refunds: [{ refundId: 'R-1', status: 'CALCULATED' }], assistance: [{ type: 'WCHR', status: 'REQUESTED' }] });
    expect(fakes['MS.Reservas'].calls.map((c) => c.path).filter((p) => p.endsWith('/tickets'))).toHaveLength(0);
  });

  it('webhooks: eventos booking.confirmed ↔ BOOKING_CONFIRMED y el secreto enmascarado con sus últimos 4 caracteres', async () => {
    const subscription = { id: '0b7c4c4e-2f8e-4c41-9a39-5f6f2a7e1b10', url: 'https://admin.ecoairlines.test/hook', events: ['booking.confirmed', 'flight.status_changed'], active: true, createdAt: '2026-10-26T10:00:00Z' };
    fakes['MS.Clientes'].on('POST', '/api/v2/vuelos/webhooks', { status: 201, body: subscription });
    const response = await gql('mutation { registerWebhook(input: { url: "https://admin.ecoairlines.test/hook", events: [BOOKING_CONFIRMED, FLIGHT_STATUS_CHANGED], secret: "secreto-de-16-caracteres" }) { events secret } }', {}, tokens.admin()).expect(200);
    expect(response.body.data.registerWebhook).toEqual({ events: ['BOOKING_CONFIRMED', 'FLIGHT_STATUS_CHANGED'], secret: '••••eres' });
    expect(fakes['MS.Clientes'].last()!.json).toEqual({ url: 'https://admin.ecoairlines.test/hook', events: ['booking.confirmed', 'flight.status_changed'], secret: 'secreto-de-16-caracteres' });
    fakes['MS.Clientes'].on('GET', '/api/v2/ecoairlines/webhooks', { body: [{ ...subscription, secretHint: '9f3a' }] });
    const list = await gql('{ webhookSubscriptions { url secret } }', {}, tokens.admin()).expect(200);
    expect(list.body.data.webhookSubscriptions).toEqual([{ url: subscription.url, secret: '••••9f3a' }]);
  });

  it('login: AuthPayload con los scopes del token como enum', async () => {
    fakes['MS.Clientes'].on('POST', '/api/v2/ecoairlines/auth/login', { body: { access_token: 'tok', token_type: 'Bearer', expires_in: 3600, scope: 'flights:read flights:ops ecoairlines:admin', user: { sub: ADMIN_SUB, fullName: 'Admin', email: 'admin@x.test', role: 'ADMIN' } } });
    const response = await gql('mutation { login(input: { email: "admin@x.test", password: "x" }) { accessToken expiresIn user { role scopes } } }').expect(200);
    expect(response.body.data.login).toEqual({ accessToken: 'tok', expiresIn: 3600, user: { role: 'ADMIN', scopes: ['FLIGHTS_READ', 'FLIGHTS_OPS', 'ECOAIRLINES_ADMIN'] } });
  });

  it('administración: precios y promociones (snake_case ↔ camelCase), partners (scopes) e indicadores', async () => {
    const view = { prices: { items: [{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', referenceMultiplier: 1, multiplier: 1.1, updatedAt: '2026-10-26T10:00:00Z' }], updatedAt: '2026-10-26T10:00:00Z' }, promotions: [{ partnerId: 'BOOKING_PROTOTIPO', proveedor_codigo: 'NODE_VUE_ECOAIRLINES', permite_promociones: true, porcentaje_descuento_maximo: 20, cabinas_habilitadas: ['ECONOMY'] }] };
    fakes['MS.Admin'].on('GET', '/api/v2/ecoairlines/admin/prices', { body: view }).on('PUT', '/api/v2/ecoairlines/admin/prices', { body: view });
    const prices = await gql('{ prices { prices { multiplier } promotions { partnerId allowsPromotions maxDiscountPercentage enabledCabins enabledRoutes } } promotionAgreement(partnerId: "BOOKING_PROTOTIPO") { maxDiscountPercentage } }', {}, tokens.admin()).expect(200);
    expect(prices.body.data).toEqual({ prices: { prices: [{ multiplier: 1.1 }], promotions: [{ partnerId: 'BOOKING_PROTOTIPO', allowsPromotions: true, maxDiscountPercentage: 20, enabledCabins: ['ECONOMY'], enabledRoutes: [] }] }, promotionAgreement: { maxDiscountPercentage: 20 } });
    await gql('mutation { savePrices(input: { prices: [{ cabinClass: BUSINESS, fareBrand: "DOSEL", multiplier: 2.5 }], promotion: { partnerId: "BOOKING_PROTOTIPO", allowsPromotions: true, maxDiscountPercentage: 15 } }) { updatedAt } }', {}, tokens.admin()).expect(200);
    expect(fakes['MS.Admin'].last('PUT')!.json).toEqual({ prices: { items: [{ cabinClass: 'BUSINESS', fareBrand: 'DOSEL', multiplier: 2.5 }] }, promotion: { partnerId: 'BOOKING_PROTOTIPO', agreement: { permite_promociones: true, porcentaje_descuento_maximo: 15 } } });

    // P-1: la vista trae la tarifa base (por defecto si MS.Admin aún no la manda) y «Guardar» pasa la tarifa base y la ruta.
    expect((await gql('{ prices { pricing { fixedCharge perKm routePrices { routeId } } } }', {}, tokens.admin()).expect(200)).body.data.prices.pricing).toEqual({ fixedCharge: 35, perKm: 0.085, routePrices: [] });
    await gql('mutation { savePrices(input: { pricing: { perKm: 0.09, route: { routeId: "EA324-EA325", prices: [{ fareBrand: "SEMILLA", amount: 70 }, { fareBrand: "BROTE", amount: 95 }, { fareBrand: "BOSQUE", amount: 125 }, { fareBrand: "DOSEL", amount: 220 }] } } }) { updatedAt } }', {}, tokens.admin()).expect(200);
    expect(fakes['MS.Admin'].last('PUT')!.json).toEqual({ pricing: { perKm: 0.09, route: { routeId: 'EA324-EA325', prices: [{ fareBrand: 'SEMILLA', amount: 70 }, { fareBrand: 'BROTE', amount: 95 }, { fareBrand: 'BOSQUE', amount: 125 }, { fareBrand: 'DOSEL', amount: 220 }] } } });

    fakes['MS.Admin'].on('POST', '/api/v2/ecoairlines/admin/partners', { status: 201, body: { clientId: 'OTRO_PARTNER', name: 'Otro', scopes: ['flights:read', 'flights:hold'], status: 'ACTIVE', createdAt: '2026-10-26T10:00:00Z', clientSecret: 'secreto-una-vez' } });
    const partner = await gql('mutation { createPartner(input: { clientId: "OTRO_PARTNER", name: "Otro", scopes: [FLIGHTS_READ, FLIGHTS_HOLD] }) { clientSecret partner { scopes status } } }', {}, tokens.admin()).expect(200);
    expect(partner.body.data.createPartner).toEqual({ clientSecret: 'secreto-una-vez', partner: { scopes: ['FLIGHTS_READ', 'FLIGHTS_HOLD'], status: 'ACTIVE' } });
    expect(fakes['MS.Admin'].last('POST')!.json).toEqual({ clientId: 'OTRO_PARTNER', name: 'Otro', scopes: ['flights:read', 'flights:hold'] });

    fakes['MS.Admin'].on('GET', '/api/v2/ecoairlines/admin/indicators', { body: { generatedAt: '2026-10-26T10:00:00Z', bookings: { totalBookings: 5, byStatus: {}, byChannel: { WEB: 2, BOOKING: 3 }, totalPassengers: 7, revenue: MONEY, byRoute: [] }, users: { total: 4, byRole: { CUSTOMER: 3, ADMIN: 1 }, byStatus: { ACTIVE: 4, BLOCKED: 0 } }, flightsToday: 6 } });
    const indicators = await gql('{ adminIndicators { totalBookings bookingsByChannel { web booking } customers admins flightsToday } }', {}, tokens.admin()).expect(200);
    expect(indicators.body.data.adminIndicators).toEqual({ totalBookings: 5, bookingsByChannel: { web: 2, booking: 3 }, customers: 3, admins: 1, flightsToday: 6 });
  });

  it('flightOperations (seatsByStatus en camelCase) y telemetría (latency_ms → latencyMs; un trace inexistente → null)', async () => {
    fakes['MS.Vuelos'].on('GET', /\/api\/v2\/vuelos\/operaciones\/vuelos/, { body: { date: '2026-11-04', totalFlights: 1, nextCursor: null, items: [{ flightNumber: 'EA101', date: '2026-11-04', origin: 'UIO', destination: 'GYE', departureAt: '2026-11-04T08:00:00Z', status: 'SCHEDULED', totalSeats: 2, loadFactor: 50, cabins: [{ cabinClass: 'ECONOMY', totalSeats: 2, seatsByStatus: { AVAILABLE: 1, HELD: 0, BOOKED: 1, TICKETED: 0, CHECKED_IN: 0, BOARDED: 0 } }], activeHolds: 0, checkInOpen: false, alerts: [] }] } });
    const operations = await gql('{ flightOperations(date: "2026-11-04") { totalFlights items { cabins { seatsByStatus { available booked } } } } }', {}, tokens.admin()).expect(200);
    expect(operations.body.data.flightOperations).toEqual({ totalFlights: 1, items: [{ cabins: [{ seatsByStatus: { available: 1, booked: 1 } }] }] });
    expect(fakes['MS.Vuelos'].last()!.path).toBe('/api/v2/vuelos/operaciones/vuelos?date=2026-11-04&limit=10');
    fakes['MS.Admin'].on('GET', '/api/v2/ecoairlines/admin/telemetry/services', { body: [{ service: 'esb', status: 'UP', latency_ms: 12, checkedAt: '2026-10-26T10:00:00Z' }] });
    fakes['MS.Admin'].on('GET', /\/telemetry\/traces\//, { status: 404, body: problem(404, 'NOT_FOUND', 'Sin datos.') });
    const telemetry = await gql('{ telemetry { services { service latencyMs } trace(correlationId: "corr-x") { correlationId } } }', {}, tokens.admin()).expect(200);
    expect(telemetry.body).toEqual({ data: { telemetry: { services: [{ service: 'esb', latencyMs: 12 }], trace: null } } });
    await gql('{ telemetry { trace(correlationId: "corr-x", from: "2026-11-08T03:50:00Z", to: "2026-11-08T04:30:00Z") { correlationId } } }', {}, tokens.admin()).expect(200);
    expect(fakes['MS.Admin'].last()!.path).toBe('/api/v2/ecoairlines/admin/telemetry/traces/corr-x?from=2026-11-08T03%3A50%3A00Z&to=2026-11-08T04%3A30%3A00Z');

    // T-2: la ventana que usó el ESB y el aviso de Loki lento.
    fakes['MS.Admin'].on('GET', /\/telemetry\/traces\//, { body: { correlationId: 'corr-y', window: { from: '2026-11-05T13:50:00Z', to: '2026-11-05T14:10:05Z', source: 'RECORDS' }, steps: [], stepsError: 'La búsqueda tardó demasiado: prueba con un rango más corto.', sagas: [], events: { items: [] } } });
    const slow = await gql('{ telemetry { trace(correlationId: "corr-y") { window { source } stepsError steps { service } } } }', {}, tokens.admin()).expect(200);
    expect(slow.body.data.telemetry.trace).toEqual({ window: { source: 'RECORDS' }, stepsError: 'La búsqueda tardó demasiado: prueba con un rango más corto.', steps: [] });
  });

  it('★ panel O-1: adminBookings busca por referencia; adminBooking da la liquidación sin exponer la asistencia médica', async () => {
    const DHV = 'e8bead02-1587-4dcd-86c3-a54653fb0986';
    const SOLD = { currency: 'USD', baseFare: '59.00', taxes: '20.85', total: '79.85' };
    fakes['MS.Admin'].on('GET', /\/api\/v2\/ecoairlines\/admin\/bookings\?/, { body: { nextCursor: null, items: [{ bookingId: DHV, pnr: 'DHV47T', status: 'CANCELLED', origin: 'UIO', destination: 'GYE', departureDate: '2026-11-08', grandTotal: SOLD, channel: 'BOOKING', partnerId: 'BOOKING_PROTOTIPO', partnerOrderId: 'ORD-BKP-7B5BADB7C0', departureAt: '2026-11-08T07:00:00-05:00', passengerCount: 1, refundTotal: '20.85', createdAt: '2026-11-08T04:09:43.317Z' }] } });
    const list = await gql('query($f: AdminBookingFilterInput) { adminBookings(filter: $f) { items { pnr channel partnerOrderId passengerCount refundTotal grandTotal { total } } nextCursor } }', { f: { reference: 'ORD-BKP-7B5BADB7C0', channel: 'BOOKING' } }, tokens.admin()).expect(200);
    expect(list.body.data.adminBookings).toEqual({ nextCursor: null, items: [{ pnr: 'DHV47T', channel: 'BOOKING', partnerOrderId: 'ORD-BKP-7B5BADB7C0', passengerCount: 1, refundTotal: '20.85', grandTotal: { total: '79.85' } }] });
    expect(fakes['MS.Admin'].last()!.path).toBe('/api/v2/ecoairlines/admin/bookings?reference=ORD-BKP-7B5BADB7C0&channel=BOOKING&limit=20');

    fakes['MS.Admin'].on('GET', `/api/v2/ecoairlines/admin/bookings/${DHV}`, { body: {
      ...BOOKING, bookingId: DHV, pnr: 'DHV47T', status: 'CANCELLED', grandTotal: SOLD, channel: 'BOOKING', ownerId: 'partner:BOOKING_PROTOTIPO:7a1c2e9f-4b3d-4c8a-9e21-5f6d7c8b9a01',
      salesChannel: { partnerId: 'BOOKING_PROTOTIPO', partnerOrderId: 'ORD-BKP-7B5BADB7C0', promotionApplied: false }, paymentReference: 'PAY-BKP-20261107-030453',
      fares: [{ itineraryId: 'EA100-20261108', cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', segmentIds: ['EA100-20261108'], price: SOLD, isRefundable: false, isChangeable: false }],
      tickets: [{ ticketId: 'TKT-E8BEAD02-1', passengerId: 'PAX-1', passengerName: 'Ana Paz', eTicketNumber: '9997852910872', status: 'VOIDED', issuedAt: null, segments: [], failureReason: null }],
      refunds: [{ refundId: 'REF-1545C35F', amount: '20.85', penaltyAmount: '59.00', currency: 'USD', percentage: 26.11, status: 'CALCULATED' }],
      payments: [{ paymentReference: 'PAY-BKP-20261107-030453', provider: 'BOOKING_PROTOTIPO', operation: 'BOOKING', amount: { currency: 'USD', total: '79.85' }, bookingId: DHV, sagaId: HOLD_ID, claimedAt: '2026-11-08T04:09:43.258Z' }],
      assistance: [{ passengerId: 'PAX-1', type: 'WCHR', needsCompanion: true, notes: 'dato de salud', status: 'REQUESTED' }],
    } });
    const detail = await gql(`{ adminBooking(bookingId: "${DHV}") { pnr channel partnerUserId salesChannel { partnerOrderId } fares { fareBrand isRefundable price { baseFare taxes } } tickets { eTicketNumber status bookingId } refunds { amount penaltyAmount status } payments { paymentReference provider } passengersWithAssistance } }`, {}, tokens.admin()).expect(200);
    expect(detail.body.data.adminBooking).toEqual({
      pnr: 'DHV47T', channel: 'BOOKING', partnerUserId: '7a1c2e9f-4b3d-4c8a-9e21-5f6d7c8b9a01', salesChannel: { partnerOrderId: 'ORD-BKP-7B5BADB7C0' },
      fares: [{ fareBrand: 'SEMILLA', isRefundable: false, price: { baseFare: '59.00', taxes: '20.85' } }],
      tickets: [{ eTicketNumber: '9997852910872', status: 'VOIDED', bookingId: DHV }],
      refunds: [{ amount: '20.85', penaltyAmount: '59.00', status: 'CALCULATED' }],
      payments: [{ paymentReference: 'PAY-BKP-20261107-030453', provider: 'BOOKING_PROTOTIPO' }],
      passengersWithAssistance: ['PAX-1'],
    });
    expect(JSON.stringify(detail.body)).not.toContain('dato de salud');

    // O-2: el historial se pide solo si la web lo selecciona (una operación más).
    fakes['MS.Admin'].on('GET', `/api/v2/ecoairlines/admin/bookings/${DHV}/timeline`, { body: {
      bookingId: DHV,
      sagas: [{ sagaId: 'saga-1', type: 'CANCEL_BOOKING', status: 'COMPLETED', correlationId: 'corr-cancel', createdAt: '2026-11-08T04:09:59Z', updatedAt: '2026-11-08T04:09:59Z', steps: [{ name: 'postSale.consumeQuote', status: 'DONE', at: '2026-11-08T04:09:59Z' }] }],
      events: [{ seq: 9, id: 'evt-1', type: 'ec.edu.epn.booking.vuelos.booking.cancelled', subject: DHV, time: '2026-11-08T04:10:00Z', correlationId: 'corr-cancel', public: true, data: null, deliveries: [{ subscriptionId: HOLD_ID, target: 'booking.example', outcome: 'DELIVERED', httpStatus: 200, attempts: 1, nextRetryAt: null }] }],
    } });
    const timeline = await gql(`{ adminBooking(bookingId: "${DHV}") { timeline { sagas { type status correlationId parentSagaId errorCode steps { name status } } events { type correlationId deliveries { outcome httpStatus } } } } }`, {}, tokens.admin()).expect(200);
    expect(timeline.body.data.adminBooking.timeline).toEqual({
      sagas: [{ type: 'CANCEL_BOOKING', status: 'COMPLETED', correlationId: 'corr-cancel', parentSagaId: null, errorCode: null, steps: [{ name: 'postSale.consumeQuote', status: 'DONE' }] }],
      events: [{ type: 'ec.edu.epn.booking.vuelos.booking.cancelled', correlationId: 'corr-cancel', deliveries: [{ outcome: 'DELIVERED', httpStatus: 200 }] }],
    });
    const customer = await gql(`{ adminBooking(bookingId: "${DHV}") { pnr } }`, {}, tokens.customer()).expect(200);
    expect(customer.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('panel O-3: adminSalesReport con el rango; la liquidación con Booking reserva por reserva', async () => {
    fakes['MS.Admin'].on('GET', /\/api\/v2\/ecoairlines\/admin\/reports\/sales\?/, { body: { from: '2026-11-01', to: '2026-11-08', currency: 'USD', generatedAt: '2026-11-08T18:00:00Z',
      totals: { bookings: 1, cancelled: 1, passengers: 1, charged: '79.85', refunded: '20.85', net: '59.00' },
      byChannel: [{ channel: 'WEB', bookings: 0, charged: '0.00', refunded: '0.00', net: '0.00' }, { channel: 'BOOKING', bookings: 1, charged: '79.85', refunded: '20.85', net: '59.00' }],
      byDay: [{ date: '2026-11-07', channel: 'BOOKING', bookings: 1, charged: '79.85' }],
      byRoute: [{ origin: 'UIO', destination: 'GYE', bookings: 1, passengers: 1, charged: '79.85' }],
      bookingSettlement: { partnerId: 'BOOKING_PROTOTIPO', bookings: 1, charged: '79.85', refunded: '20.85', penalties: '59.00', net: '59.00', pendingRefunds: { count: 1, amount: '20.85' },
        items: [{ bookingId: 'e8bead02-1587-4dcd-86c3-a54653fb0986', pnr: 'DHV47T', partnerOrderId: 'ORD-BKP-7B5BADB7C0', paymentReference: 'PAY-BKP-20261107-030453', status: 'CANCELLED', createdAt: '2026-11-08T04:09:43Z', charged: '79.85', refunded: '20.85', penalty: '59.00', net: '59.00' }] } } });
    const report = await gql('{ adminSalesReport(from: "2026-11-01", to: "2026-11-08") { totals { charged refunded net } byDay { date channel charged } bookingSettlement { net pendingRefunds { count amount } items { pnr partnerOrderId net } } } }', {}, tokens.admin()).expect(200);
    expect(report.body.data.adminSalesReport).toEqual({
      totals: { charged: '79.85', refunded: '20.85', net: '59.00' },
      byDay: [{ date: '2026-11-07', channel: 'BOOKING', charged: '79.85' }],
      bookingSettlement: { net: '59.00', pendingRefunds: { count: 1, amount: '20.85' }, items: [{ pnr: 'DHV47T', partnerOrderId: 'ORD-BKP-7B5BADB7C0', net: '59.00' }] },
    });
    expect(fakes['MS.Admin'].last()!.path).toBe('/api/v2/ecoairlines/admin/reports/sales?from=2026-11-01&to=2026-11-08');
  });

  it('panel O-4: eventHistory filtra por tipo, correlation ID y fechas; MS.Admin recibe los filtros', async () => {
    fakes['MS.Admin'].on('GET', /\/api\/v2\/ecoairlines\/admin\/events\?/, { body: { items: [{ seq: 7, id: 'evt-1', type: 'booking.cancelled', subject: 'e8bead02-1587-4dcd-86c3-a54653fb0986', time: '2026-11-08T04:10:00Z', correlationId: 'corr-dhv', public: true,
      data: { bookingId: 'e8bead02-1587-4dcd-86c3-a54653fb0986', pnr: 'DHV47T', partnerOrderId: 'ORD-BKP-7B5BADB7C0' }, deliveries: [{ subscriptionId: 's1', target: 'https://booking.example/webhooks', outcome: 'EXHAUSTED', httpStatus: 400, attempts: 6 }] }], nextCursor: null } });
    const page = await gql('{ eventHistory(type: "booking.cancelled", correlationId: "corr-dhv", from: "2026-11-01T05:00:00Z", limit: 50) { items { type subject correlationId deliveries { outcome httpStatus } } } }', {}, tokens.admin()).expect(200);
    expect(page.body.data.eventHistory.items).toEqual([{ type: 'booking.cancelled', subject: 'e8bead02-1587-4dcd-86c3-a54653fb0986', correlationId: 'corr-dhv', deliveries: [{ outcome: 'EXHAUSTED', httpStatus: 400 }] }]);
    const sent = new URL(`http://x${fakes['MS.Admin'].last()!.path}`).searchParams;
    expect(Object.fromEntries(sent)).toEqual({ type: 'booking.cancelled', correlationId: 'corr-dhv', from: '2026-11-01T05:00:00Z', limit: '50' });
    const tooLong = await gql(`{ eventHistory(type: "${'x'.repeat(61)}") { items { id } } }`, {}, tokens.admin());
    expect(tooLong.body.errors).toBeDefined();
  });

  it('R-1: flightDelayImpact pide a MS.Admin el impacto del retraso (avión y pasajeros con poco margen); solo administradores', async () => {
    fakes['MS.Admin'].on('GET', /\/api\/v2\/ecoairlines\/admin\/flights\/EA100\/delay-impact\?/, { body: { flightNumber: 'EA100', date: '2026-11-10', delayMinutes: 60, scheduledDepartureAt: '2026-11-10T07:00:00-05:00', scheduledArrivalAt: '2026-11-10T07:50:00-05:00',
      estimatedDepartureAt: '2026-11-10T13:00:00.000Z', estimatedArrivalAt: '2026-11-10T13:50:00.000Z', aircraft: { registration: 'HC-N01', aircraftType: 'Airbus A320neo', turnaroundMinutes: 45 },
      nextFlight: { flightNumber: 'EA101', date: '2026-11-10', origin: 'GYE', destination: 'UIO', scheduledDepartureAt: '2026-11-10T09:00:00-05:00', departureAt: '2026-11-10T09:00:00-05:00', status: 'SCHEDULED', readyAt: '2026-11-10T14:35:00.000Z', conflict: true, suggestedDelayMinutes: 35 },
      bookings: 1, passengers: 2,
      tightConnections: [{ bookingId: 'e8bead02-1587-4dcd-86c3-a54653fb0986', pnr: 'DHV47T', channel: 'BOOKING', kind: 'CONNECTION', nextFlightNumber: 'EA102', nextDepartureAt: '2026-11-10T09:30:00-05:00', availableMinutes: 40, requiredMinutes: 60 }] } });
    const query = '{ flightDelayImpact(flightNumber: "EA100", date: "2026-11-10", delayMinutes: 60) { estimatedArrivalAt aircraft { registration turnaroundMinutes } nextFlight { flightNumber conflict suggestedDelayMinutes } passengers tightConnections { pnr kind availableMinutes requiredMinutes } } }';
    const response = await gql(query, {}, tokens.admin()).expect(200);
    expect(response.body.data.flightDelayImpact).toEqual({
      estimatedArrivalAt: '2026-11-10T13:50:00.000Z',
      aircraft: { registration: 'HC-N01', turnaroundMinutes: 45 },
      nextFlight: { flightNumber: 'EA101', conflict: true, suggestedDelayMinutes: 35 },
      passengers: 2,
      tightConnections: [{ pnr: 'DHV47T', kind: 'CONNECTION', availableMinutes: 40, requiredMinutes: 60 }],
    });
    expect(fakes['MS.Admin'].last()!.path).toBe('/api/v2/ecoairlines/admin/flights/EA100/delay-impact?date=2026-11-10&delayMinutes=60');
    expect((await gql(query, {}, tokens.customer()).expect(200)).body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('myProfile: null si el cliente aún no guardó su perfil (404 del MS)', async () => {
    fakes['MS.Clientes'].on('GET', '/api/v2/ecoairlines/customers/me', { status: 404, body: problem(404, 'NOT_FOUND', 'Sin perfil.') });
    expect((await gql('{ myProfile { firstName } }', {}, tokens.customer()).expect(200)).body).toEqual({ data: { myProfile: null } });
  });
});

describe('catálogo de aeropuertos (PLAN_Telemetria_Asientos M-1)', () => {
  const JPJ = { code: 'JPJ', city: 'Jipijapa', name: 'Aeródromo de Jipijapa', country: 'EC', province: 'Manabí', lat: -1.3486, lon: -80.5786, utcOffsetMinutes: -300, active: true, updatedAt: '2026-11-10T00:00:00Z' };

  it('★ airports es pública (MS.Vuelos); crear, editar y borrar son solo de administradores (MS.Admin)', async () => {
    fakes['MS.Vuelos'].on('GET', '/api/v2/ecoairlines/airports', { body: [JPJ] });
    const list = await gql('{ airports { code city country province active utcOffsetMinutes } }').expect(200);
    expect(list.body.data.airports).toEqual([{ code: 'JPJ', city: 'Jipijapa', country: 'EC', province: 'Manabí', active: true, utcOffsetMinutes: -300 }]);

    fakes['MS.Admin'].on('POST', '/api/v2/ecoairlines/admin/airports', { status: 201, body: JPJ });
    const input = '{ code: "JPJ", city: "Jipijapa", name: "Aeródromo de Jipijapa", country: "EC", lat: -1.3486, lon: -80.5786, utcOffsetMinutes: -300 }';
    expect((await gql(`mutation { createAirport(input: ${input}) { code } }`, {}, tokens.admin()).expect(200)).body.data.createAirport).toEqual({ code: 'JPJ' });
    expect(fakes['MS.Admin'].last('POST')!.json).toEqual({ code: 'JPJ', city: 'Jipijapa', name: 'Aeródromo de Jipijapa', country: 'EC', lat: -1.3486, lon: -80.5786, utcOffsetMinutes: -300 });

    fakes['MS.Admin'].on('PUT', '/api/v2/ecoairlines/admin/airports/JPJ', { status: 409, body: { type: 'urn:ecoairlines:problema:AIRPORT_IN_USE', title: 'JPJ está en uso.', status: 409, code: 'CONFLICT' } });
    const conflict = await gql('mutation { updateAirport(code: "JPJ", input: { city: "J", name: "J", country: "EC", lat: -1.2, lon: -80.5, utcOffsetMinutes: -300 }) { code } }', {}, tokens.admin()).expect(200);
    expect(conflict.body.errors[0].extensions.code).toBe('AIRPORT_IN_USE');

    fakes['MS.Admin'].on('DELETE', '/api/v2/ecoairlines/admin/airports/JPJ', { status: 204 });
    expect((await gql('mutation { deleteAirport(code: "JPJ") }', {}, tokens.admin()).expect(200)).body.data.deleteAirport).toBe(true);
    const customer = await gql('mutation { deleteAirport(code: "JPJ") }', {}, tokens.customer()).expect(200);
    expect(customer.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});


describe('catálogo de tipos de avión (PLAN_Telemetria_Asientos M-2)', () => {
  it('★ aircraftTypes trae la distribución; crear, editar y borrar van a MS.Admin con el nombre codificado', async () => {
    const info = { aircraftType: 'Embraer E195-E2', registrationPrefix: 'HC-E', seats: [], totalSeats: 124, maxRouteKm: 1000, turnaroundMinutes: 30, inFleet: 0, cabins: [{ cabinClass: 'ECONOMY', seats: 112, configuration: '2-4-2', layout: 'AC-DEFG-HK', firstRow: 4, lastRow: 17, exitRows: [11], extraLegroomRows: [4, 11] }], source: 'ADMIN' };
    fakes['MS.Admin'].on('GET', '/api/v2/ecoairlines/admin/aircraft-types', { body: [info] });
    const list = await gql('{ aircraftTypes { aircraftType cabins { cabinClass configuration layout firstRow lastRow } } }', {}, tokens.admin()).expect(200);
    expect(list.body.data.aircraftTypes).toEqual([{ aircraftType: 'Embraer E195-E2', cabins: [{ cabinClass: 'ECONOMY', configuration: '2-4-2', layout: 'AC-DEFG-HK', firstRow: 4, lastRow: 17 }] }]);
    fakes['MS.Admin'].on('POST', '/api/v2/ecoairlines/admin/aircraft-types', { status: 201, body: info });
    const cabins = 'business: { seats: 12, configuration: "2-2" }, economy: { seats: 112, configuration: "2-4-2" }';
    await gql(`mutation { createAircraftType(input: { aircraftType: "Embraer E195-E2", registrationPrefix: "HC-E", maxRouteKm: 1000, turnaroundMinutes: 30, ${cabins} }) { aircraftType } }`, {}, tokens.admin()).expect(200);
    expect(fakes['MS.Admin'].last('POST')!.json).toEqual({ aircraftType: 'Embraer E195-E2', registrationPrefix: 'HC-E', maxRouteKm: 1000, turnaroundMinutes: 30, business: { seats: 12, configuration: '2-2' }, economy: { seats: 112, configuration: '2-4-2' } });
    fakes['MS.Admin'].on('PUT', /\/aircraft-types\//, { status: 409, body: { type: 'urn:ecoairlines:problema:AIRCRAFT_TYPE_IN_USE', title: 'Tiene aviones.', status: 409, code: 'CONFLICT' } });
    const inUse = await gql(`mutation { updateAircraftType(aircraftType: "Embraer E195-E2", input: { registrationPrefix: "HC-E", turnaroundMinutes: 40, ${cabins} }) { aircraftType } }`, {}, tokens.admin()).expect(200);
    expect(inUse.body.errors[0].extensions.code).toBe('AIRCRAFT_TYPE_IN_USE');
    expect(fakes['MS.Admin'].last('PUT')!.path).toBe('/api/v2/ecoairlines/admin/aircraft-types/Embraer%20E195-E2');
    fakes['MS.Admin'].on('DELETE', /\/aircraft-types\//, { status: 204 });
    expect((await gql('mutation { deleteAircraftType(aircraftType: "Embraer E195-E2") }', {}, tokens.admin()).expect(200)).body.data.deleteAircraftType).toBe(true);
  });
});

describe('vista «Recorrido» y mapa en vivo (PLAN_Telemetria_Asientos T-4)', () => {
  it('★ telemetry.journey (sin trazas → null) y telemetry.systemMap', async () => {
    fakes['MS.Admin'].on('GET', /\/telemetry\/journeys\/corr-x/, { body: { correlationId: 'corr-x', startedAt: '2026-11-10T07:55:55Z', durationMs: 900, traces: 1, nodes: [{ id: 'cliente', layer: 'CLIENT' }, { id: 'gateway', layer: 'GATEWAY' }], hops: [{ sequence: 1, from: 'cliente', to: 'gateway', operation: 'POST /api/graphql', startMs: 0, durationMs: 900, status: 'OK', httpStatus: 200, traceId: 'abc' }], truncated: false } });
    const journey = await gql('{ telemetry { journey(correlationId: "corr-x") { durationMs nodes { id layer } hops { sequence from to operation status httpStatus } } } }', {}, tokens.admin()).expect(200);
    expect(journey.body.data.telemetry.journey).toEqual({ durationMs: 900, nodes: [{ id: 'cliente', layer: 'CLIENT' }, { id: 'gateway', layer: 'GATEWAY' }], hops: [{ sequence: 1, from: 'cliente', to: 'gateway', operation: 'POST /api/graphql', status: 'OK', httpStatus: 200 }] });
    fakes['MS.Admin'].on('GET', /\/telemetry\/journeys\/corr-nada/, { status: 404, body: problem(404, 'NOT_FOUND', 'Sin trazas.') });
    expect((await gql('{ telemetry { journey(correlationId: "corr-nada") { durationMs } } }', {}, tokens.admin()).expect(200)).body.data.telemetry.journey).toBeNull();
    fakes['MS.Admin'].on('GET', '/api/v2/ecoairlines/admin/telemetry/system-map', { body: { generatedAt: '2026-11-10T08:00:00Z', windowMinutes: 5, edges: [{ from: 'gateway', to: 'ms-reservas', requestsPerMinute: 12, errorsPerMinute: 0.5, p95Ms: 120 }] } });
    const map = await gql('{ telemetry { systemMap { windowMinutes edges { from to requestsPerMinute errorsPerMinute p95Ms } } } }', {}, tokens.admin()).expect(200);
    expect(map.body.data.telemetry.systemMap).toEqual({ windowMinutes: 5, edges: [{ from: 'gateway', to: 'ms-reservas', requestsPerMinute: 12, errorsPerMinute: 0.5, p95Ms: 120 }] });
  });
});


describe('cancelación de administrador', () => {
  it('★ adminCancelBooking va a MS.Admin con el motivo; solo administradores', async () => {
    const BOOKING = 'dc4d0bf7-e126-4533-bcb5-f328f7461d51';
    fakes['MS.Admin'].on('POST', `/api/v2/ecoairlines/admin/bookings/${BOOKING}/cancel`, { body: { bookingId: BOOKING, status: 'CANCELLED' } });
    const done = await gql(`mutation { adminCancelBooking(bookingId: "${BOOKING}", reason: "Reserva de prueba de Booking") }`, {}, tokens.admin()).expect(200);
    expect(done.body.data.adminCancelBooking).toBe(true);
    expect(fakes['MS.Admin'].last('POST')!.json).toEqual({ reason: 'Reserva de prueba de Booking' });
    const denied = await gql(`mutation { adminCancelBooking(bookingId: "${BOOKING}", reason: "Reserva de prueba de Booking") }`, {}, tokens.customer()).expect(200);
    expect(denied.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});
