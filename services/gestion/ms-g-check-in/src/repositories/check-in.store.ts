import { guardPool } from '@ecoairlines/shared';
import pg from 'pg';
import type { AssistanceReadyRecord, CheckInRecord } from '../domain/boarding.js';

/**
 * Datos de CheckIn (base `check_in`, tabla `check_ins` con PK booking + segmento + pasajero). En memoria (pruebas) o
 * PostgreSQL, con el mismo comportamiento. `lockSegment` serializa los check-ins de un mismo vuelo (posición de abordaje).
 */
export const CHECK_IN_STORE = Symbol('CHECK_IN_STORE');

export interface CheckInTx {
  checkIns(bookingId: string): Promise<CheckInRecord[]>;
  countOnSegment(segmentId: string): Promise<number>;
  onSegment(segmentId: string): Promise<CheckInRecord[]>;
  /** `false` si ese pasajero ya tiene check-in en ese segmento. */
  insert(record: CheckInRecord): Promise<boolean>;
  deleteBySaga(bookingId: string, sagaId: string): Promise<void>;
  /**
   * Anula check-ins (K-1, D56): los pasa a `voided_check_ins` con quién y por qué; dejan de existir para los pases, la lista del
   * vuelo y los duplicados, y el pasajero puede volver a hacer check-in. Sin `segmentIds`/`passengerIds`, toda la reserva.
   * Devuelve cuántos anuló.
   */
  voidCheckIns(bookingId: string, voidSagaId: string, filter: { segmentIds?: string[]; passengerIds?: string[] }, reason: string, at: string): Promise<number>;
  /** ¿Esa saga ya anuló algo de la reserva? (idempotencia). */
  voidedBySaga(bookingId: string, voidSagaId: string): Promise<number>;
  /** Compensación de `voidCheckIns`: vuelven a `check_ins` los que anuló esa saga. */
  restoreVoided(bookingId: string, voidSagaId: string): Promise<void>;
  lockSegment(segmentId: string): Promise<void>;
  assistanceReady(bookingId: string): Promise<AssistanceReadyRecord[]>;
  readyOnSegment(segmentId: string): Promise<number>;
  saveAssistanceReady(record: AssistanceReadyRecord): Promise<void>;
}

export interface CheckInStore {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  transaction<T>(work: (tx: CheckInTx) => Promise<T>): Promise<T>;
}

