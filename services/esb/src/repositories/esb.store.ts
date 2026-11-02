import pg from 'pg';
import type { CloudEvent } from '@ecoairlines/shared';
import type { OutboxEntry, OutboxSource } from '@ecoairlines/shared/bus/outbox.js';

/**
 * Datos propios del ESB (base `esb`, PLAN.md §4.6):
 * - `idempotency_claims`: una fila por (`scope`, `Idempotency-Key`) con el `request_hash` y la respuesta guardada, 24 h (D6).
 * - `inbound_events`: cada CloudEvent recibido de Booking, por su `id` (D34, capa 1): uno repetido no se vuelve a procesar.
 * - `saga_log` (V2.10): el estado de cada saga y sus pasos hechos, para reanudarla o compensarla tras un reinicio.
 * - `change_offers` (V2.10): las alternativas de cambio de fecha que vio el cliente, hasta que confirma o vencen.
 * - `outbox` (V2.11): los eventos del ESB hasta que el relé los publica en RabbitMQ (por su `id`: guardar dos veces el mismo no
 *   lo duplica).
 */
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
/** Plazo de una petición idempotente "en curso": si el ESB se cae a la mitad, otra puede tomarla después. */
export const IDEMPOTENCY_LEASE_MS = 60_000;
/** Plazo con el que un trabajador toma un evento de Booking (dos réplicas no procesan el mismo a la vez). */
export const INBOUND_LEASE_MS = 30_000;
/** Plazo con el que una réplica ejecuta una saga; se renueva en cada paso. Vencido, el trabajador de recuperación la retoma. */
export const SAGA_LEASE_MS = 60_000;

export type SagaStatus = 'RUNNING' | 'COMPLETED' | 'COMPENSATING' | 'COMPENSATED' | 'FAILED';

export interface SagaStep {
  name: string;
  /** STARTED: se marcó antes de ejecutarlo (si la réplica se cae a la mitad, se compensa igual). */
  status: 'STARTED' | 'DONE' | 'COMPENSATED';
  /** Resultado del paso (se devuelve sin repetirlo al reanudar). */
  result?: unknown;
  at: string;
}

export interface SagaRecord {
  sagaId: string;
  type: string;
  status: SagaStatus;
  /** Entrada de la saga (puede tener datos personales y de asistencia): nunca se devuelve por la API ni se escribe en logs. */
  input: unknown;
  steps: SagaStep[];
  result: unknown;
  error: Record<string, unknown> | null;
  ownerId: string | null;
  actorId: string | null;
  correlationId: string;
  /** Saga que la inició (p. ej. "Cambiar estado de vuelo" → cada "Cancelar"). */
  parentSagaId: string | null;
  attempts: number;
  leaseUntil: string;
  /** Cuándo se reintenta una saga pendiente (después del punto sin retorno). */
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SagaFilter {
  type?: string;
  status?: SagaStatus;
  parentSagaId?: string;
  /** V2.16: las sagas de un proceso (búsqueda por X-Correlation-Id del panel). */
  correlationId?: string;
  limit: number;
}

/** Alternativas de cambio de fecha (`changeOfferId` de PostSale → itinerarios nuevos de Offers). */
export interface ChangeOfferRecord {
  changeOfferId: string;
  bookingId: string;
  data: Record<string, unknown>;
  expiresAt: string;
}

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type ClaimResult =
  | { kind: 'new' }
  | { kind: 'replay'; response: StoredResponse }
  | { kind: 'mismatch' }
  | { kind: 'in-progress' };

export type InboundStatus = 'PENDING' | 'PROCESSING' | 'RETRY' | 'PROCESSED' | 'REJECTED' | 'WAITING_SAGA';
export type InboundChannel = 'WEBHOOK' | 'AMQP';

export interface InboundEventRecord {
  id: string;
  type: string;
  source: string;
  bookingId: string | null;
  correlationId: string;
  channel: InboundChannel;
  event: Record<string, unknown>;
  status: InboundStatus;
  attempts: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  /** Qué se hizo (PROCESSED) o por qué no (REJECTED, RETRY): ProblemDetails o el resultado de la saga. */
  outcome: Record<string, unknown> | null;
  receivedAt: string;
  processedAt: string | null;
}

export interface InboundFilter {
  status?: InboundStatus;
  limit: number;
}

export interface EsbStore {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;

