import { Inject, Injectable } from '@nestjs/common';
import { formatCents, type MoneyAmount, moneyFromCents, ProblemDetailsException, resolvePassengerCounts, sameAmount, toCents } from '@ecoairlines/shared';
import {
  ACTIVE_STATUSES,
  type AssistanceRecord,
  type AssistanceType,
  type BookingRecord,
  type BookingStatus,
  channelOf,
  type ItineraryOption,
  type PassengerItem,
  type PaymentOperation,
  type PaymentProvider,
  type PaymentRecord,
  partnerOf,
  type PurchasedFare,
  type Refund,
  type SalesChannel,
  type SalesChannelCode,
} from '../domain/model.js';
import {
  assertPassengers,
  fareOfSegment,
  fullName,
  generatePnr,
  identityKey,
  issueTickets,
  MAX_EXTRA_BAGS,
  pendingTickets,
  reissueCoupons,
  type SegmentInfo,
  segmentsOf,
  unflown,
} from '../domain/rules.js';
import { BOOKINGS_STORE, type BookingsStore, type BookingsTx, decodeCursor, encodeCursor } from '../repositories/bookings.store.js';

/**
 * Texto del historial de un cambio de asientos. El check-in hecho por un administrador (llega con `X-Actor-Id` y sin dueño: el
 * check-in en mostrador, D57) se distingue del que hace el pasajero.
 */
function changeDescription(reason: 'CUSTOMER_CHANGE' | 'CHECK_IN_AUTO', count: number, caller: Caller): string {
  if (reason !== 'CHECK_IN_AUTO') return `Cambio de ${count} asiento(s).`;
  return caller.actorId && !caller.ownerId ? `Check-in en mostrador (administrador) de ${count} pasajero(s)-segmento.` : `Check-in de ${count} pasajero(s)-segmento.`;
}

const problem = (status: number, code: string, title: string, extra: { detail?: string; invalidParams?: { name: string; reason: string }[] } = {}) =>
  new ProblemDetailsException({ status, code, title, ...extra });
const notFound = () => problem(404, 'NOT_FOUND', 'Reserva no encontrada.');
/** Motivo de cancelación en palabras para el historial (error 6 del PLAN_Correccion). */
const CANCEL_REASONS: Record<string, string> = {
  CUSTOMER_REQUEST: 'a pedido del cliente',
  FLIGHT_CANCELLED: 'por cancelación del vuelo',
  SAGA_COMPENSATION: 'por Booking (paquete cancelado)',
  OTHER: 'por otro motivo',
};
/** Estados que no se cobraron: no cuentan en Ingresos ni en Reportes (D-C3). */
const UNCHARGED_STATUSES = ['FAILED', 'PENDING', 'PENDING_PAYMENT'];
const PARTNER_REFERENCE = /^PAY-[A-Z0-9-]{6,60}$/;
const DIRECT_REFERENCE = /^[A-Za-z0-9_-]{6,80}$/;

/** Quién llama (D29): dueño (cliente web o partner), administrador o una saga sin usuario. */
export interface Caller {
  ownerId?: string;
  actorId?: string;
}

export interface CreateBookingCommand {
  bookingId: string;
  sagaId: string;
  holdId: string;
  offerId: string;
  passengersBreakdown: { adults?: number; youths?: number; children?: number; infants?: number };
  passengers: PassengerItem[];
  itineraries: ItineraryOption[];
  fares: PurchasedFare[];
  grandTotal: MoneyAmount;
  payment: { paymentReference: string; provider: PaymentProvider };
  salesChannel?: SalesChannel;
  assistance?: { passengerId: string; type: AssistanceType; needsCompanion?: boolean; notes?: string }[];
}

/**
 * MS.G.Bookings: la reserva y todo lo que le pertenece. Nunca llama a otro servicio: cada método es un paso de una saga del
 * ESB (PLAN §4.2) o una consulta. Sin duplicados (D34): reserva idempotente por `bookingId`, un hold por reserva, una
 * referencia de pago una sola vez, un documento una sola vez por vuelo, boletos emitidos una sola vez.
 */
@Injectable()
export class BookingsService {
  constructor(@Inject(BOOKINGS_STORE) private readonly store: BookingsStore) {}

  now = (): number => Date.now();

  // ------------------------------------------------------------------ pasajeros
  /** Reglas de los pasajeros y documento único por vuelo (entre reservas no canceladas). No guarda nada. */
  async validatePassengers(input: { passengers: PassengerItem[]; passengersBreakdown: CreateBookingCommand['passengersBreakdown']; segments: SegmentInfo[] }) {
    assertPassengers(input.passengers, resolvePassengerCounts(input.passengersBreakdown), input.segments);
    const holders = await this.store.transaction((tx) => tx.documentHolders(this.claimsFor(input.passengers, input.segments.map((s) => s.segmentId), '')));
    if (holders.length) throw this.alreadyOnFlight(holders[0].segmentId);
    return { valid: true as const };
  }

  // ------------------------------------------------------------------ pagos recibidos
  /**
   * Uso único de una referencia de pago en todo el sistema. Canal Booking: formato `PAY-…` (BKG-02) y monto igual al esperado.
   * Repetir con la misma referencia, operación y `sagaId` devuelve el registro (reintento de la saga): `created = false`.
   */
  async claimPayment(input: { sagaId: string; paymentReference: string; provider: PaymentProvider; operation: PaymentOperation; bookingId?: string; amount?: MoneyAmount; expectedAmount: MoneyAmount }) {
    const pattern = input.provider === 'BOOKING_PROTOTIPO' ? PARTNER_REFERENCE : DIRECT_REFERENCE;
    if (!pattern.test(input.paymentReference)) {
      throw problem(422, 'PAYMENT_REFERENCE_INVALID', 'La referencia de pago no es válida o ya fue usada.', { invalidParams: [{ name: 'paymentReference', reason: `formato ${pattern.source}` }] });
    }
    if (input.amount && !sameAmount(input.amount, input.expectedAmount)) {
      throw problem(422, 'AMOUNT_MISMATCH', 'El monto pagado no coincide con el precio.', { detail: `Pagado ${input.amount.total} ${input.amount.currency}; esperado ${input.expectedAmount.total} ${input.expectedAmount.currency}.` });
    }
    return this.store.transaction(async (tx) => {
      const record: PaymentRecord = {
        paymentReference: input.paymentReference,
        provider: input.provider,
        operation: input.operation,
        amount: input.amount ?? input.expectedAmount,
        bookingId: input.bookingId ?? null,
        sagaId: input.sagaId,
        claimedAt: new Date(this.now()).toISOString(),
      };
      if (await tx.insertPayment(record)) return { record, created: true };
      const existing = (await tx.payment(input.paymentReference))!;
      if (existing.sagaId === input.sagaId && existing.operation === input.operation) return { record: existing, created: false };
      throw problem(422, 'PAYMENT_REFERENCE_INVALID', 'La referencia de pago no es válida o ya fue usada.', { detail: 'La referencia ya se usó en otra operación.' });
    });
  }

