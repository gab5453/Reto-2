import {
  bookingLinks,
  cabinToProto,
  EsbProblem,
  fromProto,
  type Handler,
  holdLinks,
  type OperationContext,
  publicPath,
  replayHeaders,
  type Reply,
  type ResponseServiceDefinition,
  sagaOutcome,
  stillRunning,
  withQuery,
} from '@ecoairlines/shared/respuesta/index.js';

/**
 * MS.Reservas (contract/ms-reservas.openapi.yaml): las 12 operaciones del contrato v2 con `x-microservice: MS.Reservas` y las
 * propias de la web (reserva con asistencia y la asistencia médica). El dueño (D29) siempre sale del token.
 *
 * **Pagos (D28):** con token de partner el `paymentReference` se valida (Booking ya cobró); con token de usuario se captura
 * en la Payment API. Lo decide el ESB por el dueño; aquí el cuerpo pasa exacto al contrato.
 */
export const SERVICE = { name: 'ms-reservas', version: '1.0.0' };
export const CLIENT_ID = 'ECOAIRLINES_MS_RESERVAS';
export const DEFAULT_PORT = 5002;

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Hold = { holdId: string; status: string; expiresAt: string; ttlMinutes: number; remainingSeconds: number; lockedPrice: unknown };

const bookingPath = (bookingId: string) => `/vuelos/bookings/${bookingId}`;
const withLinks = (booking: Any) => ({ ...booking, _links: bookingLinks(booking as { bookingId: string; status?: string }) });

/** La reserva vigente del dueño (para responder `201`/`202` o el resultado de una saga que ya terminó). */
async function currentBooking(context: OperationContext, bookingId: string): Promise<Any> {
  return (await context.esb<Any>({ method: 'GET', path: `/router/bookings/bookings/${bookingId}`, ownerId: context.owner() })).body;
}

/**
 * Saga "Crear reserva" (D36): `201 CONFIRMED` o `202 TICKET_ISSUING`, con `Location`. Un reintento con la misma
 * `Idempotency-Key` responde `200` con la reserva tal como está ahora (la emisión pudo terminar después).
 */
async function createBooking(context: OperationContext, json: unknown): Promise<Reply> {
  const ownerId = context.owner();
  const response = await context.esbRaw<Any>({ method: 'POST', path: '/sagas/bookings', json, ownerId, idempotencyKey: context.headers['idempotency-key'] });
  if (response.status >= 400) throw new EsbProblem(response, response.body ?? {});
  let booking = response.body;
  let status = response.status;
  if (!booking['pnr']) {
    // La saga sigue y la reserva aún no existe: si ya terminó, su reserva; si no, que reintente con la misma clave.
    const outcome = await sagaOutcome(context, response, { ownerId });
    const bookingId = (booking['bookingId'] as string | undefined) ?? (outcome.done ? (outcome.body as Any)?.['bookingId'] : undefined);
    if (!bookingId) throw stillRunning(booking['sagaId']);
    try {
      booking = await currentBooking(context, bookingId);
    } catch (error) {
      if (error instanceof EsbProblem && error.problem.status === 404) throw stillRunning(booking['sagaId']);
      throw error;
    }
    status = booking['status'] === 'TICKET_ISSUING' ? 202 : 201;
  }
  if (response.replayed) {
    booking = await currentBooking(context, booking['bookingId']);
    status = 200;
  }
  return { status, body: withLinks(booking), headers: { Location: publicPath(bookingPath(booking['bookingId'])), ...replayHeaders(response.replayed) } };
}

const holdBody = (hold: Hold, withTtl: boolean) => ({
  holdId: hold.holdId,
  status: hold.status,
  expiresAt: hold.expiresAt,
  ...(withTtl ? { ttlMinutes: hold.ttlMinutes } : { remainingSeconds: hold.remainingSeconds ?? 0 }),
  lockedPrice: hold.lockedPrice,
  _links: holdLinks(hold),
});

