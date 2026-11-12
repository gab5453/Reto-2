import { AIRPORTS, createCloudEvent, type MoneyAmount, ProblemDetailsException, toCents } from '@ecoairlines/shared';
import type { Upstreams } from '../clients/upstreams.js';
import type { EsbConfig } from '../config/config.js';
import type { EventsPublisher } from '../inbound/events-publisher.js';
import { stableUuid } from '../transversal/ids.js';
import { assertAmountMatches, assertBookingPaymentReference } from '../transversal/booking-reference.js';
import type { SagaContext } from './engine.js';

/** Lo que el ESB lee de una reserva (`BookingView` de ms-g-bookings). */
export interface Segment {
  segmentId: string;
  flightNumber: string;
  departure: { iataCode: string; at: string };
  arrival: { iataCode: string; at: string };
  [key: string]: unknown;
}
export interface Itinerary {
  itineraryId: string;
  segments: Segment[];
  pricingOptions?: { cabinClass?: string; fareBrand?: string; extraCheckedBaggagePrice?: MoneyAmount; baggageAllowance?: { checkedBaggageIncluded?: number }; fareRules?: { isRefundable?: boolean; isChangeable?: boolean } }[];
  [key: string]: unknown;
}
export interface Passenger {
  passengerId: string;
  passengerType: 'ADULT' | 'YOUTH' | 'CHILD' | 'INFANT';
  firstName: string;
  lastName: string;
  assignedSeats?: { segmentId: string; seatNumber: string }[];
  [key: string]: unknown;
}
export interface Fare {
  itineraryId: string;
  cabinClass: string;
  fareBrand: string;
  segmentIds: string[];
  price: MoneyAmount;
  isRefundable: boolean;
  isChangeable: boolean;
  changeFeeUsd?: string;
}
export interface BookingView {
  bookingId: string;
  pnr: string;
  status: string;
  ownerId: string;
  channel: 'WEB' | 'BOOKING';
  grandTotal: MoneyAmount;
  paymentReference?: string | null;
  salesChannel?: { partnerId?: string; partnerOrderId?: string | null; packageId?: string | null } | null;
  itineraries: Itinerary[];
  passengers: Passenger[];
  tickets: { ticketId: string; passengerId: string; status: string; eTicketNumber: string | null }[];
  fares?: Fare[];
  assistance?: { passengerId: string }[];
}
export interface BookingFares {
  bookingId: string;
  status: string;
  channel: 'WEB' | 'BOOKING';
  partnerId: string | null;
  fares: Fare[];
  unflownItineraryIds: string[];
  baggage: { passengerId: string; itineraryId: string; included: number; purchased: number }[];
  paymentReference: string;
}

export interface PaymentInput {
  paymentReference: string;
  amount?: MoneyAmount;
  provider?: 'BOOKING_PROTOTIPO' | 'AIRLINE_DIRECT';
}
export type PaymentOperation = 'BOOKING' | 'SEATS' | 'BAGGAGE' | 'DATE_CHANGE';

export const isPartner = (ownerId: string | undefined | null) => !!ownerId?.startsWith('partner:');
export const partnerIdOf = (ownerId: string | undefined | null) => (isPartner(ownerId) ? ownerId!.split(':')[1] : null);
export const problem = (status: number, code: string, title: string, detail?: string) => new ProblemDetailsException({ status, code, title, ...(detail ? { detail } : {}) });
export const segmentsOf = (booking: Pick<BookingView, 'itineraries'>) => booking.itineraries.flatMap((itinerary) => itinerary.segments);
export const seated = (booking: Pick<BookingView, 'passengers'>) => booking.passengers.filter((passenger) => passenger.passengerType !== 'INFANT');
export const zero = (currency = 'USD'): MoneyAmount => ({ currency, total: '0.00' });

/** Un vuelo es internacional si sale y llega en países distintos (PASSPORT_REQUIRED_INTERNATIONAL). */
export const international = (segment: Pick<Segment, 'departure' | 'arrival'>) => AIRPORTS[segment.departure.iataCode]?.country !== AIRPORTS[segment.arrival.iataCode]?.country;

const ENUM_PREFIXES = /^(CABIN_CLASS|PASSENGER_TYPE|FLIGHT_OPERATIONAL_STATUS|SEAT_STATUS|HOLD_STATUS|SALES_CHANNEL|SEAT_CHARACTERISTIC)_/;
/**
 * Un mensaje de Offers (mapeo JSON de proto3) con los nombres del contrato v2: enums sin prefijo (`CABIN_CLASS_ECONOMY` →
 * `ECONOMY`) y sin los campos virtuales de los `optional` (`_terminal`). Así se guarda en Bookings y llega al cliente.
 */
export function fromProto<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((item) => fromProto(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')).map(([key, item]) => [key, fromProto(item)])) as T;
  }
  return (typeof value === 'string' && ENUM_PREFIXES.test(value) ? value.replace(ENUM_PREFIXES, '') : value) as T;
}

