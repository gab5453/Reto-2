import type { CloudEvent } from '@ecoairlines/shared';
import pg from 'pg';
import type {
  BookingSeatRecord,
  CabinClass,
  FarePriceRecord,
  FlightRecord,
  HoldRecord,
  InventoryRecord,
  OutboxRecord,
  PromotionRuleRecord,
  StockSyncRecord,
  TakenStatus,
} from '../domain/model.js';
import { TAKEN_STATUSES } from '../domain/model.js';
import { type CupoState, type OffersStore, type OffersTx, SeatTakenError } from './offers.store.js';

/**
 * PostgreSQL (base `offers`, usuario `offers_svc`; D10). Sin duplicados (D34):
 * - cupos: `UPDATE … WHERE <quedan suficientes>` (condicional; dos holds por el último cupo → uno solo gana);
 * - asientos: índice único (segment_id, seat_number) → el segundo recibe SEAT_TAKEN;
 * - holds: el cambio de estado es condicional (`WHERE status = 'HELD'`): nunca se liberan ni se consumen dos veces.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS flights_for_sale (
  segment_id    text PRIMARY KEY,
  flight_number text NOT NULL,
  date          date NOT NULL,
  route_id      text NOT NULL,
  origin        char(3) NOT NULL,
  destination   char(3) NOT NULL,
  departure_at  text NOT NULL,
  departure_utc timestamptz NOT NULL,
  arrival_at    text NOT NULL,
  aircraft_type text NOT NULL,
  registration  text NOT NULL,
  on_sale       boolean NOT NULL DEFAULT true,
  closed_reason text
);
CREATE INDEX IF NOT EXISTS flights_for_sale_date_idx ON flights_for_sale (date, origin);
CREATE TABLE IF NOT EXISTS inventory (
  segment_id  text NOT NULL REFERENCES flights_for_sale(segment_id) ON DELETE CASCADE,
  cabin_class text NOT NULL,
  total       integer NOT NULL CHECK (total >= 0),
  held        integer NOT NULL DEFAULT 0 CHECK (held >= 0),
  booked      integer NOT NULL DEFAULT 0 CHECK (booked >= 0),
  ticketed    integer NOT NULL DEFAULT 0 CHECK (ticketed >= 0),
  checked_in  integer NOT NULL DEFAULT 0 CHECK (checked_in >= 0),
  boarded     integer NOT NULL DEFAULT 0 CHECK (boarded >= 0),
  PRIMARY KEY (segment_id, cabin_class),
  -- Nunca más cupos tomados que asientos: la última barrera contra la sobreventa.
  CHECK (held + booked + ticketed + checked_in + boarded <= total)
);
CREATE TABLE IF NOT EXISTS booking_seats (
  id           uuid PRIMARY KEY,
  booking_id   text NOT NULL,
  segment_id   text NOT NULL,
  cabin_class  text NOT NULL,
  status       text NOT NULL CHECK (status IN ('HELD', 'BOOKED', 'TICKETED', 'CHECKED_IN', 'BOARDED')),
  passenger_id text,
  seat_number  text
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_seats_seat_uidx ON booking_seats (segment_id, seat_number) WHERE seat_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS booking_seats_booking_idx ON booking_seats (booking_id);
CREATE TABLE IF NOT EXISTS holds (
  hold_id     uuid PRIMARY KEY,
  owner_id    text NOT NULL,
  channel     text NOT NULL,
  status      text NOT NULL CHECK (status IN ('HELD', 'RELEASED', 'EXPIRED', 'CONSUMED')),
  offer_id    text NOT NULL,
  data        jsonb NOT NULL,
  ttl_minutes integer NOT NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  booking_id  text
);
CREATE INDEX IF NOT EXISTS holds_due_idx ON holds (expires_at) WHERE status = 'HELD';
CREATE TABLE IF NOT EXISTS hold_segments (
  hold_id    uuid NOT NULL REFERENCES holds(hold_id) ON DELETE CASCADE,
  segment_id text NOT NULL,
  PRIMARY KEY (hold_id, segment_id)
);
CREATE INDEX IF NOT EXISTS hold_segments_segment_idx ON hold_segments (segment_id);
CREATE TABLE IF NOT EXISTS fare_prices (
  cabin_class text NOT NULL,
  fare_brand  text NOT NULL,
  multiplier  numeric(6, 3) NOT NULL,
  PRIMARY KEY (cabin_class, fare_brand)
);
CREATE TABLE IF NOT EXISTS promotion_rules (
  partner_id              text PRIMARY KEY,
  allows_promotions       boolean NOT NULL,
  max_discount_percentage numeric(5, 2) NOT NULL,
  routes                  text[] NOT NULL,
  cabins                  text[] NOT NULL,
  valid_until             date
);
CREATE TABLE IF NOT EXISTS saga_results (
  key        text PRIMARY KEY,
  result     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox (
  id           uuid PRIMARY KEY,
  type         text NOT NULL,
  event        jsonb NOT NULL,
  owner_id     text,
  created_at   timestamptz NOT NULL,
  published_at timestamptz
);
CREATE TABLE IF NOT EXISTS stock_sync (
  segment_id      text NOT NULL,
  cabin_class     text NOT NULL,
  flight_number   text NOT NULL,
  date            date NOT NULL,
  time_slot       char(5) NOT NULL,
  units           integer NOT NULL,
  version         bigint NOT NULL DEFAULT 1,
  pending         boolean NOT NULL DEFAULT true,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  pushed_units    integer,
  pushed_at       timestamptz,
  correlation_id  text,
  PRIMARY KEY (segment_id, cabin_class)
);
CREATE INDEX IF NOT EXISTS stock_sync_pending_idx ON stock_sync (next_attempt_at) WHERE pending;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS owner_id text;
-- V2.11: relé del outbox (orden de llegada y plazo de la réplica que lo publica).
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS seq bigserial;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS lease_until timestamptz;
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (seq) WHERE published_at IS NULL;
`;

type Row = Record<string, unknown>;
type Db = Pick<pg.PoolClient, 'query'>;
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const COLUMN: Record<TakenStatus, string> = { HELD: 'held', BOOKED: 'booked', TICKETED: 'ticketed', CHECKED_IN: 'checked_in', BOARDED: 'boarded' };

const toFlight = (row: Row): FlightRecord => ({
  segmentId: String(row['segment_id']),
  flightNumber: String(row['flight_number']),
  date: String(row['date']),
  routeId: String(row['route_id']),
  origin: String(row['origin']),
  destination: String(row['destination']),
  departureAt: String(row['departure_at']),
  arrivalAt: String(row['arrival_at']),
  aircraftType: row['aircraft_type'] as FlightRecord['aircraftType'],
  registration: String(row['registration']),
  onSale: Boolean(row['on_sale']),
  closedReason: (row['closed_reason'] as string | null) ?? null,
});

const toInventory = (row: Row): InventoryRecord => ({
  segmentId: String(row['segment_id']),
  cabinClass: row['cabin_class'] as CabinClass,
  total: Number(row['total']),
  counts: Object.fromEntries(TAKEN_STATUSES.map((status) => [status, Number(row[COLUMN[status]])])) as InventoryRecord['counts'],
});

const toSeat = (row: Row): BookingSeatRecord => ({
  id: String(row['id']),
  bookingId: String(row['booking_id']),
  segmentId: String(row['segment_id']),
  cabinClass: row['cabin_class'] as CabinClass,
  status: row['status'] as TakenStatus,
  passengerId: (row['passenger_id'] as string | null) ?? null,
  seatNumber: (row['seat_number'] as string | null) ?? null,
});

const toHold = (row: Row): HoldRecord => ({
  ...(row['data'] as Omit<HoldRecord, 'holdId' | 'status' | 'bookingId'>),
  holdId: String(row['hold_id']),
  status: row['status'] as HoldRecord['status'],
  bookingId: (row['booking_id'] as string | null) ?? null,
});

const toStock = (row: Row): StockSyncRecord => ({
  segmentId: String(row['segment_id']),
  cabinClass: row['cabin_class'] as CabinClass,
  flightNumber: String(row['flight_number']),
  date: String(row['date']),
  timeSlot: String(row['time_slot']),
  units: Number(row['units']),
  version: Number(row['version']),
  pending: Boolean(row['pending']),
  attempts: Number(row['attempts']),
  nextAttemptAt: iso(row['next_attempt_at']),
  lastError: (row['last_error'] as string | null) ?? null,
  pushedUnits: row['pushed_units'] === null ? null : Number(row['pushed_units']),
  pushedAt: row['pushed_at'] ? iso(row['pushed_at']) : null,
  correlationId: (row['correlation_id'] as string | null) ?? null,
});

export class PostgresOffersStore implements OffersStore {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    // `date` (OID 1082) como texto YYYY-MM-DD: sin convertirlo a la zona horaria del proceso.
    const types = { getTypeParser: (oid: number, format?: 'text' | 'binary') => (oid === 1082 ? (value: string) => value : pg.types.getTypeParser(oid, format)) };
    this.pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000, types: types as pg.CustomTypesConfig });
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

  async transaction<T>(work: (tx: OffersTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(this.tx(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async dueHolds(now: string, limit: number): Promise<string[]> {
    const { rows } = await this.pool.query(`SELECT hold_id FROM holds WHERE status = 'HELD' AND expires_at <= $1 ORDER BY expires_at LIMIT $2`, [now, limit]);
    return rows.map((row: Row) => String(row['hold_id']));
  }

  async pendingStock(now: string, limit: number): Promise<StockSyncRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM stock_sync WHERE pending AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT $2', [now, limit]);
    return rows.map(toStock);
  }

  async markStockPushed(segmentId: string, cabinClass: CabinClass, version: number, at: string): Promise<void> {
    await this.pool.query(
      `UPDATE stock_sync SET pending = false, attempts = 0, pushed_units = units, pushed_at = $4, last_error = NULL
       WHERE segment_id = $1 AND cabin_class = $2 AND version = $3`,
      [segmentId, cabinClass, version, at],
    );
  }

  async markStockFailed(segmentId: string, cabinClass: CabinClass, version: number, error: string, nextAttemptAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE stock_sync SET attempts = attempts + 1, last_error = $4, next_attempt_at = $5 WHERE segment_id = $1 AND cabin_class = $2 AND version = $3`,
      [segmentId, cabinClass, version, error.slice(0, 500), nextAttemptAt],
    );
  }

  async stats(today: string) {
    const { rows } = await this.pool.query(
      `SELECT (SELECT count(*) FROM holds WHERE status = 'HELD')::int AS holds,
              (SELECT count(*) FROM flights_for_sale WHERE date = $1 AND on_sale)::int AS flights,
              (SELECT max(pushed_at) FROM stock_sync) AS last_push,
              (SELECT count(*) FROM stock_sync WHERE pending)::int AS pending`,
      [today],
    );
    const row = rows[0] as Row;
    return {
      activeHolds: Number(row['holds']),
      flightsOnSaleToday: Number(row['flights']),
      ...(row['last_push'] ? { lastStockPushAt: iso(row['last_push']) } : {}),
      pendingStockPushes: Number(row['pending']),
    };
  }

  async claimOutbox(limit: number, leaseMs: number) {
    const { rows } = await this.pool.query(
      `UPDATE outbox SET lease_until = now() + ($2::int * interval '1 millisecond')
       WHERE id IN (SELECT id FROM outbox WHERE published_at IS NULL AND (lease_until IS NULL OR lease_until <= now()) ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, event, owner_id, seq`,
      [limit, leaseMs],
    );
    return rows
      .sort((a: Row, b: Row) => Number(a['seq']) - Number(b['seq']))
      .map((row: Row) => ({ id: String(row['id']), event: row['event'] as CloudEvent, ownerId: (row['owner_id'] as string | null) ?? null }));
  }

  async markOutboxPublished(id: string, publishedAt: string) {
    await this.pool.query('UPDATE outbox SET published_at = $2, lease_until = NULL WHERE id = $1', [id, publishedAt]);
  }

  async outbox(): Promise<OutboxRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM outbox ORDER BY created_at');
    return rows.map((row: Row) => ({ id: String(row['id']), type: String(row['type']), event: row['event'], ownerId: (row['owner_id'] as string | null) ?? null, createdAt: iso(row['created_at']), publishedAt: row['published_at'] ? iso(row['published_at']) : null }));
  }

  private tx(db: Db): OffersTx {
    const flights = async (sql: string, values: unknown[]) => (await db.query(`SELECT * FROM flights_for_sale ${sql} ORDER BY departure_utc, flight_number`, values)).rows.map(toFlight);
    return {
      flight: async (segmentId) => (await flights('WHERE segment_id = $1', [segmentId]))[0],
      flightsOn: (date) => flights('WHERE date = $1', [date]),
      flightsInRange: (from, to, routeId) =>
        routeId ? flights('WHERE date BETWEEN $1 AND $2 AND route_id = $3', [from, to, routeId]) : flights('WHERE date BETWEEN $1 AND $2', [from, to]),
      flightsByNumbers: (numbers, fromDate) => flights('WHERE flight_number = ANY($1) AND date >= $2', [numbers, fromDate]),
      saveFlight: async (f) => {
        await db.query(
          `INSERT INTO flights_for_sale (segment_id, flight_number, date, route_id, origin, destination, departure_at, departure_utc, arrival_at, aircraft_type, registration, on_sale, closed_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (segment_id) DO UPDATE SET route_id = EXCLUDED.route_id, origin = EXCLUDED.origin, destination = EXCLUDED.destination,
             departure_at = EXCLUDED.departure_at, departure_utc = EXCLUDED.departure_utc, arrival_at = EXCLUDED.arrival_at,
             aircraft_type = EXCLUDED.aircraft_type, registration = EXCLUDED.registration, on_sale = EXCLUDED.on_sale, closed_reason = EXCLUDED.closed_reason`,
          [f.segmentId, f.flightNumber, f.date, f.routeId, f.origin, f.destination, f.departureAt, new Date(f.departureAt).toISOString(), f.arrivalAt, f.aircraftType, f.registration, f.onSale, f.closedReason ?? null],
        );
      },
      deleteFlight: async (segmentId) => {
        await db.query('DELETE FROM flights_for_sale WHERE segment_id = $1', [segmentId]);
      },

      inventory: async (segmentId) => (await db.query('SELECT * FROM inventory WHERE segment_id = $1 ORDER BY cabin_class DESC', [segmentId])).rows.map(toInventory),
      saveInventory: async (r) => {
        await db.query(
          `INSERT INTO inventory (segment_id, cabin_class, total, held, booked, ticketed, checked_in, boarded) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (segment_id, cabin_class) DO UPDATE SET total = EXCLUDED.total, held = EXCLUDED.held, booked = EXCLUDED.booked,
             ticketed = EXCLUDED.ticketed, checked_in = EXCLUDED.checked_in, boarded = EXCLUDED.boarded`,
          [r.segmentId, r.cabinClass, r.total, r.counts.HELD, r.counts.BOOKED, r.counts.TICKETED, r.counts.CHECKED_IN, r.counts.BOARDED],
        );
      },
      moveCupos: async (segmentId, cabinClass, from: CupoState, to: CupoState, count) => {
        const sets = [
          ...(from !== 'AVAILABLE' ? [`${COLUMN[from]} = ${COLUMN[from]} - $3`] : []),
          ...(to !== 'AVAILABLE' ? [`${COLUMN[to]} = ${COLUMN[to]} + $3`] : []),
        ];
        if (!sets.length) return true;
        const condition = from === 'AVAILABLE' ? 'total - (held + booked + ticketed + checked_in + boarded) >= $3' : `${COLUMN[from]} >= $3`;
        const result = await db.query(`UPDATE inventory SET ${sets.join(', ')} WHERE segment_id = $1 AND cabin_class = $2 AND ${condition}`, [segmentId, cabinClass, count]);
        return result.rowCount === 1;
      },

      bookingSeats: async (bookingId) => (await db.query('SELECT * FROM booking_seats WHERE booking_id = $1 ORDER BY segment_id, passenger_id', [bookingId])).rows.map(toSeat),
      assignedSeats: async (segmentId) => (await db.query('SELECT * FROM booking_seats WHERE segment_id = $1 AND seat_number IS NOT NULL', [segmentId])).rows.map(toSeat),
      insertBookingSeat: async (s) => {
        const result = await db.query(
          `INSERT INTO booking_seats (id, booking_id, segment_id, cabin_class, status, passenger_id, seat_number) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (segment_id, seat_number) WHERE seat_number IS NOT NULL DO NOTHING`,
          [s.id, s.bookingId, s.segmentId, s.cabinClass, s.status, s.passengerId, s.seatNumber],
        );
        return result.rowCount === 1;
      },
      updateBookingSeat: async (s) => {
        try {
          await db.query('UPDATE booking_seats SET status = $2, passenger_id = $3, seat_number = $4 WHERE id = $1', [s.id, s.status, s.passengerId, s.seatNumber]);
        } catch (error) {
          // Índice único: otro cliente tomó ese asiento (la transacción queda abortada y se revierte entera).
          if ((error as { code?: string }).code === '23505') throw new SeatTakenError(s.segmentId, s.seatNumber!);
          throw error;
        }
      },
      deleteBookingSeats: async (ids) => {
        if (ids.length) await db.query('DELETE FROM booking_seats WHERE id = ANY($1::uuid[])', [ids]);
      },

      hold: async (holdId) => {
        if (!/^[0-9a-f-]{36}$/i.test(holdId)) return undefined;
        const { rows } = await db.query('SELECT * FROM holds WHERE hold_id = $1 FOR UPDATE', [holdId]);
        return rows[0] ? toHold(rows[0]) : undefined;
      },
      insertHold: async (h) => {
        const { holdId, status, bookingId, ...data } = h;
        await db.query(
          `INSERT INTO holds (hold_id, owner_id, channel, status, offer_id, data, ttl_minutes, created_at, expires_at, booking_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [holdId, h.ownerId, h.channel, status, h.offerId, JSON.stringify(data), h.ttlMinutes, h.createdAt, h.expiresAt, bookingId ?? null],
        );
        for (const segmentId of new Set(h.selections.flatMap((selection) => selection.segmentIds))) {
          await db.query('INSERT INTO hold_segments (hold_id, segment_id) VALUES ($1, $2)', [holdId, segmentId]);
        }
      },
      updateHoldIf: async (holdId, expected, patch) => {
        const result = await db.query(
          'UPDATE holds SET status = coalesce($3, status), booking_id = coalesce($4, booking_id) WHERE hold_id = $1 AND status = $2',
          [holdId, expected, patch.status ?? null, patch.bookingId ?? null],
        );
        return result.rowCount === 1;
      },
      activeHoldsOn: async (segmentId) =>
        (await db.query(`SELECT h.* FROM holds h JOIN hold_segments s ON s.hold_id = h.hold_id WHERE s.segment_id = $1 AND h.status = 'HELD'`, [segmentId])).rows.map(toHold),

      farePrices: async () =>
        (await db.query('SELECT * FROM fare_prices')).rows.map((row: Row) => ({ cabinClass: row['cabin_class'] as CabinClass, fareBrand: String(row['fare_brand']), multiplier: Number(row['multiplier']) })),
      replaceFarePrices: async (prices: FarePriceRecord[]) => {
        await db.query('DELETE FROM fare_prices');
        for (const p of prices) await db.query('INSERT INTO fare_prices (cabin_class, fare_brand, multiplier) VALUES ($1, $2, $3)', [p.cabinClass, p.fareBrand, p.multiplier]);
      },
      promotionRule: async (partnerId) => {
        const { rows } = await db.query('SELECT * FROM promotion_rules WHERE partner_id = $1', [partnerId]);
        const row = rows[0] as Row | undefined;
        return row
          ? {
              partnerId: String(row['partner_id']),
              allowsPromotions: Boolean(row['allows_promotions']),
              maxDiscountPercentage: Number(row['max_discount_percentage']),
              routes: row['routes'] as string[],
              cabins: row['cabins'] as CabinClass[],
              validUntil: (row['valid_until'] as string | null) ?? null,
            }
          : undefined;
      },
      replacePromotionRules: async (rules: PromotionRuleRecord[]) => {
        await db.query('DELETE FROM promotion_rules');
        for (const r of rules) {
          await db.query(
            'INSERT INTO promotion_rules (partner_id, allows_promotions, max_discount_percentage, routes, cabins, valid_until) VALUES ($1, $2, $3, $4, $5, $6)',
            [r.partnerId, r.allowsPromotions, r.maxDiscountPercentage, r.routes, r.cabins, r.validUntil ?? null],
          );
        }
      },

      sagaResult: async <T>(key: string) => {
        const { rows } = await db.query('SELECT result FROM saga_results WHERE key = $1', [key]);
        return (rows[0] as Row | undefined)?.['result'] as T | undefined;
      },
      saveSagaResult: async (key, result) => {
        await db.query('INSERT INTO saga_results (key, result) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(result)]);
      },
      addOutbox: async (o) => {
        await db.query('INSERT INTO outbox (id, type, event, owner_id, created_at) VALUES ($1, $2, $3, $4, $5)', [o.id, o.type, JSON.stringify(o.event), o.ownerId ?? null, o.createdAt]);
      },
      markStock: async (s) => {
        await db.query(
          `INSERT INTO stock_sync (segment_id, cabin_class, flight_number, date, time_slot, units, correlation_id, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (segment_id, cabin_class) DO UPDATE SET units = EXCLUDED.units, correlation_id = EXCLUDED.correlation_id,
             time_slot = EXCLUDED.time_slot, version = stock_sync.version + 1, pending = true, attempts = 0, next_attempt_at = now()`,
          [s.segmentId, s.cabinClass, s.flightNumber, s.date, s.timeSlot, s.units, s.correlationId ?? null],
        );
      },
    };
  }
}