  /** Reserva la clave (o devuelve la respuesta guardada). `now` en ms. */
  claim(scope: string, key: string, requestHash: string, now: number): Promise<ClaimResult>;
  complete(scope: string, key: string, response: StoredResponse): Promise<void>;
  release(scope: string, key: string): Promise<void>;

  /** true si es nuevo; false si ese `id` ya había llegado. */
  insertInbound(record: InboundEventRecord): Promise<boolean>;
  /** Toma hasta `limit` eventos listos (PENDING, RETRY vencido o PROCESSING con el plazo vencido). */
  claimInbound(now: string, limit: number): Promise<InboundEventRecord[]>;
  finishInbound(id: string, status: Exclude<InboundStatus, 'PENDING' | 'PROCESSING'>, outcome: Record<string, unknown> | null, now: string, nextAttemptAt?: string): Promise<void>;
  inbound(id: string): Promise<InboundEventRecord | undefined>;
  listInbound(filter: InboundFilter): Promise<InboundEventRecord[]>;
  lastInboundAt(): Promise<string | null>;

  /** false si ya existía (mismo `sagaId`). */
  insertSaga(record: SagaRecord): Promise<boolean>;
  saga(sagaId: string): Promise<SagaRecord | undefined>;
  saveSaga(record: SagaRecord): Promise<void>;
  /** Sagas sin terminar cuyo plazo venció (la réplica se cayó) y cuyo reintento ya toca: se toman con un plazo nuevo. */
  claimStaleSagas(now: string, limit: number): Promise<SagaRecord[]>;
  listSagas(filter: SagaFilter): Promise<SagaRecord[]>;

  saveChangeOffer(record: ChangeOfferRecord): Promise<void>;
  changeOffer(changeOfferId: string): Promise<ChangeOfferRecord | undefined>;

  /** Toma UNA saga concreta si está lista para reintentarse (reintento diferido que llegó por RabbitMQ). */
  claimSaga(sagaId: string, now: string): Promise<SagaRecord | undefined>;

  /** false si ese evento ya estaba en el outbox (mismo `id`). */
  insertOutbox(event: CloudEvent, ownerId: string | undefined, now: string): Promise<boolean>;
  claimOutbox(limit: number, leaseMs: number): Promise<OutboxEntry[]>;
  markOutboxPublished(id: string, publishedAt: string): Promise<void>;
  outboxStats(): Promise<{ pending: number; oldestPendingAt: string | null; lastPublishedAt: string | null }>;
}

export type EsbStoreWithOutbox = EsbStore & OutboxSource;

export const ESB_STORE = Symbol('ESB_STORE');

// --------------------------------------------------------------------------------------------------------------- memoria

interface ClaimRow {
  requestHash: string;
  createdAt: number;
  leaseUntil: number;
  response?: StoredResponse;
}

export class InMemoryEsbStore implements EsbStore {
  readonly kind = 'memory' as const;
  private readonly claims = new Map<string, ClaimRow>();
  private readonly events = new Map<string, InboundEventRecord>();

  async init() {}
  async ping() {
    return true;
  }
  async close() {}

