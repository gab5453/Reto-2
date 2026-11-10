import pg from 'pg';
import type { FlightState, ScheduledFlightRecord, StatusChangeRecord } from '../domain/status.js';

/**
 * Datos de FlightStatus (base `flight_status`): proyección `scheduled_flights`, `overrides` (estado actual por vuelo y fecha),
 * `status_changes` (historial) y los eventos ya aplicados (idempotencia del consumidor). En memoria o PostgreSQL.
 */
export const FLIGHT_STATUS_STORE = Symbol('FLIGHT_STATUS_STORE');

export interface FlightStatusTx {
  flight(flightNumber: string, date: string): Promise<ScheduledFlightRecord | undefined>;
  flightsOn(date: string): Promise<ScheduledFlightRecord[]>;
  /** Reemplaza los vuelos de la proyección en [from, to] (de una ruta, si se indica). */
  replaceFlights(from: string, to: string, routeId: string | undefined, flights: ScheduledFlightRecord[]): Promise<void>;
  /** Bloquea el vuelo hasta el final (los cambios de un mismo vuelo van uno tras otro). */
  state(flightNumber: string, date: string): Promise<FlightState | undefined>;
  saveState(flightNumber: string, date: string, state: FlightState): Promise<void>;
  changes(flightNumber: string, date: string): Promise<StatusChangeRecord[]>;
  change(changeId: string): Promise<StatusChangeRecord | undefined>;
  saveChange(change: StatusChangeRecord): Promise<void>;
  /** `false` si el evento ya se había aplicado. */
  markEventApplied(eventId: string, appliedAt: string): Promise<boolean>;
}

export interface FlightStatusStore {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  transaction<T>(work: (tx: FlightStatusTx) => Promise<T>): Promise<T>;
  projectionUpdatedAt(): Promise<string | null>;
}

const clone = <T>(value: T): T => structuredClone(value);
const key = (flightNumber: string, date: string) => `${flightNumber}|${date}`;
const byDeparture = (a: ScheduledFlightRecord, b: ScheduledFlightRecord) => a.departureAt.localeCompare(b.departureAt) || a.flightNumber.localeCompare(b.flightNumber);