  /** Compensación: libera la referencia si la creó esa saga y no quedó en una reserva confirmada. Idempotente. */
  async releasePayment(reference: string, sagaId: string): Promise<void> {
    await this.store.transaction(async (tx) => {
      const record = await tx.payment(reference);
      if (!record || record.sagaId !== sagaId) return;
      if (record.bookingId) {
        const booking = await tx.booking(record.bookingId);
        if (booking && ['CONFIRMED', 'CANCELLED', 'CHANGE_PENDING', 'CANCELLATION_PENDING'].includes(booking.status)) {
          throw problem(409, 'BOOKING_NOT_CANCELLABLE', 'La referencia ya pertenece a una reserva confirmada.');
        }
      }
      await tx.deletePayment(reference);
    });
  }

  // ------------------------------------------------------------------ reservas
  /**
   * Crea la reserva en TICKET_ISSUING con su PNR. Idempotente por `bookingId` (mismo hold → la existente, `created = false`;
   * otro hold → BOOKING_ID_CONFLICT). Reserva los documentos en cada vuelo y une la referencia de pago ya registrada.
   */
  async create(command: CreateBookingCommand, ownerId: string): Promise<{ booking: BookingRecord; created: boolean }> {
    const bookingId = command.bookingId.toLowerCase();
    const holdId = command.holdId.toLowerCase();
    return this.store.transaction(async (tx) => {
      const existing = await tx.booking(bookingId);
      if (existing) {
        if (existing.holdId !== holdId) throw problem(409, 'BOOKING_ID_CONFLICT', 'Ya existe una reserva con ese bookingId para otro hold.');
        return { booking: existing, created: false };
      }
      if (await tx.bookingByHold(holdId)) throw problem(409, 'HOLD_ALREADY_CONSUMED', 'El hold ya se usó para otra reserva.');
      const payment = await tx.payment(command.payment.paymentReference);
      if (!payment || payment.sagaId !== command.sagaId || payment.operation !== 'BOOKING' || (payment.bookingId && payment.bookingId !== bookingId)) {
        throw problem(422, 'PAYMENT_REFERENCE_INVALID', 'La referencia de pago no está registrada para esta reserva.', { detail: 'Primero se registra con POST /payment-references/claim.' });
      }
      const now = new Date(this.now()).toISOString();
      const base: Omit<BookingRecord, 'pnr' | 'tickets'> = {
        bookingId,
        ownerId,
        channel: channelOf(ownerId),
        partnerId: partnerOf(ownerId),
        status: 'TICKET_ISSUING',
        holdId,
        offerId: command.offerId,
        sagaId: command.sagaId,
        passengersBreakdown: resolvePassengerCounts(command.passengersBreakdown),
        passengers: command.passengers,
        itineraries: command.itineraries,
        fares: command.fares,
        grandTotal: command.grandTotal,
        payment: command.payment,
        ...(command.salesChannel ? { salesChannel: command.salesChannel } : {}),
        changes: [{ changedAt: now, description: 'Reserva creada; boletos en emisión.' }],
        refunds: [],
        checkedIn: [],
        createdAt: now,
        updatedAt: now,
      };
      let booking: BookingRecord | undefined;
      for (let attempt = 0; attempt < 5 && !booking; attempt++) {
        const candidate = { ...base, pnr: generatePnr(), tickets: pendingTickets(base) };
        const result = await tx.insertBooking(candidate);
        if (result === 'ok') booking = candidate;
        else if (result === 'hold-taken') throw problem(409, 'HOLD_ALREADY_CONSUMED', 'El hold ya se usó para otra reserva.');
        else if (result === 'id-exists') {
          // Reintento simultáneo de la saga: la otra petición la creó mientras esta esperaba. Ya confirmada, se ve al releer.
          const concurrent = await tx.booking(bookingId);
          if (concurrent?.holdId !== holdId) throw problem(409, 'BOOKING_ID_CONFLICT', 'Ya existe una reserva con ese bookingId para otro hold.');
          return { booking: concurrent, created: false };
        }
      }
      if (!booking) throw problem(500, 'INTERNAL_ERROR', 'No se pudo generar un PNR único.');
      const conflicts = await tx.claimDocuments(this.claimsFor(booking.passengers, segmentsOf(booking).map((s) => s.segmentId), bookingId));
      if (conflicts.length) throw this.alreadyOnFlight(conflicts[0].segmentId, 422);
      await tx.savePayment({ ...payment, bookingId });
      for (const request of command.assistance ?? []) {
        if (!booking.passengers.some((passenger) => passenger.passengerId === request.passengerId)) {
          throw problem(400, 'VALIDATION_FAILED', 'La asistencia es de un pasajero que no está en la reserva.', { invalidParams: [{ name: 'assistance.passengerId', reason: 'desconocido' }] });
        }
        await tx.saveAssistance({ bookingId, passengerId: request.passengerId, type: request.type, needsCompanion: request.needsCompanion ?? false, ...(request.notes ? { notes: request.notes } : {}), status: 'REQUESTED', updatedAt: now });
      }
      return { booking, created: true };
    });
  }

  async get(bookingId: string, caller: Caller) {
    return this.store.transaction(async (tx) => this.view(tx, await this.owned(tx, bookingId, caller), caller));
  }

