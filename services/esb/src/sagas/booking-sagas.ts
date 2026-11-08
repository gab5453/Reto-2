import { Inject, Injectable } from '@nestjs/common';
import { applyDiscount, createCloudEvent, type MoneyAmount, ProblemDetailsException, toCents } from '@ecoairlines/shared';
import { UPSTREAMS, type Upstreams } from '../clients/upstreams.js';
import { localDate } from '../composition/dates.js';
import { ESB_CONFIG, type EsbConfig } from '../config/config.js';
import { EVENTS_PUBLISHER, type EventsPublisher } from '../inbound/events-publisher.js';
import { stableUuid } from '../transversal/ids.js';
import { ESB_STORE, type EsbStore } from '../repositories/esb.store.js';
import { type SagaContext, type SagaDefinition } from './engine.js';
import {
  type BookingFares,
  type BookingView,
  bookingEventData,
  collectPayment,
  type Fare,
  fromProto,
  international,
  type Itinerary,
  partnerIdOf,
  type PaymentInput,
  problem,
  publishEvents,
  seated,
  segmentsOf,
  settleRefund,
  zero,
} from './support.js';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** `sagaId` propio de cada llamada a Offers dentro de una saga: Offers guarda el resultado por operación y `sagaId`. */
const sub = (saga: SagaContext, label: string) => stableUuid(`${saga.sagaId}:${label}`);
const cabinEnum = (cabin: string) => `CABIN_CLASS_${cabin}`;
const notFoundIs = (status: number) => (error: unknown) => {
  if (error instanceof ProblemDetailsException && error.problem.status === status) return undefined;
  throw error;
};

/**
 * D55: después del check-in (de cualquier pasajero) el cliente ya no modifica la reserva: ni fecha, ni maletas, ni cancelación
 * (el asiento y la asistencia ya los bloquea Bookings). Se revisa en MS.G.CheckIn, la fuente del check-in, ANTES de consumir
 * la cotización o cobrar: nunca se cobra un cambio que después se rechaza.
 */
async function assertNotCheckedIn(saga: SagaContext, d: SagaDeps, bookingId: string): Promise<void> {
  const current = await saga.step('check-in.guard', () => d.upstreams.rest['check-in'].json<{ items?: Any[] }>('GET', `/check-ins/${bookingId}`).catch(notFoundIs(404)));
  if ((current?.items ?? []).length) throw problem(409, 'CUTOFF_PASSED', 'Ya hiciste check-in: la reserva no se puede modificar.');
}

/** Dependencias comunes de las sagas de reservas. */
@Injectable()
export class SagaDeps {
  constructor(
    @Inject(UPSTREAMS) readonly upstreams: Upstreams,
    @Inject(ESB_CONFIG) readonly config: EsbConfig,
    @Inject(EVENTS_PUBLISHER) readonly events: EventsPublisher,
    @Inject(ESB_STORE) readonly store: EsbStore,
  ) {}

  get bookings() {
    return this.upstreams.rest.bookings;
  }
  get offers() {
    return this.upstreams.offers;
  }
  caller(saga: SagaContext) {
    return { ...(saga.ownerId ? { ownerId: saga.ownerId } : {}), ...(saga.actorId ? { actorId: saga.actorId } : {}) };
  }
  booking(saga: SagaContext, bookingId: string, name = 'bookings.get') {
    return saga.step(name, () => this.bookings.json<BookingView>('GET', `/bookings/${bookingId}`, { caller: this.caller(saga) }));
  }
  fares(saga: SagaContext, bookingId: string) {
    return saga.step('bookings.fares', () => this.bookings.json<BookingFares>('GET', `/bookings/${bookingId}/fares`, { caller: this.caller(saga) }));
  }
}

// ======================================================================================================== Crear reserva

export interface CreateBookingInput {
  bookingId: string;
  request: {
    holdId: string;
    passengers: (Any & { passengerId: string; passengerType: string })[];
    payment: PaymentInput;
    salesChannel?: { partnerId?: string; partnerOrderId?: string; packageId?: string | null; promotionApplied?: boolean; discountPercentage?: number };
    /** Solo la web (GraphQL): asistencia médica opcional. Dato de salud: no se escribe en logs. */
    assistance?: { passengerId: string; type: string; needsCompanion?: boolean; notes?: string }[];
  };
}

const cleanMoney = (money: Any): MoneyAmount => ({
  currency: money['currency'],
  ...(money['baseFare'] ? { baseFare: money['baseFare'] } : {}),
  ...(money['taxes'] ? { taxes: money['taxes'] } : {}),
  total: money['total'],
});
const PASSENGER_FIELDS = ['passengerId', 'passengerType', 'associatedAdultId', 'firstName', 'lastName', 'documentType', 'documentNumber', 'nationality', 'documentExpiryDate', 'birthDate', 'gender', 'contact'];
const breakdownOf = (counts: Any) => Object.fromEntries(['adults', 'youths', 'children', 'infants'].filter((k) => Number(counts[k] ?? 0) > 0).map((k) => [k, Number(counts[k])]));

/**
 * "Crear reserva" (+ asistencia opcional): Offers valida el hold y el descuento → Bookings valida los pasajeros → pago* →
 * Offers consume el hold (asientos BOOKED) → Bookings crea la reserva → "Emitir boletos" → eventos. Si algo falla antes de
 * emitir, se libera todo en orden inverso y se publica `booking.failed`.
 */
@Injectable()
export class CreateBookingSaga implements SagaDefinition<CreateBookingInput, { bookingId: string; status: string; issued: number }> {
  readonly type = 'CREATE_BOOKING';
  constructor(@Inject(SagaDeps) private readonly d: SagaDeps) {}

