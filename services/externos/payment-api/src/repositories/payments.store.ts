import pg from 'pg';
import type { PaymentMethodRecord, PaymentRecord, RefundRecord } from '../domain/payments.js';

/**
 * Datos de la Payment API (base `payment`: `payment_methods`, `payments`, `used_references`, `refunds`, `idempotency_keys`).
 * En memoria (pruebas) o PostgreSQL. Las transiciones de un pago o de un token se aplican de forma ATÓMICA: en PostgreSQL con
 * `SELECT … FOR UPDATE` dentro de una transacción, así dos capturas simultáneas de la misma referencia no cobran dos veces y
 * un token de tarjeta no paga dos veces (D34).
 */
export const PAYMENTS_STORE = Symbol('PAYMENTS_STORE');

export type IdempotencyScope = 'authorize' | 'refund';

export type IdempotencyClaim =
  | { kind: 'new' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'mismatch' }
  | { kind: 'in-progress' };

export interface PaymentsStore {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;

  insertMethod(method: PaymentMethodRecord): Promise<void>;
  /** Aplica `change` al token de forma atómica; `undefined` si no existe. */
  updateMethod(token: string, change: (method: PaymentMethodRecord) => PaymentMethodRecord): Promise<PaymentMethodRecord | undefined>;

  insertPayment(payment: PaymentRecord): Promise<void>;
  payment(reference: string): Promise<PaymentRecord | undefined>;
  /**
   * Aplica `change` al pago de forma atómica (y guarda el reembolso que devuelva, en la misma transacción); `undefined` si el pago
   * no existe. Si `change` lanza, no se guarda nada.
   */
  updatePayment(reference: string, change: (payment: PaymentRecord) => { payment: PaymentRecord; refund?: RefundRecord }): Promise<{ payment: PaymentRecord; refund?: RefundRecord } | undefined>;

  /** Reserva la `Idempotency-Key` antes de ejecutar (dos reintentos simultáneos no ejecutan dos veces). */
  claimIdempotency(scope: IdempotencyScope, key: string, requestHash: string, now: string): Promise<IdempotencyClaim>;
  completeIdempotency(scope: IdempotencyScope, key: string, status: number, body: unknown): Promise<void>;
  /** Si la operación falló, se libera la clave para que el cliente pueda reintentar. */
  releaseIdempotency(scope: IdempotencyScope, key: string): Promise<void>;
}

const clone = <T>(value: T): T => structuredClone(value);

interface IdempotencyRow {
  requestHash: string;
  status: number | null;
  body: unknown;
}

export class InMemoryPaymentsStore implements PaymentsStore {
  readonly kind = 'memory' as const;
  private readonly methods = new Map<string, PaymentMethodRecord>();
  private readonly payments = new Map<string, PaymentRecord>();
  readonly refunds: RefundRecord[] = [];
  private readonly keys = new Map<string, IdempotencyRow>();

  async init(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}

  async insertMethod(method: PaymentMethodRecord) {
    this.methods.set(method.token, clone(method));
  }
  async updateMethod(token: string, change: (method: PaymentMethodRecord) => PaymentMethodRecord) {
    const current = this.methods.get(token);
    if (!current) return undefined;
    const next = change(clone(current));
    this.methods.set(token, clone(next));
    return clone(next);
  }

  async insertPayment(payment: PaymentRecord) {
    this.payments.set(payment.paymentReference, clone(payment));
  }
  async payment(reference: string) {
    return clone(this.payments.get(reference));
  }
  async updatePayment(reference: string, change: (payment: PaymentRecord) => { payment: PaymentRecord; refund?: RefundRecord }) {
    const current = this.payments.get(reference);
    if (!current) return undefined;
    const result = change(clone(current));
    this.payments.set(reference, clone(result.payment));
    if (result.refund) this.refunds.push(clone(result.refund));
    return clone(result);
  }

