import type { AssistanceRecord, BookingRecord, BookingStatus, DocumentClaim, PaymentRecord, SalesChannelCode } from '../domain/model.js';

/**
 * Datos de Bookings (base `bookings`). Dos implementaciones con el mismo comportamiento: en memoria y PostgreSQL. Todo se
 * hace dentro de `transaction` (si `work` lanza, no queda nada); la reserva leída con `booking()` queda bloqueada hasta el final.
 */
export const BOOKINGS_STORE = Symbol('BOOKINGS_STORE');

export interface BookingFilter {
  ownerId?: string;
  pnr?: string;
  status?: BookingStatus;
  channel?: SalesChannelCode;
  createdFrom?: string;
  createdTo?: string;
  /** Solo el administrador: el PNR, la orden de Booking (`partnerOrderId`) o la referencia del pago de la reserva, exactos. */
  reference?: string;
}

export type InsertResult = 'ok' | 'id-exists' | 'pnr-taken' | 'hold-taken';

export interface BookingsTx {
  booking(bookingId: string): Promise<BookingRecord | undefined>;
  bookingByHold(holdId: string): Promise<BookingRecord | undefined>;
  insertBooking(booking: BookingRecord): Promise<InsertResult>;
  saveBooking(booking: BookingRecord): Promise<void>;
  /** Del más reciente al más antiguo. */
  listBookings(filter: BookingFilter, limit: number, offset: number): Promise<{ items: BookingRecord[]; hasMore: boolean }>;
  /** Reservas con algún segmento en ese vuelo (cualquier estado). */
  flightBookings(segmentId: string): Promise<BookingRecord[]>;
  bookingsCreatedBetween(from?: string, to?: string): Promise<BookingRecord[]>;

  payment(reference: string): Promise<PaymentRecord | undefined>;
  /** `false` si la referencia ya existe (uso único en todo el sistema). */
  insertPayment(record: PaymentRecord): Promise<boolean>;
  savePayment(record: PaymentRecord): Promise<void>;
  deletePayment(reference: string): Promise<void>;
  /** Pagos registrados de una reserva (reserva, asientos, maletas, cambio de fecha), del más antiguo al más reciente. */
  paymentsOf(bookingId: string): Promise<PaymentRecord[]>;

  /** Quién tiene ya esos documentos en esos segmentos (de otras reservas). */
  documentHolders(claims: Omit<DocumentClaim, 'bookingId'>[]): Promise<DocumentClaim[]>;
  /** Reserva los documentos en los segmentos; devuelve los que ya tenía otra reserva (y entonces no reserva ninguno). */
  claimDocuments(claims: DocumentClaim[]): Promise<DocumentClaim[]>;
  releaseDocuments(bookingId: string, segmentIds?: string[]): Promise<void>;

  assistance(bookingId: string): Promise<AssistanceRecord[]>;
  saveAssistance(record: AssistanceRecord): Promise<void>;
  deleteAssistance(bookingId: string, passengerId: string): Promise<void>;
}

export interface BookingsStore {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  transaction<T>(work: (tx: BookingsTx) => Promise<T>): Promise<T>;
}

export const encodeCursor = (offset: number): string => Buffer.from(`o:${offset}`).toString('base64url');
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^o:(\d{1,7})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return match ? Number(match[1]) : 0;
}

/** Filtro común a las dos implementaciones (la de PostgreSQL filtra igual en SQL). */
export function matches(booking: BookingRecord, filter: BookingFilter): boolean {
  const created = booking.createdAt.slice(0, 10);
  return (
    (!filter.ownerId || booking.ownerId === filter.ownerId) &&
    (!filter.pnr || booking.pnr === filter.pnr) &&
    (!filter.status || booking.status === filter.status) &&
    (!filter.channel || booking.channel === filter.channel) &&
    (!filter.createdFrom || created >= filter.createdFrom) &&
    (!filter.createdTo || created <= filter.createdTo) &&
    (!filter.reference ||
      booking.pnr === filter.reference.toUpperCase() ||
      booking.salesChannel?.partnerOrderId === filter.reference ||
      booking.payment.paymentReference === filter.reference)
  );
}