export class InMemoryFlightStatusStore implements FlightStatusStore {
  readonly kind = 'memory' as const;
  private readonly flights = new Map<string, ScheduledFlightRecord>();
  private readonly states = new Map<string, FlightState>();
  private readonly history = new Map<string, StatusChangeRecord>();
  private readonly applied = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  async init(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
  async projectionUpdatedAt(): Promise<string | null> {
    return [...this.applied.values()].sort().at(-1) ?? null;
  }

  transaction<T>(work: (tx: FlightStatusTx) => Promise<T>): Promise<T> {
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
          flight: async (n, d) => clone(this.flights.get(key(n, d))),
          flightsOn: async (date) => clone([...this.flights.values()].filter((f) => f.date === date).sort(byDeparture)),
          replaceFlights: async (from, to, routeId, flights) => {
            for (const [k, f] of this.flights) if (f.date >= from && f.date <= to && (!routeId || f.routeId === routeId)) set(this.flights, k, undefined);
            for (const f of flights) set(this.flights, key(f.flightNumber, f.date), f);
          },
          state: async (n, d) => clone(this.states.get(key(n, d))),
          saveState: async (n, d, state) => set(this.states, key(n, d), state),
          changes: async (n, d) => clone([...this.history.values()].filter((c) => c.flightNumber === n && c.date === d).sort((a, b) => a.changedAt.localeCompare(b.changedAt))),
          change: async (id) => clone(this.history.get(id)),
          saveChange: async (change) => set(this.history, change.changeId, change),
          markEventApplied: async (id, at) => {
            if (this.applied.has(id)) return false;
            set(this.applied, id, at);
            return true;
          },
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
CREATE TABLE IF NOT EXISTS scheduled_flights (
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
  PRIMARY KEY (flight_number, date)
);
CREATE INDEX IF NOT EXISTS scheduled_flights_date_idx ON scheduled_flights (date);
-- M-2: tiempo en tierra del tipo (los vuelos publicados antes no lo tienen: se usa el de la semilla).
ALTER TABLE scheduled_flights ADD COLUMN IF NOT EXISTS turnaround_minutes integer;
CREATE TABLE IF NOT EXISTS overrides (
  flight_number text NOT NULL,
  date          date NOT NULL,
  state         jsonb NOT NULL,
  PRIMARY KEY (flight_number, date)
);
CREATE TABLE IF NOT EXISTS status_changes (
  change_id     uuid PRIMARY KEY,
  flight_number text NOT NULL,
  date          date NOT NULL,
  changed_at    timestamptz NOT NULL,
  reverted      boolean NOT NULL,
  data          jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS status_changes_flight_idx ON status_changes (flight_number, date, changed_at);
CREATE TABLE IF NOT EXISTS applied_events (
  event_id   text PRIMARY KEY,
  applied_at timestamptz NOT NULL
);
`;
type Row = Record<string, unknown>;
const toFlight = (r: Row): ScheduledFlightRecord => ({
  flightNumber: String(r['flight_number']),
  date: String(r['date']),
  routeId: String(r['route_id']),
  origin: String(r['origin']),
  destination: String(r['destination']),
  departureAt: String(r['departure_at']),
  arrivalAt: String(r['arrival_at']),
  aircraftType: String(r['aircraft_type']),
  registration: String(r['registration']),
  ...(r['turnaround_minutes'] === null || r['turnaround_minutes'] === undefined ? {} : { turnaroundMinutes: Number(r['turnaround_minutes']) }),
});

export class PostgresFlightStatusStore implements FlightStatusStore {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    const types = { getTypeParser: (oid: number, format?: 'text' | 'binary') => (oid === 1082 ? (value: string) => value : pg.types.getTypeParser(oid, format)) };
    this.pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000, types: types as pg.CustomTypesConfig });
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
  async projectionUpdatedAt(): Promise<string | null> {
    const { rows } = await this.pool.query('SELECT max(applied_at) AS at FROM applied_events');
    const at = (rows[0] as Row)['at'];
    return at instanceof Date ? at.toISOString() : null;
  }

  async transaction<T>(work: (tx: FlightStatusTx) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const result = await work({
        flight: async (n, d) => (await db.query('SELECT * FROM scheduled_flights WHERE flight_number = $1 AND date = $2', [n, d])).rows.map(toFlight)[0],
        flightsOn: async (date) => (await db.query('SELECT * FROM scheduled_flights WHERE date = $1 ORDER BY departure_utc, flight_number', [date])).rows.map(toFlight),
        replaceFlights: async (from, to, routeId, flights) => {
          if (routeId) await db.query('DELETE FROM scheduled_flights WHERE date BETWEEN $1 AND $2 AND route_id = $3', [from, to, routeId]);
          else await db.query('DELETE FROM scheduled_flights WHERE date BETWEEN $1 AND $2', [from, to]);
          for (const f of flights) {
            await db.query(
              `INSERT INTO scheduled_flights (flight_number, date, route_id, origin, destination, departure_at, departure_utc, arrival_at, aircraft_type, registration, turnaround_minutes)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (flight_number, date) DO UPDATE SET route_id = EXCLUDED.route_id,
                 origin = EXCLUDED.origin, destination = EXCLUDED.destination, departure_at = EXCLUDED.departure_at, departure_utc = EXCLUDED.departure_utc,
                 arrival_at = EXCLUDED.arrival_at, aircraft_type = EXCLUDED.aircraft_type, registration = EXCLUDED.registration, turnaround_minutes = EXCLUDED.turnaround_minutes`,
              [f.flightNumber, f.date, f.routeId, f.origin, f.destination, f.departureAt, new Date(f.departureAt).toISOString(), f.arrivalAt, f.aircraftType, f.registration, f.turnaroundMinutes ?? null],
            );
          }
        },
        state: async (n, d) => {
          // Candado por vuelo y fecha: dos PATCH simultáneos no se saltan la tabla de transiciones.
          await db.query(`SELECT pg_advisory_xact_lock(hashtext('flight:' || $1 || ':' || $2))`, [n, d]);
          return ((await db.query('SELECT state FROM overrides WHERE flight_number = $1 AND date = $2', [n, d])).rows[0] as Row | undefined)?.['state'] as FlightState | undefined;
        },
        saveState: async (n, d, state) => {
          await db.query('INSERT INTO overrides (flight_number, date, state) VALUES ($1, $2, $3) ON CONFLICT (flight_number, date) DO UPDATE SET state = EXCLUDED.state', [n, d, JSON.stringify(state)]);
        },
        changes: async (n, d) => (await db.query('SELECT data FROM status_changes WHERE flight_number = $1 AND date = $2 ORDER BY changed_at, change_id', [n, d])).rows.map((r: Row) => r['data'] as StatusChangeRecord),
        change: async (id) => (/^[0-9a-f-]{36}$/i.test(id) ? ((await db.query('SELECT data FROM status_changes WHERE change_id = $1', [id])).rows[0] as Row | undefined)?.['data'] as StatusChangeRecord | undefined : undefined),
        saveChange: async (c) => {
          await db.query(
            `INSERT INTO status_changes (change_id, flight_number, date, changed_at, reverted, data) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (change_id) DO UPDATE SET reverted = EXCLUDED.reverted, data = EXCLUDED.data`,
            [c.changeId, c.flightNumber, c.date, c.changedAt, c.reverted, JSON.stringify(c)],
          );
        },
        markEventApplied: async (id, at) => (await db.query('INSERT INTO applied_events (event_id, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, at])).rowCount === 1,
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