  async run(saga: SagaContext, { bookingId, request }: CreateBookingInput) {
    const ownerId = saga.ownerId;
    if (!ownerId) throw problem(400, 'VALIDATION_FAILED', 'Falta X-Owner-Id: la reserva necesita un dueño.');
    const channel = request.salesChannel;
    const partnerId = partnerIdOf(ownerId);
    const discount = channel?.promotionApplied && channel.discountPercentage ? channel.discountPercentage : 0;
    // El descuento solo lo pide un partner (acuerdo B2B, D35); la web no tiene promociones de Booking.
    if (discount && !partnerId) throw problem(422, 'PROMOTION_DISCOUNT_OUT_OF_RANGE', 'Solo un partner con acuerdo de promociones aplica descuentos.');

    const validated = await saga.step('offers.validate-hold', () =>
      this.d.offers.call<Any>('ValidateHold', { holdId: request.holdId, ownerId, ...(discount ? { promotion: { partnerId, discountPercentage: discount } } : {}) }),
    );
    const hold = validated['hold'];
    const expected = cleanMoney(validated['expectedAmount']);
    const breakdown = breakdownOf(hold['passengersBreakdown']);
    const itineraries = (hold['selections'] as Any[]).map((selection) => fromProto<Itinerary>(selection['itinerary']));
    const passengers = request.passengers.map((p) => Object.fromEntries(PASSENGER_FIELDS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])));

    await saga.step('bookings.validate-passengers', () =>
      this.d.bookings.json('POST', '/passengers/validate', {
        json: { passengers, passengersBreakdown: breakdown, segments: itineraries.flatMap((i) => i.segments.map((s) => ({ segmentId: s.segmentId, flightNumber: s.flightNumber, departureAt: s.departure.at, international: international(s) }))) },
      }),
    );

    const payment = await collectPayment(saga, this.d, { operation: 'BOOKING', payment: request.payment, expected });
    if (!payment) throw problem(422, 'PAYMENT_REFERENCE_INVALID', 'La reserva debe tener un pago.');

    const consumed = await saga.step(
      'offers.consume-hold',
      () =>
        this.d.offers.call<Any>('ConsumeHold', {
          holdId: request.holdId,
          bookingId,
          sagaId: saga.sagaId,
          ownerId,
          // Todos los pasajeros (Offers compara la lista con el desglose del hold, infantes incluidos) con los asientos que
          // pidieron (assignedSeats del contrato); Offers asigna uno a quien no eligió y rechaza el asiento de un infante.
          passengers: request.passengers.map((p) => ({
            passengerId: p.passengerId,
            passengerType: `PASSENGER_TYPE_${p.passengerType}`,
            requestedSeats: ((p['assignedSeats'] ?? []) as { segmentId: string; seatNumber: string }[]).map((seat) => ({ passengerId: p.passengerId, segmentId: seat.segmentId, seatNumber: seat.seatNumber })),
          })),
        }),
      // El hold ya se consumió: se liberan los cupos y asientos de la reserva (si no llegó a consumirse, no hay nada que liberar).
      () => this.d.offers.call('ReleaseBookingInventory', { bookingId, sagaId: sub(saga, 'undo-consume'), segmentIds: [], reason: 'SAGA_COMPENSATION' }),
    );
    const seats = (consumed['seats'] as Any[]).map((s) => ({ passengerId: s['passengerId'], segmentId: s['segmentId'], seatNumber: s['seatNumber'] }));

    const fares: Fare[] = (hold['selections'] as Any[]).map((selection) => {
      const rules = selection['itinerary']?.['pricingOptions']?.[0]?.['fareRules'] ?? {};
      const price = cleanMoney(selection['price']);
      return {
        itineraryId: selection['itineraryId'],
        cabinClass: fromProto<string>(selection['cabinClass']),
        fareBrand: selection['fareBrand'],
        segmentIds: selection['segmentIds'],
        // Con descuento, la tarifa guardada es lo que se pagó: el reembolso nunca supera el cobro.
        price: discount ? applyDiscount(price, discount) : price,
        isRefundable: !!rules['isRefundable'],
        isChangeable: !!rules['isChangeable'],
      };
    });

    const created = await saga.step(
      'bookings.create',
      () =>
        this.d.bookings.json<BookingView>('POST', '/bookings', {
          caller: { ownerId },
          json: {
            bookingId,
            sagaId: saga.sagaId,
            holdId: request.holdId,
            offerId: hold['offerId'],
            passengersBreakdown: breakdown,
            passengers: passengers.map((p) => {
              const own = seats.filter((s) => s.passengerId === p['passengerId']).map(({ segmentId, seatNumber }) => ({ segmentId, seatNumber }));
              return own.length ? { ...p, assignedSeats: own } : p;
            }),
            itineraries,
            fares,
            grandTotal: expected,
            payment: { paymentReference: payment.paymentReference, provider: payment.provider },
            // El partner sale del token (D29), nunca del cuerpo.
            ...(channel || partnerId ? { salesChannel: { ...channel, ...(partnerId ? { partnerId } : { partnerId: undefined }), ...(discount ? { promotionApplied: true, discountPercentage: discount } : {}) } } : {}),
            ...(request.assistance?.length ? { assistance: request.assistance } : {}),
          },
        }),
      async (booking) => {
        const failed = await this.d.bookings
          .json<BookingView>('POST', `/bookings/${bookingId}/fail`, { json: { errorCode: 'SAGA_COMPENSATED', reason: 'Falló un paso de la saga "Crear reserva".' } })
          .catch(notFoundIs(404));
        const view = failed ?? booking;
        if (view) {
          await this.d.events.publish(
            { ...createCloudEvent({ name: 'booking.failed', visibility: 'public', subject: bookingId, data: { ...bookingEventData({ ...view, status: 'FAILED' }), errorCode: 'SAGA_COMPENSATED' } }), id: sub(saga, 'event:booking.failed') },
            ownerId,
          );
        }
      },
    );

    const issued = await issueTickets(saga, this.d, bookingId);
    saga.pointOfNoReturn();
    await publishEvents(saga, this.d.events, [
      { name: 'booking.confirmed', subject: bookingId, data: bookingEventData({ ...created, status: 'CONFIRMED' }), ownerId },
      ...(issued.issued > 0
        ? [{ name: 'booking.ticket_issued', subject: bookingId, data: { ...bookingEventData({ ...created, status: 'CONFIRMED' }), paymentReference: payment.paymentReference, tickets: issued.tickets.map(({ ticketId, eTicketNumber, passengerId }) => ({ ticketId, eTicketNumber, passengerId })) }, ownerId }]
        : []),
      // Interno: solo que se pidió asistencia, nunca cuál (dato de salud).
      ...(request.assistance ?? []).map((a) => ({ name: 'booking.assistance_requested', visibility: 'internal' as const, subject: bookingId, data: { bookingId, passengerId: a.passengerId, action: 'REQUESTED' }, ownerId })),
    ]);
    return { bookingId, status: issued.status, issued: issued.issued };
  }
}