  async list(
    caller: Caller,
    filter: { pnr?: string; status?: BookingStatus; channel?: SalesChannelCode; createdFrom?: string; createdTo?: string; reference?: string },
    limit: number,
    cursor?: string,
  ) {
    if (!caller.ownerId && !caller.actorId) {
      throw problem(400, 'VALIDATION_FAILED', 'El listado exige X-Owner-Id o X-Actor-Id.', { invalidParams: [{ name: 'X-Owner-Id', reason: 'obligatorio sin X-Actor-Id' }] });
    }
    const offset = decodeCursor(cursor);
    const page = await this.store.transaction((tx) =>
      tx.listBookings({ ...filter, ...(caller.ownerId ? { ownerId: caller.ownerId } : {}), ...(caller.actorId ? {} : { channel: undefined, reference: undefined }) }, limit, offset),
    );
    return {
      items: page.items.map((booking) => {
        const first = booking.itineraries[0];
        return {
          bookingId: booking.bookingId,
          pnr: booking.pnr,
          status: booking.status,
          origin: first.segments[0].departure.iataCode,
          destination: first.segments.at(-1)!.arrival.iataCode,
          departureDate: first.segments[0].departure.at.slice(0, 10),
          grandTotal: booking.grandTotal,
          // Panel de administración (O-1): de dónde vino la venta y cuánto se devolvió, sin abrir el detalle.
          ...(caller.actorId ? adminSummary(booking) : {}),
        };
      }),
      nextCursor: page.hasMore ? encodeCursor(offset + limit) : null,
    };
  }

  /** Pago fallido o compensación: → FAILED, libera la referencia de pago y los documentos. Idempotente. */
  async fail(bookingId: string, errorCode: string, reason?: string) {
    return this.store.transaction(async (tx) => {
      const booking = await this.owned(tx, bookingId, {});
      if (booking.status === 'FAILED') return this.view(tx, booking, {});
      if (booking.status === 'CANCELLED') throw problem(409, 'ALREADY_CANCELLED', 'La reserva ya está cancelada.');
      if (!['PENDING', 'PENDING_PAYMENT', 'TICKET_ISSUING'].includes(booking.status)) {
        throw problem(409, 'BOOKING_NOT_CANCELLABLE', 'Una reserva con boletos emitidos se cancela; no se marca como fallida.');
      }
      const now = new Date(this.now()).toISOString();
      const updated: BookingRecord = {
        ...booking,
        status: 'FAILED',
        failure: { errorCode, ...(reason ? { reason } : {}) },
        tickets: booking.tickets.map((ticket) => ({ ...ticket, status: 'FAILED' as const, failureReason: errorCode })),
        changes: [...booking.changes, { changedAt: now, description: `Reserva fallida (${errorCode}).` }],
        updatedAt: now,
      };
      await tx.saveBooking(updated);
      await tx.releaseDocuments(booking.bookingId);
      const payment = await tx.payment(booking.payment.paymentReference);
      if (payment?.bookingId === booking.bookingId) await tx.deletePayment(payment.paymentReference);
      return this.view(tx, updated, {});
    });
  }

  /** Lo que PostSale necesita para cotizar: tarifas, itinerarios no volados y equipaje (incluido y comprado). */
  async fares(bookingId: string, caller: Caller) {
    return this.store.transaction(async (tx) => {
      const booking = await this.owned(tx, bookingId, caller);
      return {
        bookingId: booking.bookingId,
        status: booking.status,
        channel: booking.channel,
        partnerId: booking.partnerId,
        fares: booking.fares,
        unflownItineraryIds: unflown(booking, this.now()).map((itinerary) => itinerary.itineraryId),
        baggage: booking.passengers.flatMap((passenger) =>
          booking.itineraries.map((itinerary) => ({
            passengerId: passenger.passengerId,
            itineraryId: itinerary.itineraryId,
            included: passenger.passengerType === 'INFANT' ? 0 : (itinerary.pricingOptions?.[0]?.baggageAllowance?.checkedBaggageIncluded ?? 0),
            purchased: (passenger.extraBaggage ?? []).filter((bag) => bag.itineraryId === itinerary.itineraryId).reduce((sum, bag) => sum + bag.quantity, 0),
          })),
        ),
        paymentReference: booking.payment.paymentReference,
      };
    });
  }

  // ------------------------------------------------------------------ boletos
  /** Un boleto por pasajero con un cupón por segmento; → CONFIRMED. Si ya estaban emitidos: `issued: 0`. */
  async issueTickets(bookingId: string, caller: Caller) {
    return this.store.transaction(async (tx) => {
      const booking = await this.owned(tx, bookingId, caller);
      if (!['TICKET_ISSUING', 'CONFIRMED', 'CHANGE_PENDING'].includes(booking.status)) {
        throw problem(409, 'BOOKING_NOT_CONFIRMED', `No se pueden emitir boletos de una reserva ${booking.status}.`);
      }
      const now = new Date(this.now()).toISOString();
      const { tickets, issued } = issueTickets(booking, now);
      const updated: BookingRecord = issued
        ? { ...booking, status: 'CONFIRMED', tickets, changes: [...booking.changes, { changedAt: now, description: `${issued} boleto(s) emitidos.` }], updatedAt: now }
        : booking;
      if (issued) await tx.saveBooking(updated);
      return { bookingId: updated.bookingId, pnr: updated.pnr, status: 'CONFIRMED' as const, tickets: updated.tickets, issued };
    });
  }

  async tickets(bookingId: string, caller: Caller) {
    const booking = await this.store.transaction((tx) => this.owned(tx, bookingId, caller));
    return { bookingId: booking.bookingId, tickets: booking.tickets };
  }

  async ticket(bookingId: string, ticketId: string, caller: Caller) {
    const { tickets } = await this.tickets(bookingId, caller);
    const ticket = tickets.find((candidate) => candidate.ticketId === ticketId);
    if (!ticket) throw problem(404, 'NOT_FOUND', 'Boleto no encontrado.');
    return ticket;
  }

  // ------------------------------------------------------------------ asientos
  /** Valida un cambio de asientos y devuelve el plan para Offers (no cambia nada). */
  async planSeats(bookingId: string, seats: { passengerId: string; segmentId: string; seatNumber: string }[], caller: Caller) {
    return this.store.transaction(async (tx) => {
      const booking = await this.owned(tx, bookingId, caller);
      return { bookingId: booking.bookingId, changes: this.seatPlan(booking, seats, true) };
    });
  }

