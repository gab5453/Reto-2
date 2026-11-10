import type {
  AircraftTypeChanges,
  AircraftTypeRecord,
  AirportChanges,
  AirportRecord,
  FarePriceRecord,
  PriceChangeRecord,
  PricingChangeRecord,
  PricingSettings,
  PromotionAgreementRecord,
  ScheduleChanges,
  ScheduleState,
} from '../domain/model.js';

/**
 * Acceso a los datos de Schedule (base `schedule`). Dos implementaciones con el mismo comportamiento: en memoria (pruebas y
 * local sin DATABASE_URL) y PostgreSQL.
 */
export const SCHEDULE_REPOSITORY = Symbol('SCHEDULE_REPOSITORY');

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** Decide los cambios a partir del estado leído. Es síncrona: entre leer y escribir no hay `await`. */
export type ScheduleWork<T> = (state: ScheduleState) => { changes: ScheduleChanges; result: T };
export type PriceWork = (current: FarePriceRecord[]) => { updated: FarePriceRecord[]; history: PriceChangeRecord[] };
/** Decide los cambios de aeropuertos con el catálogo y las rutas y la flota leídos (para saber si uno está en uso). */
export type AirportWork<T> = (airports: AirportRecord[], state: ScheduleState) => { changes: AirportChanges; result: T };
export type AircraftTypeWork<T> = (types: AircraftTypeRecord[], state: ScheduleState) => { changes: AircraftTypeChanges; result: T };
export type PricingWork = (current: PricingSettings) => { next: PricingSettings; history: PricingChangeRecord[] };

export interface ScheduleRepository {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;

  loadState(): Promise<ScheduleState>;
  /** Número que cambia con cada cambio de rutas o flota (para no reconstruir el horario si no cambió nada). */
  version(): Promise<number>;
  /**
   * Todo cambio de rutas o flota pasa por aquí: los cambios simultáneos se ejecutan uno tras otro (dos rutas nuevas no
   * reciben los mismos números de vuelo ni el mismo avión) y se guardan juntos o ninguno.
   */
  changeSchedule<T>(work: ScheduleWork<T>): Promise<T>;
  /** Red base: solo si no hay rutas ni aviones. Devuelve `true` si la sembró. */
  seedSchedule(state: ScheduleState): Promise<boolean>;

  listPrices(): Promise<FarePriceRecord[]>;
  /** Crea las combinaciones que falten (las existentes no se tocan). */
  seedPrices(prices: FarePriceRecord[]): Promise<void>;
  /** Igual que changeSchedule, para la tabla de precios y su historial. */
  changePrices(work: PriceWork): Promise<FarePriceRecord[]>;
  /** Del más reciente al más antiguo. */
  listPriceChanges(limit: number, offset: number): Promise<Page<PriceChangeRecord>>;

  /** Tarifa base y precios por ruta (P-1); los valores por defecto si nunca se guardaron. */
  getPricing(): Promise<PricingSettings>;
  /** Igual que changePrices: leer, decidir y guardar con su historial, uno tras otro. */
  changePricing(work: PricingWork): Promise<PricingSettings>;
  listPricingChanges(limit: number): Promise<PricingChangeRecord[]>;

  /** Catálogo de aeropuertos (M-1), ordenado por código. */
  listAirports(): Promise<AirportRecord[]>;
  /** Siembra el catálogo solo si está vacío (así un aeropuerto borrado no vuelve). Devuelve `true` si sembró. */
  seedAirports(airports: AirportRecord[]): Promise<boolean>;
  /** Con el mismo candado que rutas y flota: una ruta nueva no usa un aeropuerto que se está borrando. */
  changeAirports<T>(work: AirportWork<T>): Promise<T>;

  /** Catálogo de tipos de avión (M-2), por nombre. */
  listAircraftTypes(): Promise<AircraftTypeRecord[]>;
  /** Solo si está vacío (un tipo borrado no vuelve). */
  seedAircraftTypes(types: AircraftTypeRecord[]): Promise<boolean>;
  /** Con el candado de rutas y flota: un avión nuevo no usa un tipo que se está borrando. */
  changeAircraftTypes<T>(work: AircraftTypeWork<T>): Promise<T>;

  getAgreement(partnerId: string): Promise<PromotionAgreementRecord | undefined>;
  saveAgreement(agreement: PromotionAgreementRecord): Promise<void>;
}

export const encodeCursor = (offset: number): string => Buffer.from(`o:${offset}`).toString('base64url');
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^o:(\d{1,7})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return match ? Number(match[1]) : 0;
}
