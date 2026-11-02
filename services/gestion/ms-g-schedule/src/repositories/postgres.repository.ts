import pg from 'pg';
import type {
  AircraftRecord,
  AircraftType,
  CabinClass,
  FareBrand,
  FarePriceRecord,
  PriceChangeRecord,
  PromotionAgreementRecord,
  RouteRecord,
  ScheduleChanges,
  ScheduleState,
  Source,
} from '../domain/model.js';
import type { Weekday } from '../domain/timetable.js';
import { encodeCursor, type Page, type PriceWork, type ScheduleRepository, type ScheduleWork } from './schedule.repository.js';

/**
 * PostgreSQL (base `schedule`, usuario `schedule_svc`; D10). Tablas del modelo conceptual v4. Se crean al arrancar.
 * `schedule_meta.version` sube con cada cambio de rutas o flota (las réplicas saben si su horario en caché está viejo).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedule_meta (
  id      smallint PRIMARY KEY CHECK (id = 1),
  version bigint NOT NULL
);
INSERT INTO schedule_meta (id, version) VALUES (1, 0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS aircraft (
  registration  text PRIMARY KEY,
  aircraft_type text NOT NULL,
  base          char(3) NOT NULL,
  source        text NOT NULL CHECK (source IN ('NETWORK', 'ADMIN')),
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  updated_by    uuid
);
CREATE TABLE IF NOT EXISTS scheduled_routes (
  route_id           text PRIMARY KEY,
  origin             char(3) NOT NULL,
  destination        char(3) NOT NULL,
  outbound_flight    text NOT NULL UNIQUE,
  outbound_departure char(5) NOT NULL,
  inbound_flight     text NOT NULL UNIQUE,
  inbound_departure  char(5) NOT NULL,
  weekdays           smallint[] NOT NULL,
  aircraft_type      text NOT NULL,
  source             text NOT NULL CHECK (source IN ('NETWORK', 'ADMIN')),
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  updated_by         uuid
);
CREATE TABLE IF NOT EXISTS route_aircraft (
  route_id     text NOT NULL REFERENCES scheduled_routes(route_id) ON DELETE CASCADE,
  position     smallint NOT NULL,
  registration text NOT NULL REFERENCES aircraft(registration),
  PRIMARY KEY (route_id, position)
);
CREATE TABLE IF NOT EXISTS fare_class_prices (
  cabin_class          text NOT NULL,
  fare_brand           text NOT NULL,
  reference_multiplier numeric(6, 3) NOT NULL,
  multiplier           numeric(6, 3) NOT NULL CHECK (multiplier BETWEEN 0.5 AND 10),
  updated_at           timestamptz NOT NULL,
  updated_by           uuid,
  PRIMARY KEY (cabin_class, fare_brand)
);
CREATE TABLE IF NOT EXISTS price_changes (
  id             uuid PRIMARY KEY,
  cabin_class    text NOT NULL,
  fare_brand     text NOT NULL,
  old_multiplier numeric(6, 3) NOT NULL,
  new_multiplier numeric(6, 3) NOT NULL,
  changed_by     uuid NOT NULL,
  changed_at     timestamptz NOT NULL,
  FOREIGN KEY (cabin_class, fare_brand) REFERENCES fare_class_prices(cabin_class, fare_brand)
);
CREATE INDEX IF NOT EXISTS price_changes_changed_at_idx ON price_changes (changed_at DESC, id);
CREATE TABLE IF NOT EXISTS promotion_agreements (
  partner_id              text PRIMARY KEY,
  allows_promotions       boolean NOT NULL,
  max_discount_percentage numeric(5, 2) NOT NULL CHECK (max_discount_percentage BETWEEN 0 AND 50),
  enabled_destinations    text[],
  enabled_routes          text[],
  enabled_cabins          text[],
  valid_until             date,
  combo_conditions        text,
  updated_at              timestamptz NOT NULL,
  updated_by              uuid
);
`;

type Row = Record<string, unknown>;
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const audit = (row: Row) => ({
  source: row['source'] as Source,
  createdAt: iso(row['created_at']),
  updatedAt: iso(row['updated_at']),
  updatedBy: (row['updated_by'] as string | null) ?? null,
});

function toAircraft(row: Row): AircraftRecord {
  return { registration: String(row['registration']), aircraftType: row['aircraft_type'] as AircraftType, base: String(row['base']), ...audit(row) };
}

function toRoute(row: Row, aircraft: string[]): RouteRecord {
  return {
    routeId: String(row['route_id']),
    origin: String(row['origin']),
    destination: String(row['destination']),
    outbound: { flightNumber: String(row['outbound_flight']), departureLocal: String(row['outbound_departure']) },
    inbound: { flightNumber: String(row['inbound_flight']), departureLocal: String(row['inbound_departure']) },
    weekdays: (row['weekdays'] as number[]).map(Number) as Weekday[],
    aircraftType: row['aircraft_type'] as AircraftType,
    aircraft,
    ...audit(row),
  };
}

function toPrice(row: Row): FarePriceRecord {
  return {
    cabinClass: row['cabin_class'] as CabinClass,
    fareBrand: row['fare_brand'] as FareBrand,
    referenceMultiplier: Number(row['reference_multiplier']),
    multiplier: Number(row['multiplier']),
    updatedAt: iso(row['updated_at']),
    updatedBy: (row['updated_by'] as string | null) ?? null,
  };
}

/** Los campos opcionales del acuerdo que no se enviaron se guardan como NULL y no aparecen en la respuesta. */
function toAgreement(row: Row): PromotionAgreementRecord {
  const optional = <K extends string>(key: K, value: unknown) => (value === null || value === undefined ? {} : { [key]: value });
  const date = row['valid_until'];
  return {
    partnerId: String(row['partner_id']),
    permite_promociones: Boolean(row['allows_promotions']),
    porcentaje_descuento_maximo: Number(row['max_discount_percentage']),
    ...optional('destinos_habilitados', row['enabled_destinations']),
    ...optional('rutas_habilitadas', row['enabled_routes']),
    ...optional('cabinas_habilitadas', row['enabled_cabins']),
    ...optional('vigencia_hasta', date instanceof Date ? date.toISOString().slice(0, 10) : date),
    ...optional('condiciones_combo', row['combo_conditions']),
    updatedAt: iso(row['updated_at']),
    updatedBy: (row['updated_by'] as string | null) ?? null,
  };
}

