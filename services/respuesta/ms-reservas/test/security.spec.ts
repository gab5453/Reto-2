import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createResponseApp, FakeEsb, newKey, tokens } from '../../../../tests/support/response-service.js';
import { definition } from '../src/service.js';

/**
 * Seguridad HTTP (V2.12), adaptadas de `EcoAirlines.API/test/security.e2e-spec.ts`: cabeceras, CORS, límite de peticiones,
 * cuerpo y Content-Type, y saneamiento de la entrada. Las aplica la plantilla común a los 5 MS de respuesta.
 */
const FRONTEND_ORIGIN = 'http://localhost:5173';
const esb = new FakeEsb();
let app: NestExpressApplication;
const http = () => request(app.getHttpServer());
const HOLD_ID = '19df841d-2ba8-4081-ac82-e9815d23847b';

function validBooking() {
  return {
    holdId: HOLD_ID,
    passengers: [
      {
        passengerId: 'PAX-1',
        passengerType: 'ADULT',
        firstName: 'Jane',
        lastName: 'Doe',
        documentType: 'PASSPORT',
        documentNumber: 'X123456',
        nationality: 'EC',
        birthDate: '1990-01-01',
        gender: 'F',
        contact: { email: 'jane@example.com', phone: '+593000000000' },
      },
    ],
    payment: { paymentReference: 'pay_ref_123' },
  };
}

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
  esb.on('GET', '/router/bookings/bookings', { body: { items: [], nextCursor: null } });
});

describe('cabeceras', () => {
  it('cabeceras de seguridad y una CSP que no permite cargar nada; sin x-powered-by; HSTS solo en producción', async () => {
    const response = await http().get('/api/v2/vuelos/no-existe');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
    expect(response.headers).not.toHaveProperty('x-powered-by');
    expect(response.headers).not.toHaveProperty('strict-transport-security');
  });

  it('X-Correlation-Id en toda respuesta, también en los errores (y se crea si no llega)', async () => {
    const created = await http().get('/api/v2/vuelos/bookings').expect(401);
    expect(created.headers['x-correlation-id']).toMatch(/^corr-/);
    expect(created.body.correlation_id).toBe(created.headers['x-correlation-id']);
    const kept = await http().get('/api/v2/vuelos/no-existe').set('X-Correlation-Id', 'corr-se-conserva').expect(404);
    expect(kept.headers['x-correlation-id']).toBe('corr-se-conserva');
  });
});

describe('CORS', () => {
  it('el preflight del origen permitido incluye las cabeceras del contrato y no permite credenciales', async () => {
    const response = await http()
      .options('/api/v2/vuelos/bookings')
      .set('Origin', FRONTEND_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key')
      .expect(204);
    expect(response.headers['access-control-allow-origin']).toBe(FRONTEND_ORIGIN);
    for (const header of ['Idempotency-Key', 'X-Device-Fingerprint', 'X-Correlation-Id', 'X-User-Id']) expect(response.headers['access-control-allow-headers']).toContain(header);
    expect(response.headers).not.toHaveProperty('access-control-allow-credentials');
  });

  it('expone Retry-After y X-Correlation-Id al navegador; un origen no permitido no recibe Allow-Origin', async () => {
    const allowed = await http().get('/api/v2/vuelos/no-existe').set('Origin', FRONTEND_ORIGIN);
    expect(allowed.headers['access-control-expose-headers']).toContain('Retry-After');
    expect(allowed.headers['access-control-expose-headers']).toContain('X-Correlation-Id');
    const evil = await http().options('/api/v2/vuelos/bookings').set('Origin', 'https://evil.example.com').set('Access-Control-Request-Method', 'POST');
    expect(evil.headers).not.toHaveProperty('access-control-allow-origin');
  });
});

describe('límite de peticiones (429 del contrato)', () => {
  let limitedApp: NestExpressApplication;
  beforeAll(async () => {
    limitedApp = await createResponseApp(definition(), esb, { RATE_LIMIT_LIMIT: '3' });
  });
  afterAll(() => limitedApp.close());

  it('por usuario: al pasar el límite, 429 RATE_LIMIT_EXCEEDED con Retry-After; otro usuario sigue', async () => {
    const http = () => request(limitedApp.getHttpServer());
    const other = tokens.customer(undefined, '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f');
    const limited = tokens.customer(undefined, '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a');
    for (let i = 0; i < 3; i++) await http().get('/api/v2/vuelos/bookings').set('Authorization', limited).expect(200);
    const response = await http().get('/api/v2/vuelos/bookings').set('Authorization', limited).expect(429);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ status: 429, code: 'RATE_LIMIT_EXCEEDED' });
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    await http().get('/api/v2/vuelos/bookings').set('Authorization', other).expect(200);
  });
});