/**
 * Pasos de "Emitir boletos" (también dentro de "Crear reserva"): Offers `BOOKED → TICKETED` → Bookings emite. Compensación:
 * los asientos vuelven a `BOOKED`. Repetirla no emite dos veces (Offers solo mueve los que siguen `BOOKED`; Bookings `issued: 0`).
 */
async function issueTickets(saga: SagaContext, d: SagaDeps, bookingId: string) {
  await saga.step(
    'offers.ticket-seats',
    () => d.offers.call('TransitionBookingSeats', { bookingId, sagaId: sub(saga, 'ticket'), fromStatus: 'SEAT_STATUS_BOOKED', toStatus: 'SEAT_STATUS_TICKETED', segmentIds: [], passengerIds: [] }),
    () => d.offers.call('TransitionBookingSeats', { bookingId, sagaId: sub(saga, 'undo-ticket'), fromStatus: 'SEAT_STATUS_TICKETED', toStatus: 'SEAT_STATUS_BOOKED', segmentIds: [], passengerIds: [] }),
  );
  return saga.step('bookings.issue-tickets', () =>
    d.bookings.json<{ bookingId: string; pnr: string; status: string; issued: number; tickets: { ticketId: string; eTicketNumber: string; passengerId: string }[] }>('POST', `/bookings/${bookingId}/tickets`),
  );
}

// ======================================================================================================== Emitir boletos

export interface IssueTicketsInput {
  bookingId: string;
  /** La referencia que confirmó el pago (evento `payment.confirmed`), para el evento público. */
  paymentReference?: string;
}

@Injectable()
export class IssueTicketsSaga implements SagaDefinition<IssueTicketsInput, Any> {
  readonly type = 'ISSUE_TICKETS';
  constructor(@Inject(SagaDeps) private readonly d: SagaDeps) {}

  async run(saga: SagaContext, input: IssueTicketsInput) {
    // El primer paso no hace nada: su compensación (que corre al final) publica `booking.ticket_failed`.
    const booking = await saga.step(
      'bookings.get',
      () => this.d.bookings.json<BookingView>('GET', `/bookings/${input.bookingId}`, { caller: this.d.caller(saga) }),
      async (view) => {
        if (!view) return;
        await this.d.events.publish(
          { ...createCloudEvent({ name: 'booking.ticket_failed', visibility: 'public', subject: view.bookingId, data: { ...bookingEventData(view), failureReason: 'TICKET_ISSUANCE_FAILED' } }), id: sub(saga, 'event:booking.ticket_failed') },
          view.ownerId,
        );
      },
    );
    if (['CANCELLED', 'FAILED', 'CANCELLATION_PENDING'].includes(booking.status)) throw problem(409, 'BOOKING_NOT_CONFIRMED', `No se emiten boletos de una reserva ${booking.status}.`);
    const issuance = await issueTickets(saga, this.d, input.bookingId);
    saga.pointOfNoReturn();
    if (issuance.issued > 0) {
      await publishEvents(saga, this.d.events, [
        {
          name: 'booking.ticket_issued',
          subject: booking.bookingId,
          data: { ...bookingEventData({ ...booking, status: issuance.status }), paymentReference: booking.paymentReference ?? input.paymentReference, tickets: issuance.tickets.map(({ ticketId, eTicketNumber, passengerId }) => ({ ticketId, eTicketNumber, passengerId })) },
          ownerId: booking.ownerId,
        },
      ]);
    }
    return issuance;
  }
}

// ========================================================================================================== Pago fallido

@Injectable()
export class PaymentFailedSaga implements SagaDefinition<{ bookingId: string; failureReason?: string | null }, Any> {
  readonly type = 'PAYMENT_FAILED';
  constructor(@Inject(SagaDeps) private readonly d: SagaDeps) {}