  async claim(scope: string, key: string, requestHash: string, now: number): Promise<ClaimResult> {
    const id = `${scope}\u0000${key}`;
    const row = this.claims.get(id);
    if (!row || row.createdAt + IDEMPOTENCY_TTL_MS <= now) {
      this.claims.set(id, { requestHash, createdAt: now, leaseUntil: now + IDEMPOTENCY_LEASE_MS });
      return { kind: 'new' };
    }
    if (row.requestHash !== requestHash) return { kind: 'mismatch' };
    if (row.response) return { kind: 'replay', response: row.response };
    if (row.leaseUntil <= now) {
      row.leaseUntil = now + IDEMPOTENCY_LEASE_MS;
      return { kind: 'new' };
    }
    return { kind: 'in-progress' };
  }
  async complete(scope: string, key: string, response: StoredResponse) {
    const row = this.claims.get(`${scope}\u0000${key}`);
    if (row) row.response = response;
  }
  async release(scope: string, key: string) {
    const id = `${scope}\u0000${key}`;
    if (!this.claims.get(id)?.response) this.claims.delete(id);
  }

  async insertInbound(record: InboundEventRecord) {
    if (this.events.has(record.id)) return false;
    this.events.set(record.id, structuredClone(record));
    return true;
  }
  async claimInbound(now: string, limit: number) {
    const ready = [...this.events.values()]
      .filter((e) => ((e.status === 'PENDING' || e.status === 'RETRY' || e.status === 'WAITING_SAGA') && e.nextAttemptAt <= now) || (e.status === 'PROCESSING' && (e.leaseUntil ?? '') <= now))
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
      .slice(0, limit);
    const lease = new Date(Date.parse(now) + INBOUND_LEASE_MS).toISOString();
    for (const e of ready) Object.assign(e, { status: 'PROCESSING', leaseUntil: lease, attempts: e.attempts + 1 });
    return ready.map((e) => structuredClone(e));
  }
  async finishInbound(id: string, status: Exclude<InboundStatus, 'PENDING' | 'PROCESSING'>, outcome: Record<string, unknown> | null, now: string, nextAttemptAt?: string) {
    const e = this.events.get(id);
    if (!e) return;
    Object.assign(e, { status, outcome, leaseUntil: null, ...(status === 'RETRY' ? { nextAttemptAt: nextAttemptAt ?? now } : { processedAt: now }) });
  }
  async inbound(id: string) {
    const e = this.events.get(id);
    return e ? structuredClone(e) : undefined;
  }
  async listInbound(filter: InboundFilter) {
    return [...this.events.values()]
      .filter((e) => !filter.status || e.status === filter.status)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, filter.limit)
      .map((e) => structuredClone(e));
  }
  async lastInboundAt() {
    return [...this.events.values()].map((e) => e.receivedAt).sort().at(-1) ?? null;
  }

  private readonly sagas = new Map<string, SagaRecord>();
  private readonly offers = new Map<string, ChangeOfferRecord>();