  /**
   * Guarda los asientos nuevos (todos o ninguno). `CHECK_IN_AUTO`: los del check-in (sin pago), y marca a esos pasajeros con
   * check-in en esos segmentos. `CUSTOMER_CHANGE`: cambio pedido por el cliente (con su pago si tuvo costo).
   */
  async applySeats(bookingId: string, input: { reason: 'CUSTOMER_CHANGE' | 'CHECK_IN_AUTO'; seats: { passengerId: string; segmentId: string; seatNumber: string }[]; amountCharged?: MoneyAmount; paymentReference?: string }, caller: Caller) {
    return this.store.transaction(async (tx) => {
      const booking = await this.owned(tx, bookingId, caller);
      const plan = this.seatPlan(booking, input.seats, input.reason === 'CUSTOMER_CHANGE');
      if (input.paymentReference) await this.linkPayment(tx, input.paymentReference, booking.bookingId, 'SEATS');
      const now = new Date(this.now()).toISOString();
      const passengers = booking.passengers.map((passenger) => {
        const mine = input.seats.filter((seat) => seat.passengerId === passenger.passengerId);
        if (!mine.length) return passenger;
        const kept = (passenger.assignedSeats ?? []).filter((seat) => !mine.some((change) => change.segmentId === seat.segmentId));
        return { ...passenger, assignedSeats: [...kept, ...mine.map(({ segmentId, seatNumber }) => ({ segmentId, seatNumber }))] };
      });
      const checkedIn =
        input.reason === 'CHECK_IN_AUTO'
          ? [...booking.checkedIn, ...input.seats.filter((seat) => !booking.checkedIn.some((c) => c.segmentId === seat.segmentId && c.passengerId === seat.passengerId)).map(({ segmentId, passengerId }) => ({ segmentId, passengerId }))]
          : booking.checkedIn;
      const updated: BookingRecord = {
        ...booking,
        passengers,
        checkedIn,
        changes: [...booking.changes, { changedAt: now, description: changeDescription(input.reason, input.seats.length, caller) }],
        updatedAt: now,
      };
      updated.tickets = reissueCoupons(updated, now);
      await tx.saveBooking(updated);
      return {
        bookingId: booking.bookingId,
        seats: plan.map((change) => ({
          passengerId: change.passengerId,
          segmentId: change.segmentId,
          previousSeatNumber: change.previousSeatNumber,
          seatNumber: change.seatNumber,
          status: input.reason === 'CHECK_IN_AUTO' ? 'CHECKED_IN' : change.targetStatus,
        })),
        ...(input.amountCharged ? { amountCharged: input.amountCharged } : {}),
      };
    });
  }

  // ------------------------------------------------------------------ postventa
  async applyBaggage(bookingId: string, input: { passengerId: string; itineraryId: string; quantity: number; amountCharged: MoneyAmount; paymentReference: string }, caller: Caller) {
    return this.store.transaction(async (tx) => {
      const booking = this.confirmed(await this.owned(tx, bookingId, caller));
      // D56 (12/11, revoca D55): también después del check-in.
      const passenger = booking.passengers.find((candidate) => candidate.passengerId === input.passengerId);
      if (!passenger || passenger.passengerType === 'INFANT') throw problem(400, 'VALIDATION_FAILED', 'Pasajero inválido para maletas.', { invalidParams: [{ name: 'passengerId', reason: 'no existe o es infante' }] });
      if (!unflown(booking, this.now()).some((itinerary) => itinerary.itineraryId === input.itineraryId)) {
        throw problem(409, 'FLIGHT_ALREADY_DEPARTED', 'El itinerario ya salió o no es de la reserva.');
      }
      const current = (passenger.extraBaggage ?? []).filter((bag) => bag.itineraryId === input.itineraryId).reduce((sum, bag) => sum + bag.quantity, 0);
      if (current + input.quantity > MAX_EXTRA_BAGS) throw problem(400, 'VALIDATION_FAILED', `Máximo ${MAX_EXTRA_BAGS} maletas extra por pasajero e itinerario.`, { invalidParams: [{ name: 'quantity', reason: `ya tiene ${current}` }] });
      await this.linkPayment(tx, input.paymentReference, booking.bookingId, 'BAGGAGE');
      const now = new Date(this.now()).toISOString();
      const total = current + input.quantity;
      const passengers = booking.passengers.map((candidate) =>
        candidate.passengerId !== passenger.passengerId
          ? candidate
          : { ...candidate, extraBaggage: [...(candidate.extraBaggage ?? []).filter((bag) => bag.itineraryId !== input.itineraryId), { itineraryId: input.itineraryId, quantity: total }] },
      );
      await tx.saveBooking({ ...booking, passengers, changes: [...booking.changes, { changedAt: now, description: `${input.quantity} maleta(s) extra (${input.amountCharged.total} ${input.amountCharged.currency}).` }], updatedAt: now });
      return { passengerId: input.passengerId, itineraryId: input.itineraryId, totalBaggage: total };
    });
  }

