import type { AircraftTypeSpec } from '@ecoairlines/shared';
import type { Airport } from '@ecoairlines/shared';
import type { CloudEvent } from '@ecoairlines/shared';
import type {
  BookingSeatRecord,
  CabinClass,
  FarePriceRecord,
  FlightRecord,
  HoldRecord,
  HoldStatus,
  InventoryRecord,
  OutboxRecord,
  PricingSettingsRecord,
  PromotionRuleRecord,
  StockSyncRecord,
  TakenStatus,
} from '../domain/model.js';

/**
 * Datos de Offers (base `offers`). Dos implementaciones con el mismo comportamiento: en memoria (pruebas y local sin
 * DATABASE_URL) y PostgreSQL. Todo se hace dentro de `transaction`: si `work` lanza, no queda ningún cambio.
 */
export const OFFERS_STORE = Symbol('OFFERS_STORE');

/** `AVAILABLE` es el origen o el destino de un movimiento de cupos que se toman o se liberan. */
export type CupoState = TakenStatus | 'AVAILABLE';

/** El asiento lo tiene otro (choque en el índice único de `booking_seats`). */
export class SeatTakenError extends Error {
  constructor(
    readonly segmentId: string,
    readonly seatNumber: string,
  ) {
    super(`El asiento ${seatNumber} de ${segmentId} ya está ocupado.`);
  }
}

export interface OffersTx {
  // ---------------------------------------------------------------- vuelos a la venta
  flight(segmentId: string): Promise<FlightRecord | undefined>;
  /** Vuelos que salen en una fecha local (de cualquier estado de venta), ordenados por salida. */
  flightsOn(date: string): Promise<FlightRecord[]>;
  flightsInRange(from: string, to: string, routeId?: string): Promise<FlightRecord[]>;
  flightsByNumbers(flightNumbers: string[], fromDate: string): Promise<FlightRecord[]>;
  saveFlight(flight: FlightRecord): Promise<void>;
  deleteFlight(segmentId: string): Promise<void>;

  // ---------------------------------------------------------------- cupos
  inventory(segmentId: string): Promise<InventoryRecord[]>;
  saveInventory(inventory: InventoryRecord): Promise<void>;
  /**
   * Mueve `count` cupos de un estado a otro SOLO si el origen tiene suficientes (desde AVAILABLE: si quedan libres). Es la
   * actualización condicional de D34: devuelve `false` (sin cambiar nada) si no alcanzan.
   */
  moveCupos(segmentId: string, cabinClass: CabinClass, from: CupoState, to: CupoState, count: number): Promise<boolean>;

  // ---------------------------------------------------------------- cupos y asientos de reservas
  bookingSeats(bookingId: string): Promise<BookingSeatRecord[]>;
  /** Asientos asignados (con número) de un segmento. */
  assignedSeats(segmentId: string): Promise<BookingSeatRecord[]>;
  /** Inserta un cupo; si trae asiento y ese asiento ya es de otro, devuelve `false` sin insertar. */
  insertBookingSeat(seat: BookingSeatRecord): Promise<boolean>;
  /** Cambia estado, pasajero o asiento. Si el asiento nuevo es de otro, lanza SeatTakenError. */
  updateBookingSeat(seat: BookingSeatRecord): Promise<void>;
  deleteBookingSeats(ids: string[]): Promise<void>;

  // ---------------------------------------------------------------- holds
  hold(holdId: string): Promise<HoldRecord | undefined>;
  insertHold(hold: HoldRecord): Promise<void>;
  /** Cambia el estado SOLO si sigue en `expected` (así un hold no se libera ni se consume dos veces). */
  updateHoldIf(holdId: string, expected: HoldStatus, patch: Partial<Pick<HoldRecord, 'status' | 'bookingId'>>): Promise<boolean>;
  /** Holds vigentes que incluyen ese segmento. */
  activeHoldsOn(segmentId: string): Promise<HoldRecord[]>;

  // ---------------------------------------------------------------- precios y promociones (copias de Schedule)
  farePrices(): Promise<FarePriceRecord[]>;
  replaceFarePrices(prices: FarePriceRecord[]): Promise<void>;
  /** Tarifa base y precios por ruta (P-1); los de siempre si Schedule aún no publicó. */
  pricingSettings(): Promise<PricingSettingsRecord>;
  replacePricingSettings(settings: PricingSettingsRecord): Promise<void>;
  /** Copia del catálogo de aeropuertos de Schedule (M-1); vacía hasta la primera publicación del horario. */
  airportCatalog(): Promise<Airport[]>;
  replaceAirportCatalog(airports: Airport[]): Promise<void>;
  /** Copia del catálogo de tipos de avión (M-2), acumulada: nunca se quita un tipo. */
  aircraftTypeCatalog(): Promise<AircraftTypeSpec[]>;
  saveAircraftTypeCatalog(types: AircraftTypeSpec[]): Promise<void>;
  promotionRule(partnerId: string): Promise<PromotionRuleRecord | undefined>;
  replacePromotionRules(rules: PromotionRuleRecord[]): Promise<void>;

  // ---------------------------------------------------------------- idempotencia, outbox y stock
  sagaResult<T>(key: string): Promise<T | undefined>;
  saveSagaResult(key: string, result: unknown): Promise<void>;
  addOutbox(record: OutboxRecord): Promise<void>;
  /** Deja pendiente el envío del stock ABSOLUTO de una cabina (se guarda en la misma transacción que el cambio). */
  markStock(record: Omit<StockSyncRecord, 'version' | 'pending' | 'attempts' | 'nextAttemptAt'>): Promise<void>;
}

export interface OffersStore {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  transaction<T>(work: (tx: OffersTx) => Promise<T>): Promise<T>;

  /** Holds HELD ya vencidos (para el barrido). */
  dueHolds(now: string, limit: number): Promise<string[]>;
  pendingStock(now: string, limit: number): Promise<StockSyncRecord[]>;
  /** Marca enviado solo si la versión no cambió mientras el envío viajaba. */
  markStockPushed(segmentId: string, cabinClass: CabinClass, version: number, at: string): Promise<void>;
  markStockFailed(segmentId: string, cabinClass: CabinClass, version: number, error: string, nextAttemptAt: string): Promise<void>;
  stats(today: string): Promise<{ activeHolds: number; flightsOnSaleToday: number; lastStockPushAt?: string; pendingStockPushes: number }>;
  outbox(): Promise<OutboxRecord[]>;
  /** Relé del outbox (V2.11): pendientes del más antiguo al más nuevo, tomados por esta réplica durante `leaseMs`. */
  claimOutbox(limit: number, leaseMs: number): Promise<{ id: string; event: CloudEvent; ownerId?: string | null }[]>;
  markOutboxPublished(id: string, publishedAt: string): Promise<void>;
}