  async insertSaga(record: SagaRecord) {
    if (this.sagas.has(record.sagaId)) return false;
    this.sagas.set(record.sagaId, structuredClone(record));
    return true;
  }
  async saga(sagaId: string) {
    const record = this.sagas.get(sagaId);
    return record ? structuredClone(record) : undefined;
  }
  async saveSaga(record: SagaRecord) {
    this.sagas.set(record.sagaId, structuredClone(record));
  }
  async claimStaleSagas(now: string, limit: number) {
    const lease = new Date(Date.parse(now) + SAGA_LEASE_MS).toISOString();
    const ready = [...this.sagas.values()]
      .filter((s) => (s.status === 'RUNNING' || s.status === 'COMPENSATING') && s.leaseUntil <= now && s.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
    for (const s of ready) Object.assign(s, { leaseUntil: lease, attempts: s.attempts + 1 });
    return ready.map((s) => structuredClone(s));
  }
  async listSagas(filter: SagaFilter) {
    return [...this.sagas.values()]
      .filter((s) => (!filter.type || s.type === filter.type) && (!filter.status || s.status === filter.status) && (!filter.parentSagaId || s.parentSagaId === filter.parentSagaId) && (!filter.correlationId || s.correlationId === filter.correlationId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit)
      .map((s) => structuredClone(s));
  }
  async saveChangeOffer(record: ChangeOfferRecord) {
    this.offers.set(record.changeOfferId, structuredClone(record));
  }
  async changeOffer(changeOfferId: string) {
    const record = this.offers.get(changeOfferId);
    return record ? structuredClone(record) : undefined;
  }

  async claimSaga(sagaId: string, now: string) {
    const s = this.sagas.get(sagaId);
    if (!s || !(s.status === 'RUNNING' || s.status === 'COMPENSATING') || s.leaseUntil > now || s.nextAttemptAt > now) return undefined;
    Object.assign(s, { leaseUntil: new Date(Date.parse(now) + SAGA_LEASE_MS).toISOString(), attempts: s.attempts + 1 });
    return structuredClone(s);
  }

  private readonly outboxRows: { id: string; event: CloudEvent; ownerId: string | null; createdAt: string; publishedAt: string | null; leaseUntil: string | null }[] = [];

  async insertOutbox(event: CloudEvent, ownerId: string | undefined, now: string) {
    if (this.outboxRows.some((row) => row.id === event.id)) return false;
    this.outboxRows.push({ id: event.id, event: structuredClone(event), ownerId: ownerId ?? null, createdAt: now, publishedAt: null, leaseUntil: null });
    return true;
  }
  async claimOutbox(limit: number, leaseMs: number) {
    const now = new Date().toISOString();
    const ready = this.outboxRows.filter((row) => !row.publishedAt && (!row.leaseUntil || row.leaseUntil <= now)).slice(0, limit);
    for (const row of ready) row.leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    return ready.map((row) => ({ id: row.id, event: structuredClone(row.event), ownerId: row.ownerId }));
  }
  async markOutboxPublished(id: string, publishedAt: string) {
    const row = this.outboxRows.find((r) => r.id === id);
    if (row) Object.assign(row, { publishedAt, leaseUntil: null });
  }
  async outboxStats() {
    const pending = this.outboxRows.filter((row) => !row.publishedAt);
    return { pending: pending.length, oldestPendingAt: pending[0]?.createdAt ?? null, lastPublishedAt: this.outboxRows.map((r) => r.publishedAt).filter(Boolean).sort().at(-1) ?? null };
  }
}

// ------------------------------------------------------------------------------------------------------------- PostgreSQL

const SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency_claims (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  lease_until timestamptz NOT NULL,
  response_status integer,
  response_headers jsonb,
  response_body text,
  PRIMARY KEY (scope, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idempotency_claims_created ON idempotency_claims (created_at);
CREATE TABLE IF NOT EXISTS inbound_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  source text NOT NULL,
  booking_id uuid,
  correlation_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('WEBHOOK', 'AMQP')),
  event jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'RETRY', 'PROCESSED', 'REJECTED', 'WAITING_SAGA')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  lease_until timestamptz,
  outcome jsonb,
  received_at timestamptz NOT NULL,
  processed_at timestamptz
);
DROP INDEX IF EXISTS inbound_events_ready;
CREATE INDEX IF NOT EXISTS inbound_events_pending ON inbound_events (next_attempt_at) WHERE status IN ('PENDING', 'RETRY', 'PROCESSING', 'WAITING_SAGA');
CREATE INDEX IF NOT EXISTS inbound_events_received ON inbound_events (received_at DESC);
CREATE TABLE IF NOT EXISTS saga_log (
  saga_id uuid PRIMARY KEY,
  type text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'COMPENSATING', 'COMPENSATED', 'FAILED')),
  input jsonb,
  steps jsonb NOT NULL DEFAULT '[]',
  result jsonb,
  error jsonb,
  owner_id text,
  actor_id uuid,
  correlation_id text NOT NULL,
  parent_saga_id uuid,
  attempts integer NOT NULL DEFAULT 1,
  lease_until timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS saga_log_pending ON saga_log (lease_until) WHERE status IN ('RUNNING', 'COMPENSATING');