  /** Offers libera los asientos → Bookings `FAILED` → `booking.failed`. No se deshace: si un paso falla, se reintenta. */
  async run(saga: SagaContext, input: { bookingId: string; failureReason?: string | null }) {
    saga.pointOfNoReturn();
    const booking = await this.d.booking(saga, input.bookingId);
    if (booking.status === 'FAILED') return { bookingId: booking.bookingId, pnr: booking.pnr, alreadyFailed: true };
    if (!['PENDING', 'PENDING_PAYMENT', 'TICKET_ISSUING'].includes(booking.status)) {
      throw problem(409, 'BOOKING_NOT_CANCELLABLE', `La reserva está ${booking.status}: con boletos emitidos se cancela, no se marca como fallida.`);
    }
    const released = await saga.step('offers.release', () => this.d.offers.call<Any>('ReleaseBookingInventory', { bookingId: booking.bookingId, sagaId: sub(saga, 'release'), segmentIds: [], reason: 'PAYMENT_FAILED' }));
    const failed = await saga.step('bookings.fail', () =>
      this.d.bookings.json<BookingView>('POST', `/bookings/${booking.bookingId}/fail`, { json: { errorCode: 'PAYMENT_NOT_AUTHORIZED', ...(input.failureReason ? { reason: input.failureReason.slice(0, 200) } : {}) } }),
    );
    await publishEvents(saga, this.d.events, [{ name: 'booking.failed', subject: booking.bookingId, data: { ...bookingEventData(failed), errorCode: 'PAYMENT_NOT_AUTHORIZED' }, ownerId: booking.ownerId }]);
    return { bookingId: booking.bookingId, pnr: booking.pnr, seatsReleased: released['seatsReleased'] ?? 0 };
  }
}

// ====================================================================================================== Cambiar asientos

export interface ChangeSeatsInput {
  bookingId: string;
  request: { seats: { passengerId: string; segmentId: string; seatNumber: string }[]; payment?: PaymentInput };
}

/**
 * "Cambiar asientos" (varios, atómico): Bookings valida (sin check-in, misma cabina, sin infantes) → Offers ocupa TODOS los
 * nuevos y libera los anteriores → pago* (solo si se envió un monto) → Bookings guarda → `booking.seat_changed`.
 * Compensación: Offers vuelve a los asientos anteriores.
 */
@Injectable()
export class ChangeSeatsSaga implements SagaDefinition<ChangeSeatsInput, Any> {
  readonly type = 'CHANGE_SEATS';
  constructor(@Inject(SagaDeps) private readonly d: SagaDeps) {}

  async run(saga: SagaContext, { bookingId, request }: ChangeSeatsInput) {
    const booking = await this.d.booking(saga, bookingId);
    const plan = await saga.step('bookings.plan-seats', () => this.d.bookings.json<{ changes: Any[] }>('POST', `/bookings/${bookingId}/seats/plan`, { caller: this.d.caller(saga), json: { seats: request.seats } }));
    const target = plan.changes[0]?.['targetStatus'] ?? 'BOOKED';
    await saga.step(
      'offers.reserve-seats',
      () =>
        this.d.offers.call('ReserveSeats', {
          bookingId,
          sagaId: sub(saga, 'seats'),
          seats: request.seats,
          purchasedCabins: plan.changes.map((c) => ({ passengerId: c['passengerId'], segmentId: c['segmentId'], cabinClass: cabinEnum(c['cabinClass']) })),
          targetStatus: `SEAT_STATUS_${target}`,
        }),
      async () => {
        const previous = plan.changes.filter((c) => c['previousSeatNumber']).map((c) => ({ passengerId: c['passengerId'], segmentId: c['segmentId'], seatNumber: c['previousSeatNumber'] }));
        if (!previous.length) return;
        await this.d.offers.call('ReserveSeats', {
          bookingId,
          sagaId: sub(saga, 'undo-seats'),
          seats: previous,
          purchasedCabins: plan.changes.map((c) => ({ passengerId: c['passengerId'], segmentId: c['segmentId'], cabinClass: cabinEnum(c['cabinClass']) })),
          targetStatus: `SEAT_STATUS_${target}`,
        });
      },
    );
    // Los asientos de EcoAirlines no tienen costo: solo se cobra si el canal envió un monto (contrato v2: "si tiene costo").
    const payment = request.payment?.amount ? await collectPayment(saga, this.d, { operation: 'SEATS', payment: request.payment, expected: request.payment.amount, bookingId }) : undefined;
    const applied = await saga.step('bookings.apply-seats', () =>
      this.d.bookings.json<Any>('PUT', `/bookings/${bookingId}/seats`, {
        caller: this.d.caller(saga),
        json: { reason: 'CUSTOMER_CHANGE', seats: request.seats, ...(payment ? { amountCharged: payment.amount, paymentReference: payment.paymentReference } : {}) },
      }),
    );
    saga.pointOfNoReturn();
    await publishEvents(saga, this.d.events, [
      { name: 'booking.seat_changed', subject: bookingId, data: { ...bookingEventData(booking), changeType: 'SEAT', amountCharged: payment?.amount ?? zero(booking.grandTotal.currency), paymentReference: payment?.paymentReference ?? null }, ownerId: booking.ownerId },
    ]);
    return applied;
  }
}

// ============================================================================================================== Check-in

const CHECK_IN_OPENS_MS = 48 * 3_600_000;

/**
 * "Check-in": Bookings (boletos emitidos) → FlightStatus (ventana de 48 h, vuelo no cancelado ni salido) → Offers (asiento
 * automático a quien no tiene y `TICKETED → CHECKED_IN`) → CheckIn (pases) → Bookings → `booking.checked_in`.
 * Compensación: los asientos vuelven a `TICKETED` y se deshace el check-in.
 */
@Injectable()
export class CheckInSaga implements SagaDefinition<{ bookingId: string }, Any> {
  readonly type = 'CHECK_IN';
  constructor(@Inject(SagaDeps) private readonly d: SagaDeps) {}