describe('cuerpo y Content-Type', () => {
  it('un cuerpo mayor al límite → 400 ProblemDetails', async () => {
    const response = await http()
      .post('/api/v2/vuelos/bookings')
      .set('Authorization', tokens.partner())
      .set('Idempotency-Key', newKey())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...validBooking(), padding: 'x'.repeat(150_000) }))
      .expect(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.invalidParams).toEqual([{ name: 'body', reason: 'demasiado grande' }]);
  });

  it('JSON mal formado → 400 ProblemDetails (con X-Correlation-Id)', async () => {
    const response = await http().post('/api/v2/vuelos/bookings').set('Content-Type', 'application/json').set('X-Correlation-Id', 'corr-json').send('{"holdId": [').expect(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED', correlation_id: 'corr-json', invalidParams: [{ name: 'body', reason: 'JSON mal formado' }] });
  });

  it('un cuerpo que no es application/json → 400', async () => {
    const response = await http().post('/api/v2/vuelos/bookings').set('Authorization', tokens.partner()).set('Idempotency-Key', newKey()).set('Content-Type', 'application/x-www-form-urlencoded').send('holdId=x').expect(400);
    expect(response.body.invalidParams).toEqual([{ name: 'Content-Type', reason: 'debe ser application/json' }]);
    expect(esb.calls).toHaveLength(0);
  });
});

describe('saneamiento de la entrada', () => {
  it('rechaza claves __proto__ anidadas (prototype pollution)', async () => {
    const raw = JSON.stringify(validBooking()).replace('"contact":{', '"contact":{"__proto__":{"isAdmin":true},');
    const response = await http().post('/api/v2/vuelos/bookings').set('Authorization', tokens.partner()).set('Idempotency-Key', newKey()).set('Content-Type', 'application/json').send(raw).expect(400);
    expect(response.body.invalidParams).toEqual([{ name: 'passengers[0].contact.__proto__', reason: 'nombre de propiedad no permitido' }]);
    expect(esb.calls).toHaveLength(0);
  });

  it('rechaza caracteres de control en los textos', async () => {
    const booking = validBooking();
    booking.passengers[0]!.firstName = 'Ja\u0000ne';
    const response = await http().post('/api/v2/vuelos/bookings').set('Authorization', tokens.partner()).set('Idempotency-Key', newKey()).send(booking).expect(400);
    expect(response.body.invalidParams).toEqual([{ name: 'passengers[0].firstName', reason: 'contiene caracteres de control' }]);
  });

  it('recorta espacios al inicio y al final antes de llamar al ESB', async () => {
    esb.on('POST', '/sagas/bookings', { status: 201, body: { bookingId: '7bc123b6-ec50-4676-8b88-8f82a8c00ac7', pnr: 'BKG001', status: 'CONFIRMED', grandTotal: { currency: 'USD', total: '1.00' }, createdAt: '2026-10-25T00:00:00Z' } });
    const booking = validBooking();
    booking.passengers[0]!.firstName = '  Jane  ';
    await http().post('/api/v2/vuelos/bookings').set('Authorization', tokens.partner()).set('X-User-Id', 'usr-1').set('Idempotency-Key', newKey()).send(booking).expect(201);
    expect(esb.last('POST', '/sagas/bookings')!.json.passengers[0].firstName).toBe('Jane');
  });
});