CREATE INDEX IF NOT EXISTS saga_log_parent ON saga_log (parent_saga_id) WHERE parent_saga_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS saga_log_created ON saga_log (created_at DESC);
CREATE TABLE IF NOT EXISTS outbox (
  seq bigserial UNIQUE,
  id text PRIMARY KEY,
  type text NOT NULL,
  event jsonb NOT NULL,
  owner_id text,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  lease_until timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (seq) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS change_offers (
  change_offer_id text PRIMARY KEY,
  booking_id uuid NOT NULL,
  data jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
`;

const iso = (value: Date | string | null) => (value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toInbound = (row: any): InboundEventRecord => ({
  id: row.id,
  type: row.type,
  source: row.source,
  bookingId: row.booking_id,
  correlationId: row.correlation_id,
  channel: row.channel,
  event: row.event,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: iso(row.next_attempt_at)!,
  leaseUntil: iso(row.lease_until),
  outcome: row.outcome,
  receivedAt: iso(row.received_at)!,
  processedAt: iso(row.processed_at),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toSaga = (row: any): SagaRecord => ({
  sagaId: row.saga_id,
  type: row.type,
  status: row.status,
  input: row.input,
  steps: row.steps ?? [],
  result: row.result,
  error: row.error,
  ownerId: row.owner_id,
  actorId: row.actor_id,
  correlationId: row.correlation_id,
  parentSagaId: row.parent_saga_id,
  attempts: row.attempts,
  leaseUntil: iso(row.lease_until)!,
  nextAttemptAt: iso(row.next_attempt_at)!,
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `undefined` o `null` → NULL; lo demás, JSON. */
const json = (value: unknown) => (value === undefined || value === null ? null : JSON.stringify(value));

export class PostgresEsbStore implements EsbStore {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000 });
  }
  async init() {
    await this.pool.query(SCHEMA);
    // Limpieza de claves vencidas (24 h): al arrancar basta; una clave vencida igual se reemplaza al reutilizarse.
    await this.pool.query(`DELETE FROM idempotency_claims WHERE created_at < now() - interval '24 hours'`);
  }
  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }
  async close() {
    await this.pool.end();
  }

  async claim(scope: string, key: string, requestHash: string, now: number): Promise<ClaimResult> {
    const at = new Date(now).toISOString();
    const lease = new Date(now + IDEMPOTENCY_LEASE_MS).toISOString();
    const expired = new Date(now - IDEMPOTENCY_TTL_MS).toISOString();
    // Una sola sentencia atómica: inserta, o reemplaza la fila vencida, o retoma una "en curso" abandonada (mismo hash).
    const { rows } = await this.pool.query(
      `INSERT INTO idempotency_claims (scope, idempotency_key, request_hash, created_at, lease_until) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope, idempotency_key) DO UPDATE SET request_hash = EXCLUDED.request_hash, created_at = EXCLUDED.created_at,
         lease_until = EXCLUDED.lease_until, response_status = NULL, response_headers = NULL, response_body = NULL
       WHERE idempotency_claims.created_at <= $6
          OR (idempotency_claims.response_status IS NULL AND idempotency_claims.lease_until <= $4 AND idempotency_claims.request_hash = EXCLUDED.request_hash)
       RETURNING scope`,
      [scope, key, requestHash, at, lease, expired],
    );
    if (rows.length) return { kind: 'new' };
    const existing = (await this.pool.query('SELECT * FROM idempotency_claims WHERE scope = $1 AND idempotency_key = $2', [scope, key])).rows[0];
    if (!existing) return this.claim(scope, key, requestHash, now); // se borró entre las dos sentencias
    if (existing.request_hash !== requestHash) return { kind: 'mismatch' };
    if (existing.response_status === null) return { kind: 'in-progress' };
    return { kind: 'replay', response: { status: existing.response_status, headers: existing.response_headers ?? {}, body: existing.response_body ?? '' } };
  }
  async complete(scope: string, key: string, response: StoredResponse) {
    await this.pool.query('UPDATE idempotency_claims SET response_status = $3, response_headers = $4, response_body = $5 WHERE scope = $1 AND idempotency_key = $2', [
      scope, key, response.status, JSON.stringify(response.headers), response.body,
    ]);
  }
  async release(scope: string, key: string) {
    await this.pool.query('DELETE FROM idempotency_claims WHERE scope = $1 AND idempotency_key = $2 AND response_status IS NULL', [scope, key]);
  }

  async insertInbound(r: InboundEventRecord) {
    const { rowCount } = await this.pool.query(
      `INSERT INTO inbound_events (id, type, source, booking_id, correlation_id, channel, event, status, attempts, next_attempt_at, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
      [r.id, r.type, r.source, r.bookingId, r.correlationId, r.channel, JSON.stringify(r.event), r.status, r.attempts, r.nextAttemptAt, r.receivedAt],
    );
    return rowCount === 1;
  }
  async claimInbound(now: string, limit: number) {
    const { rows } = await this.pool.query(
      `UPDATE inbound_events SET status = 'PROCESSING', lease_until = $3, attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM inbound_events
         WHERE (status IN ('PENDING', 'RETRY', 'WAITING_SAGA') AND next_attempt_at <= $1) OR (status = 'PROCESSING' AND lease_until <= $1)
         ORDER BY received_at LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [now, limit, new Date(Date.parse(now) + INBOUND_LEASE_MS).toISOString()],
    );
    return rows.map(toInbound).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }
  async finishInbound(id: string, status: Exclude<InboundStatus, 'PENDING' | 'PROCESSING'>, outcome: Record<string, unknown> | null, now: string, nextAttemptAt?: string) {
    await this.pool.query(
      status === 'RETRY'
        ? `UPDATE inbound_events SET status = $2, outcome = $3, lease_until = NULL, next_attempt_at = $4 WHERE id = $1`
        : `UPDATE inbound_events SET status = $2, outcome = $3, lease_until = NULL, processed_at = $4 WHERE id = $1`,
      [id, status, outcome === null ? null : JSON.stringify(outcome), status === 'RETRY' ? (nextAttemptAt ?? now) : now],
    );
  }
  async inbound(id: string) {
    return (await this.pool.query('SELECT * FROM inbound_events WHERE id = $1', [id])).rows.map(toInbound)[0];
  }
  async listInbound(filter: InboundFilter) {
    const { rows } = filter.status
      ? await this.pool.query('SELECT * FROM inbound_events WHERE status = $1 ORDER BY received_at DESC LIMIT $2', [filter.status, filter.limit])
      : await this.pool.query('SELECT * FROM inbound_events ORDER BY received_at DESC LIMIT $1', [filter.limit]);
    return rows.map(toInbound);
  }
  async lastInboundAt() {
    return iso((await this.pool.query('SELECT max(received_at) AS at FROM inbound_events')).rows[0].at ?? null);
  }

  async insertSaga(r: SagaRecord) {
    const { rowCount } = await this.pool.query(
      `INSERT INTO saga_log (saga_id, type, status, input, steps, result, error, owner_id, actor_id, correlation_id, parent_saga_id, attempts, lease_until, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ON CONFLICT (saga_id) DO NOTHING`,
      [r.sagaId, r.type, r.status, json(r.input), JSON.stringify(r.steps), json(r.result), json(r.error), r.ownerId, r.actorId, r.correlationId, r.parentSagaId, r.attempts, r.leaseUntil, r.nextAttemptAt, r.createdAt, r.updatedAt],
    );
    return rowCount === 1;
  }
  async saga(sagaId: string) {
    return UUID_PATTERN.test(sagaId) ? (await this.pool.query('SELECT * FROM saga_log WHERE saga_id = $1', [sagaId])).rows.map(toSaga)[0] : undefined;
  }
  async saveSaga(r: SagaRecord) {
    await this.pool.query(
      'UPDATE saga_log SET status = $2, steps = $3, result = $4, error = $5, attempts = $6, lease_until = $7, next_attempt_at = $8, updated_at = $9 WHERE saga_id = $1',
      [r.sagaId, r.status, JSON.stringify(r.steps), json(r.result), json(r.error), r.attempts, r.leaseUntil, r.nextAttemptAt, r.updatedAt],
    );
  }
  async claimStaleSagas(now: string, limit: number) {
    const { rows } = await this.pool.query(
      `UPDATE saga_log SET lease_until = $3, attempts = attempts + 1
       WHERE saga_id IN (
         SELECT saga_id FROM saga_log WHERE status IN ('RUNNING', 'COMPENSATING') AND lease_until <= $1 AND next_attempt_at <= $1
         ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [now, limit, new Date(Date.parse(now) + SAGA_LEASE_MS).toISOString()],
    );
    return rows.map(toSaga).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async listSagas(filter: SagaFilter) {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.type) where.push(`type = $${values.push(filter.type)}`);
    if (filter.status) where.push(`status = $${values.push(filter.status)}`);
    if (filter.parentSagaId) where.push(`parent_saga_id = $${values.push(filter.parentSagaId)}`);
    if (filter.correlationId) where.push(`correlation_id = $${values.push(filter.correlationId)}`);
    const sql = `SELECT * FROM saga_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${values.push(filter.limit)}`;
    return (await this.pool.query(sql, values)).rows.map(toSaga);
  }
  async saveChangeOffer(r: ChangeOfferRecord) {
    await this.pool.query(
      `INSERT INTO change_offers (change_offer_id, booking_id, data, expires_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (change_offer_id) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
      [r.changeOfferId, r.bookingId, JSON.stringify(r.data), r.expiresAt],
    );
    await this.pool.query(`DELETE FROM change_offers WHERE expires_at < now() - interval '1 day'`);
  }
  async changeOffer(changeOfferId: string) {
    const row = (await this.pool.query('SELECT * FROM change_offers WHERE change_offer_id = $1', [changeOfferId])).rows[0];
    return row ? { changeOfferId: row.change_offer_id, bookingId: row.booking_id, data: row.data, expiresAt: iso(row.expires_at)! } : undefined;
  }

  async claimSaga(sagaId: string, now: string) {
    if (!UUID_PATTERN.test(sagaId)) return undefined;
    const { rows } = await this.pool.query(
      `UPDATE saga_log SET lease_until = $3, attempts = attempts + 1
       WHERE saga_id = $1 AND status IN ('RUNNING', 'COMPENSATING') AND lease_until <= $2 AND next_attempt_at <= $2 RETURNING *`,
      [sagaId, now, new Date(Date.parse(now) + SAGA_LEASE_MS).toISOString()],
    );
    return rows.map(toSaga)[0];
  }

  async insertOutbox(event: CloudEvent, ownerId: string | undefined, now: string) {
    const { rowCount } = await this.pool.query('INSERT INTO outbox (id, type, event, owner_id, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING', [
      event.id, event.type, JSON.stringify(event), ownerId ?? null, now,
    ]);
    return rowCount === 1;
  }
  async claimOutbox(limit: number, leaseMs: number) {
    const { rows } = await this.pool.query(
      `UPDATE outbox SET lease_until = now() + ($2::int * interval '1 millisecond')
       WHERE id IN (SELECT id FROM outbox WHERE published_at IS NULL AND (lease_until IS NULL OR lease_until <= now()) ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, event, owner_id, seq`,
      [limit, leaseMs],
    );
    return rows.sort((a, b) => Number(a.seq) - Number(b.seq)).map((row) => ({ id: row.id, event: row.event, ownerId: row.owner_id }));
  }
  async markOutboxPublished(id: string, publishedAt: string) {
    await this.pool.query('UPDATE outbox SET published_at = $2, lease_until = NULL WHERE id = $1', [id, publishedAt]);
  }
  async outboxStats() {
    const { rows } = await this.pool.query(
      `SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS pending, min(created_at) FILTER (WHERE published_at IS NULL) AS oldest, max(published_at) AS last FROM outbox`,
    );
    return { pending: rows[0].pending, oldestPendingAt: iso(rows[0].oldest ?? null), lastPublishedAt: iso(rows[0].last ?? null) };
  }
}
