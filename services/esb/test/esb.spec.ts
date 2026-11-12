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
import { HealthCompositionService } from '../src/composition/health.service.js';
import { localDate } from '../src/composition/dates.js';
import { InMemoryEventsPublisher } from '../src/inbound/events-publisher.js';
import { InboundService } from '../src/inbound/inbound.service.js';
import { InMemoryEsbStore } from '../src/repositories/esb.store.js';
import { FakeMsg, FakeOffers, FixedToken, OffersProblem, testConfig, testVerifier } from './fakes.js';

/** Pruebas del ESB (V2.9) contra MS.G falsos (HTTP y gRPC). Las respuestas de composición y de entrada se validan con su contrato. */
const expectContract = contractValidator('esb.openapi.yaml');
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const msg = new FakeMsg();
const offers = new FakeOffers();
const store = new InMemoryEsbStore();
const publisher = new InMemoryEventsPublisher();
let app: NestExpressApplication;
let inbound: InboundService;
let health: HealthCompositionService;

const OWNER = 'partner:BOOKING_PROTOTIPO:usr-v29';
const ADMIN = '6b0f1c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const SECRET = 'secreto-de-prueba-eventos-booking';
const CORR = 'corr-prueba-esb-v29';
const http = () => request(app.getHttpServer());
const svc = (call: request.Test) => call.set('Authorization', 'Bearer svc').set('X-Correlation-Id', CORR);

let upstreams: Upstreams;

beforeAll(async () => {
  const base = await msg.start();
  const address = await offers.start();
  // V2.16: la plataforma de observabilidad también la imita el servidor de MS.G falsos (bajo su propio prefijo).
  const config = testConfig(base, address, { PROMETHEUS_URL: `${base}/prometheus`, LOKI_URL: `${base}/loki`, ALERTMANAGER_URL: `${base}/alertmanager`, TEMPO_URL: `${base}/tempo`, RABBITMQ_MANAGEMENT_URL: `${base}/rabbitmq`, RABBITMQ_MANAGEMENT_USER: 'eco', RABBITMQ_MANAGEMENT_PASSWORD: 'clave-rabbit' });
  upstreams = new Upstreams(config, new FixedToken());
  const moduleRef = await Test.createTestingModule({ imports: [EsbModule.register(config, { store, verifier: testVerifier, upstreams, publisher })] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, rawBody: true, bodyParser: false });
  setupApp(app);
  await app.init();
  inbound = app.get(InboundService);
  health = app.get(HealthCompositionService);
});
afterAll(async () => {
  await app.close();
  await msg.stop();
  await offers.stop();
});
beforeEach(() => {
  msg.reset();
  offers.reset();
  publisher.published.length = 0;
});

describe('seguridad', () => {
  it('sin token → 401; token de usuario → 403; /health del ESB es público', async () => {
    expect((await http().get('/router/bookings/bookings')).status).toBe(401);
    const user = await http().get('/router/bookings/bookings').set('Authorization', 'Bearer user');
    expect(user.status).toBe(403);
    expect(user.body.code).toBe('FORBIDDEN');
    expect((await http().get('/health')).status).toBe(200);
  });

  it('D44: acepta el token de un MS de respuesta (ecoairlines:esb); otro token de servicio → 403', async () => {
    msg.on('bookings', 'GET', '/bookings', () => ({ status: 200, body: { items: [], nextCursor: null } }));
    expect((await http().get('/router/bookings/bookings').set('Authorization', 'Bearer svc-ms').set('X-Owner-Id', OWNER)).status).toBe(200);
    const other = await http().get('/router/bookings/bookings').set('Authorization', 'Bearer svc-otro').set('X-Owner-Id', OWNER);
    expect(other.status).toBe(403);
    expect(other.body.title).toContain('MS de respuesta');
  });

  it('un X-Owner-Id mal formado → 400; el partner completo (suscripciones) sí es válido', async () => {
    msg.on('webhooks', 'GET', '/subscriptions', () => ({ status: 200, body: { items: [] } }));
    expect((await svc(http().get('/router/webhooks/subscriptions')).set('X-Owner-Id', 'partner:BOOKING_PROTOTIPO')).status).toBe(200);
    const response = await svc(http().get('/router/bookings/bookings')).set('X-Owner-Id', 'cualquier cosa');
    expect(response.status).toBe(400);
    expect(response.body.invalidParams[0].name).toBe('X-Owner-Id');
  });
});

describe('enrutador REST', () => {
  it('reenvía a UN MS.G con su token, el dueño, el MISMO correlation id y un request id nuevo; devuelve su respuesta tal cual', async () => {
    const id = randomUUID();
    msg.on('bookings', 'GET', `/bookings/${id}`, () => ({ status: 200, body: { bookingId: id, pnr: 'ABC123' }, headers: { 'cache-control': 'no-store' } }));
    const response = await svc(http().get(`/router/bookings/bookings/${id}`)).set('X-Owner-Id', OWNER).set('X-Request-Id', 'req-del-ms-respuesta');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ bookingId: id, pnr: 'ABC123' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-correlation-id']).toBe(CORR);
    const [call] = msg.calls('bookings');
    expect(call.headers['authorization']).toBe('Bearer token-de-servicio-del-esb');
    expect(call.headers['x-owner-id']).toBe(OWNER);
    expect(call.headers['x-correlation-id']).toBe(CORR);
    expect(call.headers['x-request-id']).toMatch(/^req-/);
    expect(call.headers['x-request-id']).not.toBe('req-del-ms-respuesta');
  });

  it('conserva la query, el status y el ProblemDetails del MS.G (no lo traduce)', async () => {
    msg.on('flight-status', 'GET', /^\/flights\/EA100\/status/, (r) => ({ status: 404, body: { type: 'about:blank', title: `No hay ${r.path}`, status: 404, code: 'FLIGHT_STATUS_NOT_AVAILABLE' } }));
    const response = await svc(http().get('/router/flight-status/flights/EA100/status?date=2026-11-20'));
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ code: 'FLIGHT_STATUS_NOT_AVAILABLE', title: 'No hay /flights/EA100/status?date=2026-11-20' });
  });

  it('solo las rutas de la tabla: un paso de saga → 405 (o 404 si la ruta no existe), otro servicio → 404, `..` → 404', async () => {
    const saga = await svc(http().post('/router/bookings/bookings')).send({});
    expect(saga.status).toBe(405);
    expect(saga.body.title).toContain('saga');
    expect((await svc(http().post(`/router/bookings/bookings/${randomUUID()}/fail`)).send({})).status).toBe(404);
    expect((await svc(http().get('/router/payment/x'))).status).toBe(404);
    expect((await svc(http().get('/router/bookings/bookings/..'))).status).toBe(404);
    expect((await svc(http().get('/router/bookings/bookings/%2e%2e'))).status).toBe(404);
    expect(msg.received).toHaveLength(0);
  });

  it('/users/summary no se confunde con /users/{sub}', async () => {
    msg.on('identity', 'GET', '/users/summary', () => ({ status: 200, body: { total: 3 } }));
    expect((await svc(http().get('/router/identity/users/summary'))).body).toEqual({ total: 3 });
  });

  it('POST /oauth2/token se reenvía SIN el token del ESB y con el formulario intacto (client_secret_post)', async () => {
    msg.on('identity', 'POST', '/oauth2/token', () => ({ status: 200, body: { access_token: 'x', token_type: 'Bearer', expires_in: 600 } }));
    const response = await svc(http().post('/router/identity/oauth2/token')).type('form').send('grant_type=client_credentials&client_id=BOOKING_PROTOTIPO&client_secret=s3cr3t');
    expect(response.status).toBe(200);
    const [call] = msg.calls('identity', 'POST', '/oauth2/token');
    expect(call.headers['authorization']).toBeUndefined();
    expect(call.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(call.body).toBe('grant_type=client_credentials&client_id=BOOKING_PROTOTIPO&client_secret=s3cr3t');
  });

  it('MS.G caído → 503 PROVIDER_UNAVAILABLE con Retry-After; tras 5 fallas el circuito se abre y falla al instante', async () => {
    msg.down.add('schedule');
    for (let i = 0; i < 5; i++) {
      const response = await svc(http().get('/router/schedule/aircraft'));
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', correlation_id: CORR, instance: '/router/schedule/aircraft' });
      expect(response.headers['retry-after']).toBe('5');
    }
    const open = await svc(http().get('/router/schedule/aircraft'));
    expect(open.status).toBe(503);
    expect(open.body.title).toContain('circuito abierto');
    expect((await health.refresh()).health.circuit_breaker_estado).toBe('OPEN');
  });
});

