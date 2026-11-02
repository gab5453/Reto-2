import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ContractFiles } from '@ecoairlines/shared/respuesta/index.js';
import { PARTNER_ID, tokens } from '../../../tests/support/response-service.js';
import { buildRestRoutes } from '../src/rest/routes.js';
import { createGatewayApp, type FakeServices, problem, resetFakeServices, startFakeServices, stopFakeServices } from './support.js';

/**
 * Fachada REST del gateway (V2.13, PLAN.md §4.4): tabla cerrada de las 30 operaciones del contrato v2 + `/oauth2/token`,
 * verificación del token, `X-Correlation-Id` en toda respuesta, límite de búsquedas y reenvío al MS de su `x-microservice`.
 */
let fakes: FakeServices;
let app: NestExpressApplication;
const http = () => request(app.getHttpServer());
const BOOKING_ID = '7bc123b6-ec50-4676-8b88-8f82a8c00ac7';

beforeAll(async () => {
  fakes = await startFakeServices();
  ({ app } = await createGatewayApp(fakes, { RATE_LIMIT_SEARCH_LIMIT: '2' }));
});
afterAll(async () => {
  await app.close();
  await stopFakeServices(fakes);
});
beforeEach(() => resetFakeServices(fakes));

describe('tabla de rutas', () => {
  it('las 30 operaciones del contrato v2, cada una en el MS de su x-microservice, más /oauth2/token', () => {
    const { table, targets } = buildRestRoutes(new ContractFiles());
    expect(table.operations).toHaveLength(31);
    expect(targets.get('searchFlights')).toBe('MS.Vuelos');
    expect(targets.get('createHold')).toBe('MS.Reservas');
    expect(targets.get('cancelBooking')).toBe('MS.Postventa');
    expect(targets.get('createWebhook')).toBe('MS.Clientes');
    expect(targets.get('issuePartnerToken')).toBe('MS.Clientes');
    // Las propias de la web no se publican en REST (D23).
    expect([...targets.keys()].some((id) => ['createWebBooking', 'login', 'listUsers', 'listRefunds'].includes(id))).toBe(false);
  });

  it.each([
    ['GET', '/api/v2/vuelos/offers/O1/seatmap?segmentId=S1', 'MS.Vuelos'],
    ['GET', `/api/v2/vuelos/bookings/${BOOKING_ID}`, 'MS.Reservas'],
    ['GET', `/api/v2/vuelos/bookings/${BOOKING_ID}/cancellation-quote`, 'MS.Postventa'],
    ['GET', '/api/v2/vuelos/webhooks', 'MS.Clientes'],
  ] as const)('%s %s → %s, con la misma ruta y query', async (method, path, service) => {
    fakes[service].on(method, /.*/, { body: {} });
    await http().get(path).set('Authorization', tokens.partner()).set('X-User-Id', 'u1').expect(200);
    expect(fakes[service].last()!.path).toBe(path);
    for (const other of Object.keys(fakes) as (keyof FakeServices)[]) if (other !== service) expect(fakes[other].calls).toHaveLength(0);
  });

  it('404 si la ruta no existe (las propias /ecoairlines/* tampoco), 405 con Allow si es otro método', async () => {
    for (const path of ['/api/v2/vuelos/no-existe', '/api/v2/ecoairlines/admin/users', `/api/v2/ecoairlines/bookings/${BOOKING_ID}/refunds`, '/api/v2/vuelos/../ecoairlines/admin/users']) {
      const response = await http().get(path).set('Authorization', tokens.admin()).expect(404);
      expect(response.body).toMatchObject({ status: 404, code: 'NOT_FOUND', instance: expect.stringContaining('/api/v2') });
    }
    const wrong = await http().delete('/api/v2/vuelos/search').expect(405);
    expect(wrong.headers['allow']).toBe('POST');
    expect(Object.values(fakes).every((fake) => fake.calls.length === 0)).toBe(true);
  });
});

