import { ProblemDetailsException } from '@ecoairlines/shared';
import { bookingLinks, type Handler, type OperationContext, replayHeaders, type ResponseServiceDefinition, sagaOutcome } from '@ecoairlines/shared/respuesta/index.js';

/**
 * MS.Postventa (contract/ms-postventa.openapi.yaml): las 6 operaciones del contrato v2 con `x-microservice: MS.Postventa`.
 * Las consultas son composiciones del ESB (Bookings + Offers + PostSale) y los cambios, sagas. El reembolso de una cancelación
 * se calcula (`CALCULATED`) para Booking y se ejecuta (`SETTLED`) para la web: lo decide el ESB por el dueño.
 */
export const SERVICE = { name: 'ms-postventa', version: '1.0.0' };
export const CLIENT_ID = 'ECOAIRLINES_MS_POSTVENTA';
export const DEFAULT_PORT = 5003;

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const withLinks = (booking: Any) => ({ ...booking, _links: bookingLinks(booking as { bookingId: string; status?: string }) });

async function currentBooking(context: OperationContext, bookingId: string): Promise<Any> {
  return (await context.esb<Any>({ method: 'GET', path: `/router/bookings/bookings/${bookingId}`, ownerId: context.owner() })).body;
}

/**
 * Motivos de cancelación sin cotización y sin penalidad (D42): `SAGA_COMPENSATION` solo lo puede pedir Booking (su combo
 * falló); `FLIGHT_CANCELLED` no lo pide nadie desde afuera: cuando EcoAirlines cancela un vuelo, la saga "Cambiar estado de
 * vuelo" cancela sus reservas sola. Sin esta regla, cualquiera se llevaría el 100 % sin penalidad.
 */
function checkReason(context: OperationContext): void {
  const reasonCode = (context.body as Any | undefined)?.['reasonCode'];
  // 400 (documentado en `cancelBooking`; 403 no lo está): el motivo no es válido para este cliente.
  const reject = (reason: string) => new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'Motivo de cancelación no permitido.', invalidParams: [{ name: 'reasonCode', reason }] });
  if (reasonCode === 'FLIGHT_CANCELLED') throw reject('las reservas de un vuelo cancelado las cancela EcoAirlines automáticamente');
  if (reasonCode === 'SAGA_COMPENSATION' && context.principal.kind !== 'partner') throw reject('SAGA_COMPENSATION solo lo usa Booking para un combo cancelado');
}

export const postventaHandlers: Record<string, Handler> = {
  getBaggageOptions: async (context) => {
    const response = await context.esb({ method: 'GET', path: `/composition/bookings/${context.params['bookingId']}/baggage-options`, ownerId: context.owner() });
    return { status: 200, body: response.body };
  },

  /** Saga "Agregar maletas". Si sigue en curso, `202` (sin cuerpo, como el contrato): un reintento con la misma clave da el resultado. */
  addBaggage: async (context) => {
    const ownerId = context.owner();
    const response = await context.esb({ method: 'POST', path: `/sagas/bookings/${context.params['bookingId']}/baggage`, json: context.body, ownerId, idempotencyKey: context.headers['idempotency-key'] });
    const outcome = await sagaOutcome(context, response, { ownerId });
    if (!outcome.done) return { status: 202 };
    return { status: 200, body: outcome.body, headers: replayHeaders(outcome.replayed) };
  },

  searchDateChange: async (context) => {
    const response = await context.esb({ method: 'POST', path: `/composition/bookings/${context.params['bookingId']}/date-change/search`, json: context.body, ownerId: context.owner() });
    return { status: 200, body: response.body };
  },

  /** Saga "Cambiar fecha": la reserva cambiada; si sigue en curso, `202` con la reserva como está (`CHANGE_PENDING`). */
  confirmDateChange: async (context) => {
    const ownerId = context.owner();
    const bookingId = context.params['bookingId'] as string;
    const response = await context.esb({ method: 'POST', path: `/sagas/bookings/${bookingId}/date-change`, json: context.body, ownerId, idempotencyKey: context.headers['idempotency-key'] });
    const outcome = await sagaOutcome(context, response, { ownerId });
    if (!outcome.done) return { status: 202, body: withLinks(await currentBooking(context, bookingId)) };
    return { status: 200, body: withLinks(outcome.body as Any), headers: replayHeaders(outcome.replayed) };
  },

  getCancellationQuote: async (context) => {
    const response = await context.esb({ method: 'GET', path: `/composition/bookings/${context.params['bookingId']}/cancellation-quote`, ownerId: context.owner() });
    return { status: 200, body: response.body };
  },

  /** Saga "Cancelar". Si sigue en curso, `202 CANCELLATION_PENDING` (el reembolso se informa con `booking.cancelled`). */
  cancelBooking: async (context) => {
    checkReason(context);
    const ownerId = context.owner();
    const bookingId = context.params['bookingId'] as string;
    const response = await context.esb({ method: 'POST', path: `/sagas/bookings/${bookingId}/cancel`, json: context.body ?? {}, ownerId, idempotencyKey: context.headers['idempotency-key'] });
    const outcome = await sagaOutcome(context, response, { ownerId });
    if (!outcome.done) {
      const booking = await currentBooking(context, bookingId);
      return {
        status: 202,
        body: { bookingId, pnr: booking['pnr'], status: 'CANCELLATION_PENDING', message: 'La cancelación sigue en curso; el resultado llega con el evento booking.cancelled.', _links: bookingLinks({ bookingId, status: 'CANCELLATION_PENDING' }) },
      };
    }
    return { status: 200, body: { ...(outcome.body as Any), _links: bookingLinks({ bookingId, status: 'CANCELLED' }) }, headers: replayHeaders(outcome.replayed) };
  },
};

export function definition(_env: NodeJS.ProcessEnv = process.env): ResponseServiceDefinition {
  return { ...SERVICE, contract: 'ms-postventa.openapi.yaml', handlers: postventaHandlers };
}
