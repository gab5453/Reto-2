import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { ADMIN_SUB, createResponseApp, FakeEsb, PARTNER_ID, tokens } from '../../../../tests/support/response-service.js';
import { definition } from '../src/service.js';

/** MS.Admin (V2.12) contra un ESB falso: solo ADMIN, `X-Actor-Id` en cada llamada, y cada grupo del panel. */
const expectOwn = contractValidator('ms-admin.openapi.yaml');
const esb = new FakeEsb();
let app: NestExpressApplication;
const http = () => request(app.getHttpServer());
const admin = (call: request.Test) => call.set('Authorization', tokens.admin());
const USER = { sub: '1f0a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b', email: 'ana@ecoairlines.test', fullName: 'Ana Paz', role: 'CUSTOMER', status: 'ACTIVE', createdAt: '2026-10-25T00:00:00Z' };

beforeAll(async () => {
  await esb.start();
  app = await createResponseApp(definition(), esb);
});
afterAll(async () => {
  await app.close();
  await esb.stop();
});
beforeEach(() => esb.reset());

describe('seguridad del panel', () => {
  it('★ solo un usuario ADMIN: un cliente o un partner reciben 403, sin token 401', async () => {
    await http().get('/api/v2/ecoairlines/admin/users').expect(401);
    expectOwn('get', '/ecoairlines/admin/users', await http().get('/api/v2/ecoairlines/admin/users').set('Authorization', tokens.customer()).expect(403));
    expectOwn('get', '/ecoairlines/admin/users', await http().get('/api/v2/ecoairlines/admin/users').set('Authorization', tokens.partner()).expect(403));
    expect(esb.calls).toHaveLength(0);
  });

  it('cada llamada lleva X-Actor-Id = sub del administrador y los filtros del contrato', async () => {
    esb.on('GET', '/router/identity/users', { body: { items: [USER] } });
    const response = await admin(http().get('/api/v2/ecoairlines/admin/users').query({ q: 'ana', role: 'CUSTOMER', limit: 10, desconocido: 'x' })).expect(200);
    expectOwn('get', '/ecoairlines/admin/users', response);
    const call = esb.last()!;
    expect(call.headers['x-actor-id']).toBe(ADMIN_SUB);
    expect(call.headers['x-owner-id']).toBeUndefined();
    // Solo los parámetros del contrato llegan al ESB.
    expect(call.path).toBe('/router/identity/users?q=ana&role=CUSTOMER&limit=10');
  });
});

