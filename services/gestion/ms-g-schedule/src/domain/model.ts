import type { AircraftType, AircraftTypeSpec, Airport, CabinClass } from '@ecoairlines/shared';
import type { FleetAircraft, RouteDefinition } from './timetable.js';

/**
 * Modelo de MS.G.Schedule (contract/ms-g-schedule.openapi.yaml y modelo conceptual v4: scheduled_routes, route_aircraft,
 * aircraft, fare_class_prices, price_changes, promotion_agreements).
 */
export type Source = 'NETWORK' | 'ADMIN';

interface Audit {
  source: Source;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

/** Ruta guardada: siempre con sus aviones asignados (en orden), así el horario se reconstruye igual en cada réplica. */
export type RouteRecord = Omit<RouteDefinition, 'aircraft' | 'autoAddAircraft'> & { aircraft: string[] } & Audit;
export type AircraftRecord = FleetAircraft & Audit;

export interface ScheduleState {
  routes: RouteRecord[];
  fleet: AircraftRecord[];
}

/** Cambios de una operación sobre rutas o flota; el repositorio los guarda todos juntos o ninguno. */
export interface ScheduleChanges {
  saveRoutes?: RouteRecord[];
  deleteRoutes?: string[];
  saveAircraft?: AircraftRecord[];
  deleteAircraft?: string[];
}

export const WEEKDAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

export type FareBrand = 'SEMILLA' | 'BROTE' | 'BOSQUE' | 'DOSEL';

/** Valores de referencia del botón «Rellenar» (multiplicadores de `FARE_BRANDS` del monolito). */
export const REFERENCE_FARE_PRICES: readonly { cabinClass: CabinClass; fareBrand: FareBrand; multiplier: number }[] = [
  { cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 1 },
  { cabinClass: 'ECONOMY', fareBrand: 'BROTE', multiplier: 1.35 },
  { cabinClass: 'ECONOMY', fareBrand: 'BOSQUE', multiplier: 1.8 },
  { cabinClass: 'BUSINESS', fareBrand: 'DOSEL', multiplier: 3.2 },
];

export interface FarePriceRecord {
  cabinClass: CabinClass;
  fareBrand: FareBrand;
  referenceMultiplier: number;
  multiplier: number;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Tarifa base y precios exactos por ruta (PLAN_Telemetria_Asientos P-1). La tarifa de un adulto en un vuelo, sin impuestos, es
 * `(fixedCharge + perKm × km) × multiplicador del paquete`, salvo que la ruta tenga un precio exacto para ese paquete (D-T12).
 */
export interface PricingSettings {
  fixedCharge: number;
  perKm: number;
  /** routeId → paquete → tarifa base de un adulto en US$, sin impuestos. */
  routePrices: Record<string, Partial<Record<FareBrand, number>>>;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Los valores con que nació la red (los que estaban fijos en Offers): nada cambia hasta que el administrador los edite. */
export const DEFAULT_PRICING: Readonly<Pick<PricingSettings, 'fixedCharge' | 'perKm'>> = { fixedCharge: 35, perKm: 0.085 };
export const FARE_BRANDS: readonly FareBrand[] = ['SEMILLA', 'BROTE', 'BOSQUE', 'DOSEL'];

export interface PricingChangeRecord {
  id: string;
  field: 'FIXED_CHARGE' | 'PER_KM' | 'ROUTE_PRICE';
  routeId: string | null;
  fareBrand: FareBrand | null;
  /** null: la ruta no tenía precio exacto (o se quitó). */
  oldValue: number | null;
  newValue: number | null;
  changedBy: string;
  changedAt: string;
}

export interface PriceChangeRecord {
  id: string;
  cabinClass: CabinClass;
  fareBrand: FareBrand;
  oldMultiplier: number;
  newMultiplier: number;
  changedBy: string;
  changedAt: string;
}

/** Acuerdo de promociones con un partner, con los nombres del contrato v2 (`ContratoPromocionesRequest`). */
export interface PromotionTerms {
  permite_promociones: boolean;
  porcentaje_descuento_maximo: number;
  destinos_habilitados?: string[];
  rutas_habilitadas?: string[];
  cabinas_habilitadas?: CabinClass[];
  vigencia_hasta?: string;
  condiciones_combo?: string;
}

export interface PromotionAgreementRecord extends PromotionTerms {
  partnerId: string;
  updatedAt: string;
  /** `null` en el acuerdo inicial de la semilla. */
  updatedBy: string | null;
}

export type { AircraftType, CabinClass };

/** Aeropuerto del catálogo (M-1): el código es la clave y no se edita; `active = false` no se ofrece para rutas nuevas. */
export type AirportRecord = Airport & { active: boolean; createdAt: string; updatedAt: string; updatedBy: string | null };

/** Cambios de una operación sobre el catálogo de aeropuertos. */
export interface AirportChanges {
  saveAirports?: AirportRecord[];
  deleteAirports?: string[];
}

/** Tipo de avión del catálogo (M-2): el nombre es la clave. */
export type AircraftTypeRecord = AircraftTypeSpec & Audit;

export interface AircraftTypeChanges {
  saveAircraftTypes?: AircraftTypeRecord[];
  deleteAircraftTypes?: string[];
}
