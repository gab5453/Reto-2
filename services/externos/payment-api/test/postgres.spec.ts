import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ProblemDetailsException } from '@ecoairlines/shared';
import { capture, type PaymentRecord, refund } from '../src/domain/payments.js';
import { PostgresPaymentsStore } from '../src/repositories/payments.store.js';

/**
 * PostgreSQL real (opcional): `PAYMENT_TEST_DATABASE_URL=postgres://payment_svc:dev-payment@localhost:5432/payment`.
 * Esquema propio que se borra al terminar. Dos "réplicas" (dos pools) compiten por el mismo pago.
 */
const url = process.env['PAYMENT_TEST_DATABASE_URL'];

describe.skipIf(!url)('PostgresPaymentsStore (concurrencia real)', () => {
  const schema = `prueba_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: url });
  let a: PostgresPaymentsStore;
  let b: PostgresPaymentsStore;
  const now = Date.now();

  const payment = (reference: string): PaymentRecord => ({
    paymentReference: reference, status: 'AUTHORIZED', declineCode: null, amount: { currency: 'USD', total: '100.00' }, card: { brand: 'VISA', last4: '4242' },
    createdAt: new Date(now).toISOString(), pendingUntil: null, authorizationExpiresAt: new Date(now + 1_800_000).toISOString(), capturedAmount: null, capturedAt: null,
    orderId: null, operation: null, refundedCents: 0, voidedAt: null, correlationId: 'corr-pg',
  });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const conn = `${url}?options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    a = new PostgresPaymentsStore(conn);
    b = new PostgresPaymentsStore(conn);
    await a.init();
  }, 60_000);

  afterAll(async () => {
    await a?.close();
    await b?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('★ 6 capturas a la vez con órdenes distintas: una sola cobra y queda en used_references', async () => {
    await a.insertPayment(payment('pay_concurrencia000001'));
    const attempts = [a, b, a, b, a, b].map((store, i) =>
      store.updatePayment('pay_concurrencia000001', (p) => ({ payment: capture(p, { orderId: `saga-${i}`, operation: 'BOOKING', expectedAmount: { currency: 'USD', total: '100.00' } }, now) })).then(
        () => 'ok',
        (error: unknown) => (error instanceof ProblemDetailsException ? error.problem.code : 'otro'),
      ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'ALREADY_CAPTURED')).toHaveLength(5);
    const { rows } = await admin.query(`SELECT order_id FROM ${schema}.used_references WHERE payment_reference = 'pay_concurrencia000001'`);
    expect(rows).toHaveLength(1);
  });

  it('★ reembolsos simultáneos que juntos superan lo capturado: solo pasan los que caben', async () => {
    await a.insertPayment(payment('pay_concurrencia000002'));
    await a.updatePayment('pay_concurrencia000002', (p) => ({ payment: capture(p, { orderId: 'saga-r', operation: 'BOOKING', expectedAmount: { currency: 'USD', total: '100.00' } }, now) }));
    const results = await Promise.all([a, b, a, b].map((store, i) =>
      store.updatePayment('pay_concurrencia000002', (p) => ({
        payment: refund(p, { currency: 'USD', total: '40.00' }, now),
        refund: { refundId: `re_concurrencia${i}0000000`, paymentReference: p.paymentReference, amount: { currency: 'USD', total: '40.00' }, reason: 'CUSTOMER_REQUEST', orderId: null, status: 'SETTLED', createdAt: new Date(now).toISOString() },
      })).then(() => 'ok', () => 'rechazado'),
    ));
    expect(results.filter((r) => r === 'ok')).toHaveLength(2); // 40 + 40 = 80 ≤ 100; el tercero pasaría de 100
    expect((await a.payment('pay_concurrencia000002'))!.refundedCents).toBe(8000);
  });

  it('la misma Idempotency-Key reservada a la vez: solo una ejecuta', async () => {
    const key = randomUUID();
    const claims = await Promise.all([a, b, a, b].map((store) => store.claimIdempotency('refund', key, 'hash-1', new Date().toISOString())));
    expect(claims.filter((c) => c.kind === 'new')).toHaveLength(1);
  });
});