  async run(saga: SagaContext, { bookingId }: { bookingId: string }) {
    const booking = await this.d.booking(saga, bookingId);
    if (booking.status !== 'CONFIRMED' || !booking.tickets.length || booking.tickets.some((t) => t.status !== 'ISSUED')) {
      throw problem(409, 'CHECK_IN_NOT_AVAILABLE', 'El check-in exige la reserva confirmada con sus boletos emitidos.');
    }
    const now = Date.now();
    const window = segmentsOf(booking).filter((s) => now >= Date.parse(s.departure.at) - CHECK_IN_OPENS_MS && now < Date.parse(s.departure.at));
    if (!window.length) throw problem(409, 'CHECK_IN_NOT_AVAILABLE', 'El check-in abre 48 h antes de la salida y cierra a la hora de salida.');

    const flights = await saga.step('flight-status.check', async () => {
      const result: Record<string, { gate: string | null }> = {};
      for (const segment of window) {
        const status = await this.d.upstreams.rest['flight-status'].json<Any>('GET', `/flights/${segment.flightNumber}/status?date=${localDate(new Date(segment.departure.at))}`);
        if (status['status'] === 'CANCELLED') throw problem(409, 'FLIGHT_CANCELLED', `El vuelo ${segment.flightNumber} está cancelado.`);
        if (['DEPARTED', 'ARRIVED', 'DIVERTED'].includes(status['status'])) throw problem(409, 'FLIGHT_ALREADY_DEPARTED', `El vuelo ${segment.flightNumber} ya salió.`);
        result[segment.segmentId] = { gate: status['departure']?.['gate'] ?? null };
      }
      return result;
    });

    const existing = await saga.step('check-in.current', () => this.d.upstreams.rest['check-in'].json<{ items?: Any[] }>('GET', `/check-ins/${bookingId}`).catch(notFoundIs(404)));
    const done = new Set((existing?.items ?? []).map((i) => `${i['passengerId']}|${i['segmentId']}`));
    const people = booking.passengers;
    const pending = window.flatMap((segment) => people.filter((p) => !done.has(`${p.passengerId}|${segment.segmentId}`)).map((p) => ({ passenger: p, segment })));
    if (!pending.length) throw problem(409, 'CHECK_IN_NOT_AVAILABLE', 'Los pasajeros ya hicieron check-in.');
    const cabinOf = (segmentId: string) => booking.fares?.find((f) => f.segmentIds.includes(segmentId))?.cabinClass ?? 'ECONOMY';
    const seatOf = (passengerId: string, segmentId: string) => booking.passengers.find((p) => p.passengerId === passengerId)?.assignedSeats?.find((s) => s.segmentId === segmentId)?.seatNumber;
    const seatedPending = pending.filter(({ passenger }) => passenger.passengerType !== 'INFANT');
    const withoutSeat = seatedPending.filter(({ passenger, segment }) => !seatOf(passenger.passengerId, segment.segmentId));
    const segmentIds = [...new Set(pending.map((p) => p.segment.segmentId))];
    const passengerIds = [...new Set(seatedPending.map((p) => p.passenger.passengerId))];
    const undoCheckIn = () => this.d.offers.call('TransitionBookingSeats', { bookingId, sagaId: sub(saga, 'undo-check-in'), fromStatus: 'SEAT_STATUS_CHECKED_IN', toStatus: 'SEAT_STATUS_TICKETED', segmentIds, passengerIds });

    const auto = withoutSeat.length
      ? await saga.step(
          'offers.auto-assign',
          () =>
            this.d.offers.call<Any>('AutoAssignSeats', {
              bookingId,
              sagaId: sub(saga, 'auto-assign'),
              passengers: withoutSeat.map(({ passenger, segment }) => ({ passengerId: passenger.passengerId, segmentId: segment.segmentId, cabinClass: cabinEnum(cabinOf(segment.segmentId)) })),
              targetStatus: 'SEAT_STATUS_CHECKED_IN',
            }),
          undoCheckIn,
        )
      : undefined;
    await saga.step('offers.check-in-seats', () => this.d.offers.call('TransitionBookingSeats', { bookingId, sagaId: sub(saga, 'check-in'), fromStatus: 'SEAT_STATUS_TICKETED', toStatus: 'SEAT_STATUS_CHECKED_IN', segmentIds, passengerIds }), undoCheckIn);
    const autoSeats = (auto?.['result']?.['seats'] ?? []) as Any[];
    const finalSeat = (passengerId: string, segmentId: string) => seatOf(passengerId, segmentId) ?? autoSeats.find((s) => s['passengerId'] === passengerId && s['segmentId'] === segmentId)?.['seatNumber'] ?? null;
    const assisted = new Set((booking.assistance ?? []).map((a) => a.passengerId));
    const tickets = new Map(booking.tickets.map((t) => [t.passengerId, t.eTicketNumber]));

    const registered = await saga.step(
      'check-in.register',
      () =>
        this.d.upstreams.rest['check-in'].json<Any>('POST', `/check-ins/${bookingId}`, {
          caller: this.d.caller(saga),
          json: {
            sagaId: saga.sagaId,
            pnr: booking.pnr,
            passengers: [...new Set(pending.map((p) => p.passenger.passengerId))].map((passengerId) => {
              const passenger = booking.passengers.find((p) => p.passengerId === passengerId)!;
              return {
                passengerId,
                passengerType: passenger.passengerType,
                firstName: passenger.firstName,
                lastName: passenger.lastName,
                eTicketNumber: tickets.get(passengerId) ?? null,
                segments: pending
                  .filter((p) => p.passenger.passengerId === passengerId)
                  .map(({ segment }) => ({
                    segmentId: segment.segmentId,
                    flightNumber: segment.flightNumber,
                    origin: segment.departure.iataCode,
                    destination: segment.arrival.iataCode,
                    departureAt: segment.departure.at,
                    cabinClass: cabinOf(segment.segmentId),
                    seat: passenger.passengerType === 'INFANT' ? null : finalSeat(passengerId, segment.segmentId),
                    gate: flights[segment.segmentId]?.gate ?? null,
                    needsAssistance: assisted.has(passengerId),
                  })),
              };
            }),
          },
        }),
      () => this.d.upstreams.rest['check-in'].request({ method: 'DELETE', path: `/check-ins/${bookingId}?sagaId=${saga.sagaId}` }).then((r) => {
        if (r.status >= 500) throw problem(503, 'PROVIDER_UNAVAILABLE', 'MS.G.CheckIn no deshizo el check-in.');
      }),
    );
    const checkInSeats = seatedPending.map(({ passenger, segment }) => ({ passengerId: passenger.passengerId, segmentId: segment.segmentId, seatNumber: finalSeat(passenger.passengerId, segment.segmentId) })).filter((s) => s.seatNumber);
    saga.pointOfNoReturn();
    if (checkInSeats.length) await saga.step('bookings.apply-check-in', () => this.d.bookings.json('PUT', `/bookings/${bookingId}/seats`, { caller: this.d.caller(saga), json: { reason: 'CHECK_IN_AUTO', seats: checkInSeats } }));
    await publishEvents(saga, this.d.events, [{ name: 'booking.checked_in', subject: bookingId, data: { ...bookingEventData(booking), passengersCheckedIn: new Set(pending.map((p) => p.passenger.passengerId)).size }, ownerId: booking.ownerId }]);
    return registered;
  }
}

