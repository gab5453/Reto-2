import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { PaymentApiModule, setupApp } from '../src/app.module.js';
import { loadConfig } from '../src/config.js';
import { brandOf, passesLuhn, TEST_CARDS } from '../src/domain/cards.js';
import { InMemoryPaymentsStore } from '../src/repositories/payments.store.js';
import { PaymentsService } from '../src/services/payments.service.js';

/**
 * Payment API simulada (V2.15) contra contract/payment-api.openapi.yaml: cada tarjeta de prueba, tarjetas inválidas, tokens
 * reutilizados o vencidos, captura por monto exacto y una sola vez, anular, reembolsar, idempotencia, claves y privacidad.
 */
const expectContract = contractValidator('payment-api.openapi.yaml');
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const PK = 'pk_test_dev_solo_local_ecoairlines_0001';
const SK = 'sk_test_dev_solo_local_ecoairlines_0001';
const USD = (total: string) => ({ currency: 'USD', total });

let app: NestExpressApplication;
let store: InMemoryPaymentsStore;
let clock = Date.parse('2026-10-26T12:00:00Z');
const http = () => request(app.getHttpServer());

async function createApp(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ NODE_ENV: 'test', PAYMENT_BROWSER_LIMIT: '1000', ...env });
  const memory = new InMemoryPaymentsStore();
  const moduleRef = await Test.createTestingModule({ imports: [PaymentApiModule.register(config, { store: memory })] }).compile();
  const instance = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  setupApp(instance, config);
  await instance.init();
  const payments = instance.get(PaymentsService);
  payments.now = () => clock;
  return { instance, payments, memory };
}

beforeAll(async () => {
  ({ instance: app, memory: store } = await createApp());
});
afterAll(async () => {
  await app.close();
});

const card = (number: string, extra: Any = {}) => ({ holderName: 'MARIA ANDRADE', number, expMonth: 12, expYear: 2030, cvv: number.startsWith('3') ? '1234' : '123', ...extra });
const tokenize = (number: string, extra: Any = {}) => http().post('/payment-methods').set('X-Api-Key', PK).send(card(number, extra));
const authorize = (token: string, amount = USD('239.00'), key = crypto.randomUUID()) =>
  http().post('/payments').set('X-Api-Key', PK).set('Idempotency-Key', key).send({ paymentMethodToken: token, amount, description: 'Reserva EcoAirlines' });
async function authorized(number = '4242424242424242', amount = USD('239.00')) {
  const token = (await tokenize(number).expect(201)).body.token;
  return (await authorize(token, amount).expect(201)).body as Any;
}
const esb = (method: 'get' | 'post', path: string) => http()[method](path).set('Authorization', `Bearer ${SK}`);
const capture = (reference: string, orderId: string, total = '239.00', operation = 'BOOKING') => esb('post', `/payments/${reference}/capture`).send({ orderId, operation, expectedAmount: USD(total) });
const refund = (reference: string, total: string, key = crypto.randomUUID()) => esb('post', '/refunds').set('Idempotency-Key', key).send({ paymentReference: reference, amount: USD(total), reason: 'CUSTOMER_REQUEST', orderId: 'orden-1' });

describe('reglas de tarjetas', () => {
  it('las tarjetas de prueba pasan Luhn y tienen su marca', () => {
    for (const test of TEST_CARDS) {
      expect(passesLuhn(test.number)).toBe(true);
      expect(brandOf(test.number)).toBe(test.brand);
    }
    expect(brandOf('378282246310005')).toBe('AMEX');
    expect(brandOf('2223003122003222')).toBe('MASTERCARD');
    expect(brandOf('6011111111111117')).toBeUndefined(); // Discover: no se acepta
  });
});