  /** Reemplaza los itinerarios cambiados y su tarifa, reemite los cupones y mueve los documentos a los vuelos nuevos. */
  async applyDateChange(
    bookingId: string,
    input: { changeOfferId: string; replacedItineraryIds: string[]; newItineraries: ItineraryOption[]; newFares: PurchasedFare[]; priceDifference: MoneyAmount; paymentReference?: string | null; assignedSeats?: { passengerId: string; segmentId: string; seatNumber: string }[] },
    caller: Caller,
  ) {
    return this.store.transaction(async (tx) => {
      const booking = this.confirmed(await this.owned(tx, bookingId, caller));
      // D56 (12/11, revoca D55): también después del check-in.
      const replaced = booking.itineraries.filter((itinerary) => input.replacedItineraryIds.includes(itinerary.itineraryId));
      if (replaced.length !== input.replacedItineraryIds.length) throw problem(400, 'VALIDATION_FAILED', 'Un itinerario a cambiar no es de la reserva.', { invalidParams: [{ name: 'replacedItineraryIds', reason: 'desconocido' }] });
      if (replaced.some((itinerary) => !unflown(booking, this.now()).includes(itinerary))) throw problem(409, 'FLIGHT_ALREADY_DEPARTED', 'Un itinerario a cambiar ya salió.');
      if (input.paymentReference) await this.linkPayment(tx, input.paymentReference, booking.bookingId, 'DATE_CHANGE');
      const oldSegments = replaced.flatMap((itinerary) => itinerary.segments.map((segment) => segment.segmentId));
      const now = new Date(this.now()).toISOString();
      const itineraries = [...booking.itineraries.filter((itinerary) => !input.replacedItineraryIds.includes(itinerary.itineraryId)), ...input.newItineraries]
        .sort((a, b) => a.segments[0].departure.at.localeCompare(b.segments[0].departure.at));
      const fares = [...booking.fares.filter((fare) => !input.replacedItineraryIds.includes(fare.itineraryId)), ...input.newFares];
      const passengers = booking.passengers.map((passenger) => ({
        ...passenger,
        assignedSeats: [
          ...(passenger.assignedSeats ?? []).filter((seat) => !oldSegments.includes(seat.segmentId)),
          ...(input.assignedSeats ?? []).filter((seat) => seat.passengerId === passenger.passengerId).map(({ segmentId, seatNumber }) => ({ segmentId, seatNumber })),
        ],
        extraBaggage: (passenger.extraBaggage ?? []).filter((bag) => !input.replacedItineraryIds.includes(bag.itineraryId)),
      }));
      const updated: BookingRecord = {
        ...booking,
        itineraries,
        fares,
        passengers,
        checkedIn: booking.checkedIn.filter((entry) => !oldSegments.includes(entry.segmentId)),
        changes: [...booking.changes, { changedAt: now, description: `Cambio de fecha (${input.changeOfferId}); diferencia ${input.priceDifference.total} ${input.priceDifference.currency}.` }],
        updatedAt: now,
      };
      updated.tickets = reissueCoupons(updated, now);
      await tx.releaseDocuments(booking.bookingId, oldSegments);
      const conflicts = await tx.claimDocuments(this.claimsFor(passengers, input.newItineraries.flatMap((i) => i.segments.map((s) => s.segmentId)), booking.bookingId));
      if (conflicts.length) throw this.alreadyOnFlight(conflicts[0].segmentId, 409);
      await tx.saveBooking(updated);
      return this.view(tx, updated, caller);
    });
  }

  /** → CANCELLED, boletos VOIDED y el reembolso (CALCULATED en el canal Booking, SETTLED en la web). Ya cancelada → ALREADY_CANCELLED. */
  async applyCancellation(bookingId: string, input: { reasonCode: string; reason?: string; quoteId?: string | null; refund: Refund; seatsReleased: number }, caller: Caller) {
    return this.store.transaction(async (tx) => {
      const booking = await this.owned(tx, bookingId, caller);
      if (booking.status === 'CANCELLED') {
        throw problem(409, 'ALREADY_CANCELLED', 'La reserva ya estaba cancelada.', { detail: JSON.stringify(booking.cancellation ?? {}) });
      }
      if (!['CONFIRMED', 'TICKET_ISSUING', 'CANCELLATION_PENDING', 'CHANGE_PENDING'].includes(booking.status)) {
        throw problem(409, 'BOOKING_NOT_CANCELLABLE', `Una reserva ${booking.status} no se puede cancelar.`);
      }
      // D56 (12/11, revoca D55): también se cancela después del check-in; el ESB anula el check-in en MS.G.CheckIn.
      const now = new Date(this.now()).toISOString();
      const voided = booking.tickets.filter((ticket) => ticket.status === 'ISSUED').map((ticket) => ticket.ticketId);
      const refund: Refund = { ...input.refund, originalPaymentReference: input.refund.originalPaymentReference ?? booking.payment.paymentReference };
      const cancellation = {
        bookingId: booking.bookingId,
        pnr: booking.pnr,
        status: 'CANCELLED' as const,
        cancelledAt: now,
        reasonCode: input.reasonCode,
        refund,
        ticketsVoided: voided,
        inventoryRestoration: { status: 'RESTORED' as const, seatsReleased: input.seatsReleased, newSeatStatus: 'AVAILABLE' },
        message:
          refund.status === 'CALCULATED'
            ? `Reembolso de ${refund.amount} ${refund.currency} calculado: lo ejecuta ${booking.partnerId ?? 'el partner'}.`
            : refund.status === 'SETTLED'
              ? `Reembolso de ${refund.amount} ${refund.currency} acreditado.`
              : 'La tarifa no es reembolsable.',
      };
      const updated: BookingRecord = {
        ...booking,
        status: 'CANCELLED',
        tickets: booking.tickets.map((ticket) => (ticket.status === 'ISSUED' || ticket.status === 'PENDING' ? { ...ticket, status: 'VOIDED' as const } : ticket)),
        refunds: [...booking.refunds, refund],
        cancellation,
        changes: [...booking.changes, { changedAt: now, description: cancellationText(input.reasonCode, input.reason) }],
        updatedAt: now,
      };
      await tx.saveBooking(updated);
      await tx.releaseDocuments(booking.bookingId);
      return cancellation;
    });
  }

  // ------------------------------------------------------------------ vuelos e indicadores
  /** Reservas activas de un vuelo (saga "Cambiar estado de vuelo": `affectedBookings`). */
  async flightBookings(flightNumber: string, date: string) {
    const segmentId = `${flightNumber}-${date.replaceAll('-', '')}`;
    const bookings = (await this.store.transaction((tx) => tx.flightBookings(segmentId))).filter((booking) => ACTIVE_STATUSES.includes(booking.status));
    return {
      flightNumber,
      date,
      total: bookings.length,
      items: bookings.map((booking) => ({ bookingId: booking.bookingId, pnr: booking.pnr, status: booking.status, channel: booking.channel, partnerId: booking.partnerId, passengers: booking.passengers.length })),
    };
  }

  /** Pasajeros con asistencia de un vuelo (solo el administrador). */
  async flightAssistance(flightNumber: string, date: string) {
    const segmentId = `${flightNumber}-${date.replaceAll('-', '')}`;
    return this.store.transaction(async (tx) => {
      const items = [];
      for (const booking of (await tx.flightBookings(segmentId)).filter((b) => ACTIVE_STATUSES.includes(b.status))) {
        for (const record of await tx.assistance(booking.bookingId)) {
          const passenger = booking.passengers.find((candidate) => candidate.passengerId === record.passengerId)!;
          items.push({
            bookingId: booking.bookingId,
            pnr: booking.pnr,
            passengerId: record.passengerId,
            passengerName: fullName(passenger),
            segmentId,
            seatNumber: passenger.assignedSeats?.find((seat) => seat.segmentId === segmentId)?.seatNumber ?? null,
            assistance: toAssistance(record),
          });
        }
      }
      return items;
    });
  }