// ============================================================================================================== Cancelar

export interface CancelInput {
  bookingId: string;
  request: { quoteId?: string; reasonCode?: 'CUSTOMER_REQUEST' | 'SAGA_COMPENSATION' | 'FLIGHT_CANCELLED' | 'OTHER'; reason?: string };
}

/**
 * "Cancelar" (también el combo cancelado y cada reserva de un vuelo cancelado): Bookings → PostSale (consumir la cotización, o
 * `CalculateCompensationRefund` si es `SAGA_COMPENSATION` / `FLIGHT_CANCELLED`) → Offers libera asientos → reembolso →
 * Bookings `CANCELLED` (boletos `VOIDED`) → `booking.cancelled`. **No se deshace**: después de PostSale, un fallo se reintenta.
 */
@Injectable()
export class CancelBookingSaga implements SagaDefinition<CancelInput, Any> {
  readonly type = 'CANCEL_BOOKING';
  constructor(@Inject(SagaDeps) private readonly d: SagaDeps) {}

  async run(saga: SagaContext, { bookingId, request }: CancelInput) {
    const reasonCode = request.reasonCode ?? 'CUSTOMER_REQUEST';
    const booking = await this.d.booking(saga, bookingId);
    if (booking.status === 'CANCELLED') throw problem(409, 'ALREADY_CANCELLED', 'La reserva ya estaba cancelada.');
    const compensation = reasonCode === 'SAGA_COMPENSATION' || reasonCode === 'FLIGHT_CANCELLED';
    if (!compensation && !request.quoteId) {
      throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'Falta quoteId.', invalidParams: [{ name: 'quoteId', reason: 'obligatorio salvo SAGA_COMPENSATION o FLIGHT_CANCELLED' }] });
    }
    if (!compensation) await assertNotCheckedIn(saga, this.d, bookingId);
    const fares = await this.d.fares(saga, bookingId);
    const quote = await saga.step('post-sale.quote', async () =>
      compensation
        ? (await this.d.upstreams.postSale.call<Any>('CalculateCompensationRefund', { sagaId: saga.sagaId, reasonCode, booking: postSaleContext(booking, fares) }))['quote']
        : (await this.d.upstreams.postSale.call<Any>('ConsumeCancellationQuote', { sagaId: saga.sagaId, bookingId, quoteId: request.quoteId }))['quote'],
    );
    saga.pointOfNoReturn();
    const released = await saga.step('offers.release', () => this.d.offers.call<Any>('ReleaseBookingInventory', { bookingId, sagaId: sub(saga, 'release'), segmentIds: [], reason: reasonCode }));
    const refund = await settleRefund(saga, this.d, {
      booking,
      amount: Number(quote['refundAmount']).toFixed(2),
      penaltyAmount: Number(quote['penaltyAmount']).toFixed(2),
      penaltyWaived: quote['penaltyWaived'] === true || quote['penaltyWaived'] === 'true',
      percentage: Number(quote['percentage']),
      reason: reasonCode,
    });
    const cancellation = await saga.step('bookings.cancel', async () => {
      try {
        return await this.d.bookings.json<Any>('POST', `/bookings/${bookingId}/cancellation`, {
          caller: this.d.caller(saga),
          json: { reasonCode, ...(request.reason ? { reason: request.reason.slice(0, 200) } : {}), ...(request.quoteId ? { quoteId: request.quoteId } : {}), refund, seatsReleased: released['seatsReleased'] ?? 0 },
        });
      } catch (error) {
        if (!(error instanceof ProblemDetailsException) || error.problem.code !== 'ALREADY_CANCELLED') throw error;
        // Bookings ya la canceló. Si fue ESTA saga (un reintento: el reembolso guardado es el suyo, su id sale del sagaId), es su
        // resultado; si fue otra (dos cancelaciones a la vez), esta termina sin publicar nada: el evento ya lo publicó la otra.
        const stored = (error.problem.detail ? JSON.parse(error.problem.detail) : {}) as Any;
        return stored['refund']?.['refundId'] === refund.refundId ? stored : { ...stored, alreadyCancelled: true };
      }
    });
    if (cancellation['alreadyCancelled']) return cancellation;
    await publishEvents(saga, this.d.events, [
      { name: 'booking.cancelled', subject: bookingId, data: { ...bookingEventData({ ...booking, status: 'CANCELLED' }), reasonCode, refundId: refund.refundId, refundAmount: refund.amount, seatsReleased: released['seatsReleased'] ?? 0 }, ownerId: booking.ownerId },
    ]);
    return cancellation;
  }
}