describe('navegador: tarjetas de prueba, tokenizar y autorizar', () => {
  it('GET /test-cards con la clave pública', async () => {
    const response = await http().get('/test-cards').set('X-Api-Key', PK).expect(200);
    expectContract('get', '/test-cards', response);
    expect(response.body.map((c: Any) => c.number)).toEqual(['4242424242424242', '5555555555554444', '4000000000000002', '4000000000009995', '4000000000003220']);
  });

  it.each([
    ['4242424242424242', 'AUTHORIZED', null, 'VISA'],
    ['5555555555554444', 'AUTHORIZED', null, 'MASTERCARD'],
    ['4000000000000002', 'DECLINED', 'card_declined', 'VISA'],
    ['4000000000009995', 'DECLINED', 'insufficient_funds', 'VISA'],
    ['4000000000003220', 'PENDING', null, 'VISA'],
    ['378282246310005', 'AUTHORIZED', null, 'AMEX'],
  ])('★ %s → %s (%s): un rechazo es 201, no un error', async (number, status, declineCode, brand) => {
    const tokenized = await tokenize(number).expect(201);
    expectContract('post', '/payment-methods', tokenized);
    expect(tokenized.headers['cache-control']).toBe('no-store');
    expect(tokenized.body).toMatchObject({ brand, last4: number.slice(-4) });
    const payment = await authorize(tokenized.body.token).expect(201);
    expectContract('post', '/payments', payment);
    expect(payment.body).toMatchObject({ status, declineCode, card: { brand, last4: number.slice(-4) }, amount: USD('239.00'), testMode: true });
    expect(payment.headers['location']).toBe(`/payments/${payment.body.paymentReference}`);
  });

  it.each([
    ['número que no cumple Luhn', card('4242424242424241'), 'CARD_NUMBER_INVALID'],
    ['marca no aceptada', card('6011111111111117'), 'CARD_BRAND_NOT_SUPPORTED'],
    ['vencida', card('4242424242424242', { expMonth: 9, expYear: 2026 }), 'CARD_EXPIRED'],
    ['CVV de 4 dígitos en Visa', card('4242424242424242', { cvv: '1234' }), 'CVV_INVALID'],
    ['CVV de 3 dígitos en Amex', card('378282246310005', { cvv: '123' }), 'CVV_INVALID'],
  ])('★ tarjeta inválida (%s) → 422 %s', async (_label, body, code) => {
    const response = await http().post('/payment-methods').set('X-Api-Key', PK).send(body).expect(422);
    expectContract('post', '/payment-methods', response);
    expect(response.body.code).toBe(code);
  });

  it('formato inválido o propiedades de más → 400 VALIDATION_FAILED', async () => {
    await http().post('/payment-methods').set('X-Api-Key', PK).send(card('4242 4242 4242 4242')).expect(400);
    const extra = await http().post('/payment-methods').set('X-Api-Key', PK).send({ ...card('4242424242424242'), pan: 'x' }).expect(400);
    expect(extra.body.code).toBe('VALIDATION_FAILED');
  });

  it('★ el número completo y el CVV nunca se devuelven, ni se guardan, ni aparecen en los logs', async () => {
    const previous = process.env['HTTP_REQUEST_LOG'];
    process.env['HTTP_REQUEST_LOG'] = 'true';
    const logged = await createApp();
    const lines: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => lines.push(String(chunk)) > 0) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => lines.push(String(chunk)) > 0) as typeof process.stderr.write;
    try {
      const tokenized = await request(logged.instance.getHttpServer()).post('/payment-methods').set('X-Api-Key', PK).send(card('5555555555554444', { cvv: '987' })).expect(201);
      const payment = await request(logged.instance.getHttpServer()).post('/payments').set('X-Api-Key', PK).set('Idempotency-Key', crypto.randomUUID()).send({ paymentMethodToken: tokenized.body.token, amount: USD('10.00') }).expect(201);
      const everything = JSON.stringify([tokenized.body, payment.body, (logged.memory as unknown as Any)['methods'] ? [...(logged.memory as unknown as Any)['methods'].values()] : [], lines]);
      expect(everything).not.toContain('5555555555554444');
      expect(everything).not.toContain('987');
      expect(lines.join('')).toContain('/payment-methods'); // sí hubo log de la petición
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
      process.env['HTTP_REQUEST_LOG'] = previous;
      await logged.instance.close();
    }
  });

  it('★ un token sirve para UN pago (también si se rechazó) y vence a los 15 min', async () => {
    const token = (await tokenize('4000000000000002').expect(201)).body.token;
    await authorize(token).expect(201);
    const reused = await authorize(token).expect(409);
    expectContract('post', '/payments', reused);
    expect(reused.body.code).toBe('PAYMENT_METHOD_ALREADY_USED');
    const later = (await tokenize('4242424242424242').expect(201)).body.token;
    clock += 15 * 60_000;
    const expired = await authorize(later).expect(410);
    expect(expired.body.code).toBe('PAYMENT_METHOD_EXPIRED');
    const unknown = await authorize('pm_noexiste1234567890').expect(400);
    expect(unknown.body.invalidParams[0].name).toBe('paymentMethodToken');
  });

  it('★ Idempotency-Key: misma clave y cuerpo → 200 con Idempotent-Replayed; otro cuerpo → 409; sin clave → 400', async () => {
    const token = (await tokenize('4242424242424242').expect(201)).body.token;
    const key = crypto.randomUUID();
    const first = await authorize(token, USD('50.00'), key).expect(201);
    const replay = await authorize(token, USD('50.00'), key).expect(200);
    expectContract('post', '/payments', replay);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.paymentReference).toBe(first.body.paymentReference);
    expect((await authorize(token, USD('51.00'), key).expect(409)).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await http().post('/payments').set('X-Api-Key', PK).send({ paymentMethodToken: token, amount: USD('1.00') }).expect(400);
  });
});