/** `ownerId` público de un evento: de una reserva de Booking, su usuario (`X-User-Id`), sin nuestro prefijo interno. */
export const publicOwner = (ownerId: string) => (ownerId.startsWith('partner:') ? ownerId.split(':').slice(2).join(':') : ownerId);

export function bookingEventData(booking: Pick<BookingView, 'bookingId' | 'pnr' | 'status' | 'ownerId' | 'grandTotal' | 'salesChannel'>) {
  return {
    bookingId: booking.bookingId,
    pnr: booking.pnr,
    status: booking.status,
    ownerId: publicOwner(booking.ownerId),
    partnerOrderId: booking.salesChannel?.partnerOrderId ?? null,
    packageId: booking.salesChannel?.packageId ?? null,
    grandTotal: booking.grandTotal,
  };
}

/**
 * Publica los eventos de una saga como su ÚLTIMO paso. El `id` del CloudEvent sale del `sagaId`: si la saga se reanuda y el
 * evento se vuelve a publicar, Webhooks lo descarta por su `id` (no llega dos veces a Booking). El outbox llega en V2.11.
 */
export async function publishEvents(
  saga: SagaContext,
  events: EventsPublisher,
  list: { name: string; visibility?: 'public' | 'internal'; subject: string; data: Record<string, unknown>; ownerId?: string }[],
): Promise<string[]> {
  return saga.step('events', async () => {
    const ids: string[] = [];
    for (const [index, item] of list.entries()) {
      const event = { ...createCloudEvent({ name: item.name, visibility: item.visibility ?? 'public', subject: item.subject, data: item.data }), id: stableUuid(`${saga.sagaId}:${index}:${item.name}`) };
      await events.publish(event, item.ownerId);
      ids.push(event.id);
    }
    return ids;
  });
}

/**
 * El paso `pago*` del plan (§4.2):
 * - **Canal Booking** (dueño `partner:…`): la aerolínea NO cobra. Se valida la referencia (formato y monto) y se registra su
 *   uso único en Bookings (`claim`). Compensación: liberar la referencia.
 * - **Canal web**: se **captura** en la Payment API el monto exacto autorizado y se registra en Bookings. Compensación: si se
 *   capturó, reembolso; si no se llegó a capturar, anular la autorización.
 * Un monto esperado de 0 no cobra nada (no se exige referencia).
 */
/** Consulta el pago cada pocos segundos mientras siga PENDING, como mucho `maxWaitMs`. */
async function waitWhilePending(read: () => Promise<{ status: string }>, maxWaitMs: number): Promise<void> {
  const until = Date.now() + maxWaitMs;
  const every = Math.min(3_000, Math.max(50, Math.floor(maxWaitMs / 10)));
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, every));
    const payment = await read().catch(() => undefined);
    if (payment && payment.status !== 'PENDING') return;
  }
}