/** `BookingContext` de PostSale. */
export function postSaleContext(booking: BookingView, fares: BookingFares) {
  const departureOf = (itineraryId: string) => booking.itineraries.find((i) => i.itineraryId === itineraryId)?.segments[0]?.departure.at ?? new Date().toISOString();
  return {
    bookingId: booking.bookingId,
    status: booking.status,
    channel: booking.channel,
    ...(fares.partnerId ? { partnerId: fares.partnerId } : {}),
    currency: booking.grandTotal.currency,
    seatedPassengers: Math.max(1, seated(booking).length),
    fare: fares.fares.map((fare) => ({
      itineraryId: fare.itineraryId,
      cabinClass: fare.cabinClass,
      fareBrand: fare.fareBrand,
      price: fare.price,
      isRefundable: fare.isRefundable,
      isChangeable: fare.isChangeable,
      changeFeeUsd: fare.changeFeeUsd ?? '0.00',
      departureAt: departureOf(fare.itineraryId),
      departed: !fares.unflownItineraryIds.includes(fare.itineraryId),
    })),
  };
}

// ========================================================================================================= Cambiar fecha

export interface ChangeDateInput {
  bookingId: string;
  request: { changeOfferId: string; payment?: PaymentInput };
}

/**
 * "Cambiar fecha": Bookings → (las alternativas de Offers y la oferta de PostSale ya se calcularon en la búsqueda) → PostSale
 * consume la oferta → pago* → Offers retiene cupos en los vuelos nuevos → Bookings cambia los itinerarios → Offers libera los
 * viejos → `booking.changed`. Compensación: liberar los cupos nuevos y la oferta.
 */
@Injectable()
export class ChangeDateSaga implements SagaDefinition<ChangeDateInput, Any> {
  readonly type = 'CHANGE_DATE';
  constructor(@Inject(SagaDeps) private readonly d: SagaDeps) {}

  async run(saga: SagaContext, { bookingId, request }: ChangeDateInput) {
    const offer = await this.d.store.changeOffer(request.changeOfferId);
    if (!offer || offer.bookingId !== bookingId) throw problem(404, 'NOT_FOUND', 'La oferta de cambio no existe para esta reserva.');
    const booking = await this.d.booking(saga, bookingId);
    await assertNotCheckedIn(saga, this.d, bookingId);
    const fares = await this.d.fares(saga, bookingId);
    const consumed = await saga.step(
      'post-sale.consume-offer',
      async () => (await this.d.upstreams.postSale.call<Any>('ConsumeDateChangeOffer', { sagaId: saga.sagaId, bookingId, changeOfferId: request.changeOfferId }))['offer'],
      () => this.d.upstreams.postSale.call('ReleaseDateChangeOffer', { sagaId: saga.sagaId, changeOfferId: request.changeOfferId }),
    );
    const difference = consumed['priceDifference'];
    const toPay: MoneyAmount = { currency: difference['currency'], total: Number(difference['totalToPay']).toFixed(2) };
    const payment = await collectPayment(saga, this.d, { operation: 'DATE_CHANGE', payment: request.payment, expected: toPay, bookingId });

    const replacements = offer.data['replacements'] as { replacedItineraryId: string; itinerary: Itinerary; price: MoneyAmount }[];
    const replacedFare = (itineraryId: string) => fares.fares.find((f) => f.itineraryId === itineraryId)!;
    const newSegments = replacements.flatMap((r) => r.itinerary.segments.map((s) => ({ segmentId: s.segmentId, cabinClass: replacedFare(r.replacedItineraryId).cabinClass })));
    const ticketed = booking.tickets.some((t) => t.status === 'ISSUED');
    await saga.step(
      'offers.reserve-new',
      () =>
        this.d.offers.call('ReserveInventory', {
          bookingId,
          sagaId: sub(saga, 'reserve-new'),
          segments: newSegments.map((s) => ({ segmentId: s.segmentId, cabinClass: cabinEnum(s.cabinClass), count: seated(booking).length })),
          targetStatus: ticketed ? 'SEAT_STATUS_TICKETED' : 'SEAT_STATUS_BOOKED',
        }),
      () => this.d.offers.call('ReleaseBookingInventory', { bookingId, sagaId: sub(saga, 'undo-reserve-new'), segmentIds: newSegments.map((s) => s.segmentId), reason: 'SAGA_COMPENSATION' }),
    );
    const applied = await saga.step('bookings.apply-date-change', () =>
      this.d.bookings.json<BookingView>('POST', `/bookings/${bookingId}/date-change`, {
        caller: this.d.caller(saga),
        json: {
          changeOfferId: request.changeOfferId,
          replacedItineraryIds: replacements.map((r) => r.replacedItineraryId),
          newItineraries: replacements.map((r) => r.itinerary),
          newFares: replacements.map((r) => {
            const old = replacedFare(r.replacedItineraryId);
            return { itineraryId: r.itinerary.itineraryId, cabinClass: old.cabinClass, fareBrand: old.fareBrand, segmentIds: r.itinerary.segments.map((s) => s.segmentId), price: r.price, isRefundable: old.isRefundable, isChangeable: old.isChangeable };
          }),
          priceDifference: toPay,
          ...(payment ? { paymentReference: payment.paymentReference } : {}),
        },
      }),
    );
    saga.pointOfNoReturn();
    const oldSegments = replacements.flatMap((r) => booking.itineraries.find((i) => i.itineraryId === r.replacedItineraryId)?.segments.map((s) => s.segmentId) ?? []);
    await saga.step('offers.release-old', () => this.d.offers.call('ReleaseBookingInventory', { bookingId, sagaId: sub(saga, 'release-old'), segmentIds: oldSegments, reason: 'DATE_CHANGE' }));
    await publishEvents(saga, this.d.events, [
      { name: 'booking.changed', subject: bookingId, data: { ...bookingEventData(applied), changeType: 'DATE_CHANGE', amountCharged: toPay, paymentReference: payment?.paymentReference ?? null }, ownerId: booking.ownerId },
    ]);
    return applied;
  }
}

