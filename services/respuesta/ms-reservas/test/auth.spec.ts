import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { createResponseApp, CUSTOMER_SUB, FakeEsb, PARTNER_ID, tokens } from '../../../../tests/support/response-service.js';
import { definition } from '../src/service.js';

/**
 * Autenticación y dueño (V2.12), adaptadas de `EcoAirlines.API/test/auth.e2e-spec.ts`: tokens RS256 verificados con la JWKS,
 * scopes del contrato, el dueño sale del token (D29) y `X-User-Id` solo cuenta con un token de partner.
 */
const expectContract = contractValidator('vuelos-openapi-v2.yaml');
const esb = new FakeEsb();
let app: NestExpressApplication;
const http = () => request(app.getHttpServer());
const BOOKING_ID = '7bc123b6-ec50-4676-8b88-8f82a8c00ac7';
const LIST = { items: [], nextCursor: null };

beforeAll(async () => {
  await esb.start();
  app = await createResponseApp(definition(), esb);
});
afterAll(async () => {
  await app.close();
  await esb.stop();
});
beforeEach(() => {
  esb.reset();
  esb.on('GET', '/router/bookings/bookings', { body: LIST });
});

describe('verificación del token', () => {
  it('acepta un token de usuario y uno de partner válidos con el scope', async () => {
    expectContract('get', '/vuelos/bookings', await http().get('/api/v2/vuelos/bookings').set('Authorization', tokens.customer()).expect(200));
    expectContract('get', '/vuelos/bookings', await http().get('/api/v2/vuelos/bookings').set('Authorization', tokens.partner()).set('X-User-Id', 'usr-1').expect(200));
  });

  it.each([
    ['sin token', undefined],
    ['el antiguo token mock `sub:scopes`', 'Bearer owner-a:flights:read'],
    ['firmado con otra clave', tokens.otherKey()],
    ['vencido', tokens.expired()],
    ['un esquema que no es Bearer', 'Basic dXNlcjpwYXNz'],
  ])('401 UNAUTHORIZED %s, con WWW-Authenticate y sin llamar al ESB', async (_label, authorization) => {
    const call = http().get('/api/v2/vuelos/bookings');
    if (authorization) call.set('Authorization', authorization);
    const response = await call.expect(401);
    expectContract('get', '/vuelos/bookings', response);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.body.code).toBe('UNAUTHORIZED');
    expect(esb.calls).toHaveLength(0);
  });

  it('★ un token de SERVICIO (del ESB o de otro MS) se rechaza con 401: solo lo aceptan el ESB y los MS.G', async () => {
    for (const token of [tokens.service('ecoairlines:internal'), tokens.service('ecoairlines:esb')]) {
      const response = await http().get('/api/v2/vuelos/bookings').set('Authorization', token).expect(401);
      expect(response.body.title).toContain('servicio');
    }
    expect(esb.calls).toHaveLength(0);
  });

  it('un token válido sin el scope requerido responde 403 FORBIDDEN', async () => {
    const response = await http().post('/api/v2/vuelos/offers/hold').set('Authorization', tokens.customer('flights:read')).set('Idempotency-Key', crypto.randomUUID()).send({}).expect(403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN', title: expect.stringContaining('flights:hold') });
  });

  it('un partner no puede usar las operaciones propias de la web (UserJwt): 403', async () => {
    await http().get(`/api/v2/ecoairlines/bookings/${BOOKING_ID}/assistance`).set('Authorization', tokens.partner()).expect(403);
    expect(esb.calls).toHaveLength(0);
  });
});

describe('dueño (D29): siempre del token, nunca del cuerpo', () => {
  it('usuario: el dueño es su sub', async () => {
    await http().get('/api/v2/vuelos/bookings').set('Authorization', tokens.customer()).expect(200);
    expect(esb.last()!.headers['x-owner-id']).toBe(CUSTOMER_SUB);
  });

  it('★ sin token de partner, X-User-Id se ignora (un usuario no puede hacerse pasar por otro)', async () => {
    await http().get('/api/v2/vuelos/bookings').set('Authorization', tokens.customer()).set('X-User-Id', 'usr-victima').expect(200);
    expect(esb.last()!.headers['x-owner-id']).toBe(CUSTOMER_SUB);
  });

  it('partner: partner:<clientId>:<X-User-Id>; sin él, la huella como respaldo (contrato); sin ninguno, 400', async () => {
    await http().get('/api/v2/vuelos/bookings').set('Authorization', tokens.partner()).set('X-User-Id', 'usr-4f9a2c').set('X-Device-Fingerprint', 'fp-1').expect(200);
    expect(esb.last()!.headers['x-owner-id']).toBe(`partner:${PARTNER_ID}:usr-4f9a2c`);
    await http().get('/api/v2/vuelos/bookings').set('Authorization', tokens.partner()).set('X-Device-Fingerprint', 'fp-3a7c9e21').expect(200);
    expect(esb.last()!.headers['x-owner-id']).toBe(`partner:${PARTNER_ID}:fp:fp-3a7c9e21`);
    const calls = esb.calls.length;
    const missing = await http().get('/api/v2/vuelos/bookings').set('Authorization', tokens.partner()).expect(400);
    expect(missing.body.invalidParams[0].name).toBe('X-User-Id');
    expect(esb.calls).toHaveLength(calls);
  });

  it('un X-User-Id con espacios o caracteres de control → 400 (no llega al dueño)', async () => {
    const response = await http().get('/api/v2/vuelos/bookings').set('Authorization', tokens.partner()).set('X-User-Id', 'usr con espacio').expect(400);
    expect(response.body.invalidParams).toEqual([{ name: 'X-User-Id', reason: expect.any(String) }]);
  });

  it('el token de servicio que llega al ESB es el del MS, nunca el del cliente', async () => {
    const partner = tokens.partner();
    await http().get('/api/v2/vuelos/bookings').set('Authorization', partner).set('X-User-Id', 'usr-1').expect(200);
    expect(esb.last()!.headers['authorization']).not.toBe(partner);
    expect(esb.last()!.headers['x-actor-id']).toBeUndefined();
  });

  it('otro dueño recibe 404 (lo resuelve el MS.G con el X-Owner-Id que pone este MS)', async () => {
    esb.on('GET', `/router/bookings/bookings/${BOOKING_ID}`, (call) =>
      call.headers['x-owner-id'] === CUSTOMER_SUB ? { body: { bookingId: BOOKING_ID, pnr: 'ABC123', status: 'CONFIRMED', grandTotal: { currency: 'USD', total: '1.00' }, createdAt: '2026-10-25T00:00:00Z' } } : { status: 404, body: { type: 'about:blank', title: 'Reserva no encontrada.', status: 404, code: 'NOT_FOUND' } },
    );
    await http().get(`/api/v2/vuelos/bookings/${BOOKING_ID}`).set('Authorization', tokens.customer()).expect(200);
    await http().get(`/api/v2/vuelos/bookings/${BOOKING_ID}`).set('Authorization', tokens.customer(undefined, '2a1b0c9d-8e7f-4a65-b432-10fedcba9876')).expect(404);
  });
});
