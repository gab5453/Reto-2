import { guardPool } from '@ecoairlines/shared';
import pg from 'pg';
import type { DeliveryRecord, EventRecord, SubscriptionRecord } from '../domain/rules.js';

/**
 * Datos de Webhooks (base `webhooks`: `subscriptions`, `event_log`, `deliveries`). En memoria (pruebas) o PostgreSQL.
 * `claimDue` toma las entregas que tocan y les pone un plazo de 30 s: dos réplicas no envían la misma entrega a la vez.
 */
export const WEBHOOKS_STORE = Symbol('WEBHOOKS_STORE');

export interface HistoryFilter {
  name?: string;
  correlationId?: string;
  /** Panel O-2: los eventos de una reserva (`subject` = su `bookingId`). */
  subject?: string;
  from?: string;
  to?: string;
}

export interface WebhooksStore {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;

  insertSubscription(subscription: SubscriptionRecord): Promise<void>;
  subscriptions(ownerId: string): Promise<SubscriptionRecord[]>;
  subscription(id: string): Promise<SubscriptionRecord | undefined>;
  activeSubscriptionsFor(name: string): Promise<SubscriptionRecord[]>;
  /** Da de baja la suscripción y cancela sus entregas pendientes. */
  deactivate(id: string): Promise<void>;
  countActiveSubscriptions(): Promise<number>;

  /** Guarda el evento y crea sus entregas en una sola transacción; `undefined` si el evento ya existía (deduplicado por `id`). */
  ingest(event: Omit<EventRecord, 'seq'>, subscriptionIds: string[], now: string): Promise<EventRecord | undefined>;
  eventById(id: string): Promise<EventRecord | undefined>;
  eventBySeq(seq: number): Promise<EventRecord | undefined>;
  /** Eventos públicos con `seq` > `afterSeq`, en orden (el filtro D40 se aplica en el servicio). */
  publicEventsAfter(afterSeq: number, name: string | undefined, limit: number): Promise<EventRecord[]>;
  history(filter: HistoryFilter, limit: number, offset: number): Promise<EventRecord[]>;

  deliveriesOf(eventSeqs: number[]): Promise<DeliveryRecord[]>;
  claimDue(now: string, limit: number): Promise<DeliveryRecord[]>;
  saveDelivery(delivery: DeliveryRecord): Promise<void>;
  deliveryStats(since: string): Promise<{ pending: number; retrying: number; exhausted: number; delivered: number; lastDeliveredAt: string | null }>;
}

const clone = <T>(value: T): T => structuredClone(value);
const LEASE_MS = 30_000;

export class InMemoryWebhooksStore implements WebhooksStore {
  readonly kind = 'memory' as const;
  private readonly subs = new Map<string, SubscriptionRecord>();
  private readonly events: EventRecord[] = [];
  private readonly deliveries = new Map<string, DeliveryRecord>();

  async init(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}

