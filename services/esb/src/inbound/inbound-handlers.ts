import { Inject, Injectable } from '@nestjs/common';
import { ProblemDetailsException } from '@ecoairlines/shared';
import { UPSTREAMS, type Upstreams } from '../clients/upstreams.js';
import { ESB_CONFIG, type EsbConfig } from '../config/config.js';
import { CancelBookingSaga, IssueTicketsSaga, PaymentFailedSaga } from '../sagas/booking-sagas.js';
import { SagaEngine, type SagaDefinition } from '../sagas/engine.js';
import type { BookingView } from '../sagas/support.js';
import { assertAmountMatches, assertBookingPaymentReference } from '../transversal/booking-reference.js';
import { stableUuid } from '../transversal/ids.js';
import type { PackageCancelledData, PaymentEventData } from './inbound-event.js';

export { stableUuid };

const rejected = (status: number, code: string, title: string, detail?: string) => new ProblemDetailsException({ status, code, title, ...(detail ? { detail } : {}) });

/**
 * Lo que hace el ESB con cada evento de Booking (D34, capa 2: idempotente aunque el evento llegue repetido con OTRO `id`).
 * Primero se comprueba que el evento sea legítimo (reserva del canal Booking, su referencia de pago y su monto); después se
 * ejecuta la saga con un `sagaId` derivado del `id` del evento: un reintento del mismo evento retoma la misma saga.
 * - `payment.confirmed` → "Emitir boletos";
 * - `payment.failed` → "Pago fallido";
 * - `package.cancelled` → "Cancelar" con `SAGA_COMPENSATION` (100 % sin penalidad, D42).
 * Un error de negocio rechaza el evento; si la saga queda pendiente (un MS.G caído), el evento se reintenta.
 */
@Injectable()
export class InboundHandlers {
  constructor(
    @Inject(UPSTREAMS) private readonly upstreams: Upstreams,
    @Inject(ESB_CONFIG) private readonly config: EsbConfig,
    @Inject(SagaEngine) private readonly engine: SagaEngine,
    @Inject(IssueTicketsSaga) private readonly issueTickets: IssueTicketsSaga,
    @Inject(PaymentFailedSaga) private readonly paymentFailedSaga: PaymentFailedSaga,
    @Inject(CancelBookingSaga) private readonly cancel: CancelBookingSaga,
  ) {}

  /** Solo reservas del canal Booking: un partner nunca confirma, hace fallar ni cancela una reserva de nuestra web. */
  private async bookingOfPartner(bookingId: string): Promise<BookingView> {
    const booking = await this.upstreams.rest.bookings.json<BookingView>('GET', `/bookings/${bookingId}`);
    if (booking.channel !== 'BOOKING') throw rejected(403, 'FORBIDDEN', 'La reserva no es del canal de Booking.', 'Booking solo puede actuar sobre sus propias reservas.');
    return booking;
  }

  /** La referencia del evento debe tener el formato de Booking y ser la MISMA con la que se creó la reserva (y el monto, si llega). */
  private assertPayment(data: PaymentEventData, booking: BookingView, required: boolean): void {
    if (data.paymentReference === undefined && !required) return;
    const reference = assertBookingPaymentReference(data.paymentReference, this.config.bookingPaymentReferencePattern);
    if (booking.paymentReference && booking.paymentReference !== reference) {
      throw rejected(422, 'PAYMENT_REFERENCE_INVALID', 'La referencia de pago no es la de la reserva.', `La reserva ${booking.pnr} se pagó con otra referencia.`);
    }
    assertAmountMatches(data.amount, booking.grandTotal);
  }

  private async saga(definition: SagaDefinition<never, unknown>, input: unknown, sagaId: string): Promise<Record<string, unknown>> {
    const outcome = await this.engine.run(definition, input, { sagaId });
    if (outcome.status === 'PENDING') throw rejected(503, 'PROVIDER_UNAVAILABLE', 'La saga sigue pendiente; el evento se reintenta.');
    return { ...(outcome.result as Record<string, unknown>), sagaId };
  }

  async paymentConfirmed(eventId: string, data: PaymentEventData): Promise<Record<string, unknown>> {
    const booking = await this.bookingOfPartner(data.bookingId);
    this.assertPayment(data, booking, true);
    if (['CANCELLED', 'FAILED', 'CANCELLATION_PENDING'].includes(booking.status)) throw rejected(409, 'BOOKING_NOT_CONFIRMED', `No se emiten boletos de una reserva ${booking.status}.`);
    if (booking.status === 'CONFIRMED' && booking.tickets.length > 0 && booking.tickets.every((ticket) => ticket.status === 'ISSUED')) {
      return { action: 'issue-tickets', bookingId: booking.bookingId, pnr: booking.pnr, issued: 0, alreadyIssued: true };
    }
    const result = await this.saga(this.issueTickets, { bookingId: booking.bookingId, paymentReference: data.paymentReference }, stableUuid(`issue-tickets:${eventId}`));
    return { action: 'issue-tickets', bookingId: booking.bookingId, pnr: booking.pnr, issued: result['issued'], sagaId: result['sagaId'] };
  }

  async paymentFailed(eventId: string, data: PaymentEventData): Promise<Record<string, unknown>> {
    const booking = await this.bookingOfPartner(data.bookingId);
    this.assertPayment(data, booking, false);
    if (booking.status === 'FAILED') return { action: 'payment-failed', bookingId: booking.bookingId, pnr: booking.pnr, alreadyFailed: true };
    const result = await this.saga(this.paymentFailedSaga, { bookingId: booking.bookingId, failureReason: data.failureReason ?? null }, stableUuid(`payment-failed:${eventId}`));
    return { action: 'payment-failed', ...result };
  }

  async packageCancelled(eventId: string, data: PackageCancelledData): Promise<Record<string, unknown>> {
    const booking = await this.bookingOfPartner(data.bookingId);
    const packageId = booking.salesChannel?.packageId;
    if (data.packageId && packageId && data.packageId !== packageId) {
      throw rejected(422, 'VALIDATION_FAILED', 'El combo no es el de la reserva.', `La reserva ${booking.pnr} es del combo ${packageId}.`);
    }
    if (booking.status === 'CANCELLED') return { action: 'cancel', bookingId: booking.bookingId, pnr: booking.pnr, alreadyCancelled: true };
    try {
      const result = await this.saga(this.cancel, { bookingId: booking.bookingId, request: { reasonCode: 'SAGA_COMPENSATION', ...(data.reason ? { reason: data.reason } : {}) } }, stableUuid(`package-cancelled:${eventId}`));
      return { action: 'cancel', bookingId: booking.bookingId, pnr: booking.pnr, refund: result['refund'] ?? null, sagaId: result['sagaId'] };
    } catch (error) {
      if (error instanceof ProblemDetailsException && error.problem.code === 'ALREADY_CANCELLED') return { action: 'cancel', bookingId: booking.bookingId, pnr: booking.pnr, alreadyCancelled: true };
      throw error;
    }
  }
}