describe('idempotencia (D6)', () => {
  const profile = { firstName: 'Ana', lastName: 'Paz' };

  it('misma clave y mismo cuerpo → el MS.G se llama UNA vez y el reintento lleva Idempotent-Replayed', async () => {
    let n = 0;
    msg.on('customers', 'PUT', '/profile', () => ({ status: n++ === 0 ? 201 : 200, body: { saved: n } }));
    const key = randomUUID();
    const owner = randomUUID();
    const first = await svc(http().put('/router/customers/profile')).set('X-Owner-Id', owner).set('Idempotency-Key', key).send(profile);
    const again = await svc(http().put('/router/customers/profile')).set('X-Owner-Id', owner).set('Idempotency-Key', key).send(profile);
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(msg.calls('customers')).toHaveLength(1);
    expect(msg.calls('customers')[0].headers['idempotency-key']).toBeUndefined(); // la resuelve el ESB
  });

  it('misma clave con otro cuerpo → 409 IDEMPOTENCY_KEY_REUSED; otro dueño con la misma clave no ve la respuesta ajena', async () => {
    msg.on('customers', 'PUT', '/profile', (r) => ({ status: 200, body: JSON.parse(r.body) }));
    const key = randomUUID();
    const owner = randomUUID();
    await svc(http().put('/router/customers/profile')).set('X-Owner-Id', owner).set('Idempotency-Key', key).send(profile);
    const reused = await svc(http().put('/router/customers/profile')).set('X-Owner-Id', owner).set('Idempotency-Key', key).send({ ...profile, lastName: 'Otro' });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const other = await svc(http().put('/router/customers/profile')).set('X-Owner-Id', randomUUID()).set('Idempotency-Key', key).send({ firstName: 'Luis', lastName: 'B' });
    expect(other.status).toBe(200);
    expect(other.body.firstName).toBe('Luis');
  });

  it('5 reintentos simultáneos con la misma clave → una sola ejecución', async () => {
    msg.on('webhooks', 'POST', '/subscriptions', () => ({ status: 201, body: { id: randomUUID() }, delayMs: 150 }));
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => svc(http().post('/router/webhooks/subscriptions')).set('X-Owner-Id', OWNER).set('Idempotency-Key', key).send({ url: 'https://x.test/h', events: ['booking.confirmed'], secret: 'a'.repeat(16) })),
    );
    expect(msg.calls('webhooks', 'POST')).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(4);
  });

  it('un 5xx no se guarda: el reintento con la misma clave vuelve a intentarlo', async () => {
    let n = 0;
    msg.on('customers', 'PUT', '/profile', () => (n++ === 0 ? { status: 500, body: { type: 'about:blank', title: 'falla', status: 500, code: 'INTERNAL_ERROR' } } : { status: 200, body: { ok: true } }));
    const key = randomUUID();
    const owner = randomUUID();
    expect((await svc(http().put('/router/customers/profile')).set('X-Owner-Id', owner).set('Idempotency-Key', key).send(profile)).status).toBe(500);
    const retry = await svc(http().put('/router/customers/profile')).set('X-Owner-Id', owner).set('Idempotency-Key', key).send(profile);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(msg.calls('customers')).toHaveLength(2);
  });

  it('una clave que no es UUID → 400', async () => {
    const response = await svc(http().put('/router/customers/profile')).set('X-Owner-Id', randomUUID()).set('Idempotency-Key', 'clave-1').send(profile);
    expect(response.status).toBe(400);
    expect(response.body.invalidParams[0].name).toBe('Idempotency-Key');
  });
});

