import type { AircraftType, CabinClass, MoneyAmount, PassengerCounts, PassengerType } from '@ecoairlines/shared';

/**
 * Modelo de MS.G.Offers (contract/ms-g-offers.proto; modelo conceptual v4: flights_for_sale, inventory, booking_seats, holds,
 * fare_prices, promotion_rules, stock_sync, outbox).
 */
export type SeatStatus = 'AVAILABLE' | 'HELD' | 'BOOKED' | 'TICKETED' | 'CHECKED_IN' | 'BOARDED';
/** Estados que ocupan un cupo (todos menos AVAILABLE), en el orden de la máquina de estados (contrato v2 §10). */
export const TAKEN_STATUSES = ['HELD', 'BOOKED', 'TICKETED', 'CHECKED_IN', 'BOARDED'] as const;
export type TakenStatus = (typeof TAKEN_STATUSES)[number];
export type HoldStatus = 'HELD' | 'RELEASED' | 'EXPIRED' | 'CONSUMED';
export type SalesChannel = 'WEB' | 'BOOKING';
export type SeatCharacteristic = 'WINDOW' | 'AISLE' | 'EXTRA_LEGROOM' | 'EMERGENCY_EXIT';

/** Vuelo a la venta (copia de lectura del horario de Schedule, publicada por el ESB con PublishTimetable). */
export interface FlightRecord {
  segmentId: string;
  flightNumber: string;
  /** Fecha local de salida (YYYY-MM-DD). */
  date: string;
  routeId: string;
  origin: string;
  destination: string;
  /** RFC 3339 con el desfase del aeropuerto. */
  departureAt: string;
  arrivalAt: string;
  aircraftType: AircraftType;
  registration: string;
  onSale: boolean;
  /** Motivo del cierre de la venta (p. ej. FLIGHT_CANCELLED). */
  closedReason?: string | null;
}

/** Cupos de una cabina de un vuelo, por estado. Disponibles = total − ocupados. */
export interface InventoryRecord {
  segmentId: string;
  cabinClass: CabinClass;
  total: number;
  counts: Record<TakenStatus, number>;
}

export const available = (inventory: InventoryRecord): number =>
  inventory.total - TAKEN_STATUSES.reduce((sum, status) => sum + inventory.counts[status], 0);

export interface FlightEndpoint {
  iataCode: string;
  at: string;
  terminal?: string;
}

export interface FlightSegment {
  segmentId: string;
  flightNumber: string;
  departure: FlightEndpoint;
  arrival: FlightEndpoint;
  layoverMinutes?: number;
  marketingCarrier: string;
  operatingCarrier: string;
  aircraft?: string;
  durationMinutes?: number;
  status: 'SCHEDULED' | 'CANCELLED';
}

export interface CabinPricing {
  cabinClass: CabinClass;
  fareBrand: string;
  availableSeats: number;
  fareRules: { isRefundable: boolean; isChangeable: boolean };
  baggageAllowance: { personalItemIncluded: boolean; carryOnIncluded: number; checkedBaggageIncluded: number };
  extraCheckedBaggagePrice: MoneyAmount;
  pricePerPassengerType: { passengerType: PassengerType; price: MoneyAmount }[];
}

export interface ItineraryOption {
  itineraryId: string;
  totalDurationMinutes: number;
  stopsCount: number;
  segments: FlightSegment[];
  pricingOptions: CabinPricing[];
}

export interface FlightOffer {
  offerId: string;
  airline: { code: string; name: string };
  itineraries: ItineraryOption[];
  grandTotal: MoneyAmount;
}

export interface FareSelection {
  itineraryId: string;
  cabinClass: CabinClass;
  fareBrand: string;
}

export interface PricedSelection extends FareSelection {
  segmentIds: string[];
  /** Con `pricingOptions` limitado a la tarifa elegida. */
  itinerary: ItineraryOption;
  price: MoneyAmount;
}

export interface HoldRecord {
  holdId: string;
  ownerId: string;
  channel: SalesChannel;
  status: HoldStatus;
  offerId: string;
  counts: PassengerCounts;
  selections: PricedSelection[];
  lockedPrice: MoneyAmount;
  ttlMinutes: number;
  createdAt: string;
  expiresAt: string;
  bookingId?: string | null;
}

/** Un cupo de una reserva en un segmento; con asiento cuando `seatNumber` no es null (único por segmento). */
export interface BookingSeatRecord {
  id: string;
  bookingId: string;
  segmentId: string;
  cabinClass: CabinClass;
  status: TakenStatus;
  passengerId: string | null;
  seatNumber: string | null;
}

export interface FarePriceRecord {
  cabinClass: CabinClass;
  fareBrand: string;
  multiplier: number;
}

/** Copia de `promotion_agreements` de Schedule (D35). */
export interface PromotionRuleRecord {
  partnerId: string;
  allowsPromotions: boolean;
  maxDiscountPercentage: number;
  routes: string[];
  cabins: CabinClass[];
  validUntil?: string | null;
}

/** Último stock de una cabina de un vuelo pendiente de enviar a Booking (D33). */
export interface StockSyncRecord {
  segmentId: string;
  cabinClass: CabinClass;
  flightNumber: string;
  date: string;
  timeSlot: string;
  units: number;
  /** Sube con cada cambio: un envío solo se marca hecho si nadie lo cambió mientras viajaba. */
  version: number;
  pending: boolean;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string | null;
  pushedUnits?: number | null;
  pushedAt?: string | null;
  correlationId?: string | null;
}

export interface OutboxRecord {
  id: string;
  type: string;
  event: unknown;
  /** Dueño del hold (D29): el relé lo publica como cabecera AMQP `x-owner-id` para el filtro D40 de Webhooks. */
  ownerId?: string | null;
  createdAt: string;
  publishedAt?: string | null;
}

export type { AircraftType, CabinClass, MoneyAmount, PassengerCounts, PassengerType };