  /**
   * Indicadores del panel. **Ingresos = cobrado − reembolsado** de toda reserva que se cobró (D-C3, la misma regla que el reporte
   * de ventas): una cancelada aporta la penalidad que se retuvo y una no reembolsable aporta todo. Los impuestos de los ingresos
   * son los de las reservas que siguen vigentes (al cancelar, los impuestos se devuelven siempre); el resto es tarifa.
   */
  async summary(from?: string, to?: string) {
    const { bookings, rows } = await this.store.transaction(async (tx) => {
      const all = await tx.bookingsCreatedBetween(from, to);
      return { bookings: all, rows: await this.chargedRows(tx, all) };
    });
    const sold = bookings.filter((booking) => booking.status === 'CONFIRMED' || booking.status === 'CHANGE_PENDING');
    const byStatus: Record<string, number> = {};
    for (const booking of bookings) byStatus[booking.status] = (byStatus[booking.status] ?? 0) + 1;
    const byRoute = new Map<string, { origin: string; destination: string; bookings: number; cents: number }>();
    for (const row of rows) {
      const first = row.booking.itineraries[0];
      const key = `${first.segments[0].departure.iataCode}-${first.segments.at(-1)!.arrival.iataCode}`;
      const entry = byRoute.get(key) ?? { origin: key.slice(0, 3), destination: key.slice(4), bookings: 0, cents: 0 };
      entry.bookings++;
      entry.cents += row.charged - row.refunded;
      byRoute.set(key, entry);
    }
    const net = rows.reduce((sum, row) => sum + row.charged - row.refunded, 0);
    const taxes = rows.filter((row) => row.booking.status !== 'CANCELLED').reduce((sum, row) => sum + toCents(row.booking.grandTotal.taxes), 0);
    const refunds = bookings.flatMap((booking) => booking.refunds).filter((refund) => refund.status === 'CALCULATED');
    return {
      totalBookings: bookings.length,
      byStatus,
      byChannel: { WEB: bookings.filter((b) => b.channel === 'WEB').length, BOOKING: bookings.filter((b) => b.channel === 'BOOKING').length },
      totalPassengers: sold.reduce((sum, booking) => sum + booking.passengers.length, 0),
      revenue: moneyFromCents(net - Math.min(taxes, net), Math.min(taxes, net)),
      refundsCalculated: moneyFromCents(refunds.reduce((sum, refund) => sum + toCents(refund.amount), 0), 0),
      byRoute: [...byRoute.values()].map((route) => ({ origin: route.origin, destination: route.destination, bookings: route.bookings, revenue: (route.cents / 100).toFixed(2) })),
    };
  }

  /**
   * Lo cobrado y lo reembolsado de cada reserva que se cobró (no FAILED ni pendiente de pago). Lo cobrado es la suma de sus
   * referencias de pago registradas (reserva, asientos, maletas, cambio de fecha); sin referencias, su total.
   */
  private async chargedRows(tx: BookingsTx, bookings: BookingRecord[]) {
    const result = [];
    for (const booking of bookings.filter((candidate) => !UNCHARGED_STATUSES.includes(candidate.status))) {
      const payments = await tx.paymentsOf(booking.bookingId);
      const charged = payments.length ? payments.reduce((sum, payment) => sum + toCents(payment.amount.total), 0) : toCents(booking.grandTotal.total);
      const refunded = booking.refunds.reduce((sum, refund) => sum + toCents(refund.amount), 0);
      const penalty = booking.refunds.reduce((sum, refund) => sum + toCents(refund.penaltyAmount), 0);
      const pending = booking.refunds.filter((refund) => refund.status === 'CALCULATED').reduce((sum, refund) => sum + toCents(refund.amount), 0);
      result.push({ booking, charged, refunded, penalty, pending });
    }
    return result;
  }