describe('ESB: consultar, capturar, anular y reembolsar', () => {
  it('★ captura por el monto exacto y una sola vez: otro monto → 422, otra orden → 409, la misma orden → idempotente', async () => {
    const payment = await authorized();
    const mismatch = await capture(payment.paymentReference, 'saga-1', '238.99').expect(422);
    expectContract('post', '/payments/{paymentReference}/capture', mismatch);
    expect(mismatch.body.code).toBe('AMOUNT_MISMATCH');
    const captured = await capture(payment.paymentReference, 'saga-1').expect(200);
    expectContract('post', '/payments/{paymentReference}/capture', captured);
    expect(captured.body).toMatchObject({ status: 'CAPTURED', orderId: 'saga-1', capturedAmount: USD('239.00') });
    expect((await capture(payment.paymentReference, 'saga-1').expect(200)).body.status).toBe('CAPTURED');
    const reused = await capture(payment.paymentReference, 'saga-2').expect(409);
    expect(reused.body.code).toBe('ALREADY_CAPTURED');
    const read = await esb('get', `/payments/${payment.paymentReference}`).expect(200);
    expectContract('get', '/payments/{paymentReference}', read);
    expect(read.body).toMatchObject({ status: 'CAPTURED', orderId: 'saga-1' });
  });

  it('★ dos capturas simultáneas con órdenes distintas: solo una cobra', async () => {
    const payment = await authorized();
    const results = await Promise.all([capture(payment.paymentReference, 'saga-A'), capture(payment.paymentReference, 'saga-B')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('★ pendiente: 409 PAYMENT_NOT_CAPTURABLE hasta ~30 s; luego se captura. Rechazado o vencido no se captura', async () => {
    const pending = await authorized('4000000000003220');
    const early = await capture(pending.paymentReference, 'saga-p').expect(409);
    expect(early.body).toMatchObject({ code: 'PAYMENT_NOT_CAPTURABLE', detail: 'Estado actual PENDING.' });
    clock += 30_000;
    expect((await esb('get', `/payments/${pending.paymentReference}`).expect(200)).body.status).toBe('AUTHORIZED');
    await capture(pending.paymentReference, 'saga-p').expect(200);

    const declined = await authorized('4000000000009995');
    expect((await capture(declined.paymentReference, 'saga-d').expect(409)).body.code).toBe('PAYMENT_NOT_CAPTURABLE');
    const stale = await authorized();
    clock += 30 * 60_000;
    expect((await esb('get', `/payments/${stale.paymentReference}`).expect(200)).body.status).toBe('EXPIRED');
    expect((await capture(stale.paymentReference, 'saga-e').expect(409)).body.detail).toBe('Estado actual EXPIRED.');
  });

  it('anular: AUTHORIZED → VOIDED (idempotente); ya capturado → 409; anulado no se captura', async () => {
    const payment = await authorized();
    const voided = await esb('post', `/payments/${payment.paymentReference}/void`).expect(200);
    expectContract('post', '/payments/{paymentReference}/void', voided);
    expect(voided.body.status).toBe('VOIDED');
    expect((await esb('post', `/payments/${payment.paymentReference}/void`).expect(200)).body.status).toBe('VOIDED');
    expect((await capture(payment.paymentReference, 'saga-v').expect(409)).body.code).toBe('PAYMENT_NOT_CAPTURABLE');
    const captured = await authorized();
    await capture(captured.paymentReference, 'saga-c').expect(200);
    const late = await esb('post', `/payments/${captured.paymentReference}/void`).expect(409);
    expectContract('post', '/payments/{paymentReference}/void', late);
    expect(late.body.code).toBe('PAYMENT_ALREADY_CAPTURED');
  });

  it('★ reembolsos parciales y totales, nunca más de lo capturado; SETTLED; idempotentes por Idempotency-Key', async () => {
    const payment = await authorized('4242424242424242', USD('100.00'));
    expect((await refund(payment.paymentReference, '10.00').expect(409)).body.code).toBe('PAYMENT_NOT_CAPTURED');
    await capture(payment.paymentReference, 'saga-r', '100.00').expect(200);
    const key = crypto.randomUUID();
    const partial = await refund(payment.paymentReference, '60.00', key).expect(201);
    expectContract('post', '/refunds', partial);
    expect(partial.body).toMatchObject({ status: 'SETTLED', amount: USD('60.00'), refundId: expect.stringMatching(/^re_/) });
    expect((await refund(payment.paymentReference, '60.00', key).expect(200)).headers['idempotent-replayed']).toBe('true');
    expect((await esb('get', `/payments/${payment.paymentReference}`).expect(200)).body).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedAmount: USD('60.00') });
    const excess = await refund(payment.paymentReference, '40.01').expect(422);
    expectContract('post', '/refunds', excess);
    expect(excess.body.code).toBe('REFUND_EXCEEDS_CAPTURED');
    await refund(payment.paymentReference, '40.00').expect(201);
    expect((await esb('get', `/payments/${payment.paymentReference}`).expect(200)).body.status).toBe('REFUNDED');
    expect(store.refunds.filter((r) => r.paymentReference === payment.paymentReference)).toHaveLength(2);
  });

  it('un pago inexistente → 404 PAYMENT_NOT_FOUND', async () => {
    const missing = await esb('get', '/payments/pay_noexiste123456').expect(404);
    expectContract('get', '/payments/{paymentReference}', missing);
    expect(missing.body.code).toBe('PAYMENT_NOT_FOUND');
    expect((await refund('pay_noexiste123456', '1.00').expect(404)).body.code).toBe('PAYMENT_NOT_FOUND');
  });
});

describe('claves y límites', () => {
  it('★ sin clave o con la equivocada → 401 ANTES de validar el cuerpo; la pública no sirve para el ESB ni la secreta para el navegador', async () => {
    const noKey = await http().post('/payment-methods').send({ basura: true }).expect(401);
    expectContract('post', '/payment-methods', noKey);
    await http().post('/payment-methods').set('X-Api-Key', SK).send(card('4242424242424242')).expect(401);
    const payment = await authorized();
    await http().post(`/payments/${payment.paymentReference}/capture`).set('Authorization', `Bearer ${PK}`).send({ orderId: 'x', operation: 'BOOKING', expectedAmount: USD('239.00') }).expect(401);
    await http().get(`/payments/${payment.paymentReference}`).set('X-Api-Key', PK).expect(401);
    await http().get('/test-cards').expect(401);
  });

  it('★ más de 20 intentos por minuto desde la misma IP → 429 con Retry-After', async () => {
    const limited = await createApp({ PAYMENT_BROWSER_LIMIT: '20' });
    try {
      for (let i = 0; i < 20; i++) await request(limited.instance.getHttpServer()).post('/payment-methods').set('X-Api-Key', PK).send(card('4242424242424242')).expect(201);
      const blocked = await request(limited.instance.getHttpServer()).post('/payment-methods').set('X-Api-Key', PK).send(card('4242424242424242')).expect(429);
      expectContract('post', '/payment-methods', blocked);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await limited.instance.close();
    }
  });

  it('health, X-Correlation-Id guardado en el pago y devuelto; CORS solo para la web', async () => {
    const health = await http().get('/health').expect(200);
    expectContract('get', '/health', health);
    const token = (await tokenize('4242424242424242').expect(201)).body.token;
    const payment = await http().post('/payments').set('X-Api-Key', PK).set('Idempotency-Key', crypto.randomUUID()).set('X-Correlation-Id', 'corr-web-pago-1').send({ paymentMethodToken: token, amount: USD('5.00') }).expect(201);
    expect(payment.headers['x-correlation-id']).toBe('corr-web-pago-1');
    expect(payment.body.correlationId).toBe('corr-web-pago-1');
    const preflight = await http().options('/payments').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'x-api-key,idempotency-key,content-type');
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(preflight.headers['access-control-allow-headers']).toContain('X-Api-Key');
    expect((await http().options('/payments').set('Origin', 'https://otro.example').set('Access-Control-Request-Method', 'POST')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('configuración de producción: exige base y claves propias (no las de desarrollo)', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL[\s\S]*PAYMENT_PUBLISHABLE_KEY[\s\S]*PAYMENT_SECRET_KEY/);
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', PAYMENT_PUBLISHABLE_KEY: PK, PAYMENT_SECRET_KEY: SK })).toThrow(/desarrollo/);
    expect(() => loadConfig({ PAYMENT_SECRET_KEY: 'sk_live_xxxxxxxxxxxxxxxxxxxx' })).toThrow(/sk_test_/);
  });
});