const key = (r: Pick<CheckInRecord, 'bookingId' | 'segmentId' | 'passengerId'>) => `${r.bookingId}|${r.segmentId}|${r.passengerId}`;
const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryCheckInStore implements CheckInStore {
  readonly kind = 'memory' as const;
  private readonly rows = new Map<string, CheckInRecord>();
  private readonly voided = new Map<string, { record: CheckInRecord; voidSagaId: string; reason: string; voidedAt: string }>();
  private readonly ready = new Map<string, AssistanceReadyRecord>();
  private queue: Promise<unknown> = Promise.resolve();

  async init(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}

  transaction<T>(work: (tx: CheckInTx) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const undo: (() => void)[] = [];
      const set = <V>(map: Map<string, V>, k: string, value: V | undefined) => {
        const had = map.has(k);
        const previous = map.get(k);
        undo.push(() => (had ? map.set(k, previous!) : map.delete(k)));
        if (value === undefined) map.delete(k);
        else map.set(k, clone(value));
      };
      try {
        return await work({
          checkIns: async (bookingId) => clone([...this.rows.values()].filter((r) => r.bookingId === bookingId)),
          // La mayor posición dada en el vuelo (también a check-ins anulados): anular uno nunca repite una posición.
          countOnSegment: async (segmentId) =>
            Math.max(0, ...[...this.rows.values(), ...[...this.voided.values()].map((v) => v.record)].filter((r) => r.segmentId === segmentId).map((r) => r.boardingPosition)),
          onSegment: async (segmentId) => clone([...this.rows.values()].filter((r) => r.segmentId === segmentId)),
          insert: async (record) => {
            if (this.rows.has(key(record))) return false;
            set(this.rows, key(record), record);
            return true;
          },
          deleteBySaga: async (bookingId, sagaId) => {
            for (const [k, r] of this.rows) if (r.bookingId === bookingId && r.sagaId === sagaId) set(this.rows, k, undefined);
          },
          voidCheckIns: async (bookingId, voidSagaId, filter, reason, at) => {
            let count = 0;
            for (const [k, r] of this.rows) {
              if (r.bookingId !== bookingId || (filter.segmentIds && !filter.segmentIds.includes(r.segmentId)) || (filter.passengerIds && !filter.passengerIds.includes(r.passengerId))) continue;
              set(this.rows, k, undefined);
              set(this.voided, `${k}|${voidSagaId}`, { record: r, voidSagaId, reason, voidedAt: at });
              count++;
            }
            return count;
          },
          voidedBySaga: async (bookingId, voidSagaId) => [...this.voided.values()].filter((v) => v.record.bookingId === bookingId && v.voidSagaId === voidSagaId).length,
          restoreVoided: async (bookingId, voidSagaId) => {
            for (const [k, v] of this.voided) {
              if (v.record.bookingId !== bookingId || v.voidSagaId !== voidSagaId) continue;
              set(this.voided, k, undefined);
              set(this.rows, key(v.record), v.record);
            }
          },
          lockSegment: async () => undefined,
          assistanceReady: async (bookingId) => clone([...this.ready.values()].filter((r) => r.bookingId === bookingId)),
          readyOnSegment: async (segmentId) => [...this.ready.values()].filter((r) => r.segmentId === segmentId && r.ready).length,
          saveAssistanceReady: async (record) => set(this.ready, key(record), record),
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
CREATE TABLE IF NOT EXISTS check_ins (
  booking_id        uuid NOT NULL,
  segment_id        text NOT NULL,
  passenger_id      text NOT NULL,
  saga_id           uuid NOT NULL,
  pnr               char(6) NOT NULL,
  passenger_type    text NOT NULL,
  first_name        text NOT NULL,
  last_name         text NOT NULL,
  e_ticket_number   text,
  flight_number     text NOT NULL,
  origin            char(3) NOT NULL,
  destination       char(3) NOT NULL,
  departure_at      text NOT NULL,
  cabin_class       text NOT NULL,
  seat              text,
  gate              text,
  needs_assistance  boolean NOT NULL,
  boarding_group    text NOT NULL,
  boarding_position integer NOT NULL,
  checked_in_at     timestamptz NOT NULL,
  PRIMARY KEY (booking_id, segment_id, passenger_id)
);
CREATE INDEX IF NOT EXISTS check_ins_segment_idx ON check_ins (segment_id);
-- K-1 (D56): check-ins anulados (cancelación o cambio de fecha después del check-in). Quedan para la historia; no son pases válidos.
CREATE TABLE IF NOT EXISTS voided_check_ins (
  LIKE check_ins,
  void_saga_id uuid NOT NULL,
  void_reason  text NOT NULL,
  voided_at    timestamptz NOT NULL,
  PRIMARY KEY (booking_id, segment_id, passenger_id, void_saga_id)
);
CREATE INDEX IF NOT EXISTS voided_check_ins_segment_idx ON voided_check_ins (segment_id);
CREATE TABLE IF NOT EXISTS assistance_ready (
  booking_id   uuid NOT NULL,
  segment_id   text NOT NULL,
  passenger_id text NOT NULL,
  ready        boolean NOT NULL,
  updated_by   uuid NOT NULL,
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (booking_id, segment_id, passenger_id)
);
`;

type Row = Record<string, unknown>;
const toRecord = (row: Row): CheckInRecord => ({
  bookingId: String(row['booking_id']),
  segmentId: String(row['segment_id']),
  passengerId: String(row['passenger_id']),
  sagaId: String(row['saga_id']),
  pnr: String(row['pnr']),
  passengerType: row['passenger_type'] as CheckInRecord['passengerType'],
  firstName: String(row['first_name']),
  lastName: String(row['last_name']),
  eTicketNumber: (row['e_ticket_number'] as string | null) ?? null,
  flightNumber: String(row['flight_number']),
  origin: String(row['origin']),
  destination: String(row['destination']),
  departureAt: String(row['departure_at']),
  cabinClass: String(row['cabin_class']),
  seat: (row['seat'] as string | null) ?? null,
  gate: (row['gate'] as string | null) ?? null,
  needsAssistance: Boolean(row['needs_assistance']),
  boardingGroup: String(row['boarding_group']),
  boardingPosition: Number(row['boarding_position']),
  checkedInAt: row['checked_in_at'] instanceof Date ? row['checked_in_at'].toISOString() : String(row['checked_in_at']),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PostgresCheckInStore implements CheckInStore {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = guardPool(new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000 }), 'ms-g-check-in');
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

  async transaction<T>(work: (tx: CheckInTx) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const result = await work({
        checkIns: async (bookingId) => (UUID.test(bookingId) ? (await db.query('SELECT * FROM check_ins WHERE booking_id = $1 ORDER BY segment_id, passenger_id', [bookingId])).rows.map(toRecord) : []),
        // La mayor posición dada en el vuelo (también a check-ins anulados): anular uno nunca repite una posición.
        countOnSegment: async (segmentId) =>
          Number(
            (
              await db.query(
                'SELECT GREATEST((SELECT COALESCE(MAX(boarding_position), 0) FROM check_ins WHERE segment_id = $1), (SELECT COALESCE(MAX(boarding_position), 0) FROM voided_check_ins WHERE segment_id = $1))::int AS n',
                [segmentId],
              )
            ).rows[0].n,
          ),
        onSegment: async (segmentId) => (await db.query('SELECT * FROM check_ins WHERE segment_id = $1', [segmentId])).rows.map(toRecord),
        insert: async (r) =>
          (
            await db.query(
              `INSERT INTO check_ins (booking_id, segment_id, passenger_id, saga_id, pnr, passenger_type, first_name, last_name, e_ticket_number, flight_number,
                 origin, destination, departure_at, cabin_class, seat, gate, needs_assistance, boarding_group, boarding_position, checked_in_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) ON CONFLICT DO NOTHING`,
              [r.bookingId, r.segmentId, r.passengerId, r.sagaId, r.pnr, r.passengerType, r.firstName, r.lastName, r.eTicketNumber, r.flightNumber, r.origin,
                r.destination, r.departureAt, r.cabinClass, r.seat, r.gate, r.needsAssistance, r.boardingGroup, r.boardingPosition, r.checkedInAt],
            )
          ).rowCount === 1,
        deleteBySaga: async (bookingId, sagaId) => {
          if (UUID.test(bookingId) && UUID.test(sagaId)) await db.query('DELETE FROM check_ins WHERE booking_id = $1 AND saga_id = $2', [bookingId, sagaId]);
        },
        voidCheckIns: async (bookingId, voidSagaId, filter, reason, at) => {
          if (!UUID.test(bookingId)) return 0;
          const moved = await db.query(
            `WITH anulados AS (
               DELETE FROM check_ins WHERE booking_id = $1 AND ($2::text[] IS NULL OR segment_id = ANY($2)) AND ($3::text[] IS NULL OR passenger_id = ANY($3))
               RETURNING *
             )
             INSERT INTO voided_check_ins SELECT anulados.*, $4::uuid, $5, $6::timestamptz FROM anulados`,
            [bookingId, filter.segmentIds ?? null, filter.passengerIds ?? null, voidSagaId, reason, at],
          );
          return moved.rowCount ?? 0;
        },
        voidedBySaga: async (bookingId, voidSagaId) =>
          UUID.test(bookingId) && UUID.test(voidSagaId)
            ? Number((await db.query('SELECT count(*)::int AS n FROM voided_check_ins WHERE booking_id = $1 AND void_saga_id = $2', [bookingId, voidSagaId])).rows[0].n)
            : 0,
        restoreVoided: async (bookingId, voidSagaId) => {
          if (!UUID.test(bookingId) || !UUID.test(voidSagaId)) return;
          await db.query(
            `WITH devueltos AS (DELETE FROM voided_check_ins WHERE booking_id = $1 AND void_saga_id = $2 RETURNING *)
             INSERT INTO check_ins (booking_id, segment_id, passenger_id, saga_id, pnr, passenger_type, first_name, last_name, e_ticket_number, flight_number,
               origin, destination, departure_at, cabin_class, seat, gate, needs_assistance, boarding_group, boarding_position, checked_in_at)
             SELECT booking_id, segment_id, passenger_id, saga_id, pnr, passenger_type, first_name, last_name, e_ticket_number, flight_number,
               origin, destination, departure_at, cabin_class, seat, gate, needs_assistance, boarding_group, boarding_position, checked_in_at FROM devueltos
             ON CONFLICT DO NOTHING`,
            [bookingId, voidSagaId],
          );
        },
        // Un candado por vuelo: dos reservas a la vez no reciben la misma posición de abordaje.
        lockSegment: async (segmentId) => {
          await db.query(`SELECT pg_advisory_xact_lock(hashtext('check-in:' || $1))`, [segmentId]);
        },
        assistanceReady: async (bookingId) =>
          UUID.test(bookingId)
            ? (await db.query('SELECT * FROM assistance_ready WHERE booking_id = $1', [bookingId])).rows.map((row: Row) => ({
                bookingId: String(row['booking_id']),
                segmentId: String(row['segment_id']),
                passengerId: String(row['passenger_id']),
                ready: Boolean(row['ready']),
                updatedBy: String(row['updated_by']),
                updatedAt: row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']),
              }))
            : [],
        readyOnSegment: async (segmentId) => Number((await db.query('SELECT count(*)::int AS n FROM assistance_ready WHERE segment_id = $1 AND ready', [segmentId])).rows[0].n),
        saveAssistanceReady: async (r) => {
          await db.query(
            `INSERT INTO assistance_ready (booking_id, segment_id, passenger_id, ready, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (booking_id, segment_id, passenger_id) DO UPDATE SET ready = EXCLUDED.ready, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
            [r.bookingId, r.segmentId, r.passengerId, r.ready, r.updatedBy, r.updatedAt],
          );
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