  /**
   * Reporte de ventas del panel (O-3), por fecha de creación en hora de Ecuador. Cuenta como venta lo que se cobró (no FAILED ni
   * pendiente de pago); lo cobrado es la suma de las referencias de pago registradas de cada reserva (reserva, asientos, maletas,
   * cambio de fecha), igual que la liquidación del detalle. Neto = cobrado − reembolsado.
   */
  async salesReport(from: string, to: string) {
    if (from > to) throw problem(400, 'VALIDATION_FAILED', '«from» no puede ser posterior a «to».', { invalidParams: [{ name: 'from', reason: 'posterior a to' }] });
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw problem(400, 'VALIDATION_FAILED', 'El rango es de máximo un año.', { invalidParams: [{ name: 'to', reason: 'máximo 366 días después de from' }] });
    const localDay = (iso: string) => new Date(Date.parse(iso) - 5 * 3_600_000).toISOString().slice(0, 10);
    const shift = (day: string, days: number) => new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.store.transaction(async (tx) => {
      const candidates = (await tx.bookingsCreatedBetween(shift(from, -1), shift(to, 1))).filter((booking) => {
        const day = localDay(booking.createdAt);
        return day >= from && day <= to;
      });
      const result = await this.chargedRows(tx, candidates);
      return result.sort((a, b) => a.booking.createdAt.localeCompare(b.booking.createdAt));
    });
    const money = formatCents;
    const sum = (list: typeof rows, pick: (row: (typeof rows)[number]) => number) => list.reduce((total, row) => total + pick(row), 0);
    const routeOf = (booking: BookingRecord) => {
      const first = booking.itineraries[0];
      return { origin: first.segments[0].departure.iataCode, destination: first.segments.at(-1)!.arrival.iataCode };
    };

    const byDay = new Map<string, { date: string; channel: SalesChannelCode; bookings: number; charged: number }>();
    const byRoute = new Map<string, { origin: string; destination: string; bookings: number; passengers: number; charged: number }>();
    for (const row of rows) {
      const date = localDay(row.booking.createdAt);
      const day = byDay.get(`${date}|${row.booking.channel}`) ?? { date, channel: row.booking.channel, bookings: 0, charged: 0 };
      day.bookings++;
      day.charged += row.charged;
      byDay.set(`${date}|${row.booking.channel}`, day);
      const { origin, destination } = routeOf(row.booking);
      const route = byRoute.get(`${origin}-${destination}`) ?? { origin, destination, bookings: 0, passengers: 0, charged: 0 };
      route.bookings++;
      route.passengers += row.booking.passengers.length;
      route.charged += row.charged;
      byRoute.set(`${origin}-${destination}`, route);
    }
    const channelTotals = (channel: SalesChannelCode) => {
      const list = rows.filter((row) => row.booking.channel === channel);
      const charged = sum(list, (row) => row.charged);
      const refunded = sum(list, (row) => row.refunded);
      return { channel, bookings: list.length, charged: money(charged), refunded: money(refunded), net: money(charged - refunded) };
    };
    const partner = rows.filter((row) => row.booking.channel === 'BOOKING');
    const partnerCharged = sum(partner, (row) => row.charged);
    const partnerRefunded = sum(partner, (row) => row.refunded);
    const charged = sum(rows, (row) => row.charged);
    const refunded = sum(rows, (row) => row.refunded);
    return {
      from,
      to,
      currency: 'USD',
      generatedAt: new Date(this.now()).toISOString(),
      totals: {
        bookings: rows.length,
        cancelled: rows.filter((row) => row.booking.status === 'CANCELLED').length,
        passengers: rows.reduce((total, row) => total + row.booking.passengers.length, 0),
        charged: money(charged),
        refunded: money(refunded),
        net: money(charged - refunded),
      },
      byChannel: [channelTotals('WEB'), channelTotals('BOOKING')],
      byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel)).map((day) => ({ ...day, charged: money(day.charged) })),
      byRoute: [...byRoute.values()].sort((a, b) => b.charged - a.charged).map((route) => ({ ...route, charged: money(route.charged) })),
      bookingSettlement: {
        partnerId: 'BOOKING_PROTOTIPO',
        bookings: partner.length,
        charged: money(partnerCharged),
        refunded: money(partnerRefunded),
        penalties: money(sum(partner, (row) => row.penalty)),
        net: money(partnerCharged - partnerRefunded),
        pendingRefunds: { count: partner.filter((row) => row.pending > 0).length, amount: money(sum(partner, (row) => row.pending)) },
        items: partner.map((row) => ({
          bookingId: row.booking.bookingId,
          pnr: row.booking.pnr,
          partnerOrderId: row.booking.salesChannel?.partnerOrderId ?? null,
          paymentReference: row.booking.payment.paymentReference,
          status: row.booking.status,
          createdAt: row.booking.createdAt,
          charged: money(row.charged),
          refunded: money(row.refunded),
          penalty: money(row.penalty),
          net: money(row.charged - row.refunded),
        })),
      },
    };
  }

  // ------------------------------------------------------------------ asistencia
  /** Pedir o cambiar la asistencia; también después del check-in (D56). */
  async saveAssistance(bookingId: string, passengerId: string, input: { type: AssistanceType; needsCompanion?: boolean; notes?: string }, caller: Caller) {
    return this.store.transaction(async (tx) => {
      const booking = await this.owned(tx, bookingId, caller);
      this.assistancePassenger(booking, passengerId);
      const previous = (await tx.assistance(bookingId)).find((record) => record.passengerId === passengerId);
      const record: AssistanceRecord = {
        bookingId: booking.bookingId,
        passengerId,
        type: input.type,
        needsCompanion: input.needsCompanion ?? false,
        ...(input.notes ? { notes: input.notes } : {}),
        status: previous && previous.type === input.type ? previous.status : 'REQUESTED',
        updatedAt: new Date(this.now()).toISOString(),
      };
      await tx.saveAssistance(record);
      return toAssistance(record);
    });
  }

  async deleteAssistance(bookingId: string, passengerId: string, caller: Caller): Promise<void> {
    await this.store.transaction(async (tx) => {
      const booking = await this.owned(tx, bookingId, caller);
      this.assistancePassenger(booking, passengerId);
      await tx.deleteAssistance(booking.bookingId, passengerId);
    });
  }

  /** "Asistencia lista": READY cuando el aeropuerto la preparó (lo confirma el administrador en CheckIn). */
  async setAssistanceStatus(bookingId: string, passengerId: string, status: 'REQUESTED' | 'READY') {
    return this.store.transaction(async (tx) => {
      const booking = await this.owned(tx, bookingId, {});
      const record = (await tx.assistance(booking.bookingId)).find((candidate) => candidate.passengerId === passengerId);
      if (!record) throw problem(404, 'NOT_FOUND', 'El pasajero no tiene asistencia.');
      const updated = { ...record, status, updatedAt: new Date(this.now()).toISOString() };
      await tx.saveAssistance(updated);
      return toAssistance(updated);
    });
  }

  // ------------------------------------------------------------------ internos
  /** Con `X-Owner-Id`, una reserva de otro dueño responde 404 (nunca 403: no revela que existe). */
  private async owned(tx: BookingsTx, bookingId: string, caller: Caller): Promise<BookingRecord> {
    const booking = await tx.booking(bookingId.toLowerCase());
    if (!booking || (caller.ownerId && !caller.actorId && booking.ownerId !== caller.ownerId)) throw notFound();
    return booking;
  }

  private confirmed(booking: BookingRecord): BookingRecord {
    if (booking.status !== 'CONFIRMED') throw problem(409, 'BOOKING_NOT_CONFIRMED', `La reserva está ${booking.status}: la operación exige boletos emitidos.`);
    return booking;
  }

  /** `BookingView`: la asistencia solo si llama el dueño o un administrador (nunca en un paso de saga sin usuario). */
  private async view(tx: BookingsTx, booking: BookingRecord, caller: Caller) {
    const assistance = caller.ownerId || caller.actorId ? (await tx.assistance(booking.bookingId)).map(toAssistance) : undefined;
    return {
      bookingId: booking.bookingId,
      pnr: booking.pnr,
      status: booking.status,
      grandTotal: booking.grandTotal,
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
      holdId: booking.holdId,
      paymentReference: booking.payment.paymentReference,
      ...(booking.salesChannel ? { salesChannel: booking.salesChannel } : {}),
      itineraries: booking.itineraries,
      passengers: booking.passengers,
      tickets: booking.tickets,
      changes: booking.changes,
      ownerId: booking.ownerId,
      channel: booking.channel,
      fares: booking.fares,
      refunds: booking.refunds,
      ...(assistance ? { assistance } : {}),
      // Solo el administrador: cada referencia de pago usada por la reserva (reserva, asientos, maletas, cambio de fecha).
      ...(caller.actorId ? { payments: await tx.paymentsOf(booking.bookingId) } : {}),
    };
  }

  private seatPlan(booking: BookingRecord, seats: { passengerId: string; segmentId: string; seatNumber: string }[], customerChange: boolean) {
    if (!['CONFIRMED', 'TICKET_ISSUING'].includes(booking.status)) throw problem(409, 'BOOKING_NOT_CONFIRMED', `La reserva está ${booking.status}.`);
    const keys = seats.map((seat) => `${seat.passengerId}|${seat.segmentId}`);
    if (new Set(keys).size !== keys.length) throw problem(400, 'VALIDATION_FAILED', 'Un pasajero tiene dos asientos en el mismo segmento.');
    const ticketed = booking.tickets.some((ticket) => ticket.status === 'ISSUED');
    return seats.map((change) => {
      const passenger = booking.passengers.find((candidate) => candidate.passengerId === change.passengerId);
      const segment = segmentsOf(booking).find((candidate) => candidate.segmentId === change.segmentId);
      if (!passenger || !segment) throw problem(400, 'VALIDATION_FAILED', 'El pasajero o el segmento no son de la reserva.', { invalidParams: [{ name: 'seats', reason: `${change.passengerId}/${change.segmentId}` }] });
      if (passenger.passengerType === 'INFANT') throw problem(422, 'INFANT_SEAT_NOT_ALLOWED', 'Los infantes viajan en el regazo de un adulto y no tienen asiento.');
      if (Date.parse(segment.departure.at) <= this.now()) throw problem(409, 'FLIGHT_ALREADY_DEPARTED', `El vuelo ${segment.flightNumber} ya salió.`);
      if (customerChange && booking.checkedIn.some((c) => c.segmentId === change.segmentId && c.passengerId === change.passengerId)) {
        throw problem(409, 'CUTOFF_PASSED', 'El pasajero ya hizo check-in en ese segmento: el asiento no se puede cambiar.', {
          detail: `El pasajero ${change.passengerId} hizo check-in en ${change.segmentId}. Según el contrato del grupo (changeSeats), el asiento no se cambia después del check-in del segmento.`,
        });
      }
      return {
        passengerId: change.passengerId,
        segmentId: change.segmentId,
        previousSeatNumber: passenger.assignedSeats?.find((seat) => seat.segmentId === change.segmentId)?.seatNumber ?? null,
        seatNumber: change.seatNumber,
        cabinClass: fareOfSegment(booking, change.segmentId)?.cabinClass ?? 'ECONOMY',
        targetStatus: ticketed ? ('TICKETED' as const) : ('BOOKED' as const),
      };
    });
  }

  private assistancePassenger(booking: BookingRecord, passengerId: string) {
    if (!booking.passengers.some((passenger) => passenger.passengerId === passengerId)) throw problem(404, 'NOT_FOUND', 'Pasajero no encontrado en la reserva.');
    if (booking.status === 'CANCELLED' || booking.status === 'FAILED') throw problem(409, 'BOOKING_NOT_CONFIRMED', `La reserva está ${booking.status}.`);
    // D56 (12/11, revoca D55): la asistencia también se pide o se quita después del check-in. El pase sigue valiendo; su grupo
    // de abordaje (A para quien tiene asistencia) no se recalcula: el aeropuerto coordina la asistencia con la lista del vuelo.
  }

  /** Une a la reserva una referencia ya registrada (claim) de esa operación; si no está registrada, no se acepta. */
  private async linkPayment(tx: BookingsTx, reference: string, bookingId: string, operation: PaymentOperation): Promise<void> {
    const payment = await tx.payment(reference);
    if (!payment || payment.operation !== operation || (payment.bookingId && payment.bookingId !== bookingId)) {
      throw problem(422, 'PAYMENT_REFERENCE_INVALID', 'La referencia de pago no está registrada para esta operación.');
    }
    if (!payment.bookingId) await tx.savePayment({ ...payment, bookingId });
  }

  private claimsFor(passengers: PassengerItem[], segmentIds: string[], bookingId: string) {
    return passengers.flatMap((passenger) => segmentIds.map((segmentId) => ({ segmentId, identityKey: identityKey(passenger), bookingId })));
  }

  private alreadyOnFlight(segmentId: string, status = 422) {
    return problem(status, 'PASSENGER_ALREADY_ON_FLIGHT', 'Un pasajero ya tiene una reserva activa en ese vuelo.', { invalidParams: [{ name: 'passengers.documentNumber', reason: `ya viaja en ${segmentId}` }] });
  }
}