  async claimIdempotency(scope: IdempotencyScope, key: string, requestHash: string): Promise<IdempotencyClaim> {
    const id = `${scope}|${key}`;
    const row = this.keys.get(id);
    if (!row) {
      this.keys.set(id, { requestHash, status: null, body: null });
      return { kind: 'new' };
    }
    if (row.requestHash !== requestHash) return { kind: 'mismatch' };
    return row.status === null ? { kind: 'in-progress' } : { kind: 'replay', status: row.status, body: clone(row.body) };
  }
  async completeIdempotency(scope: IdempotencyScope, key: string, status: number, body: unknown) {
    const row = this.keys.get(`${scope}|${key}`);
    if (row) Object.assign(row, { status, body: clone(body) });
  }
  async releaseIdempotency(scope: IdempotencyScope, key: string) {
    this.keys.delete(`${scope}|${key}`);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payment_methods (
  token       text PRIMARY KEY,
  brand       text NOT NULL,
  last4       char(4) NOT NULL,
  exp_month   smallint NOT NULL,
  exp_year    smallint NOT NULL,
  outcome     text NOT NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE TABLE IF NOT EXISTS payments (
  payment_reference        text PRIMARY KEY,
  status                   text NOT NULL,
  decline_code             text,
  currency                 char(3) NOT NULL,
  amount                   numeric(12,2) NOT NULL,
  card_brand               text NOT NULL,
  card_last4               char(4) NOT NULL,
  created_at               timestamptz NOT NULL,
  pending_until            timestamptz,
  authorization_expires_at timestamptz,
  captured_amount          numeric(12,2),
  captured_at              timestamptz,
  order_id                 text,
  operation                text,
  refunded_cents           bigint NOT NULL DEFAULT 0,
  voided_at                timestamptz,
  correlation_id           text
);
-- Uso único de cada referencia (D34): una referencia capturada pertenece a UNA orden.
CREATE TABLE IF NOT EXISTS used_references (
  payment_reference text PRIMARY KEY REFERENCES payments(payment_reference),
  order_id          text NOT NULL,
  operation         text NOT NULL,
  captured_at       timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS refunds (
  refund_id         text PRIMARY KEY,
  payment_reference text NOT NULL REFERENCES payments(payment_reference),
  currency          char(3) NOT NULL,
  amount            numeric(12,2) NOT NULL,
  reason            text NOT NULL,
  order_id          text,
  status            text NOT NULL,
  created_at        timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS refunds_payment_idx ON refunds (payment_reference);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope        text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status       integer,
  body         jsonb,
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);
`;

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
const money = (currency: unknown, total: unknown) => ({ currency: String(currency), total: Number(total).toFixed(2) });

const toMethod = (r: Row): PaymentMethodRecord => ({
  token: String(r['token']), brand: r['brand'] as PaymentMethodRecord['brand'], last4: String(r['last4']), expMonth: Number(r['exp_month']), expYear: Number(r['exp_year']),
  outcome: r['outcome'] as PaymentMethodRecord['outcome'], createdAt: iso(r['created_at'])!, expiresAt: iso(r['expires_at'])!, usedAt: iso(r['used_at']),
});
const toPayment = (r: Row): PaymentRecord => ({
  paymentReference: String(r['payment_reference']), status: r['status'] as PaymentRecord['status'], declineCode: (r['decline_code'] as PaymentRecord['declineCode']) ?? null,
  amount: money(r['currency'], r['amount']), card: { brand: r['card_brand'] as PaymentRecord['card']['brand'], last4: String(r['card_last4']) },
  createdAt: iso(r['created_at'])!, pendingUntil: iso(r['pending_until']), authorizationExpiresAt: iso(r['authorization_expires_at']),
  capturedAmount: r['captured_amount'] === null ? null : money(r['currency'], r['captured_amount']), capturedAt: iso(r['captured_at']),
  orderId: (r['order_id'] as string | null) ?? null, operation: (r['operation'] as PaymentRecord['operation']) ?? null, refundedCents: Number(r['refunded_cents']),
  voidedAt: iso(r['voided_at']), correlationId: (r['correlation_id'] as string | null) ?? null,
});

export class PostgresPaymentsStore implements PaymentsStore {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
    // Un error de una conexión inactiva (la base se reinició) no debe tumbar el proceso.
    this.pool.on('error', () => undefined);
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }
  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }

  private async transaction<T>(work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
  }

  async insertMethod(m: PaymentMethodRecord) {
    await this.pool.query('INSERT INTO payment_methods (token, brand, last4, exp_month, exp_year, outcome, created_at, expires_at, used_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      m.token, m.brand, m.last4, m.expMonth, m.expYear, m.outcome, m.createdAt, m.expiresAt, m.usedAt,
    ]);
  }
  async updateMethod(token: string, change: (method: PaymentMethodRecord) => PaymentMethodRecord) {
    return this.transaction(async (db) => {
      const { rows } = await db.query('SELECT * FROM payment_methods WHERE token = $1 FOR UPDATE', [token]);
      if (!rows[0]) return undefined;
      const next = change(toMethod(rows[0]));
      await db.query('UPDATE payment_methods SET used_at = $2 WHERE token = $1', [token, next.usedAt]);
      return next;
    });
  }

  async insertPayment(p: PaymentRecord) {
    await this.pool.query(
      `INSERT INTO payments (payment_reference, status, decline_code, currency, amount, card_brand, card_last4, created_at, pending_until,
        authorization_expires_at, captured_amount, captured_at, order_id, operation, refunded_cents, voided_at, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [p.paymentReference, p.status, p.declineCode, p.amount.currency, p.amount.total, p.card.brand, p.card.last4, p.createdAt, p.pendingUntil,
        p.authorizationExpiresAt, p.capturedAmount?.total ?? null, p.capturedAt, p.orderId, p.operation, p.refundedCents, p.voidedAt, p.correlationId],
    );
  }
  async payment(reference: string) {
    const { rows } = await this.pool.query('SELECT * FROM payments WHERE payment_reference = $1', [reference]);
    return rows[0] ? toPayment(rows[0]) : undefined;
  }
  async updatePayment(reference: string, change: (payment: PaymentRecord) => { payment: PaymentRecord; refund?: RefundRecord }) {
    return this.transaction(async (db) => {
      const { rows } = await db.query('SELECT * FROM payments WHERE payment_reference = $1 FOR UPDATE', [reference]);
      if (!rows[0]) return undefined;
      const before = toPayment(rows[0]);
      const result = change(before);
      const p = result.payment;
      await db.query(
        `UPDATE payments SET status = $2, pending_until = $3, captured_amount = $4, captured_at = $5, order_id = $6, operation = $7,
          refunded_cents = $8, voided_at = $9 WHERE payment_reference = $1`,
        [reference, p.status, p.pendingUntil, p.capturedAmount?.total ?? null, p.capturedAt, p.orderId, p.operation, p.refundedCents, p.voidedAt],
      );
      if (!before.orderId && p.orderId) {
        await db.query('INSERT INTO used_references (payment_reference, order_id, operation, captured_at) VALUES ($1,$2,$3,$4)', [reference, p.orderId, p.operation, p.capturedAt]);
      }
      if (result.refund) {
        const r = result.refund;
        await db.query('INSERT INTO refunds (refund_id, payment_reference, currency, amount, reason, order_id, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
          r.refundId, r.paymentReference, r.amount.currency, r.amount.total, r.reason, r.orderId, r.status, r.createdAt,
        ]);
      }
      return result;
    });
  }

  async claimIdempotency(scope: IdempotencyScope, key: string, requestHash: string, now: string): Promise<IdempotencyClaim> {
    const inserted = await this.pool.query('INSERT INTO idempotency_keys (scope, key, request_hash, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [scope, key, requestHash, now]);
    if (inserted.rowCount === 1) return { kind: 'new' };
    const { rows } = await this.pool.query('SELECT request_hash, status, body FROM idempotency_keys WHERE scope = $1 AND key = $2', [scope, key]);
    const row = rows[0] as Row | undefined;
    if (!row) return { kind: 'in-progress' };
    if (row['request_hash'] !== requestHash) return { kind: 'mismatch' };
    return row['status'] === null ? { kind: 'in-progress' } : { kind: 'replay', status: Number(row['status']), body: row['body'] };
  }
  async completeIdempotency(scope: IdempotencyScope, key: string, status: number, body: unknown) {
    await this.pool.query('UPDATE idempotency_keys SET status = $3, body = $4 WHERE scope = $1 AND key = $2', [scope, key, status, JSON.stringify(body)]);
  }
  async releaseIdempotency(scope: IdempotencyScope, key: string) {
    await this.pool.query('DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2 AND status IS NULL', [scope, key]);
  }
}
