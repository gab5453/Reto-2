import pg from 'pg';
import type { CancellationQuote, DateChangeOffer } from '../domain/rules.js';

/**
 * Datos de PostSale (base `post_sale`): cotizaciones de cancelación y ofertas de cambio, que vencen en 15 minutos y se usan
 * una sola vez (`status` + `saga_id`). En memoria (pruebas) o PostgreSQL, con el mismo comportamiento.
 */
export const POST_SALE_STORE = Symbol('POST_SALE_STORE');

export interface Stored<T> {
  data: T;
  status: 'AVAILABLE' | 'CONSUMED';
  sagaId: string | null;
}

export interface PostSaleTx {
  quote(quoteId: string): Promise<Stored<CancellationQuote> | undefined>;
  saveQuote(quote: Stored<CancellationQuote>): Promise<void>;
  offer(changeOfferId: string): Promise<Stored<DateChangeOffer> | undefined>;
  saveOffer(offer: Stored<DateChangeOffer>): Promise<void>;
  sagaResult<T>(key: string): Promise<T | undefined>;
  saveSagaResult(key: string, result: unknown): Promise<void>;
}

export interface PostSaleStore {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  transaction<T>(work: (tx: PostSaleTx) => Promise<T>): Promise<T>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryPostSaleStore implements PostSaleStore {
  readonly kind = 'memory' as const;
  private readonly quotes = new Map<string, Stored<CancellationQuote>>();
  private readonly offers = new Map<string, Stored<DateChangeOffer>>();
  private readonly sagas = new Map<string, unknown>();
  private queue: Promise<unknown> = Promise.resolve();

  async init(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}

  transaction<T>(work: (tx: PostSaleTx) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const undo: (() => void)[] = [];
      const set = <V>(map: Map<string, V>, key: string, value: V) => {
        const had = map.has(key);
        const previous = map.get(key);
        undo.push(() => (had ? map.set(key, previous!) : map.delete(key)));
        map.set(key, clone(value));
      };
      try {
        return await work({
          quote: async (id) => clone(this.quotes.get(id)),
          saveQuote: async (quote) => set(this.quotes, quote.data.quoteId, quote),
          offer: async (id) => clone(this.offers.get(id)),
          saveOffer: async (offer) => set(this.offers, offer.data.changeOfferId, offer),
          sagaResult: async <R>(key: string) => clone(this.sagas.get(key) as R | undefined),
          saveSagaResult: async (key, result) => set(this.sagas, key, result),
        });
      } catch (error) {
        for (const step of undo.reverse()) step();
        throw error;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cancellation_quotes (
  quote_id   uuid PRIMARY KEY,
  booking_id uuid NOT NULL,
  status     text NOT NULL CHECK (status IN ('AVAILABLE', 'CONSUMED')),
  saga_id    uuid,
  expires_at timestamptz,
  data       jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS date_change_offers (
  change_offer_id uuid PRIMARY KEY,
  booking_id      uuid NOT NULL,
  status          text NOT NULL CHECK (status IN ('AVAILABLE', 'CONSUMED')),
  saga_id         uuid,
  expires_at      timestamptz NOT NULL,
  data            jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS saga_results (
  key        text PRIMARY KEY,
  result     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = Record<string, unknown>;
const stored = <T>(row: Row): Stored<T> => ({ data: row['data'] as T, status: row['status'] as Stored<T>['status'], sagaId: (row['saga_id'] as string | null) ?? null });

export class PostgresPostSaleStore implements PostSaleStore {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000 });
  }
  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }
  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }
  async close(): Promise<void> {
    await this.pool.end();
  }

  async transaction<T>(work: (tx: PostSaleTx) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const result = await work({
        // FOR UPDATE: dos sagas que consumen la misma cotización se ejecutan una tras otra.
        quote: async (id) => (UUID.test(id) ? (await db.query('SELECT * FROM cancellation_quotes WHERE quote_id = $1 FOR UPDATE', [id])).rows.map((r: Row) => stored<CancellationQuote>(r))[0] : undefined),
        saveQuote: async (q) => {
          await db.query(
            `INSERT INTO cancellation_quotes (quote_id, booking_id, status, saga_id, expires_at, data) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (quote_id) DO UPDATE SET status = EXCLUDED.status, saga_id = EXCLUDED.saga_id, data = EXCLUDED.data`,
            [q.data.quoteId, q.data.bookingId, q.status, q.sagaId, q.data.expiresAt ?? null, JSON.stringify(q.data)],
          );
        },
        offer: async (id) => (UUID.test(id) ? (await db.query('SELECT * FROM date_change_offers WHERE change_offer_id = $1 FOR UPDATE', [id])).rows.map((r: Row) => stored<DateChangeOffer>(r))[0] : undefined),
        saveOffer: async (o) => {
          await db.query(
            `INSERT INTO date_change_offers (change_offer_id, booking_id, status, saga_id, expires_at, data) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (change_offer_id) DO UPDATE SET status = EXCLUDED.status, saga_id = EXCLUDED.saga_id`,
            [o.data.changeOfferId, o.data.bookingId, o.status, o.sagaId, o.data.expiresAt, JSON.stringify(o.data)],
          );
        },
        sagaResult: async <R>(key: string) => ((await db.query('SELECT result FROM saga_results WHERE key = $1', [key])).rows[0] as Row | undefined)?.['result'] as R | undefined,
        saveSagaResult: async (key, result) => {
          await db.query('INSERT INTO saga_results (key, result) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(result)]);
        },
      });
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
  }
}