describe('token (JWKS) antes de reenviar', () => {
  it.each([
    ['sin token', undefined],
    ['firmado con otra clave', tokens.otherKey()],
    ['vencido', tokens.expired()],
    ['de servicio (del ESB)', tokens.service()],
    ['de servicio (de un MS de respuesta, D44)', tokens.service('ecoairlines:esb')],
  ])('401 UNAUTHORIZED %s, con WWW-Authenticate y sin llamar al MS', async (_label, authorization) => {
    const call = http().get('/api/v2/vuelos/bookings');
    if (authorization) call.set('Authorization', authorization);
    const response = await call.expect(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.body).toMatchObject({ status: 401, code: 'UNAUTHORIZED', instance: '/api/v2/vuelos/bookings', correlation_id: response.headers['x-correlation-id'] });
    expect(fakes['MS.Reservas'].calls).toHaveLength(0);
  });

  it('partner y usuario pasan con su token intacto (el MS lo vuelve a verificar); las operaciones públicas no lo piden', async () => {
    fakes['MS.Reservas'].on('GET', '/api/v2/vuelos/bookings', { body: { items: [], nextCursor: null } });
    const partner = tokens.partner();
    await http().get('/api/v2/vuelos/bookings').set('Authorization', partner).set('X-User-Id', 'usr-1').expect(200);
    expect(fakes['MS.Reservas'].last()!.headers).toMatchObject({ authorization: partner, 'x-user-id': 'usr-1' });
    await http().get('/api/v2/vuelos/bookings').set('Authorization', tokens.customer()).expect(200);
    fakes['MS.Vuelos'].on('GET', '/api/v2/vuelos/health', { body: { status: 'HEALTHY' } });
    await http().get('/api/v2/vuelos/health').expect(200);
    expect(fakes['MS.Vuelos'].last()!.headers['authorization']).toBeUndefined();
  });

  it('los scopes los decide el MS: su 403 llega tal cual', async () => {
    fakes['MS.Vuelos'].on('PUT', '/api/v2/vuelos/promociones/contrato', { status: 403, body: problem(403, 'FORBIDDEN', 'Falta el scope flights:admin.') });
    const response = await http().put('/api/v2/vuelos/promociones/contrato').set('Authorization', tokens.partner()).set('Idempotency-Key', crypto.randomUUID()).send({}).expect(403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN', title: 'Falta el scope flights:admin.' });
  });
});

describe('reenvío', () => {
  it('★ X-Correlation-Id: se crea si no llega, se conserva si llega y viaja igual al MS; X-Request-Id es nuevo en cada salto', async () => {
    fakes['MS.Vuelos'].on('GET', '/api/v2/vuelos/health', { body: { status: 'HEALTHY' } });
    const created = await http().get('/api/v2/vuelos/health').expect(200);
    expect(created.headers['x-correlation-id']).toMatch(/^corr-/);
    expect(fakes['MS.Vuelos'].last()!.headers['x-correlation-id']).toBe(created.headers['x-correlation-id']);
    const kept = await http().get('/api/v2/vuelos/health').set('X-Correlation-Id', 'corr-booking-123').set('X-Request-Id', 'req-booking-1').expect(200);
    expect(kept.headers['x-correlation-id']).toBe('corr-booking-123');
    const upstream = fakes['MS.Vuelos'].last()!.headers;
    expect(upstream['x-correlation-id']).toBe('corr-booking-123');
    expect(upstream['x-request-id']).not.toBe('req-booking-1');
    // También en un error del propio gateway.
    expect((await http().get('/api/v2/vuelos/nada').set('X-Correlation-Id', 'corr-booking-123').expect(404)).headers['x-correlation-id']).toBe('corr-booking-123');
  });

  it('201: status, cuerpo, Location (ruta pública) e Idempotent-Replayed del MS; el cuerpo y la Idempotency-Key viajan tal cual', async () => {
    const hold = { holdId: '2f1d1a0e-0f5b-4c8a-9d1e-3b2a1c0d9e8f', status: 'HELD' };
    fakes['MS.Reservas'].on('POST', '/api/v2/vuelos/offers/hold', { status: 201, body: hold, headers: { location: `/api/v2/vuelos/offers/hold/${hold.holdId}`, 'idempotent-replayed': 'false', 'x-interno': 'no-sale' } });
    const key = crypto.randomUUID();
    const sent = { offerId: 'OF-1', itinerarySelections: [{ itineraryId: 'IT-1', cabinClass: 'ECONOMY', fareBrand: 'SEMILLA' }], passengersBreakdown: { adults: 1 } };
    const response = await http().post('/api/v2/vuelos/offers/hold').set('Authorization', tokens.partner()).set('X-User-Id', 'u1').set('Idempotency-Key', key).set('Cookie', 'sesion=secreta').send(sent).expect(201);
    expect(response.body).toEqual(hold);
    expect(response.headers['location']).toBe(`/api/v2/vuelos/offers/hold/${hold.holdId}`);
    expect(response.headers['idempotent-replayed']).toBe('false');
    expect(response.headers['x-interno']).toBeUndefined();
    const call = fakes['MS.Reservas'].last()!;
    expect(call.json).toEqual(sent);
    expect(call.headers).toMatchObject({ 'idempotency-key': key, 'content-type': expect.stringContaining('application/json'), 'x-forwarded-for': expect.any(String) });
    expect(call.headers['cookie']).toBeUndefined();
  });

  it('★ POST /api/v2/oauth2/token y el alias /oauth2/token (BKG-03) → MS.Clientes, con el formulario y el Basic intactos', async () => {
    fakes['MS.Clientes'].on('POST', '/api/v2/oauth2/token', { body: { access_token: 'x', token_type: 'Bearer', expires_in: 3600, scope: 'flights:read' }, headers: { 'cache-control': 'no-store' } });
    const basic = `Basic ${Buffer.from(`${PARTNER_ID}:s3creto`).toString('base64')}`;
    for (const path of ['/api/v2/oauth2/token', '/oauth2/token']) {
      const response = await http().post(path).set('Authorization', basic).type('form').send('grant_type=client_credentials').expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const call = fakes['MS.Clientes'].last()!;
      expect(call.path).toBe('/api/v2/oauth2/token');
      expect(call.body).toBe('grant_type=client_credentials');
      expect(call.headers).toMatchObject({ authorization: basic, 'content-type': 'application/x-www-form-urlencoded' });
    }
    await http().get('/oauth2/token').expect(405);
  });

  it('el MS no responde → 503 PROVIDER_UNAVAILABLE con Retry-After', async () => {
    fakes['MS.Postventa'].down = true;
    const response = await http().get(`/api/v2/vuelos/bookings/${BOOKING_ID}/baggage-options`).set('Authorization', tokens.partner()).set('X-User-Id', 'u1').expect(503);
    expect(response.body).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 });
    expect(response.headers['retry-after']).toBe('5');
  });

  it('★ search: límite por X-Device-Fingerprint (429 con Retry-After); otra huella no se ve afectada', async () => {
    fakes['MS.Vuelos'].on('POST', '/api/v2/vuelos/search', { body: { totalOffers: 0, offers: [] } });
    const search = (fingerprint: string) => http().post('/api/v2/vuelos/search').set('X-Device-Fingerprint', fingerprint).send({ itineraries: [], passengers: {} });
    await search('fp-limite').expect(200);
    await search('fp-limite').expect(200);
    const limited = await search('fp-limite').expect(429);
    expect(limited.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await search('fp-otra').expect(200);
    expect(fakes['MS.Vuelos'].calls).toHaveLength(3);
  });

  it('un cuerpo demasiado grande → 400 sin llegar al MS', async () => {
    const response = await http().post('/api/v2/vuelos/search').set('X-Device-Fingerprint', 'fp-grande').set('Content-Type', 'application/json').send(JSON.stringify({ x: 'a'.repeat(200_000) })).expect(400);
    expect(response.body.invalidParams[0]).toMatchObject({ name: 'body', reason: 'demasiado grande' });
    expect(fakes['MS.Vuelos'].calls).toHaveLength(0);
  });
});

describe('Swagger y cabeceras', () => {
  it('/api/docs sirve Swagger UI; /api/docs/openapi.json es el contrato v2 con este gateway como primer servidor', async () => {
    const page = await http().get('/api/docs/').expect(200);
    expect(page.text).toContain('swagger-ui');
    const document = (await http().get('/api/docs/openapi.json').expect(200)).body;
    expect(document.info.version).toMatch(/^2\./);
    expect(document.servers[0].url).toBe('/api/v2');
    expect(Object.keys(document.paths)).toContain('/vuelos/search');
  });

  it('la API solo devuelve JSON: CSP default-src none y sin X-Powered-By; CORS solo para los orígenes configurados', async () => {
    fakes['MS.Vuelos'].on('GET', '/api/v2/vuelos/health', { body: { status: 'HEALTHY' } });
    const response = await http().get('/api/v2/vuelos/health').set('Origin', 'http://localhost:5173').expect(200);
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect((await http().get('/api/v2/vuelos/health').set('Origin', 'https://otro.example')).headers['access-control-allow-origin']).toBeUndefined();
  });
});