describe('enrutador gRPC (MS.G.Offers)', () => {
  it('CreateHold: metadata con token, dueño y correlation id; un reintento con la misma clave no crea otro hold', async () => {
    offers.handlers.set('CreateHold', () => ({ hold: { holdId: randomUUID(), status: 'HOLD_STATUS_ACTIVE' } }));
    const key = randomUUID();
    const body = { offerId: 'OFF-1', itinerarySelections: [{ itineraryId: 'EA100', cabinClass: 'CABIN_CLASS_ECONOMY', fareBrand: 'SEMILLA' }], ttlMinutes: 15 };
    const first = await svc(http().post('/router/offers/CreateHold')).set('X-Owner-Id', OWNER).set('Idempotency-Key', key).send(body);
    const again = await svc(http().post('/router/offers/CreateHold')).set('X-Owner-Id', OWNER).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(200);
    expect(again.body.hold.holdId).toBe(first.body.hold.holdId);
    expect(offers.calls).toHaveLength(1);
    expect(offers.calls[0].request['offerId']).toBe('OFF-1');
    expect(offers.calls[0].metadata).toMatchObject({ authorization: 'Bearer token-de-servicio-del-esb', 'x-owner-id': OWNER, 'x-correlation-id': CORR });
  });

  it('un error de Offers vuelve con el status y el code de su trailer (HOLD_EXPIRED 410, no un genérico)', async () => {
    offers.handlers.set('GetHold', () => {
      throw new OffersProblem({ status: 410, code: 'HOLD_EXPIRED', title: 'El hold venció.' }, grpc.status.FAILED_PRECONDITION);
    });
    const response = await svc(http().post('/router/offers/GetHold')).set('X-Owner-Id', OWNER).send({ holdId: randomUUID() });
    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ code: 'HOLD_EXPIRED', title: 'El hold venció.', correlation_id: CORR, instance: '/router/offers/GetHold' });
  });

  it('un RPC que es paso de saga (TransitionBookingSeats) no pasa por el enrutador', async () => {
    expect((await svc(http().post('/router/offers/TransitionBookingSeats')).send({})).status).toBe(404);
    expect(offers.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------------------- composición

const today = localDate();
const occupancy = (flightNumber: string, departureAt: string, available: number, loadFactor: number) => ({
  flightNumber, date: today, origin: 'UIO', destination: 'GYE', departureAt, aircraft: 'Airbus A320neo', totalSeats: 186, loadFactor, activeHolds: 2,
  nextHoldExpiryAt: new Date(Date.now() + 600_000).toISOString(), onSale: true,
  cabins: [{ cabinClass: 'CABIN_CLASS_ECONOMY', totalSeats: 174, seatsByStatus: { available, held: 4, booked: 10, ticketed: 20, checkedIn: 0, boarded: 0 } }],
});
const flightStatus = (flightNumber: string, status: string, scheduledAt: string) => ({ flightNumber, date: today, status, delayMinutes: status === 'DELAYED' ? 25 : 0, departure: { iataCode: 'UIO', scheduledAt }, arrival: { iataCode: 'GYE', scheduledAt } });

describe('composición', () => {
  it('health del nodo con la forma del contrato v2, desde caché: HEALTHY, DEGRADED (cae Customers) y DOWN 503 (cae Bookings)', async () => {
    offers.handlers.set('GetStats', () => ({ stats: { activeHolds: 4, flightsOnSaleToday: 4, pendingStockPushes: 0 } }));
    msg.on('flight-status', 'GET', /^\/flights\?date=/, () => ({ status: 200, body: { date: today, total: 4, items: [] } }));
    await health.refresh();
    const ok = await svc(http().get('/composition/health'));
    expectContract('GET', '/composition/health', ok);
    expect(ok.body).toMatchObject({ status: 'HEALTHY', nodo_id: 'NODE_VUE_ECOAIRLINES', vertical: 'VUELOS', holds_activos_count: 4, vuelos_programados_hoy: 4 });
    expect(ok.body.dependencias.map((d: Any) => d.nombre)).toEqual(expect.arrayContaining(['esb-postgres', 'ms-g-offers', 'ms-g-post-sale', 'ms-g-bookings']));

    msg.down.add('customers');
    await health.refresh();
    expect((await svc(http().get('/composition/health'))).body.status).toBe('DEGRADED');
    msg.down.add('bookings');
    await health.refresh();
    const down = await svc(http().get('/composition/health'));
    expect(down.status).toBe(503);
    expectContract('GET', '/composition/health', down);
    expect(down.body.dependencias.find((d: Any) => d.nombre === 'ms-g-bookings').status).toBe('DOWN');
    const services = await svc(http().get('/composition/services-health'));
    expectContract('GET', '/composition/services-health', services);
  });

  it('el health se sirve en < 1 s aunque los MS.G tarden (se lee la caché, no se consulta en la petición)', async () => {
    await health.refresh();
    msg.on('bookings', 'GET', '/health', () => ({ status: 200, body: { status: 'ok' }, delayMs: 700 }));
    const started = Date.now();
    for (let i = 0; i < 5; i++) await svc(http().get('/composition/health'));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('operaciones: Offers + FlightStatus en paralelo, alertas, check-in abierto, filtro por estado y paginación', async () => {
    const soon = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const later = new Date(Date.now() + 6 * 3_600_000).toISOString();
    offers.handlers.set('GetOccupancy', () => ({ date: today, flights: [occupancy('EA102', later, 120, 31), occupancy('EA100', soon, 5, 97)] }));
    msg.on('flight-status', 'GET', /^\/flights\?/, () => ({ status: 200, body: { date: today, total: 2, items: [flightStatus('EA100', 'DELAYED', soon), flightStatus('EA102', 'CANCELLED', later)] } }));
    const page = await svc(http().get(`/composition/flight-operations?date=${today}&origin=UIO&limit=1`));
    expectContract('GET', '/composition/flight-operations', page);
    expect(offers.calls[0].request).toMatchObject({ date: today, origin: 'UIO' });
    expect(msg.calls('flight-status')[0].path).toBe(`/flights?date=${today}&origin=UIO`);
    expect(page.body.totalFlights).toBe(2);
    const [first] = page.body.items;
    expect(first).toMatchObject({ flightNumber: 'EA100', status: 'DELAYED', checkInOpen: true, loadFactor: 97, activeHolds: 2 });
    expect(first.cabins[0]).toMatchObject({ cabinClass: 'ECONOMY', seatsByStatus: { AVAILABLE: 5, HELD: 4, TICKETED: 20 } });
    expect(first.alerts.map((a: Any) => a.code).sort()).toEqual(['CHECKIN_OPEN', 'DELAYED', 'LOW_AVAILABILITY', 'OVERBOOKING_RISK']);
    const next = await svc(http().get(`/composition/flight-operations?date=${today}&origin=UIO&limit=1&cursor=${page.body.nextCursor}`));
    expect(next.body.items[0]).toMatchObject({ flightNumber: 'EA102', status: 'CANCELLED', checkInOpen: false, alerts: [{ code: 'CANCELLED', severity: 'CRITICAL' }] });
    expect(next.body.nextCursor).toBeNull();
    const cancelled = await svc(http().get(`/composition/flight-operations?date=${today}&status=CANCELLED`));
    expect(cancelled.body.items.map((i: Any) => i.flightNumber)).toEqual(['EA102']);
    const bad = await svc(http().get('/composition/flight-operations?date=mañana'));
    expect(bad.status).toBe(400);
    expectContract('GET', '/composition/flight-operations', bad);
  });

  it('indicadores: Bookings + Identity + FlightStatus, con el X-Actor-Id del administrador', async () => {
    msg.on('bookings', 'GET', /^\/indicators/, () => ({ status: 200, body: { totalBookings: 3, byStatus: { CONFIRMED: 3 }, byChannel: { WEB: 1, BOOKING: 2 }, totalPassengers: 4, revenue: { currency: 'USD', total: '478.00' }, byRoute: [] } }));
    msg.on('identity', 'GET', '/users/summary', () => ({ status: 200, body: { total: 2, byRole: { CUSTOMER: 1, ADMIN: 1 }, byStatus: { ACTIVE: 2, BLOCKED: 0 } } }));
    msg.on('flight-status', 'GET', /^\/flights\?date=/, () => ({ status: 200, body: { date: today, total: 4, items: [] } }));
    const response = await svc(http().get('/composition/indicators?from=2026-10-01')).set('X-Actor-Id', ADMIN);
    expectContract('GET', '/composition/indicators', response);
    expect(response.body).toMatchObject({ flightsToday: 4, bookings: { totalBookings: 3 } });
    expect(msg.calls('bookings')[0].path).toBe('/indicators?from=2026-10-01');
    expect(msg.calls('bookings')[0].headers['x-actor-id']).toBe(ADMIN);
  });

  it('asistencia por vuelo: exige X-Actor-Id; un vuelo inexistente → 404 de FlightStatus', async () => {
    const item = { bookingId: randomUUID(), pnr: 'ABC123', passengerId: 'PAX-1', passengerName: 'Ana Paz', segmentId: 'SEG-1', seatNumber: '12A', assistance: { passengerId: 'PAX-1', type: 'WCHR', needsCompanion: false, status: 'REQUESTED', updatedAt: new Date().toISOString() } };
    msg.on('flight-status', 'GET', /^\/flights\/EA100\/status/, () => ({ status: 200, body: flightStatus('EA100', 'SCHEDULED', new Date().toISOString()) }));
    msg.on('bookings', 'GET', `/flights/EA100/${today}/assistance`, () => ({ status: 200, body: [item] }));
    expect((await svc(http().get(`/composition/flights/EA100/assistance?date=${today}`))).status).toBe(400);
    const ok = await svc(http().get(`/composition/flights/EA100/assistance?date=${today}`)).set('X-Actor-Id', ADMIN);
    expectContract('GET', '/composition/flights/{flightNumber}/assistance', ok);
    expect(ok.body).toEqual([item]);
    msg.on('flight-status', 'GET', /^\/flights\/EA999\/status/, () => ({ status: 404, body: { type: 'about:blank', title: 'No existe ese vuelo.', status: 404, code: 'FLIGHT_STATUS_NOT_AVAILABLE' } }));
    const missing = await svc(http().get(`/composition/flights/EA999/assistance?date=${today}`)).set('X-Actor-Id', ADMIN);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('FLIGHT_STATUS_NOT_AVAILABLE');
  });

  it('★ R-1 impacto de un retraso: el avión (FlightStatus) y los pasajeros con poco margen para su siguiente vuelo (Bookings)', async () => {
    const at = (time: string) => `${today}T${time}:00-05:00`;
    const segment = (flightNumber: string, time: string) => ({ segmentId: `${flightNumber}-${today.replaceAll('-', '')}`, flightNumber, departure: { iataCode: 'UIO', at: at(time) } });
    const [conexion, idaVuelta, soloIda] = [randomUUID(), randomUUID(), randomUUID()];
    msg.on('flight-status', 'GET', /^\/flights\/EA100\/delay-impact\?/, () => ({
      status: 200,
      body: {
        flightNumber: 'EA100', date: today, delayMinutes: 60, scheduledDepartureAt: at('07:00'), scheduledArrivalAt: at('07:50'),
        estimatedDepartureAt: new Date(at('08:00')).toISOString(), estimatedArrivalAt: new Date(at('08:50')).toISOString(),
        aircraft: { registration: 'HC-N01', aircraftType: 'Airbus A320neo', turnaroundMinutes: 45 },
        nextFlight: { flightNumber: 'EA101', date: today, origin: 'GYE', destination: 'UIO', scheduledDepartureAt: at('09:00'), departureAt: at('09:00'), status: 'SCHEDULED', readyAt: new Date(at('09:35')).toISOString(), conflict: true, suggestedDelayMinutes: 35 },
      },
    }));
    msg.on('bookings', 'GET', `/flights/EA100/${today}/bookings`, () => ({
      status: 200,
      body: { flightNumber: 'EA100', date: today, total: 3, items: [conexion, idaVuelta, soloIda].map((bookingId, i) => ({ bookingId, pnr: `PNR00${i}`, status: 'CONFIRMED', channel: i === 1 ? 'WEB' : 'BOOKING', passengers: i + 1 })) },
    }));
    msg.on('bookings', 'GET', `/bookings/${conexion}`, () => ({ status: 200, body: { itineraries: [{ segments: [segment('EA100', '07:00'), segment('EA102', '09:30')] }] } }));
    msg.on('bookings', 'GET', `/bookings/${idaVuelta}`, () => ({ status: 200, body: { itineraries: [{ segments: [segment('EA100', '07:00')] }, { segments: [segment('EA101', '12:00')] }] } }));
    msg.on('bookings', 'GET', `/bookings/${soloIda}`, () => ({ status: 200, body: { itineraries: [{ segments: [segment('EA100', '07:00')] }] } }));

    expect((await svc(http().get(`/composition/flights/EA100/delay-impact?date=${today}&delayMinutes=60`))).status).toBe(400); // sin X-Actor-Id
    expect((await svc(http().get(`/composition/flights/EA100/delay-impact?date=${today}&delayMinutes=0`)).set('X-Actor-Id', ADMIN)).status).toBe(400);
    const ok = await svc(http().get(`/composition/flights/EA100/delay-impact?date=${today}&delayMinutes=60`)).set('X-Actor-Id', ADMIN);
    expect(ok.status).toBe(200);
    expectContract('GET', '/composition/flights/{flightNumber}/delay-impact', ok);
    expect(ok.body).toMatchObject({ delayMinutes: 60, bookings: 3, passengers: 6, nextFlight: { flightNumber: 'EA101', conflict: true, suggestedDelayMinutes: 35 } });
    // Conexión: llega 08:50 y su escala sale 09:30 → 40 min < 60. La vuelta de las 12:00 tiene margen (190 ≥ 120).
    expect(ok.body.tightConnections).toEqual([{ bookingId: conexion, pnr: 'PNR000', channel: 'BOOKING', kind: 'CONNECTION', nextFlightNumber: 'EA102', nextDepartureAt: at('09:30'), availableMinutes: 40, requiredMinutes: 60 }]);
  });

  it('integración con Booking: último token (Identity), webhooks, stock (Offers) y último evento entrante', async () => {
    msg.on('identity', 'GET', '/partners/BOOKING_PROTOTIPO', () => ({ status: 200, body: { clientId: 'BOOKING_PROTOTIPO', lastTokenAt: '2026-10-25T10:00:00.000Z' } }));
    msg.on('webhooks', 'GET', '/stats', () => ({ status: 200, body: { subscriptions: 1, pending: 0, retrying: 0, exhaustedLast24h: 0, deliveredLast24h: 5, lastDeliveredAt: null } }));
    offers.handlers.set('GetStats', () => ({ stats: { activeHolds: 1, flightsOnSaleToday: 4, lastStockPushAt: '2026-10-25T10:01:00.000Z', pendingStockPushes: 2 } }));
    const response = await svc(http().get('/composition/booking-integration')).set('X-Actor-Id', ADMIN);
    expectContract('GET', '/composition/booking-integration', response);
    expect(response.body).toMatchObject({ partnerId: 'BOOKING_PROTOTIPO', lastTokenAt: '2026-10-25T10:00:00.000Z', stock: { lastPushAt: '2026-10-25T10:01:00.000Z', pendingPushes: 2 } });
  });
});

// --------------------------------------------------------------------------------------------------- entrada de Booking

const REFERENCE = 'PAY-BKP-20261023-000981';
interface FakeBooking {
  bookingId: string;
  status: string;
  channel: 'WEB' | 'BOOKING';
  tickets: { ticketId: string; status: string; eTicketNumber: string | null; passengerId: string }[];
}

/** Bookings falso con las reglas reales de emisión: `issued: 0` si ya estaban emitidos. */
function fakeBookings(booking: FakeBooking) {
  const view = () => ({
    ...booking, pnr: 'XK7P2Q', ownerId: booking.channel === 'BOOKING' ? OWNER : randomUUID(), paymentReference: REFERENCE,
    grandTotal: { currency: 'USD', total: '239.00' }, salesChannel: { partnerOrderId: 'ORD-BKP-1', packageId: null }, createdAt: new Date().toISOString(),
  });
  msg.on('bookings', 'GET', `/bookings/${booking.bookingId}`, () => ({ status: 200, body: view() }));
  msg.on('bookings', 'POST', `/bookings/${booking.bookingId}/tickets`, () => {
    const pending = booking.tickets.filter((t) => t.status !== 'ISSUED');
    for (const ticket of pending) Object.assign(ticket, { status: 'ISSUED', eTicketNumber: `9990${Math.floor(Math.random() * 1e9)}` });
    booking.status = 'CONFIRMED';
    return { status: 200, body: { bookingId: booking.bookingId, pnr: 'XK7P2Q', status: 'CONFIRMED', tickets: booking.tickets, issued: pending.length } };
  });
  msg.on('bookings', 'POST', `/bookings/${booking.bookingId}/fail`, () => {
    booking.status = 'FAILED';
    return { status: 200, body: view() };
  });
  return booking;
}

const newBooking = (channel: 'WEB' | 'BOOKING' = 'BOOKING'): FakeBooking => ({
  bookingId: randomUUID(), status: 'TICKET_ISSUING', channel,
  tickets: [{ ticketId: 'T1', status: 'PENDING', eTicketNumber: null, passengerId: 'PAX-1' }, { ticketId: 'T2', status: 'PENDING', eTicketNumber: null, passengerId: 'PAX-2' }],
});

const cloudEvent = (type: 'payment.confirmed' | 'payment.failed' | 'package.cancelled', data: Any, id: string = randomUUID()) => ({
  specversion: '1.0',
  type: type === 'package.cancelled' ? 'ec.edu.epn.booking.paquetes.package.cancelled' : `ec.edu.epn.booking.pagos.${type}`,
  source: '/booking-prototipo', id, time: new Date().toISOString(), subject: data['bookingId'], datacontenttype: 'application/json', correlationid: 'corr-combo-booking-77', data,
});

const deliver = (event: unknown, secret = SECRET) => {
  const body = JSON.stringify(event);
  return http().post('/integraciones/booking/eventos').set('Content-Type', 'application/cloudevents+json').set('X-Webhook-Signature', signWebhook(secret, body)).send(body);
};
const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await inbound.processDue();
};

describe('entrada de eventos de Booking (D34)', () => {
  it('★ el mismo payment.confirmed enviado TRES veces emite los boletos UNA sola vez', async () => {
    const booking = fakeBookings(newBooking());
    offers.handlers.set('TransitionBookingSeats', () => ({ result: { bookingId: booking.bookingId, seats: [], seatsAffected: 2 } }));
    const event = cloudEvent('payment.confirmed', { bookingId: booking.bookingId, paymentReference: REFERENCE, amount: { currency: 'USD', total: '239.00' } });
    const responses = [await deliver(event), await deliver(event), await deliver(event)];
    for (const response of responses) expectContract('POST', '/integraciones/booking/eventos', response);
    expect(responses.map((r) => r.body.duplicate)).toEqual([false, true, true]);
    await settle();
    expect(msg.calls('bookings', 'POST', `/bookings/${booking.bookingId}/tickets`)).toHaveLength(1);
    expect(offers.calls.filter((c) => c.rpc === 'TransitionBookingSeats')).toHaveLength(1);
    expect(offers.calls[0].request).toMatchObject({ bookingId: booking.bookingId, fromStatus: 'SEAT_STATUS_BOOKED', toStatus: 'SEAT_STATUS_TICKETED' });
    expect(booking.tickets.every((t) => t.status === 'ISSUED')).toBe(true);
    const issued = publisher.published.filter((p) => p.event.type === 'ec.edu.epn.booking.vuelos.booking.ticket_issued');
    expect(issued).toHaveLength(1);
    // Mismo proceso de negocio: el evento publicado y cada llamada llevan el correlationid de Booking.
    expect(issued[0].event.correlationid).toBe('corr-combo-booking-77');
    expect(msg.calls('bookings')[0].headers['x-correlation-id']).toBe('corr-combo-booking-77');
    expect(issued[0].ownerId).toBe(OWNER);
    expect(issued[0].event.data).toMatchObject({ bookingId: booking.bookingId, ownerId: 'usr-v29', paymentReference: REFERENCE, partnerOrderId: 'ORD-BKP-1' });
    expect((await store.inbound(event.id))!).toMatchObject({ status: 'PROCESSED', attempts: 1, outcome: { issued: 2 } });
  });

  it('el mismo pago con OTRO id (capa 2): no se emite de nuevo ni se publica otra vez', async () => {
    const booking = fakeBookings(newBooking());
    const data = { bookingId: booking.bookingId, paymentReference: REFERENCE };
    await deliver(cloudEvent('payment.confirmed', data));
    await settle();
    const second = cloudEvent('payment.confirmed', data);
    await deliver(second);
    await settle();
    expect((await store.inbound(second.id))!.outcome).toMatchObject({ issued: 0, alreadyIssued: true });
    expect(publisher.published).toHaveLength(1);
  });

  it('se rechaza: firma mala (401), evento inválido (400), reserva de la web, referencia ajena o monto distinto', async () => {
    const event = cloudEvent('payment.confirmed', { bookingId: randomUUID(), paymentReference: REFERENCE });
    expect((await deliver(event, 'otro-secreto')).status).toBe(401);
    const invalid = await deliver({ ...event, specversion: '0.3', data: { bookingId: 'no-uuid' } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.invalidParams.map((p: Any) => p.name)).toEqual(['specversion', 'data.bookingId']);

    const web = fakeBookings(newBooking('WEB'));
    const forWeb = cloudEvent('payment.confirmed', { bookingId: web.bookingId, paymentReference: REFERENCE });
    const partner = fakeBookings(newBooking());
    const otherReference = cloudEvent('payment.confirmed', { bookingId: partner.bookingId, paymentReference: 'PAY-BKP-20261023-000999' });
    const badFormat = cloudEvent('payment.confirmed', { bookingId: partner.bookingId, paymentReference: 'PAGO-123' });
    const wrongAmount = cloudEvent('payment.confirmed', { bookingId: partner.bookingId, paymentReference: REFERENCE, amount: { currency: 'USD', total: '1.00' } });
    for (const e of [forWeb, otherReference, badFormat, wrongAmount]) await deliver(e);
    await settle();
    const code = async (id: string) => ((await store.inbound(id))!.outcome as Any).problem.code;
    expect(await code(forWeb.id)).toBe('FORBIDDEN');
    expect(await code(otherReference.id)).toBe('PAYMENT_REFERENCE_INVALID');
    expect(await code(badFormat.id)).toBe('PAYMENT_REFERENCE_INVALID');
    expect(await code(wrongAmount.id)).toBe('AMOUNT_MISMATCH');
    expect(msg.calls('bookings', 'POST')).toHaveLength(0);
    expect(web.tickets.every((t) => t.status === 'PENDING')).toBe(true);
  });

  it('si Bookings no responde, el evento queda RETRY (no se pierde) y se procesa cuando vuelve', async () => {
    const booking = fakeBookings(newBooking());
    msg.down.add('bookings');
    const event = cloudEvent('payment.confirmed', { bookingId: booking.bookingId, paymentReference: REFERENCE });
    await deliver(event);
    await settle();
    const waiting = (await store.inbound(event.id))!;
    expect(waiting.status).toBe('RETRY');
    expect(Date.parse(waiting.nextAttemptAt)).toBeGreaterThan(Date.now());
    msg.down.delete('bookings');
    await store.finishInbound(event.id, 'RETRY', waiting.outcome, new Date().toISOString(), new Date(Date.now() - 1).toISOString()); // adelanta el reintento
    await inbound.processDue();
    expect((await store.inbound(event.id))!).toMatchObject({ status: 'PROCESSED', attempts: 2 });
  });

  it('payment.failed: Offers libera, Bookings FAILED y booking.failed; repetido con otro id no hace nada', async () => {
    const booking = fakeBookings(newBooking());
    offers.handlers.set('ReleaseBookingInventory', () => ({ seatsReleased: 2 }));
    await deliver(cloudEvent('payment.failed', { bookingId: booking.bookingId, paymentReference: REFERENCE, failureReason: 'Fondos insuficientes' }));
    await settle();
    expect(booking.status).toBe('FAILED');
    expect(JSON.parse(msg.calls('bookings', 'POST')[0].body)).toEqual({ errorCode: 'PAYMENT_NOT_AUTHORIZED', reason: 'Fondos insuficientes' });
    expect(publisher.published.map((p) => p.event.type)).toEqual(['ec.edu.epn.booking.vuelos.booking.failed']);
    const again = cloudEvent('payment.failed', { bookingId: booking.bookingId });
    await deliver(again);
    await settle();
    expect((await store.inbound(again.id))!.outcome).toMatchObject({ alreadyFailed: true });
    expect(offers.calls.filter((c) => c.rpc === 'ReleaseBookingInventory')).toHaveLength(1);
  });

  it('package.cancelled de una reserva de la web se rechaza (FORBIDDEN) y se ve en /inbound-events; el caso feliz está en sagas.spec', async () => {
    const web = fakeBookings(newBooking('WEB'));
    const event = cloudEvent('package.cancelled', { bookingId: web.bookingId, packageId: 'PKG-UIO-GYE-0091', reason: 'Falló el hotel' });
    await deliver(event);
    await settle();
    expect((await store.inbound(event.id))!).toMatchObject({ status: 'REJECTED', outcome: { problem: { code: 'FORBIDDEN' } } });
    expect(msg.calls('bookings', 'POST')).toHaveLength(0);
    const list = await svc(http().get('/inbound-events?status=REJECTED')).set('X-Actor-Id', ADMIN);
    expectContract('GET', '/inbound-events', list);
    expect(list.body.items.map((i: Any) => i.id)).toContain(event.id);
    expect((await svc(http().get('/inbound-events'))).status).toBe(400); // sin X-Actor-Id
  });
});

describe('composición: pases de abordar con la puerta vigente (V2.12)', () => {
  const id = '7bc123b6-ec50-4676-8b88-8f82a8c00ac7';
  const segment = { segmentId: 'EA100-20261106', flightNumber: 'EA100', departure: { iataCode: 'UIO', at: '2026-11-06T07:00:00-05:00' }, arrival: { iataCode: 'GYE', at: '2026-11-06T07:50:00-05:00' } };
  const passes = { bookingId: id, boardingPasses: [{ passengerId: 'PAX-1', segmentId: 'EA100-20261106', seat: '7C', gate: 'A1', barcode: 'M1PAZ', barcodeType: 'PDF417' }] };

  it('Bookings comprueba el dueño, CheckIn da los pases y FlightStatus la puerta de hoy', async () => {
    msg.on('bookings', 'GET', `/bookings/${id}`, (r) => (r.headers['x-owner-id'] === OWNER ? { status: 200, body: { bookingId: id, itineraries: [{ segments: [segment] }] } } : { status: 404, body: { type: 'about:blank', title: 'No existe.', status: 404, code: 'NOT_FOUND' } }));
    msg.on('check-in', 'GET', `/check-ins/${id}/boarding-passes`, () => ({ status: 200, body: passes }));
    msg.on('flight-status', 'GET', /^\/flights\/EA100\/status\?date=2026-11-06$/, () => ({ status: 200, body: { departure: { gate: 'B7' } } }));
    const response = await svc(http().get(`/composition/bookings/${id}/boarding-passes`)).set('X-Owner-Id', OWNER);
    expect(response.status).toBe(200);
    expectContract('get', '/composition/bookings/{bookingId}/boarding-passes', response);
    expect(response.body.boardingPasses[0].gate).toBe('B7');
    // Otro dueño: 404 y CheckIn ni se consulta.
    msg.received.length = 0;
    expect((await svc(http().get(`/composition/bookings/${id}/boarding-passes`)).set('X-Owner-Id', 'partner:BOOKING_PROTOTIPO:otro')).status).toBe(404);
    expect(msg.calls('check-in')).toHaveLength(0);
  });

  it('si FlightStatus no responde, el pase sale con la puerta que tenía', async () => {
    msg.on('bookings', 'GET', `/bookings/${id}`, () => ({ status: 200, body: { bookingId: id, itineraries: [{ segments: [segment] }] } }));
    msg.on('check-in', 'GET', `/check-ins/${id}/boarding-passes`, () => ({ status: 200, body: passes }));
    msg.down.add('flight-status');
    const response = await svc(http().get(`/composition/bookings/${id}/boarding-passes`)).set('X-Owner-Id', OWNER);
    expect(response.status).toBe(200);
    expect(response.body.boardingPasses[0].gate).toBe('A1');
  });

  it('el enrutador ya no expone los pases de CheckIn directamente (no comprobaba el dueño)', async () => {
    expect((await svc(http().get(`/router/check-in/check-ins/${id}/boarding-passes`)).set('X-Owner-Id', OWNER)).status).toBe(404);
  });
});

describe('telemetría del panel (V2.16, D50)', () => {
  const admin = (call: request.Test) => svc(call).set('X-Actor-Id', ADMIN);

  it('★ latencia: p50/p95/p99, peticiones y tasa de error por servicio desde Prometheus', async () => {
    msg.on('prometheus', 'GET', /^\/api\/v1\/query\?/, (r) => {
      const query = new URL(r.path, 'http://x').searchParams.get('query')!;
      const value = query.startsWith('histogram_quantile(0.5,') ? '0.012' : query.startsWith('histogram_quantile(0.95,') ? '0.08' : query.startsWith('histogram_quantile(0.99,') ? '0.14' : query.includes('5..') ? '2' : '100';
      return { status: 200, body: { status: 'success', data: { resultType: 'vector', result: [{ metric: { service_name: 'gateway' }, value: [1, value] }] } } };
    });
    const response = await admin(http().get('/composition/telemetry/latency').query({ from: '2026-10-26T10:00:00Z', to: '2026-10-26T11:00:00Z' })).expect(200);
    expectContract('GET', '/composition/telemetry/latency', response);
    expect(response.body).toEqual([{ service: 'gateway', p50_ms: 12, p95_ms: 80, p99_ms: 140, requests: 100, errorRate: 0.02 }]);
    expect(msg.calls('prometheus')[0].path).toContain('%5B3600s%5D');
  });

  it('★ traza por X-Correlation-Id: pasos (Loki), sagas (saga_log) y eventos (Webhooks); 404 sin rastro', async () => {
    const corr = 'corr-busqueda-panel-1';
    msg.on('loki', 'GET', /^\/loki\/api\/v1\/query_range\?/, (r) => {
      const query = new URL(r.path, 'http://x').searchParams.get('query')!;
      if (!query.includes(corr)) return { status: 200, body: { data: { result: [] } } };
      const line = (service: string, status: number) => JSON.stringify({ timestamp: '2026-10-26T10:00:00.000Z', level: 'info', service, correlation_id: corr, request_id: `req-${service}`, trace_id: 'abc123', type: 'api_request', operation: 'POST /x', status, latency_ms: 42 });
      return { status: 200, body: { data: { result: [{ values: [['1', line('esb', 201)], ['2', line('gateway', 201)]] }] } } };
    });
    msg.on('webhooks', 'GET', /^\/history\?/, () => ({ status: 200, body: { items: [] } }));
    const now = new Date().toISOString();
    await store.insertSaga({ sagaId: randomUUID(), type: 'CREATE_BOOKING', status: 'COMPLETED', input: { secreto: 'x' }, steps: [], result: null, error: null, ownerId: OWNER, actorId: null, correlationId: corr, parentSagaId: null, attempts: 0, leaseUntil: now, nextAttemptAt: now, createdAt: now, updatedAt: now });
    const response = await admin(http().get(`/composition/telemetry/traces/${corr}`)).expect(200);
    expectContract('GET', '/composition/telemetry/traces/{correlationId}', response);
    expect(response.body.steps.map((s: { service: string }) => s.service)).toEqual(['esb', 'gateway']);
    expect(response.body.sagas).toEqual([expect.objectContaining({ type: 'CREATE_BOOKING', status: 'COMPLETED' })]);
    expect(JSON.stringify(response.body)).not.toContain('secreto'); // la entrada de la saga nunca sale
    expect(msg.calls('webhooks', 'GET')[0].headers['x-actor-id']).toBe(ADMIN);
    await admin(http().get('/composition/telemetry/traces/corr-sin-rastro')).expect(404);

    // O-2: con rango, Loki busca solo en esa ventana (7 días tardan ~24 s en la VM); un rango inválido → 400.
    const from = '2026-11-08T03:50:00.000Z';
    const to = '2026-11-08T04:30:00.000Z';
    await admin(http().get(`/composition/telemetry/traces/${corr}`).query({ from, to })).expect(200);
    const loki = new URL(msg.calls('loki').at(-1)!.path, 'http://x').searchParams;
    expect([loki.get('start'), loki.get('end')]).toEqual([String(Date.parse(from) * 1_000_000), String(Date.parse(to) * 1_000_000)]);
    await admin(http().get(`/composition/telemetry/traces/${corr}`).query({ from: 'ayer' })).expect(400);
  });

  it('★ T-2: sin rango, la ventana de Loki sale de las sagas y eventos del proceso (±10 min); sin ellos, las últimas 3 h', async () => {
    const corr = 'corr-ventana-automatica';
    msg.on('loki', 'GET', /^\/loki\/api\/v1\/query_range\?/, () => ({ status: 200, body: { data: { result: [] } } }));
    const createdAt = '2026-11-05T14:00:00.000Z';
    const updatedAt = '2026-11-05T14:00:03.000Z';
    msg.on('webhooks', 'GET', /^\/history\?/, () => ({ status: 200, body: { items: [] } }));
    msg.on('webhooks', 'GET', /^\/history\?correlationId=corr-ventana-automatica/, () => ({ status: 200, body: { items: [{ seq: 1, id: 'e1', type: 'ec.edu.epn.booking.vuelos.booking.confirmed', subject: 'b1', time: '2026-11-05T14:00:05.000Z', correlationId: corr, public: true, data: null, deliveries: [] }] } }));
    await store.insertSaga({ sagaId: randomUUID(), type: 'CREATE_BOOKING', status: 'COMPLETED', input: {}, steps: [], result: null, error: null, ownerId: OWNER, actorId: null, correlationId: corr, parentSagaId: null, attempts: 0, leaseUntil: createdAt, nextAttemptAt: createdAt, createdAt, updatedAt });
    const response = await admin(http().get(`/composition/telemetry/traces/${corr}`)).expect(200);
    expectContract('GET', '/composition/telemetry/traces/{correlationId}', response);
    expect(response.body.window).toEqual({ from: '2026-11-05T13:50:00.000Z', to: '2026-11-05T14:10:05.000Z', source: 'RECORDS' });
    const loki = new URL(msg.calls('loki').at(-1)!.path, 'http://x').searchParams;
    expect([loki.get('start'), loki.get('end')]).toEqual([String(Date.parse('2026-11-05T13:50:00.000Z') * 1_000_000), String(Date.parse('2026-11-05T14:10:05.000Z') * 1_000_000)]);

    // Sin sagas ni eventos: las últimas 3 h, y el 404 lo dice.
    const before = Date.now();
    const missing = await admin(http().get('/composition/telemetry/traces/corr-nada')).expect(404);
    expect(missing.body.title).toContain('últimas 3 horas');
    const last = new URL(msg.calls('loki').at(-1)!.path, 'http://x').searchParams;
    expect(Number(last.get('end')) / 1_000_000 - Number(last.get('start')) / 1_000_000).toBe(3 * 3_600_000);
    expect(Number(last.get('end')) / 1_000_000).toBeGreaterThanOrEqual(before);
  });

  it('★ T-2: si Loki tarda, vienen las sagas y los eventos con el aviso honesto; sin nada más, 503 con el mismo aviso', async () => {
    const corr = 'corr-loki-lento';
    msg.on('loki', 'GET', /^\/loki\/api\/v1\/query_range\?/, () => ({ status: 200, delayMs: 3_500, body: { data: { result: [] } } }));
    msg.on('webhooks', 'GET', /^\/history\?/, () => ({ status: 200, body: { items: [] } }));
    const now = new Date().toISOString();
    await store.insertSaga({ sagaId: randomUUID(), type: 'CHANGE_SEAT', status: 'COMPLETED', input: {}, steps: [], result: null, error: null, ownerId: OWNER, actorId: null, correlationId: corr, parentSagaId: null, attempts: 0, leaseUntil: now, nextAttemptAt: now, createdAt: now, updatedAt: now });
    const response = await admin(http().get(`/composition/telemetry/traces/${corr}`)).expect(200);
    expectContract('GET', '/composition/telemetry/traces/{correlationId}', response);
    expect(response.body.steps).toEqual([]);
    expect(response.body.sagas).toEqual([expect.objectContaining({ type: 'CHANGE_SEAT' })]);
    expect(response.body.stepsError).toBe('La búsqueda tardó demasiado: prueba con un rango más corto.');

    const alone = await admin(http().get('/composition/telemetry/traces/corr-sin-sagas-lento')).expect(503);
    expect(alone.body.detail).toBe('La búsqueda tardó demasiado: prueba con un rango más corto.');
  }, 15_000);

  it('★ panel O-2: historial de una reserva — sus sagas con los pasos (sin entrada ni resultado) y sus eventos por `subject`', async () => {
    const bookingId = randomUUID();
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();
    const saga = (type: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
      sagaId: randomUUID(), type, status: 'COMPLETED' as const, input: { bookingId, request: { documentNumber: 'P1234567', notes: 'dato de salud' } },
      steps: [{ name: 'bookings.get', status: 'DONE' as const, result: { secreto: 'x' }, at: createdAt }], result: { secreto: 'resultado' }, error: null,
      ownerId: OWNER, actorId: null, correlationId: `corr-${type}`, parentSagaId: null, attempts: 1, leaseUntil: createdAt, nextAttemptAt: createdAt, createdAt, updatedAt: createdAt, ...extra,
    });
    await store.insertSaga(saga('CANCEL_BOOKING', now));
    await store.insertSaga(saga('CREATE_BOOKING', earlier));
    await store.insertSaga({ ...saga('CREATE_BOOKING', now), input: { bookingId: randomUUID() } }); // de otra reserva
    msg.on('webhooks', 'GET', /^\/history\?/, (r) => ({
      status: 200,
      body: { items: r.path.includes(`subject=${bookingId}`) ? [{ seq: 7, id: randomUUID(), type: 'ec.edu.epn.booking.vuelos.booking.cancelled', subject: bookingId, time: now, correlationId: 'corr-CANCEL_BOOKING', public: true, data: { bookingId }, deliveries: [] }] : [] },
    }));
    const response = await admin(http().get(`/composition/bookings/${bookingId}/timeline`)).expect(200);
    expectContract('GET', '/composition/bookings/{bookingId}/timeline', response);
    expect(response.body.sagas.map((s: { type: string }) => s.type)).toEqual(['CREATE_BOOKING', 'CANCEL_BOOKING']);
    expect(response.body.sagas[0].steps).toEqual([{ name: 'bookings.get', status: 'DONE', at: earlier }]);
    expect(response.body.events).toHaveLength(1);
    const body = JSON.stringify(response.body);
    for (const hidden of ['secreto', 'P1234567', 'dato de salud']) expect(body).not.toContain(hidden);
    expect(msg.calls('webhooks', 'GET').at(-1)!.headers['x-actor-id']).toBe(ADMIN);
    await svc(http().get(`/composition/bookings/${bookingId}/timeline`)).expect(403); // sin X-Actor-Id
    await admin(http().get('/composition/bookings/no-es-uuid/timeline')).expect(400);
  });

  it('colas de RabbitMQ (con usuario y contraseña) sin las de espera, con sus fallidos; alertas de Alertmanager', async () => {
    msg.on('rabbitmq', 'GET', '/api/queues', () => ({ status: 200, body: [
      { name: 'webhooks.events', messages: 3, consumers: 1 }, { name: 'webhooks.events.dlq', messages: 2, consumers: 0 }, { name: 'webhooks.events.retry.1s', messages: 1, consumers: 0 }, { name: 'esb.deferred.wait.2s', messages: 0, consumers: 0 },
    ] }));
    const queues = await admin(http().get('/composition/telemetry/queues')).expect(200);
    expectContract('GET', '/composition/telemetry/queues', queues);
    expect(queues.body).toEqual([{ queue: 'webhooks.events', messages: 3, consumers: 1, deadLetters: 2 }]);
    expect(msg.calls('rabbitmq')[0].headers['authorization']).toBe(`Basic ${Buffer.from('eco:clave-rabbit').toString('base64')}`);
    msg.on('alertmanager', 'GET', /^\/api\/v2\/alerts\?/, () => ({ status: 200, body: [{ fingerprint: 'f1', labels: { alertname: 'StockSinEnviar', severity: 'warning' }, annotations: { summary: '736 cambios de stock sin enviar' }, startsAt: '2026-10-26T10:00:00Z' }] }));
    const alerts = await admin(http().get('/composition/telemetry/alerts')).expect(200);
    expectContract('GET', '/composition/telemetry/alerts', alerts);
    expect(alerts.body).toEqual([{ id: 'f1', rule: 'StockSinEnviar', severity: 'WARNING', message: '736 cambios de stock sin enviar', startedAt: '2026-10-26T10:00:00Z' }]);
  });

  it('sin X-Actor-Id → 403; si la plataforma no responde → 503 PROVIDER_UNAVAILABLE', async () => {
    await svc(http().get('/composition/telemetry/queues')).expect(403);
    msg.down.add('alertmanager');
    const down = await admin(http().get('/composition/telemetry/alerts')).expect(503);
    expect(down.body.code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('catálogo de aeropuertos (PLAN_Telemetria_Asientos M-1)', () => {
  const airport = { code: 'JPJ', city: 'Jipijapa', name: 'Aeródromo de Jipijapa', country: 'EC', province: 'Manabí', lat: -1.3486, lon: -80.5786, utcOffsetMinutes: -300, active: true, updatedAt: '2026-11-10T00:00:00Z' };
  // La prueba de «MS.G caído» deja abierto el circuito de Schedule.
  beforeEach(() => upstreams.rest.schedule.breaker.reset());
  afterEach(() => removeAirport('JPJ'));

  it('★ el enrutador pasa las escrituras a Schedule y el catálogo del ESB se actualiza en el acto (alta, cambio y baja)', async () => {
    msg.on('schedule', 'POST', '/airports', () => ({ status: 201, body: airport }));
    msg.on('schedule', 'PUT', '/airports/JPJ', () => ({ status: 200, body: { ...airport, country: 'CO' } }));
    msg.on('schedule', 'DELETE', '/airports/JPJ', () => ({ status: 204 }));
    const created = await svc(http().post('/router/schedule/airports')).set('X-Actor-Id', ADMIN).send({ code: 'JPJ', city: 'Jipijapa', name: 'Aeródromo de Jipijapa', country: 'EC', lat: -1.3486, lon: -80.5786, utcOffsetMinutes: -300 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(msg.calls('schedule', 'POST', '/airports')[0].headers['x-actor-id']).toBe(ADMIN);
    expect(AIRPORTS['JPJ']).toMatchObject({ city: 'Jipijapa', country: 'EC', active: true });
    expect((await svc(http().put('/router/schedule/airports/JPJ')).set('X-Actor-Id', ADMIN).send({ ...airport })).status).toBe(200);
    expect(AIRPORTS['JPJ'].country).toBe('CO'); // ahora sería internacional desde Quito
    expect((await svc(http().delete('/router/schedule/airports/JPJ')).set('X-Actor-Id', ADMIN)).status).toBe(204);
    expect(AIRPORTS['JPJ']).toBeUndefined();
  });

  it('una escritura que Schedule rechaza no cambia el catálogo', async () => {
    msg.on('schedule', 'DELETE', '/airports/UIO', () => ({ status: 409, body: { type: 'about:blank', title: 'UIO está en uso: no se puede borrar.', status: 409, code: 'AIRPORT_IN_USE' } }));
    expect((await svc(http().delete('/router/schedule/airports/UIO')).set('X-Actor-Id', ADMIN)).status).toBe(409);
    expect(AIRPORTS['UIO']).toEqual(SEED_AIRPORTS['UIO']);
  });
});

describe('catálogo de tipos de avión (PLAN_Telemetria_Asientos M-2)', () => {
  beforeEach(() => upstreams.rest.schedule.breaker.reset());
  it('el enrutador reenvía el nombre del tipo codificado en la ruta (con espacios)', async () => {
    msg.on('schedule', 'PUT', /^\/aircraft-types\//, () => ({ status: 409, body: { type: 'about:blank', title: 'El Embraer E195-E2 tiene aviones: no se cambia.', status: 409, code: 'AIRCRAFT_TYPE_IN_USE' } }));
    msg.on('schedule', 'DELETE', /^\/aircraft-types\//, () => ({ status: 204 }));
    const changed = await svc(http().put('/router/schedule/aircraft-types/Embraer%20E195-E2')).set('X-Actor-Id', ADMIN).send({ registrationPrefix: 'HC-E', maxRouteKm: 1000, turnaroundMinutes: 30, business: { seats: 12, configuration: '2-2' }, economy: { seats: 112, configuration: '2-4-2' } });
    expect([changed.status, changed.body.code]).toEqual([409, 'AIRCRAFT_TYPE_IN_USE']);
    expect(msg.calls('schedule', 'PUT').at(-1)!.path).toBe('/aircraft-types/Embraer%20E195-E2');
    expect((await svc(http().delete('/router/schedule/aircraft-types/Embraer%20E195-E2')).set('X-Actor-Id', ADMIN)).status).toBe(204);
  });
});

describe('vista «Recorrido» y mapa en vivo (PLAN_Telemetria_Asientos T-4)', () => {
  const admin = (call: request.Test) => svc(call).set('X-Actor-Id', ADMIN);
  const otlp = (spans: unknown[]) => ({ trace: { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'gateway' } }] }, scopeSpans: [{ spans }] }] } });

  it('★ recorrido: busca en Tempo por correlation_id dentro de la ventana de sus sagas, trae cada traza y arma los saltos', async () => {
    const corr = 'corr-recorrido-1';
    const at = '2026-11-05T14:00:00.000Z';
    msg.on('webhooks', 'GET', /^\/history\?/, () => ({ status: 200, body: { items: [] } }));
    await store.insertSaga({ sagaId: randomUUID(), type: 'CREATE_BOOKING', status: 'COMPLETED', input: {}, steps: [], result: null, error: null, ownerId: OWNER, actorId: null, correlationId: corr, parentSagaId: null, attempts: 0, leaseUntil: at, nextAttemptAt: at, createdAt: at, updatedAt: at });
    msg.on('tempo', 'GET', /^\/api\/search\?/, () => ({ status: 200, body: { traces: [{ traceID: 'abc' }] } }));
    msg.on('tempo', 'GET', '/api/v2/traces/abc', () => ({ status: 200, body: otlp([{ traceId: 'abc', spanId: 's1', name: 'POST', kind: 'SPAN_KIND_SERVER', startTimeUnixNano: '1794297355000000000', endTimeUnixNano: '1794297355500000000', attributes: [{ key: 'http.request.method', value: { stringValue: 'POST' } }, { key: 'http.route', value: { stringValue: '/api/graphql' } }] }]) }));
    const response = await admin(http().get(`/composition/telemetry/journeys/${corr}`)).expect(200);
    expectContract('GET', '/composition/telemetry/journeys/{correlationId}', response);
    expect(response.body).toMatchObject({ correlationId: corr, traces: 1, hops: [{ sequence: 1, from: 'cliente', to: 'gateway', operation: 'POST /api/graphql', durationMs: 500 }], window: { source: 'RECORDS' } });
    const search = new URL(msg.calls('tempo', 'GET', /^\/api\/search/)[0].path, 'http://x').searchParams;
    expect(search.get('q')).toBe(`{ span.correlation_id = "${corr}" }`);
    expect([search.get('start'), search.get('end')]).toEqual([String(Date.parse('2026-11-05T13:50:00Z') / 1000), String(Date.parse('2026-11-05T14:10:00Z') / 1000)]);
    // Sin trazas: 404; sin X-Actor-Id: 403.
    msg.on('tempo', 'GET', /^\/api\/search\?/, () => ({ status: 200, body: { traces: [] } }));
    expect((await admin(http().get('/composition/telemetry/journeys/corr-sin-trazas')).expect(404)).body.title).toContain('últimas 3 horas');
    await svc(http().get(`/composition/telemetry/journeys/${corr}`)).expect(403);
  });

  it('★ mapa en vivo: aristas de los últimos 5 min con peticiones, errores por minuto y p95, de la más usada a la menos', async () => {
    msg.on('prometheus', 'GET', /^\/api\/v1\/query\?/, (r) => {
      const query = new URL(r.path, 'http://x').searchParams.get('query')!;
      const value = query.includes('failed') ? ['0.5', '0'] : query.includes('histogram_quantile') ? ['120', '35.5'] : ['12', '3'];
      return { status: 200, body: { status: 'success', data: { resultType: 'vector', result: [{ metric: { client: 'esb', server: 'ms-g-bookings' }, value: [1, value[1]] }, { metric: { client: 'gateway', server: 'ms-reservas' }, value: [1, value[0]] }] } } };
    });
    const response = await admin(http().get('/composition/telemetry/system-map')).expect(200);
    expectContract('GET', '/composition/telemetry/system-map', response);
    expect(response.body.edges).toEqual([
      { from: 'gateway', to: 'ms-reservas', requestsPerMinute: 12, errorsPerMinute: 0.5, p95Ms: 120 },
      { from: 'esb', to: 'ms-g-bookings', requestsPerMinute: 3, errorsPerMinute: 0, p95Ms: 35.5 },
    ]);
  });
});