describe('usuarios y partners (Identity por el enrutador)', () => {
  it('createUser 201; un código propio de Identity sale en `type`', async () => {
    esb.on('POST', '/router/identity/users', { status: 201, body: USER });
    expectOwn('post', '/ecoairlines/admin/users', await admin(http().post('/api/v2/ecoairlines/admin/users')).send({ email: 'ana@ecoairlines.test', fullName: 'Ana Paz', password: 'Clave-segura-1', role: 'CUSTOMER' }).expect(201));
    esb.on('POST', '/router/identity/users', { status: 409, body: { type: 'about:blank', title: 'El correo ya está registrado.', status: 409, code: 'EMAIL_ALREADY_REGISTERED' } });
    const taken = await admin(http().post('/api/v2/ecoairlines/admin/users')).send({ email: 'ana@ecoairlines.test', fullName: 'Ana Paz', password: 'Clave-segura-1', role: 'CUSTOMER' }).expect(409);
    expectOwn('post', '/ecoairlines/admin/users', taken);
    expect(taken.body.type).toBe('urn:ecoairlines:problema:EMAIL_ALREADY_REGISTERED');
  });

  it('rotatePartnerSecret: el secreto nuevo se muestra una vez, con Cache-Control: no-store', async () => {
    esb.on('POST', `/router/identity/partners/${PARTNER_ID}/secret`, { body: { clientId: PARTNER_ID, name: 'Booking Prototipo', scopes: ['flights:read'], status: 'ACTIVE', createdAt: '2026-10-25T00:00:00Z', clientSecret: 'nuevo-secreto-0123456789' }, headers: { 'cache-control': 'no-store' } });
    const response = await admin(http().post(`/api/v2/ecoairlines/admin/partners/${PARTNER_ID}/secret`)).expect(200);
    expectOwn('post', '/ecoairlines/admin/partners/{clientId}/secret', response);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('precios, rutas y asistencia', () => {
  const TABLE = { items: [], updatedAt: '2026-10-25T00:00:00Z', updatedBy: ADMIN_SUB };
  const AGREEMENT = { proveedor_codigo: 'NODE_VUE_ECOAIRLINES', nombre_socio: 'EcoAirlines', vertical: 'VUELOS', actualizado_en: '2026-10-25T17:41:38.120Z', permite_promociones: false, porcentaje_descuento_maximo: 0 };

  it('savePrices: un solo «Guardar» ejecuta las dos sagas y responde la vista nueva', async () => {
    esb.on('PUT', '/sagas/fare-prices', { body: TABLE });
    esb.on('PUT', `/sagas/promotion-agreements/${PARTNER_ID}`, { body: AGREEMENT });
    esb.on('GET', '/router/schedule/fare-prices', { body: TABLE });
    esb.on('GET', '/router/identity/partners', { body: { items: [{ clientId: PARTNER_ID }, { clientId: 'SIN_ACUERDO' }], nextCursor: null } });
    esb.on('GET', `/router/schedule/promotion-agreements/${PARTNER_ID}`, { body: AGREEMENT });
    esb.on('GET', '/router/schedule/promotion-agreements/SIN_ACUERDO', { status: 404, body: { type: 'about:blank', title: 'Sin acuerdo.', status: 404, code: 'NOT_FOUND' } });
    const response = await admin(http().put('/api/v2/ecoairlines/admin/prices'))
      .send({ prices: { items: [{ cabinClass: 'ECONOMY', fareBrand: 'BROTE', multiplier: 1.2 }] }, promotion: { partnerId: PARTNER_ID, agreement: { permite_promociones: false, porcentaje_descuento_maximo: 0 } } })
      .expect(200);
    expect(response.body.promotions).toHaveLength(1);
    expect(response.body.promotions[0].partnerId).toBe(PARTNER_ID); // no `proveedor_codigo`: ese es la aerolínea
    expect(esb.calls.filter((c) => c.path.startsWith('/sagas/')).map((c) => c.path)).toEqual(['/sagas/fare-prices', `/sagas/promotion-agreements/${PARTNER_ID}`]);
  });

  it('createRoute: la saga "Publicar horario" responde solo la ruta (201 ScheduledRoute), sin el resultado de Offers', async () => {
    const leg = (flightNumber: string, origin: string, destination: string) => ({ flightNumber, origin, destination, departureLocal: '07:00', arrivalLocal: '07:50', arrivalDayOffset: 0 });
    const route = { routeId: 'EA300-EA301', origin: 'UIO', destination: 'CUE', outbound: leg('EA300', 'UIO', 'CUE'), inbound: leg('EA301', 'CUE', 'UIO'), weekdays: ['MON'], aircraftType: 'Airbus A320neo', aircraft: ['HC-EAA'], distanceKm: 300, durationMinutes: 50, source: 'ADMIN', createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z', updatedBy: ADMIN_SUB };
    esb.on('POST', '/sagas/routes', { status: 201, body: { route, flights: 120, published: { flights: 120 } } });
    const response = await admin(http().post('/api/v2/ecoairlines/admin/routes')).send({ origin: 'UIO', destination: 'CUE', outboundDepartureLocal: '07:00', inboundDepartureLocal: '09:00', weekdays: ['MON'] }).expect(201);
    expectOwn('post', '/ecoairlines/admin/routes', response);
    expect(response.body).not.toHaveProperty('flights');
    expect(response.body.routeId).toBe('EA300-EA301');
  });

  it('deleteRoute → 204; listFlightAssistance (dato de salud) por la composición con X-Actor-Id', async () => {
    esb.on('DELETE', '/sagas/routes/EA100-EA101', { body: { deletedRouteId: 'EA100-EA101', flights: 0 } });
    await admin(http().delete('/api/v2/ecoairlines/admin/routes/EA100-EA101')).expect(204);
    esb.on('GET', '/composition/flights/EA100/assistance', { body: [] });
    expectOwn('get', '/ecoairlines/admin/flights/{flightNumber}/assistance', await admin(http().get('/api/v2/ecoairlines/admin/flights/EA100/assistance').query({ date: '2026-11-04' })).expect(200));
    expect(esb.last()!.headers['x-actor-id']).toBe(ADMIN_SUB);
  });
});

describe('eventos y telemetría', () => {
  it('listEventHistory busca por correlation id (parámetro nuevo de ms-admin 1.1.0)', async () => {
    esb.on('GET', '/router/webhooks/history', { body: { items: [], nextCursor: null } });
    await admin(http().get('/api/v2/ecoairlines/admin/events').query({ correlationId: 'corr-x', limit: 5 })).expect(200);
    expect(esb.last()!.path).toBe('/router/webhooks/history?correlationId=corr-x&limit=5');
  });

  it('★ V2.16: latencia, traza por correlation id, colas y alertas por la composición del ESB (con el actor)', async () => {
    esb.on('GET', '/composition/services-health', { body: [{ service: 'ms-g-offers', status: 'UP', latency_ms: 3, checkedAt: '2026-10-26T00:00:00Z' }] });
    expectOwn('get', '/ecoairlines/admin/telemetry/services', await admin(http().get('/api/v2/ecoairlines/admin/telemetry/services')).expect(200));
    esb.on('GET', '/composition/telemetry/latency', { body: [{ service: 'gateway', p50_ms: 12, p95_ms: 80, p99_ms: 140, requests: 52, errorRate: 0.02 }] });
    const latency = await admin(http().get('/api/v2/ecoairlines/admin/telemetry/latency').query({ from: '2026-10-26T00:00:00Z' })).expect(200);
    expectOwn('get', '/ecoairlines/admin/telemetry/latency', latency);
    expect(esb.last()!.path).toBe('/composition/telemetry/latency?from=2026-10-26T00%3A00%3A00Z');
    expect(esb.last()!.headers['x-actor-id']).toBeDefined();
    esb.on('GET', '/composition/telemetry/traces/corr-x', { body: { correlationId: 'corr-x', steps: [{ timestamp: '2026-10-26T00:00:00Z', service: 'gateway', operation: 'POST /api/v2/*path', status: '201', latency_ms: 90, request_id: 'req-1', trace_id: 'abc' }], sagas: [{ sagaId: 's1', type: 'CREATE_BOOKING', status: 'COMPLETED' }], events: { items: [] } } });
    expectOwn('get', '/ecoairlines/admin/telemetry/traces/{correlationId}', await admin(http().get('/api/v2/ecoairlines/admin/telemetry/traces/corr-x')).expect(200));
    esb.on('GET', '/composition/telemetry/queues', { body: [{ queue: 'webhooks.events', messages: 0, consumers: 1, deadLetters: 0 }] });
    expectOwn('get', '/ecoairlines/admin/telemetry/queues', await admin(http().get('/api/v2/ecoairlines/admin/telemetry/queues')).expect(200));
    esb.on('GET', '/composition/telemetry/alerts', { body: [{ id: 'f1', rule: 'StockSinEnviar', severity: 'WARNING', message: 'Stock pendiente', startedAt: '2026-10-26T00:00:00Z' }] });
    expectOwn('get', '/ecoairlines/admin/telemetry/alerts', await admin(http().get('/api/v2/ecoairlines/admin/telemetry/alerts')).expect(200));
    // Si la plataforma no responde, el 503 del ESB llega como PROVIDER_UNAVAILABLE.
    esb.on('GET', '/composition/telemetry/queues', { status: 503, body: { type: 'about:blank', title: 'RabbitMQ no está disponible.', status: 503, code: 'PROVIDER_UNAVAILABLE' } });
    const down = await admin(http().get('/api/v2/ecoairlines/admin/telemetry/queues')).expect(503);
    expectOwn('get', '/ecoairlines/admin/telemetry/queues', down);
    expect(down.body.code).toBe('PROVIDER_UNAVAILABLE');
  });
});