// ======================================================================================================== Agregar maletas

export interface AddBaggageInput {
  bookingId: string;
  request: { passengerId: string; itineraryId: string; quantity: number; payment?: PaymentInput };
}

/** "Agregar maletas": Bookings → PostSale (límite y monto) → pago* → Bookings → `booking.baggage_added`. El pago va al final. */
@Injectable()
export class AddBaggageSaga implements SagaDefinition<AddBaggageInput, Any> {
  readonly type = 'ADD_BAGGAGE';
  constructor(@Inject(SagaDeps) private readonly d: SagaDeps) {}

  async run(saga: SagaContext, { bookingId, request }: AddBaggageInput) {
    const booking = await this.d.booking(saga, bookingId);
    await assertNotCheckedIn(saga, this.d, bookingId);
    const fares = await this.d.fares(saga, bookingId);
    const line = baggageLine(booking, fares, request.passengerId, request.itineraryId);
    const validation = await saga.step('post-sale.validate-baggage', () => this.d.upstreams.postSale.call<Any>('ValidateBaggagePurchase', { bookingId, line, quantity: request.quantity }));
    const amount = validation['amountToCharge'] as Any;
    const expected: MoneyAmount = { currency: amount['currency'], ...(amount['baseFare'] ? { baseFare: Number(amount['baseFare']).toFixed(2) } : {}), ...(amount['taxes'] ? { taxes: Number(amount['taxes']).toFixed(2) } : {}), total: Number(amount['total']).toFixed(2) };
    const payment = await collectPayment(saga, this.d, { operation: 'BAGGAGE', payment: request.payment, expected, bookingId });
    const applied = await saga.step('bookings.apply-baggage', () =>
      this.d.bookings.json<Any>('POST', `/bookings/${bookingId}/baggage`, {
        caller: this.d.caller(saga),
        json: { passengerId: request.passengerId, itineraryId: request.itineraryId, quantity: request.quantity, amountCharged: expected, paymentReference: payment!.paymentReference },
      }),
    );
    saga.pointOfNoReturn();
    await publishEvents(saga, this.d.events, [
      { name: 'booking.baggage_added', subject: bookingId, data: { ...bookingEventData(booking), changeType: 'BAGGAGE', amountCharged: expected, paymentReference: payment?.paymentReference ?? null }, ownerId: booking.ownerId },
    ]);
    return applied;
  }
}

/** Una línea `BaggageLine` del XSD: lo ya comprado (Bookings) y el precio por maleta del itinerario (Offers, guardado en la reserva). */
export function baggageLine(booking: BookingView, fares: BookingFares, passengerId: string, itineraryId: string) {
  const itinerary = booking.itineraries.find((i) => i.itineraryId === itineraryId);
  if (!itinerary) throw problem(404, 'NOT_FOUND', 'El itinerario no es de la reserva.');
  const price = itinerary.pricingOptions?.[0]?.extraCheckedBaggagePrice;
  if (!price || toCents(price.total) <= 0) throw problem(422, 'BAGGAGE_LIMIT_EXCEEDED', 'La tarifa de este itinerario no admite maletas extra.');
  return {
    passengerId,
    itineraryId,
    alreadyPurchased: fares.baggage.find((b) => b.passengerId === passengerId && b.itineraryId === itineraryId)?.purchased ?? 0,
    unitPrice: price,
    departed: !fares.unflownItineraryIds.includes(itineraryId),
  };
}

// ==================================================================================================== Asistencia lista

export interface AssistanceReadyInput {
  bookingId: string;
  request: { passengerId: string; segmentId: string; ready: boolean };
}

/** "Marcar asistencia lista" (administrador): CheckIn la marca → Bookings actualiza el estado que ve el cliente. Compensación: desmarcar. */
@Injectable()
export class AssistanceReadySaga implements SagaDefinition<AssistanceReadyInput, Any> {
  readonly type = 'ASSISTANCE_READY';
  constructor(@Inject(SagaDeps) private readonly d: SagaDeps) {}

  async run(saga: SagaContext, { bookingId, request }: AssistanceReadyInput) {
    const checkIn = this.d.upstreams.rest['check-in'];
    const marked = await saga.step(
      'check-in.mark',
      () => checkIn.json<Any>('PUT', `/check-ins/${bookingId}/assistance-ready`, { caller: this.d.caller(saga), json: request }),
      () => checkIn.json('PUT', `/check-ins/${bookingId}/assistance-ready`, { caller: this.d.caller(saga), json: { ...request, ready: !request.ready } }),
    );
    await saga.step('bookings.assistance-status', () =>
      this.d.bookings.json('PUT', `/bookings/${bookingId}/passengers/${encodeURIComponent(request.passengerId)}/assistance/status`, { caller: this.d.caller(saga), json: { status: request.ready ? 'READY' : 'REQUESTED' } }),
    );
    saga.pointOfNoReturn();
    if (request.ready) {
      await publishEvents(saga, this.d.events, [{ name: 'booking.assistance_requested', visibility: 'internal', subject: bookingId, data: { bookingId, passengerId: request.passengerId, action: 'READY' } }]);
    }
    return marked;
  }
}

