import pg from 'pg';
import type { AssistanceRecord, BookingRecord, DocumentClaim, PaymentRecord } from '../domain/model.js';
import { segmentsOf } from '../domain/rules.js';
import type { BookingFilter, BookingsStore, BookingsTx, InsertResult } from './bookings.store.js';

/**
 * PostgreSQL (base `bookings`, usuario `bookings_svc`; D10). La reserva completa va en `bookings.data` (jsonb) con columnas
 * para filtrar; lo que debe ser único en todo el sistema tiene su índice único:
 * - `pnr` y `hold_id` (un hold no se usa en dos reservas: HOLD_ALREADY_CONSUMED);
 * - `payment_records.payment_reference` (una referencia de pago se usa una sola vez: D34);
 * - `passenger_documents (segment_id, identity_key)` (un mismo documento una sola vez por vuelo).
 * La asistencia (dato de salud) va en su propia tabla.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS bookings (
  booking_id uuid PRIMARY KEY,
  pnr        char(6) NOT NULL UNIQUE,
  hold_id    uuid NOT NULL UNIQUE,
  owner_id   text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('WEB', 'BOOKING')),
  partner_id text,
  status     text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  data       jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_owner_idx ON bookings (owner_id, created_at DESC);
-- Búsqueda del panel (O-1): por la orden de Booking o la referencia del pago de la reserva.
CREATE INDEX IF NOT EXISTS bookings_partner_order_idx ON bookings ((data->'salesChannel'->>'partnerOrderId'));
CREATE INDEX IF NOT EXISTS bookings_payment_ref_idx ON bookings ((data->'payment'->>'paymentReference'));
CREATE TABLE IF NOT EXISTS booking_segments (
  booking_id uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  segment_id text NOT NULL,
  PRIMARY KEY (booking_id, segment_id)
);
CREATE INDEX IF NOT EXISTS booking_segments_segment_idx ON booking_segments (segment_id);
CREATE TABLE IF NOT EXISTS payment_records (
  payment_reference text PRIMARY KEY,
  provider          text NOT NULL,
  operation         text NOT NULL,
  amount            jsonb NOT NULL,
  booking_id        uuid,
  saga_id           uuid NOT NULL,
  claimed_at        timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS passenger_documents (
  segment_id   text NOT NULL,
  identity_key text NOT NULL,
  booking_id   uuid NOT NULL,
  PRIMARY KEY (segment_id, identity_key)
);
CREATE INDEX IF NOT EXISTS passenger_documents_booking_idx ON passenger_documents (booking_id);
CREATE TABLE IF NOT EXISTS passenger_assistance (
  booking_id      uuid NOT NULL,
  passenger_id    text NOT NULL,
  type            text NOT NULL,
  needs_companion boolean NOT NULL,
  notes           text,
  status          text NOT NULL CHECK (status IN ('REQUESTED', 'READY')),
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (booking_id, passenger_id)
);
`;

type Row = Record<string, unknown>;
type Db = Pick<pg.PoolClient, 'query'>;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toBooking = (row: Row) => row['data'] as BookingRecord;
const toPayment = (row: Row): PaymentRecord => ({
  paymentReference: String(row['payment_reference']),
  provider: row['provider'] as PaymentRecord['provider'],
  operation: row['operation'] as PaymentRecord['operation'],
  amount: row['amount'] as PaymentRecord['amount'],
  bookingId: (row['booking_id'] as string | null) ?? null,
  sagaId: String(row['saga_id']),
  claimedAt: iso(row['claimed_at']),
});

function where(filter: BookingFilter): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const parts: string[] = [];
  const add = (sql: string, value: unknown) => parts.push(sql.replace('?', `$${values.push(value)}`));
  if (filter.ownerId) add('owner_id = ?', filter.ownerId);
  if (filter.pnr) add('pnr = ?', filter.pnr);
  if (filter.status) add('status = ?', filter.status);
  if (filter.channel) add('channel = ?', filter.channel);
  if (filter.createdFrom) add('created_at >= ?::date', filter.createdFrom);
  if (filter.createdTo) add(`created_at < (?::date + 1)`, filter.createdTo);
  if (filter.reference) {
    const at = values.push(filter.reference);
    parts.push(`(pnr = upper($${at}) OR data->'salesChannel'->>'partnerOrderId' = $${at} OR data->'payment'->>'paymentReference' = $${at})`);
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', values };
}

export class PostgresBookingsStore implements BookingsStore {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000 });
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

  async transaction<T>(work: (tx: BookingsTx) => Promise<T>): Promise<T> {
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

  private async writeSegments(db: Db, booking: BookingRecord): Promise<void> {
    await db.query('DELETE FROM booking_segments WHERE booking_id = $1', [booking.bookingId]);
    for (const segmentId of new Set(segmentsOf(booking).map((segment) => segment.segmentId))) {
      await db.query('INSERT INTO booking_segments (booking_id, segment_id) VALUES ($1, $2)', [booking.bookingId, segmentId]);
    }
  }

  private tx(db: Db): BookingsTx {
    return {
      booking: async (id) => {
        if (!UUID.test(id)) return undefined;
        const { rows } = await db.query('SELECT data FROM bookings WHERE booking_id = $1 FOR UPDATE', [id]);
        return rows[0] ? toBooking(rows[0]) : undefined;
      },
      bookingByHold: async (holdId) => {
        if (!UUID.test(holdId)) return undefined;
        const { rows } = await db.query('SELECT data FROM bookings WHERE hold_id = $1', [holdId]);
        return rows[0] ? toBooking(rows[0]) : undefined;
      },
      insertBooking: async (b): Promise<InsertResult> => {
        // ON CONFLICT DO NOTHING no aborta la transacción; luego se averigua qué índice chocó.
        const result = await db.query(
          `INSERT INTO bookings (booking_id, pnr, hold_id, owner_id, channel, partner_id, status, created_at, updated_at, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
          [b.bookingId, b.pnr, b.holdId, b.ownerId, b.channel, b.partnerId, b.status, b.createdAt, b.updatedAt, JSON.stringify(b)],
        );
        if (result.rowCount === 1) {
          await this.writeSegments(db, b);
          return 'ok';
        }
        const { rows } = await db.query('SELECT booking_id, hold_id FROM bookings WHERE booking_id = $1 OR hold_id = $2 OR pnr = $3', [b.bookingId, b.holdId, b.pnr]);
        if (rows.some((row: Row) => row['booking_id'] === b.bookingId)) return 'id-exists';
        if (rows.some((row: Row) => row['hold_id'] === b.holdId)) return 'hold-taken';
        return 'pnr-taken';
      },
      saveBooking: async (b) => {
        await db.query('UPDATE bookings SET status = $2, updated_at = $3, data = $4 WHERE booking_id = $1', [b.bookingId, b.status, b.updatedAt, JSON.stringify(b)]);
        await this.writeSegments(db, b);
      },
      listBookings: async (filter, limit, offset) => {
        const { sql, values } = where(filter);
        const { rows } = await db.query(`SELECT data FROM bookings ${sql} ORDER BY created_at DESC, booking_id LIMIT ${limit + 1} OFFSET ${offset}`, values);
        return { items: rows.slice(0, limit).map(toBooking), hasMore: rows.length > limit };
      },
      flightBookings: async (segmentId) =>
        (await db.query('SELECT b.data FROM bookings b JOIN booking_segments s ON s.booking_id = b.booking_id WHERE s.segment_id = $1 ORDER BY b.created_at', [segmentId])).rows.map(toBooking),
      bookingsCreatedBetween: async (from, to) => {
        const { sql, values } = where({ createdFrom: from, createdTo: to });
        return (await db.query(`SELECT data FROM bookings ${sql}`, values)).rows.map(toBooking);
      },

      payment: async (reference) => {
        const { rows } = await db.query('SELECT * FROM payment_records WHERE payment_reference = $1', [reference]);
        return rows[0] ? toPayment(rows[0]) : undefined;
      },
      insertPayment: async (p) => {
        const result = await db.query(
          `INSERT INTO payment_records (payment_reference, provider, operation, amount, booking_id, saga_id, claimed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (payment_reference) DO NOTHING`,
          [p.paymentReference, p.provider, p.operation, JSON.stringify(p.amount), p.bookingId, p.sagaId, p.claimedAt],
        );
        return result.rowCount === 1;
      },
      savePayment: async (p) => {
        await db.query('UPDATE payment_records SET booking_id = $2 WHERE payment_reference = $1', [p.paymentReference, p.bookingId]);
      },
      deletePayment: async (reference) => {
        await db.query('DELETE FROM payment_records WHERE payment_reference = $1', [reference]);
      },
      paymentsOf: async (bookingId) =>
        (await db.query('SELECT * FROM payment_records WHERE booking_id = $1 ORDER BY claimed_at', [bookingId])).rows.map(toPayment),

      documentHolders: async (claims) => {
        if (!claims.length) return [];
        const { rows } = await db.query(
          'SELECT * FROM passenger_documents WHERE (segment_id, identity_key) IN (SELECT * FROM unnest($1::text[], $2::text[]))',
          [claims.map((c) => c.segmentId), claims.map((c) => c.identityKey)],
        );
        return rows.map((row: Row) => ({ segmentId: String(row['segment_id']), identityKey: String(row['identity_key']), bookingId: String(row['booking_id']) }));
      },
      claimDocuments: async (claims) => {
        const conflicts: DocumentClaim[] = [];
        for (const claim of claims) {
          const result = await db.query(
            'INSERT INTO passenger_documents (segment_id, identity_key, booking_id) VALUES ($1, $2, $3) ON CONFLICT (segment_id, identity_key) DO NOTHING',
            [claim.segmentId, claim.identityKey, claim.bookingId],
          );
          if (result.rowCount === 0) {
            const { rows } = await db.query('SELECT booking_id FROM passenger_documents WHERE segment_id = $1 AND identity_key = $2', [claim.segmentId, claim.identityKey]);
            const holder = String((rows[0] as Row | undefined)?.['booking_id'] ?? '');
            if (holder !== claim.bookingId) conflicts.push({ ...claim, bookingId: holder });
          }
        }
        // Quien llama lanza un error si hay choques: el ROLLBACK deshace los que sí se insertaron.
        return conflicts;
      },
      releaseDocuments: async (bookingId, segmentIds) => {
        if (segmentIds) await db.query('DELETE FROM passenger_documents WHERE booking_id = $1 AND segment_id = ANY($2)', [bookingId, segmentIds]);
        else await db.query('DELETE FROM passenger_documents WHERE booking_id = $1', [bookingId]);
      },

      assistance: async (bookingId) =>
        (await db.query('SELECT * FROM passenger_assistance WHERE booking_id = $1 ORDER BY passenger_id', [bookingId])).rows.map((row: Row) => ({
          bookingId: String(row['booking_id']),
          passengerId: String(row['passenger_id']),
          type: row['type'] as AssistanceRecord['type'],
          needsCompanion: Boolean(row['needs_companion']),
          ...(row['notes'] ? { notes: String(row['notes']) } : {}),
          status: row['status'] as AssistanceRecord['status'],
          updatedAt: iso(row['updated_at']),
        })),
      saveAssistance: async (a) => {
        await db.query(
          `INSERT INTO passenger_assistance (booking_id, passenger_id, type, needs_companion, notes, status, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (booking_id, passenger_id) DO UPDATE SET type = EXCLUDED.type, needs_companion = EXCLUDED.needs_companion, notes = EXCLUDED.notes,
             status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
          [a.bookingId, a.passengerId, a.type, a.needsCompanion, a.notes ?? null, a.status, a.updatedAt],
        );
      },
      deleteAssistance: async (bookingId, passengerId) => {
        await db.query('DELETE FROM passenger_assistance WHERE booking_id = $1 AND passenger_id = $2', [bookingId, passengerId]);
      },
    };
  }
}