export async function collectPayment(
  saga: SagaContext,
  deps: { upstreams: Upstreams; config: EsbConfig },
  input: { operation: PaymentOperation; payment?: PaymentInput; expected: MoneyAmount; bookingId?: string },
): Promise<{ paymentReference: string; provider: 'BOOKING_PROTOTIPO' | 'AIRLINE_DIRECT'; amount: MoneyAmount } | undefined> {
  if (toCents(input.expected.total) === 0) return undefined;
  if (!input.payment?.paymentReference) {
    throw new ProblemDetailsException({ status: 422, code: 'PAYMENT_REFERENCE_INVALID', title: 'Falta la referencia de pago.', invalidParams: [{ name: 'payment.paymentReference', reason: `obligatoria: el monto es ${input.expected.total} ${input.expected.currency}` }] });
  }
  const reference = input.payment.paymentReference;
  const bookings = deps.upstreams.rest.bookings;
  const claim = (provider: 'BOOKING_PROTOTIPO' | 'AIRLINE_DIRECT', amount?: MoneyAmount) =>
    saga.step(
      `payment.claim:${input.operation}`,
      () => bookings.json('POST', '/payment-references/claim', { json: { sagaId: saga.sagaId, paymentReference: reference, provider, operation: input.operation, ...(input.bookingId ? { bookingId: input.bookingId } : {}), ...(amount ? { amount } : {}), expectedAmount: input.expected } }),
      () => bookings.request({ method: 'DELETE', path: `/payment-references/${encodeURIComponent(reference)}?sagaId=${saga.sagaId}` }).then((r) => {
        if (r.status >= 500) throw problem(503, 'PROVIDER_UNAVAILABLE', 'MS.G.Bookings no liberó la referencia.');
      }),
    );

  if (isPartner(saga.ownerId)) {
    if (input.payment.provider === 'AIRLINE_DIRECT') throw problem(422, 'PAYMENT_REFERENCE_INVALID', 'Un partner no puede pagar con la pasarela de la aerolínea.');
    assertBookingPaymentReference(reference, deps.config.bookingPaymentReferencePattern);
    assertAmountMatches(input.payment.amount, input.expected);
    await claim('BOOKING_PROTOTIPO', input.payment.amount);
    return { paymentReference: reference, provider: 'BOOKING_PROTOTIPO', amount: input.expected };
  }

  const payments = deps.upstreams.payments;
  if (!payments) throw problem(503, 'PROVIDER_UNAVAILABLE', 'La Payment API no está configurada (canal web, V2.15).');
  // Si la saga falla antes de capturar, la autorización se anula (anular una ya capturada o vencida no hace nada).
  await saga.step(`payment.authorization:${input.operation}`, async () => ({ paymentReference: reference }), () =>
    payments.void(reference).catch((error: unknown) => {
      if (error instanceof ProblemDetailsException && error.problem.status < 500) return;
      throw error;
    }),
  );
  await saga.step(
    `payment.capture:${input.operation}`,
    async () => {
      const capture = () => payments.capture(reference, { orderId: saga.sagaId, operation: input.operation, expectedAmount: input.expected });
      const pending = (error: unknown) => error instanceof ProblemDetailsException && error.problem.code === 'PAYMENT_NOT_CAPTURABLE' && /PENDING/.test(error.problem.detail ?? '');
      try {
        let captured;
        try {
          captured = await capture();
        } catch (error) {
          if (!pending(error)) throw error;
          // Tarjeta PENDING (PLAN.md §4.8, V2.17): el cliente ya recibió 202 y la saga espera aquí a que la pasarela la
          // autorice, consultándola, y entonces captura. Si no se resuelve a tiempo, se trata como no autorizada.
          await waitWhilePending(() => payments.get(reference), deps.config.paymentPendingWaitMs);
          captured = await capture();
        }
        return { paymentReference: captured.paymentReference, status: captured.status };
      } catch (error) {
        if (error instanceof ProblemDetailsException && error.problem.code === 'PAYMENT_NOT_CAPTURABLE') {
          if (pending(error)) throw problem(409, 'PAYMENT_NOT_AUTHORIZED', 'El pago todavía no está autorizado.', 'La tarjeta sigue pendiente: inténtelo de nuevo con otra tarjeta.');
          throw problem(409, 'PAYMENT_NOT_AUTHORIZED', 'El pago no está autorizado.', `${error.problem.detail ?? 'La tarjeta fue rechazada o la autorización venció.'} Use otra tarjeta.`);
        }
        throw error;
      }
    },
    async () => {
      // Compensación del cobro: reembolso (idempotente por la clave derivada del sagaId). Se consulta el pago y se reembolsa
      // SOLO si lo capturó ESTA saga (`orderId` = sagaId): si la captura falló porque otra orden ya usó la referencia
      // (`ALREADY_CAPTURED`), reembolsar devolvería el dinero de la compra ajena (V2.15: lo encontró la prueba con la Payment
      // API real). Si no se pudo consultar, se reembolsa igual: la clave idempotente y el `orderId` lo hacen seguro.
      const payment = await payments.get(reference).catch(() => undefined);
      if (payment && (payment.status !== 'CAPTURED' || payment['orderId'] !== saga.sagaId)) return;
      await payments.refund({ paymentReference: reference, amount: input.expected, reason: 'SAGA_COMPENSATION', orderId: saga.sagaId }, stableUuid(`refund:${saga.sagaId}:${input.operation}`));
    },
  );
  await claim('AIRLINE_DIRECT');
  return { paymentReference: reference, provider: 'AIRLINE_DIRECT', amount: input.expected };
}

/**
 * El paso `reembolso` del plan: canal Booking → se CALCULA y se registra (`CALCULATED`, lo ejecuta Booking); canal web → se
 * EJECUTA en la Payment API (`SETTLED`). Sin monto, `NOT_REFUNDABLE`.
 */
export async function settleRefund(
  saga: SagaContext,
  deps: { upstreams: Upstreams },
  input: { booking: Pick<BookingView, 'channel' | 'paymentReference' | 'grandTotal'>; amount: string; penaltyAmount: string; penaltyWaived: boolean; percentage: number; reason: 'CUSTOMER_REQUEST' | 'FLIGHT_CANCELLED' | 'SAGA_COMPENSATION' | 'OTHER' },
) {
  const currency = input.booking.grandTotal.currency;
  const base = { refundId: `REF-${saga.sagaId.slice(0, 8).toUpperCase()}`, amount: input.amount, penaltyAmount: input.penaltyAmount, penaltyWaived: input.penaltyWaived, currency, percentage: input.percentage, originalPaymentReference: input.booking.paymentReference ?? null };
  if (toCents(input.amount) === 0) return { ...base, status: 'NOT_REFUNDABLE' as const };
  if (input.booking.channel === 'BOOKING') return { ...base, status: 'CALCULATED' as const };
  return saga.step('refund.settle', async () => {
    const payments = deps.upstreams.payments;
    if (!payments) throw problem(503, 'PROVIDER_UNAVAILABLE', 'La Payment API no está configurada (canal web, V2.15).');
    const refund = await payments.refund({ paymentReference: input.booking.paymentReference!, amount: { currency, total: input.amount }, reason: input.reason, orderId: saga.sagaId }, stableUuid(`refund:${saga.sagaId}`));
    return { ...base, refundId: refund.refundId, status: 'SETTLED' as const, settledAt: refund.createdAt };
  });
}