export const reservasHandlers: Record<string, Handler> = {
  // ------------------------------------------------------------------------------------------------------------- holds
  createHold: async (context) => {
    const ownerId = context.owner();
    const body = context.body as Any;
    const json = {
      offerId: body['offerId'],
      itinerarySelections: (body['itinerarySelections'] as Any[]).map((s) => ({ itineraryId: s['itineraryId'], cabinClass: cabinToProto(s['cabinClass']), fareBrand: s['fareBrand'] })),
      passengersBreakdown: body['passengersBreakdown'],
      ...(body['ttlMinutes'] !== undefined ? { ttlMinutes: body['ttlMinutes'] } : {}),
      // Offers da prioridad al `ownerId` del mensaje: siempre el del token, nunca uno del cliente.
      ownerId,
    };
    const response = await context.esb<{ hold: Hold }>({ method: 'POST', path: '/router/offers/CreateHold', json, ownerId, idempotencyKey: context.headers['idempotency-key'] });
    const hold = fromProto<Hold>(response.body.hold);
    return { status: response.replayed ? 200 : 201, body: holdBody(hold, true), headers: { Location: publicPath(`/vuelos/offers/hold/${hold.holdId}`), ...replayHeaders(response.replayed) } };
  },

  getHold: async (context) => {
    const ownerId = context.owner();
    const response = await context.esb<{ hold: Hold }>({ method: 'POST', path: '/router/offers/GetHold', json: { holdId: context.params['holdId'], ownerId }, ownerId });
    return { status: 200, body: holdBody(fromProto<Hold>(response.body.hold), false) };
  },

  releaseHold: async (context) => {
    const ownerId = context.owner();
    await context.esb({ method: 'POST', path: '/router/offers/ReleaseHold', json: { holdId: context.params['holdId'], ownerId }, ownerId });
    return { status: 204 };
  },

  // ---------------------------------------------------------------------------------------------------------- reservas
  listBookings: async (context) => {
    const response = await context.esb<{ items: Any[]; nextCursor?: string | null }>({ method: 'GET', path: withQuery('/router/bookings/bookings', context.query), ownerId: context.owner() });
    return { status: 200, body: { items: response.body.items.map(withLinks), nextCursor: response.body.nextCursor ?? null } };
  },

  createBooking: (context) => createBooking(context, context.body),

  getBooking: async (context) => ({ status: 200, body: withLinks(await currentBooking(context, context.params['bookingId'])) }),

  // ----------------------------------------------------------------------------------------------------------- boletos
  listTickets: async (context) => {
    const response = await context.esb({ method: 'GET', path: `/router/bookings/bookings/${context.params['bookingId']}/tickets`, ownerId: context.owner() });
    return { status: 200, body: response.body };
  },

  getTicket: async (context) => {
    const response = await context.esb({ method: 'GET', path: `/router/bookings/bookings/${context.params['bookingId']}/tickets/${encodeURIComponent(context.params['ticketId'])}`, ownerId: context.owner() });
    return { status: 200, body: response.body };
  },

  /** Saga "Emitir boletos": idempotente (`issued: 0` si ya estaban). Si sigue en curso, la reserva en `TICKET_ISSUING`. */
  issueTickets: async (context) => {
    const ownerId = context.owner();
    const bookingId = context.params['bookingId'] as string;
    const response = await context.esb({ method: 'POST', path: `/sagas/bookings/${bookingId}/tickets`, ownerId, idempotencyKey: context.headers['idempotency-key'] });
    const outcome = await sagaOutcome(context, response, { ownerId });
    if (outcome.done) return { status: 200, body: withLinks(outcome.body as Any), headers: replayHeaders(outcome.replayed) };
    const booking = await currentBooking(context, bookingId);
    return { status: 200, body: { bookingId, pnr: booking['pnr'], status: 'TICKET_ISSUING', tickets: booking['tickets'] ?? [], issued: 0, _links: bookingLinks(booking as { bookingId: string; status?: string }) } };
  },

  // ---------------------------------------------------------------------------------------------- asientos y check-in
  changeSeats: async (context) => {
    const ownerId = context.owner();
    const response = await context.esb({ method: 'PUT', path: `/sagas/bookings/${context.params['bookingId']}/seats`, json: context.body, ownerId, idempotencyKey: context.headers['idempotency-key'] });
    const outcome = await sagaOutcome(context, response, { ownerId });
    if (!outcome.done) throw stillRunning(outcome.sagaId);
    return { status: 200, body: { ...(outcome.body as Any), _links: bookingLinks({ bookingId: context.params['bookingId'], status: 'CONFIRMED' }) }, headers: replayHeaders(outcome.replayed) };
  },

  checkIn: async (context) => {
    const ownerId = context.owner();
    const response = await context.esb({ method: 'POST', path: `/sagas/bookings/${context.params['bookingId']}/check-in`, ownerId, idempotencyKey: context.headers['idempotency-key'] });
    const outcome = await sagaOutcome(context, response, { ownerId });
    if (!outcome.done) throw stillRunning(outcome.sagaId);
    const base = bookingPath(context.params['bookingId']);
    const links = { self: { href: publicPath(base), method: 'GET' }, 'boarding-passes': { href: publicPath(`${base}/boarding-passes`), method: 'GET' } };
    return { status: 200, body: { ...(outcome.body as Any), _links: links }, headers: replayHeaders(outcome.replayed) };
  },

  /** Composición del ESB: pases de CheckIn con la puerta vigente de FlightStatus (y el dueño comprobado en Bookings). */
  listBoardingPasses: async (context) => {
    const response = await context.esb({ method: 'GET', path: `/composition/bookings/${context.params['bookingId']}/boarding-passes`, ownerId: context.owner() });
    return { status: 200, body: response.body };
  },

  // ----------------------------------------------------------------------------------------------- propias de la web
  /** Misma saga que `createBooking`, más la asistencia médica (dato de salud: nunca en logs ni en eventos externos). */
  createWebBooking: (context) => {
    const { booking, assistance } = context.body as { booking: Any; assistance?: unknown[] };
    return createBooking(context, { ...booking, ...(assistance?.length ? { assistance } : {}) });
  },

  listAssistance: async (context) => {
    const booking = await currentBooking(context, context.params['bookingId']);
    return { status: 200, body: booking['assistance'] ?? [] };
  },

  /** Reembolsos de la reserva (V2.13, `Booking.refunds` de la web): los guarda Bookings y el contrato v2 no los publica. */
  listRefunds: async (context) => {
    const booking = await currentBooking(context, context.params['bookingId']);
    return { status: 200, body: booking['refunds'] ?? [] };
  },

  saveAssistance: async (context) => {
    const response = await context.esb({
      method: 'PUT',
      path: `/router/bookings/bookings/${context.params['bookingId']}/passengers/${encodeURIComponent(context.params['passengerId'])}/assistance`,
      json: context.body,
      ownerId: context.owner(),
    });
    return { status: 200, body: response.body };
  },

  deleteAssistance: async (context) => {
    await context.esb({ method: 'DELETE', path: `/router/bookings/bookings/${context.params['bookingId']}/passengers/${encodeURIComponent(context.params['passengerId'])}/assistance`, ownerId: context.owner() });
    return { status: 204 };
  },
};

export function definition(_env: NodeJS.ProcessEnv = process.env): ResponseServiceDefinition {
  return { ...SERVICE, contract: 'ms-reservas.openapi.yaml', handlers: reservasHandlers };
}
