import type { AircraftType, CabinClass } from '@ecoairlines/shared';
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