  async insertSubscription(s: SubscriptionRecord) {
    this.subs.set(s.id, clone(s));
  }
  async subscriptions(ownerId: string) {
    return clone([...this.subs.values()].filter((s) => s.ownerId === ownerId && s.active).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }
  async subscription(id: string) {
    return clone(this.subs.get(id));
  }
  async activeSubscriptionsFor(name: string) {
    return clone([...this.subs.values()].filter((s) => s.active && s.events.includes(name as never)));
  }
  async deactivate(id: string) {
    const s = this.subs.get(id);
    if (s) s.active = false;
    for (const d of this.deliveries.values()) if (d.subscriptionId === id && (d.outcome === 'PENDING' || d.outcome === 'RETRYING')) Object.assign(d, { outcome: 'CANCELLED', nextRetryAt: null });
  }
  async countActiveSubscriptions() {
    return [...this.subs.values()].filter((s) => s.active).length;
  }

  async ingest(event: Omit<EventRecord, 'seq'>, subscriptionIds: string[], now: string) {
    if (this.events.some((e) => e.id === event.id)) return undefined;
    const record = { ...clone(event), seq: this.events.length + 1 };
    this.events.push(record);
    for (const subscriptionId of subscriptionIds) {
      this.deliveries.set(`${record.seq}|${subscriptionId}`, { eventSeq: record.seq, subscriptionId, outcome: 'PENDING', attempts: 0, httpStatus: null, lastAttemptAt: null, nextRetryAt: now, deliveredAt: null });
    }
    return clone(record);
  }
  async eventById(id: string) {
    return clone(this.events.find((e) => e.id === id));
  }
  async eventBySeq(seq: number) {
    return clone(this.events.find((e) => e.seq === seq));
  }
  async publicEventsAfter(afterSeq: number, name: string | undefined, limit: number) {
    return clone(this.events.filter((e) => e.public && e.seq > afterSeq && (!name || e.name === name)).slice(0, limit));
  }
  async history(filter: HistoryFilter, limit: number, offset: number) {
    return clone(
      [...this.events]
        .reverse()
        .filter(
          (e) =>
            (!filter.name || e.name === filter.name) &&
            (!filter.correlationId || e.correlationId === filter.correlationId) &&
            (!filter.subject || e.subject === filter.subject) &&
            (!filter.from || e.time >= filter.from) &&
            (!filter.to || e.time <= filter.to),
        )
        .slice(offset, offset + limit),
    );
  }

  async deliveriesOf(seqs: number[]) {
    return clone([...this.deliveries.values()].filter((d) => seqs.includes(d.eventSeq)));
  }
  async claimDue(now: string, limit: number) {
    const due = [...this.deliveries.values()].filter((d) => (d.outcome === 'PENDING' || d.outcome === 'RETRYING') && d.nextRetryAt !== null && d.nextRetryAt <= now).slice(0, limit);
    for (const d of due) d.nextRetryAt = new Date(Date.parse(now) + LEASE_MS).toISOString();
    return clone(due);
  }
  async saveDelivery(d: DeliveryRecord) {
    this.deliveries.set(`${d.eventSeq}|${d.subscriptionId}`, clone(d));
  }
  async deliveryStats(since: string) {
    const all = [...this.deliveries.values()];
    const delivered = all.map((d) => d.deliveredAt).filter((at): at is string => !!at).sort();
    return {
      pending: all.filter((d) => d.outcome === 'PENDING').length,
      retrying: all.filter((d) => d.outcome === 'RETRYING').length,
      exhausted: all.filter((d) => d.outcome === 'EXHAUSTED' && (d.lastAttemptAt ?? '') >= since).length,
      delivered: all.filter((d) => d.outcome === 'DELIVERED' && (d.deliveredAt ?? '') >= since).length,
      lastDeliveredAt: delivered.at(-1) ?? null,
    };
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscriptions (
  id               uuid PRIMARY KEY,
  owner_id         text NOT NULL,
  url              text NOT NULL,
  events           text[] NOT NULL,
  secret_encrypted text NOT NULL,
  active           boolean NOT NULL,
  created_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_owner_idx ON subscriptions (owner_id) WHERE active;
CREATE TABLE IF NOT EXISTS event_log (
  seq            bigserial PRIMARY KEY,
  id             text NOT NULL UNIQUE,
  type           text NOT NULL,
  name           text NOT NULL,
  subject        text,
  time           timestamptz NOT NULL,
  correlation_id text,
  owner_id       text,
  public         boolean NOT NULL,
  event          jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS event_log_correlation_idx ON event_log (correlation_id);
CREATE INDEX IF NOT EXISTS event_log_subject_idx ON event_log (subject);
CREATE TABLE IF NOT EXISTS deliveries (
  event_seq       bigint NOT NULL REFERENCES event_log(seq),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  outcome         text NOT NULL,
  attempts        integer NOT NULL,
  http_status     integer,
  last_attempt_at timestamptz,
  next_retry_at   timestamptz,
  delivered_at    timestamptz,
  PRIMARY KEY (event_seq, subscription_id)
);
CREATE INDEX IF NOT EXISTS deliveries_due_idx ON deliveries (next_retry_at) WHERE outcome IN ('PENDING', 'RETRYING');
`;
type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
const toSub = (r: Row): SubscriptionRecord => ({
  id: String(r['id']), ownerId: String(r['owner_id']), url: String(r['url']), events: r['events'] as SubscriptionRecord['events'],
  secretEncrypted: String(r['secret_encrypted']), active: Boolean(r['active']), createdAt: iso(r['created_at'])!,
});
const toEvent = (r: Row): EventRecord => ({
  seq: Number(r['seq']), id: String(r['id']), type: String(r['type']), name: String(r['name']), subject: (r['subject'] as string | null) ?? null,
  time: iso(r['time'])!, correlationId: (r['correlation_id'] as string | null) ?? null, ownerId: (r['owner_id'] as string | null) ?? null,
  public: Boolean(r['public']), event: r['event'] as EventRecord['event'],
});
const toDelivery = (r: Row): DeliveryRecord => ({
  eventSeq: Number(r['event_seq']), subscriptionId: String(r['subscription_id']), outcome: r['outcome'] as DeliveryRecord['outcome'], attempts: Number(r['attempts']),
  httpStatus: r['http_status'] === null ? null : Number(r['http_status']), lastAttemptAt: iso(r['last_attempt_at']), nextRetryAt: iso(r['next_retry_at']), deliveredAt: iso(r['delivered_at']),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PostgresWebhooksStore implements WebhooksStore {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = guardPool(new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000 }), 'ms-g-webhooks');
  }
  async init() {
    await this.pool.query(SCHEMA);
  }
  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }
  async close() {
    await this.pool.end();
  }

  async insertSubscription(s: SubscriptionRecord) {
    await this.pool.query('INSERT INTO subscriptions (id, owner_id, url, events, secret_encrypted, active, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      s.id, s.ownerId, s.url, s.events, s.secretEncrypted, s.active, s.createdAt,
    ]);
  }
  async subscriptions(ownerId: string) {
    return (await this.pool.query('SELECT * FROM subscriptions WHERE owner_id = $1 AND active ORDER BY created_at', [ownerId])).rows.map(toSub);
  }
  async subscription(id: string) {
    return UUID.test(id) ? (await this.pool.query('SELECT * FROM subscriptions WHERE id = $1', [id])).rows.map(toSub)[0] : undefined;
  }
  async activeSubscriptionsFor(name: string) {
    return (await this.pool.query('SELECT * FROM subscriptions WHERE active AND $1 = ANY(events)', [name])).rows.map(toSub);
  }
  async deactivate(id: string) {
    await this.pool.query('UPDATE subscriptions SET active = false WHERE id = $1', [id]);
    await this.pool.query(`UPDATE deliveries SET outcome = 'CANCELLED', next_retry_at = NULL WHERE subscription_id = $1 AND outcome IN ('PENDING', 'RETRYING')`, [id]);
  }
  async countActiveSubscriptions() {
    return Number((await this.pool.query('SELECT count(*)::int AS n FROM subscriptions WHERE active')).rows[0].n);
  }

  async ingest(e: Omit<EventRecord, 'seq'>, subscriptionIds: string[], now: string) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const { rows } = await db.query(
        `INSERT INTO event_log (id, type, name, subject, time, correlation_id, owner_id, public, event) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [e.id, e.type, e.name, e.subject, e.time, e.correlationId, e.ownerId, e.public, JSON.stringify(e.event)],
      );
      const record = rows[0] ? toEvent(rows[0]) : undefined;
      if (record) {
        for (const subscriptionId of subscriptionIds) {
          await db.query(`INSERT INTO deliveries (event_seq, subscription_id, outcome, attempts, next_retry_at) VALUES ($1, $2, 'PENDING', 0, $3)`, [record.seq, subscriptionId, now]);
        }
      }
      await db.query('COMMIT');
      return record;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
  }
  async eventById(id: string) {
    return (await this.pool.query('SELECT * FROM event_log WHERE id = $1', [id])).rows.map(toEvent)[0];
  }
  async eventBySeq(seq: number) {
    return (await this.pool.query('SELECT * FROM event_log WHERE seq = $1', [seq])).rows.map(toEvent)[0];
  }
  async publicEventsAfter(afterSeq: number, name: string | undefined, limit: number) {
    return (await this.pool.query(`SELECT * FROM event_log WHERE public AND seq > $1 AND ($2::text IS NULL OR name = $2) ORDER BY seq LIMIT $3`, [afterSeq, name ?? null, limit])).rows.map(toEvent);
  }
  async history(f: HistoryFilter, limit: number, offset: number) {
    return (
      await this.pool.query(
        `SELECT * FROM event_log WHERE ($1::text IS NULL OR name = $1) AND ($2::text IS NULL OR correlation_id = $2)
           AND ($3::timestamptz IS NULL OR time >= $3) AND ($4::timestamptz IS NULL OR time <= $4) AND ($7::text IS NULL OR subject = $7)
           ORDER BY seq DESC LIMIT $5 OFFSET $6`,
        [f.name ?? null, f.correlationId ?? null, f.from ?? null, f.to ?? null, limit, offset, f.subject ?? null],
      )
    ).rows.map(toEvent);
  }

  async deliveriesOf(seqs: number[]) {
    return seqs.length ? (await this.pool.query('SELECT * FROM deliveries WHERE event_seq = ANY($1::bigint[])', [seqs])).rows.map(toDelivery) : [];
  }
  async claimDue(now: string, limit: number) {
    const { rows } = await this.pool.query(
      `UPDATE deliveries SET next_retry_at = $1::timestamptz + interval '30 seconds'
       WHERE (event_seq, subscription_id) IN (
         SELECT event_seq, subscription_id FROM deliveries WHERE outcome IN ('PENDING', 'RETRYING') AND next_retry_at <= $1
         ORDER BY next_retry_at LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [now, limit],
    );
    return rows.map(toDelivery);
  }
  async saveDelivery(d: DeliveryRecord) {
    await this.pool.query(
      'UPDATE deliveries SET outcome = $3, attempts = $4, http_status = $5, last_attempt_at = $6, next_retry_at = $7, delivered_at = $8 WHERE event_seq = $1 AND subscription_id = $2',
      [d.eventSeq, d.subscriptionId, d.outcome, d.attempts, d.httpStatus, d.lastAttemptAt, d.nextRetryAt, d.deliveredAt],
    );
  }
  async deliveryStats(since: string) {
    const { rows } = await this.pool.query(
      `SELECT count(*) FILTER (WHERE outcome = 'PENDING')::int AS pending, count(*) FILTER (WHERE outcome = 'RETRYING')::int AS retrying,
              count(*) FILTER (WHERE outcome = 'EXHAUSTED' AND last_attempt_at >= $1)::int AS exhausted,
              count(*) FILTER (WHERE outcome = 'DELIVERED' AND delivered_at >= $1)::int AS delivered, max(delivered_at) AS last
       FROM deliveries`,
      [since],
    );
    const r = rows[0] as Row;
    return { pending: Number(r['pending']), retrying: Number(r['retrying']), exhausted: Number(r['exhausted']), delivered: Number(r['delivered']), lastDeliveredAt: iso(r['last']) };
  }
}