type Queryable = Pick<pg.PoolClient, 'query'>;

export class PostgresScheduleRepository implements ScheduleRepository {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    // `date` (OID 1082) como texto YYYY-MM-DD: sin convertirlo a la zona horaria del proceso.
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

  async loadState(): Promise<ScheduleState> {
    return this.readState(this.pool);
  }

  async version(): Promise<number> {
    const { rows } = await this.pool.query('SELECT version FROM schedule_meta WHERE id = 1');
    return Number((rows[0] as Row | undefined)?.['version'] ?? 0);
  }

  async changeSchedule<T>(work: ScheduleWork<T>): Promise<T> {
    return this.transaction(async (client) => {
      // Un candado para todos los cambios de rutas y flota: el estado leído no cambia hasta el COMMIT.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('schedule:changes'))`);
      const { changes, result } = work(await this.readState(client));
      await this.apply(client, changes);
      return result;
    });
  }

  async seedSchedule(state: ScheduleState): Promise<boolean> {
    return this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('schedule:changes'))`);
      const { rows } = await client.query('SELECT (SELECT count(*) FROM aircraft) + (SELECT count(*) FROM scheduled_routes) AS n');
      if (Number((rows[0] as Row)['n']) > 0) return false;
      await this.apply(client, { saveAircraft: state.fleet, saveRoutes: state.routes });
      return true;
    });
  }

  async listPrices(): Promise<FarePriceRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM fare_class_prices ORDER BY cabin_class DESC, reference_multiplier');
    return rows.map(toPrice);
  }

  async seedPrices(prices: FarePriceRecord[]): Promise<void> {
    for (const p of prices) {
      await this.pool.query(
        `INSERT INTO fare_class_prices (cabin_class, fare_brand, reference_multiplier, multiplier, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [p.cabinClass, p.fareBrand, p.referenceMultiplier, p.multiplier, p.updatedAt, p.updatedBy],
      );
    }
  }

  async changePrices(work: PriceWork): Promise<FarePriceRecord[]> {
    await this.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM fare_class_prices FOR UPDATE');
      const { updated, history } = work(rows.map(toPrice));
      for (const p of updated) {
        await client.query('UPDATE fare_class_prices SET multiplier = $3, updated_at = $4, updated_by = $5 WHERE cabin_class = $1 AND fare_brand = $2', [
          p.cabinClass,
          p.fareBrand,
          p.multiplier,
          p.updatedAt,
          p.updatedBy,
        ]);
      }
      for (const h of history) {
        await client.query(
          `INSERT INTO price_changes (id, cabin_class, fare_brand, old_multiplier, new_multiplier, changed_by, changed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [h.id, h.cabinClass, h.fareBrand, h.oldMultiplier, h.newMultiplier, h.changedBy, h.changedAt],
        );
      }
    });
    return this.listPrices();
  }

  async listPriceChanges(limit: number, offset: number): Promise<Page<PriceChangeRecord>> {
    const { rows } = await this.pool.query('SELECT * FROM price_changes ORDER BY changed_at DESC, id LIMIT $1 OFFSET $2', [limit + 1, offset]);
    const items = rows.slice(0, limit).map((row: Row) => ({
      id: String(row['id']),
      cabinClass: row['cabin_class'] as CabinClass,
      fareBrand: row['fare_brand'] as FareBrand,
      oldMultiplier: Number(row['old_multiplier']),
      newMultiplier: Number(row['new_multiplier']),
      changedBy: String(row['changed_by']),
      changedAt: iso(row['changed_at']),
    }));
    return rows.length > limit ? { items, nextCursor: encodeCursor(offset + limit) } : { items };
  }

  async getAgreement(partnerId: string) {
    const { rows } = await this.pool.query('SELECT * FROM promotion_agreements WHERE partner_id = $1', [partnerId]);
    return rows[0] ? toAgreement(rows[0]) : undefined;
  }

  async saveAgreement(a: PromotionAgreementRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO promotion_agreements (partner_id, allows_promotions, max_discount_percentage, enabled_destinations, enabled_routes,
                                         enabled_cabins, valid_until, combo_conditions, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (partner_id) DO UPDATE SET allows_promotions = EXCLUDED.allows_promotions,
         max_discount_percentage = EXCLUDED.max_discount_percentage, enabled_destinations = EXCLUDED.enabled_destinations,
         enabled_routes = EXCLUDED.enabled_routes, enabled_cabins = EXCLUDED.enabled_cabins, valid_until = EXCLUDED.valid_until,
         combo_conditions = EXCLUDED.combo_conditions, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [
        a.partnerId,
        a.permite_promociones,
        a.porcentaje_descuento_maximo,
        a.destinos_habilitados ?? null,
        a.rutas_habilitadas ?? null,
        a.cabinas_habilitadas ?? null,
        a.vigencia_hasta ?? null,
        a.condiciones_combo ?? null,
        a.updatedAt,
        a.updatedBy,
      ],
    );
  }

  private async readState(db: Queryable): Promise<ScheduleState> {
    const [fleet, routes, assignments] = await Promise.all([
      db.query('SELECT * FROM aircraft ORDER BY registration'),
      db.query('SELECT * FROM scheduled_routes ORDER BY route_id'),
      db.query('SELECT route_id, registration FROM route_aircraft ORDER BY route_id, position'),
    ]);
    const byRoute = new Map<string, string[]>();
    for (const row of assignments.rows as Row[]) {
      const id = String(row['route_id']);
      byRoute.set(id, [...(byRoute.get(id) ?? []), String(row['registration'])]);
    }
    return {
      fleet: fleet.rows.map(toAircraft),
      routes: routes.rows.map((row: Row) => toRoute(row, byRoute.get(String(row['route_id'])) ?? [])),
    };
  }

  /** Orden por las claves foráneas: rutas borradas → aviones nuevos → rutas → aviones retirados. */
  private async apply(client: Queryable, changes: ScheduleChanges): Promise<void> {
    if (changes.deleteRoutes?.length) await client.query('DELETE FROM scheduled_routes WHERE route_id = ANY($1)', [changes.deleteRoutes]);
    for (const a of changes.saveAircraft ?? []) {
      await client.query(
        `INSERT INTO aircraft (registration, aircraft_type, base, source, created_at, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (registration) DO UPDATE SET base = EXCLUDED.base, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
        [a.registration, a.aircraftType, a.base, a.source, a.createdAt, a.updatedAt, a.updatedBy],
      );
    }
    for (const r of changes.saveRoutes ?? []) {
      await client.query(
        `INSERT INTO scheduled_routes (route_id, origin, destination, outbound_flight, outbound_departure, inbound_flight, inbound_departure,
                                       weekdays, aircraft_type, source, created_at, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (route_id) DO UPDATE SET origin = EXCLUDED.origin, destination = EXCLUDED.destination,
           outbound_departure = EXCLUDED.outbound_departure, inbound_departure = EXCLUDED.inbound_departure, weekdays = EXCLUDED.weekdays,
           aircraft_type = EXCLUDED.aircraft_type, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
        [r.routeId, r.origin, r.destination, r.outbound.flightNumber, r.outbound.departureLocal, r.inbound.flightNumber, r.inbound.departureLocal,
          [...r.weekdays], r.aircraftType, r.source, r.createdAt, r.updatedAt, r.updatedBy],
      );
      await client.query('DELETE FROM route_aircraft WHERE route_id = $1', [r.routeId]);
      for (const [position, registration] of r.aircraft.entries()) {
        await client.query('INSERT INTO route_aircraft (route_id, position, registration) VALUES ($1, $2, $3)', [r.routeId, position, registration]);
      }
    }
    if (changes.deleteAircraft?.length) await client.query('DELETE FROM aircraft WHERE registration = ANY($1)', [changes.deleteAircraft]);
    if (Object.values(changes).some((list) => list?.length)) await client.query('UPDATE schedule_meta SET version = version + 1 WHERE id = 1');
  }

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
