import type { MoneyAmount, PassengerCounts, PassengerType } from '@ecoairlines/shared';

/**
 * Modelo de MS.G.Bookings (contract/ms-g-bookings.openapi.yaml; contrato v2 §10). La reserva es un agregado: se guarda
 * completa, y lo que debe ser único en todo el sistema (PNR, hold, referencia de pago, documento por vuelo) va en tablas
 * propias con índice único. La asistencia (dato de salud) también va aparte.
 */
export type BookingStatus = 'PENDING' | 'PENDING_PAYMENT' | 'TICKET_ISSUING' | 'CONFIRMED' | 'FAILED' | 'CHANGE_PENDING' | 'CANCELLATION_PENDING' | 'CANCELLED';
export type SalesChannelCode = 'WEB' | 'BOOKING';
export type PaymentProvider = 'BOOKING_PROTOTIPO' | 'AIRLINE_DIRECT';
export type PaymentOperation = 'BOOKING' | 'SEATS' | 'BAGGAGE' | 'DATE_CHANGE';
export type AssistanceType = 'WCHR' | 'WCHS' | 'WCHC' | 'BLND' | 'DEAF' | 'DPNA' | 'MEDA';

export interface PassengerItem {
  passengerId: string;
  passengerType: PassengerType;
  associatedAdultId?: string;
  firstName: string;
  lastName: string;
  documentType: 'PASSPORT' | 'NATIONAL_ID';
  documentNumber: string;
  nationality: string;
  documentExpiryDate?: string;
  birthDate: string;
  gender: 'M' | 'F' | 'X';
  contact: { email: string; phone: string };
  assignedSeats?: { segmentId: string; seatNumber: string }[];
  extraBaggage?: { itineraryId: string; quantity: number }[];
}

/** `ItineraryOption` del contrato v2 tal como la entregó Offers (aquí solo se leen segmentos y equipaje). */
export interface ItineraryOption {
  itineraryId: string;
  segments: {
    segmentId: string;
    flightNumber: string;
    departure: { iataCode: string; at: string };
    arrival: { iataCode: string; at: string };
    [key: string]: unknown;
  }[];
  pricingOptions?: { baggageAllowance?: { checkedBaggageIncluded?: number } }[];
  [key: string]: unknown;
}

export interface PurchasedFare {
  itineraryId: string;
  cabinClass: string;
  fareBrand: string;
  segmentIds: string[];
  price: MoneyAmount;
  isRefundable: boolean;
  isChangeable: boolean;
  changeFeeUsd?: string;
}

export interface TicketSegment {
  segmentId: string;
  status: 'PENDING' | 'ISSUED' | 'FAILED';
  couponNumber: string | null;
  flightNumber?: string;
  departureIataCode?: string;
  arrivalIataCode?: string;
  departureAt?: string;
  arrivalAt?: string;
  seatNumber?: string | null;
}

export interface Ticket {
  ticketId: string;
  bookingId: string;
  passengerId: string;
  passengerName: string;
  eTicketNumber: string | null;
  status: 'PENDING' | 'ISSUING' | 'ISSUED' | 'FAILED' | 'VOIDED' | 'REFUNDED';
  issuedAt: string | null;
  segments: TicketSegment[];
  failureReason: string | null;
}

export interface Refund {
  refundId: string;
  amount: string;
  penaltyAmount: string;
  penaltyWaived?: boolean;
  currency: string;
  percentage?: number;
  originalPaymentReference?: string | null;
  status: 'CALCULATED' | 'SETTLED' | 'NOT_REFUNDABLE';
  settledAt?: string | null;
}

export interface SalesChannel {
  partnerId?: string;
  partnerOrderId?: string;
  packageId?: string | null;
  promotionApplied?: boolean;
  discountPercentage?: number;
}

export interface BookingRecord {
  bookingId: string;
  pnr: string;
  ownerId: string;
  channel: SalesChannelCode;
  partnerId: string | null;
  status: BookingStatus;
  holdId: string;
  offerId: string;
  sagaId: string;
  passengersBreakdown: PassengerCounts;
  passengers: PassengerItem[];
  itineraries: ItineraryOption[];
  fares: PurchasedFare[];
  grandTotal: MoneyAmount;
  payment: { paymentReference: string; provider: PaymentProvider };
  salesChannel?: SalesChannel;
  tickets: Ticket[];
  changes: { changedAt: string; description: string }[];
  refunds: Refund[];
  /** Pasajeros con check-in por segmento (lo informa la saga "Check-in" con `CHECK_IN_AUTO`). */
  checkedIn: { segmentId: string; passengerId: string }[];
  /** Resultado original de la cancelación (se devuelve en `ALREADY_CANCELLED`). */
  cancellation?: Record<string, unknown>;
  failure?: { errorCode: string; reason?: string };
  createdAt: string;
  updatedAt: string;
}

export interface PaymentRecord {
  paymentReference: string;
  provider: PaymentProvider;
  operation: PaymentOperation;
  amount: MoneyAmount;
  bookingId: string | null;
  sagaId: string;
  claimedAt: string;
}

/** Asistencia médica o de movilidad de un pasajero. **Dato de salud**: nunca en logs, trazas ni eventos externos. */
export interface AssistanceRecord {
  bookingId: string;
  passengerId: string;
  type: AssistanceType;
  needsCompanion: boolean;
  notes?: string;
  status: 'REQUESTED' | 'READY';
  updatedAt: string;
}

/** Un documento (país + número normalizado) en un segmento: único entre las reservas activas (contrato: validate). */
export interface DocumentClaim {
  segmentId: string;
  identityKey: string;
  bookingId: string;
}

export const ACTIVE_STATUSES: BookingStatus[] = ['PENDING', 'PENDING_PAYMENT', 'TICKET_ISSUING', 'CONFIRMED', 'CHANGE_PENDING', 'CANCELLATION_PENDING'];
export const channelOf = (ownerId: string): SalesChannelCode => (ownerId.startsWith('partner:') ? 'BOOKING' : 'WEB');
export const partnerOf = (ownerId: string): string | null => (ownerId.startsWith('partner:') ? ownerId.split(':')[1] : null);

export type { MoneyAmount, PassengerCounts, PassengerType };
