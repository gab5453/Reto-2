import pg from 'pg';
import {
  type AircraftRecord,
  type AircraftTypeRecord,
  type AirportRecord,
  type AircraftType,
  type CabinClass,
  DEFAULT_PRICING,
  type FareBrand,
  type FarePriceRecord,
  type PriceChangeRecord,
  type PricingChangeRecord,
  type PricingSettings,
  type PromotionAgreementRecord,
  type RouteRecord,
  type ScheduleChanges,
  type ScheduleState,
  type Source,
} from '../domain/model.js';
import type { Weekday } from '../domain/timetable.js';
import { type AircraftTypeWork, type AirportWork, encodeCursor, type Page, type PriceWork, type PricingWork, type ScheduleRepository, type ScheduleWork } from './schedule.repository.js';

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
-- P-1: tarifa base (cargo fijo y precio por km) y precios exactos por ruta (route_prices: routeId → paquete → US$).
CREATE TABLE IF NOT EXISTS pricing_settings (
  id           smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  fixed_charge numeric(8, 2) NOT NULL,
  per_km       numeric(8, 4) NOT NULL,
  route_prices jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz,
  updated_by   uuid
);
CREATE TABLE IF NOT EXISTS pricing_changes (
  id         uuid PRIMARY KEY,
  field      text NOT NULL,
  route_id   text,
  fare_brand text,
  old_value  numeric(10, 4),
  new_value  numeric(10, 4),
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pricing_changes_changed_at_idx ON pricing_changes (changed_at DESC, id);
-- M-1: catálogo de aeropuertos (antes constante del código). El código no se edita; desactivar en vez de borrar si está en uso.
CREATE TABLE IF NOT EXISTS airports (
  code               char(3) PRIMARY KEY,
  city               text NOT NULL,
  name               text NOT NULL,
  country            char(2) NOT NULL,
  province           text,
  lat                numeric(9, 6) NOT NULL,
  lon                numeric(9, 6) NOT NULL,
  utc_offset_minutes smallint NOT NULL,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  updated_by         uuid
);
-- M-2: catálogo de tipos de avión (antes constante del código). cabins: [{cabinClass, firstRow, lastRow, layout, exitRows, extraLegroomRows}].
CREATE TABLE IF NOT EXISTS aircraft_types (
  name                text PRIMARY KEY,
  registration_prefix text NOT NULL UNIQUE,
  max_route_km        integer,
  turnaround_minutes  integer NOT NULL,
  cabins              jsonb NOT NULL,
  source              text NOT NULL CHECK (source IN ('NETWORK', 'ADMIN')),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  updated_by          uuid
);
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
const toPricing = (row: Row): PricingSettings => ({
  fixedCharge: Number(row['fixed_charge']),
  perKm: Number(row['per_km']),
  routePrices: (row['route_prices'] as PricingSettings['routePrices'] | null) ?? {},
  updatedAt: row['updated_at'] ? iso(row['updated_at']) : null,
  updatedBy: (row['updated_by'] as string | null) ?? null,
});
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

  async listAirports(): Promise<AirportRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM airports ORDER BY code');
    return rows.map(toAirport);
  }

  async seedAirports(airports: AirportRecord[]): Promise<boolean> {
    return this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('schedule:changes'))`);
      const { rows } = await client.query('SELECT count(*) AS n FROM airports');
      if (Number((rows[0] as Row)['n']) > 0) return false;
      for (const airport of airports) await saveAirport(client, airport);
      return true;
    });
  }

  async changeAirports<T>(work: AirportWork<T>): Promise<T> {
    return this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('schedule:changes'))`);
      const { rows } = await client.query('SELECT * FROM airports ORDER BY code');
      const { changes, result } = work(rows.map(toAirport), await this.readState(client));
      for (const airport of changes.saveAirports ?? []) await saveAirport(client, airport);
      for (const code of changes.deleteAirports ?? []) await client.query('DELETE FROM airports WHERE code = $1', [code]);
      return result;
    });
  }

  async listAircraftTypes(): Promise<AircraftTypeRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM aircraft_types ORDER BY name');
    return rows.map(toAircraftType);
  }

  async seedAircraftTypes(types: AircraftTypeRecord[]): Promise<boolean> {
    return this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('schedule:changes'))`);
      const { rows } = await client.query('SELECT count(*) AS n FROM aircraft_types');
      if (Number((rows[0] as Row)['n']) > 0) return false;
      for (const type of types) await saveAircraftType(client, type);
      return true;
    });
  }

  async changeAircraftTypes<T>(work: AircraftTypeWork<T>): Promise<T> {
    return this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('schedule:changes'))`);
      const { rows } = await client.query('SELECT * FROM aircraft_types ORDER BY name');
      const { changes, result } = work(rows.map(toAircraftType), await this.readState(client));
      for (const type of changes.saveAircraftTypes ?? []) await saveAircraftType(client, type);
      for (const name of changes.deleteAircraftTypes ?? []) await client.query('DELETE FROM aircraft_types WHERE name = $1', [name]);
      return result;
    });
  }

  async getPricing(): Promise<PricingSettings> {
    const { rows } = await this.pool.query('SELECT * FROM pricing_settings WHERE id = 1');
    return rows[0] ? toPricing(rows[0]) : { ...DEFAULT_PRICING, routePrices: {}, updatedAt: null, updatedBy: null };
  }

  async changePricing(work: PricingWork): Promise<PricingSettings> {
    await this.transaction(async (client) => {
      await client.query('INSERT INTO pricing_settings (id, fixed_charge, per_km) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING', [DEFAULT_PRICING.fixedCharge, DEFAULT_PRICING.perKm]);
      const { rows } = await client.query('SELECT * FROM pricing_settings WHERE id = 1 FOR UPDATE');
      const { next, history } = work(toPricing(rows[0]!));
      await client.query('UPDATE pricing_settings SET fixed_charge = $1, per_km = $2, route_prices = $3, updated_at = $4, updated_by = $5 WHERE id = 1', [
        next.fixedCharge,
        next.perKm,
        JSON.stringify(next.routePrices),
        next.updatedAt,
        next.updatedBy,
      ]);
      for (const h of history) {
        await client.query(
          `INSERT INTO pricing_changes (id, field, route_id, fare_brand, old_value, new_value, changed_by, changed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [h.id, h.field, h.routeId, h.fareBrand, h.oldValue, h.newValue, h.changedBy, h.changedAt],
        );
      }
    });
    return this.getPricing();
  }

  async listPricingChanges(limit: number): Promise<PricingChangeRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM pricing_changes ORDER BY changed_at DESC, id LIMIT $1', [limit]);
    return rows.map((row: Row) => ({
      id: String(row['id']),
      field: row['field'] as PricingChangeRecord['field'],
      routeId: (row['route_id'] as string | null) ?? null,
      fareBrand: (row['fare_brand'] as FareBrand | null) ?? null,
      oldValue: row['old_value'] === null ? null : Number(row['old_value']),
      newValue: row['new_value'] === null ? null : Number(row['new_value']),
      changedBy: String(row['changed_by']),
      changedAt: iso(row['changed_at']),
    }));
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

function toAirport(row: Row): AirportRecord {
  return {
    code: String(row['code']),
    city: String(row['city']),
    name: String(row['name']),
    country: String(row['country']),
    ...(row['province'] ? { province: String(row['province']) } : {}),
    lat: Number(row['lat']),
    lon: Number(row['lon']),
    utcOffsetMinutes: Number(row['utc_offset_minutes']),
    active: Boolean(row['active']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    updatedBy: (row['updated_by'] as string | null) ?? null,
  };
}

async function saveAirport(client: pg.PoolClient, a: AirportRecord): Promise<void> {
  await client.query(
    `INSERT INTO airports (code, city, name, country, province, lat, lon, utc_offset_minutes, active, created_at, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (code) DO UPDATE SET city = $2, name = $3, country = $4, province = $5, lat = $6, lon = $7, utc_offset_minutes = $8,
       active = $9, updated_at = $11, updated_by = $12`,
    [a.code, a.city, a.name, a.country, a.province ?? null, a.lat, a.lon, a.utcOffsetMinutes, a.active, a.createdAt, a.updatedAt, a.updatedBy],
  );
}

function toAircraftType(row: Row): AircraftTypeRecord {
  return {
    name: String(row['name']),
    registrationPrefix: String(row['registration_prefix']),
    maxRouteKm: row['max_route_km'] === null ? null : Number(row['max_route_km']),
    turnaroundMinutes: Number(row['turnaround_minutes']),
    cabins: row['cabins'] as AircraftTypeRecord['cabins'],
    source: row['source'] as Source,
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    updatedBy: (row['updated_by'] as string | null) ?? null,
  };
}

async function saveAircraftType(client: pg.PoolClient, t: AircraftTypeRecord): Promise<void> {
  await client.query(
    `INSERT INTO aircraft_types (name, registration_prefix, max_route_km, turnaround_minutes, cabins, source, created_at, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (name) DO UPDATE SET registration_prefix = $2, max_route_km = $3, turnaround_minutes = $4, cabins = $5, updated_at = $8, updated_by = $9`,
    [t.name, t.registrationPrefix, t.maxRouteKm, t.turnaroundMinutes, JSON.stringify(t.cabins), t.source, t.createdAt, t.updatedAt, t.updatedBy],
  );
}