/** Lo que el listado agrega para el administrador: canal, orden de Booking, salida, pasajeros y reembolso total. */
function adminSummary(booking: BookingRecord) {
  const refunded = booking.refunds.reduce((cents, refund) => cents + toCents(refund.amount), 0);
  return {
    channel: booking.channel,
    partnerId: booking.partnerId,
    partnerOrderId: booking.salesChannel?.partnerOrderId ?? null,
    departureAt: booking.itineraries[0].segments[0].departure.at,
    passengerCount: booking.passengers.length,
    refundTotal: booking.refunds.length ? formatCents(refunded) : null,
    createdAt: booking.createdAt,
  };
}

/** Vista de la asistencia (sin el id de la reserva). */
function toAssistance(record: AssistanceRecord) {
  return { passengerId: record.passengerId, type: record.type, needsCompanion: record.needsCompanion, ...(record.notes ? { notes: record.notes } : {}), status: record.status, updatedAt: record.updatedAt };
}

/** «Reserva cancelada a pedido del cliente: «cambio de planes».»: el motivo escrito queda en el historial (nunca en los logs). */
function cancellationText(reasonCode: string, reason?: string): string {
  const why = CANCEL_REASONS[reasonCode] ?? 'por otro motivo';
  const text = reason?.trim();
  return text ? `Reserva cancelada ${why}: «${text}».` : `Reserva cancelada ${why}.`;
}
