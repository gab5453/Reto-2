import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { applyDiscount, type MoneyAmount, type PassengerCounts, seatsRequired, sumMoney } from '@ecoairlines/shared';
import { findFare, localDate, priceItinerary, priceRuleOf, seatsOf, toItineraryOption } from '../domain/catalog.js';
import type { BookingSeatRecord, CabinClass, FareSelection, HoldRecord, PassengerType, PricedSelection, SeatStatus } from '../domain/model.js';
import { OFFERS_STORE, type OffersStore, type OffersTx, SeatTakenError } from '../repositories/offers.store.js';
import { checkPassengers } from './catalog.service.js';
import { addEvent, channelOf, markStock, noCupos, offerGone, problem, TxReader, validation } from './common.js';

export const DEFAULT_TTL_MINUTES = 15;

export interface PassengerSeatRequest {
  passengerId: string;
  passengerType: PassengerType;
  requestedSeats: { segmentId: string; seatNumber: string }[];
}

export interface AssignedSeat {
  passengerId: string;
  segmentId: string;
  seatNumber: string;
  previousSeatNumber?: string;
  status: SeatStatus;
}

/** `SEAT_TAKEN` con el formato que espera Booking: título fijo y el asiento y el segmento en `detail` (T-1). */
const seatTaken = (error: SeatTakenError) =>
  problem(409, 'SEAT_TAKEN', 'Asiento no disponible', {
    detail: `El asiento ${error.seatNumber} del segmento ${error.segmentId} ya fue tomado.`,
    invalidParams: [{ name: 'seatNumber', reason: `${error.seatNumber} en ${error.segmentId}` }],
  });
const holdNotFound = () => problem(404, 'NOT_FOUND', 'Hold no encontrado.');

/**
 * Holds (`HoldService` del proto). Un hold retiene cupos HELD por 5–30 min y congela el precio. Cada cambio de estado es
 * condicional (`updateHoldIf`): un hold no se libera, vence ni consume dos veces aunque lleguen dos peticiones a la vez.
 */
@Injectable()
export class HoldsService {
  constructor(@Inject(OFFERS_STORE) private readonly store: OffersStore) {}

  now = (): number => Date.now();

  async create(input: { offerId: string; selections: FareSelection[]; passengers: Partial<PassengerCounts> | undefined; ttlMinutes?: number; ownerId: string }) {
    const ttl = input.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    if (!Number.isInteger(ttl) || ttl < 5 || ttl > 30) throw validation('ttlMinutes debe estar entre 5 y 30.', 'ttlMinutes', 'entre 5 y 30');
    if (!input.ownerId) throw validation('Falta el dueño del hold.', 'ownerId', 'obligatorio (D29)');
    const counts = checkPassengers(input.passengers, 'passengersBreakdown');
    const seats = seatsRequired(counts);
    return this.store.transaction(async (tx) => {
      const reader = new TxReader(tx);
      const itineraries = await reader.offer(input.offerId);
      if (!itineraries || itineraries.some((itinerary) => !itinerary.flights.every((flight) => flight.onSale) || Date.parse(itinerary.flights[0].departureAt) < this.now() + 60 * 60_000)) {
        throw offerGone();
      }
      const ids = itineraries.map((itinerary) => itinerary.itineraryId);
      const chosen = input.selections.map((selection) => selection.itineraryId);
      if (chosen.length !== ids.length || new Set(chosen).size !== chosen.length || !ids.every((id) => chosen.includes(id))) {
        throw problem(422, 'VALIDATION_FAILED', 'Debe elegirse una tarifa para cada itinerario de la oferta, sin repetir.', {
          invalidParams: [{ name: 'itinerarySelections', reason: 'una por cada itinerario de la oferta' }],
        });
      }
      const prices = await tx.farePrices();
      const pricing = await tx.pricingSettings();
      const priced: PricedSelection[] = [];
      for (const selection of input.selections) {
        const itinerary = itineraries.find((candidate) => candidate.itineraryId === selection.itineraryId)!;
        const fare = findFare(selection.cabinClass, selection.fareBrand);
        if (!fare) {
          throw problem(422, 'VALIDATION_FAILED', 'La cabina o familia tarifaria no existe en la oferta.', {
            invalidParams: [{ name: 'itinerarySelections', reason: `${selection.cabinClass}/${selection.fareBrand} no se ofrece en ${selection.itineraryId}` }],
          });
        }
        // Cupos de TODOS los vuelos o de ninguno: si uno falla, la transacción se revierte entera.
        for (const flight of itinerary.flights) {
          if (!(await tx.moveCupos(flight.segmentId, selection.cabinClass, 'AVAILABLE', 'HELD', seats))) throw noCupos();
        }
        const availableSeats = await reader.availableSeats(itinerary, selection.cabinClass);
        priced.push({
          ...selection,
          segmentIds: itinerary.flights.map((flight) => flight.segmentId),
          itinerary: toItineraryOption(itinerary, counts, { prices, pricing, availableSeats: () => availableSeats }, selection),
          price: priceItinerary(itinerary, priceRuleOf(fare, prices, pricing), counts),
        });
      }
      const now = this.now();
      const hold: HoldRecord = {
        holdId: randomUUID(),
        ownerId: input.ownerId,
        channel: channelOf(input.ownerId),
        status: 'HELD',
        offerId: input.offerId,
        counts,
        selections: priced,
        lockedPrice: sumMoney(priced.map((selection) => selection.price)),
        ttlMinutes: ttl,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttl * 60_000).toISOString(),
        bookingId: null,
      };
      await tx.insertHold(hold);
      for (const selection of priced) for (const segmentId of selection.segmentIds) await markStock(tx, segmentId, [selection.cabinClass]);
      await addEvent(tx, 'hold.created', hold.holdId, { holdId: hold.holdId, offerId: hold.offerId, seatsHeld: seats, expiresAt: hold.expiresAt }, hold.ownerId);
      return hold;
    });
  }

  /** Con `ownerId`, un hold de otro dueño responde NOT_FOUND (no revela que existe). Un hold vencido se marca EXPIRED al leerlo. */
  async get(holdId: string, ownerId?: string): Promise<HoldRecord> {
    return this.store.transaction(async (tx) => this.current(tx, holdId, ownerId));
  }

  /** Idempotente: liberar uno ya liberado o vencido no es error. Uno CONSUMED → HOLD_ALREADY_CONSUMED. */
  async release(holdId: string, ownerId?: string): Promise<HoldRecord> {
    return this.store.transaction(async (tx) => {
      const hold = await this.current(tx, holdId, ownerId);
      if (hold.status === 'CONSUMED') throw problem(409, 'HOLD_ALREADY_CONSUMED', 'El hold ya se convirtió en una reserva: cancele la reserva.');
      if (hold.status !== 'HELD') return hold;
      await this.freeCupos(tx, hold, 'RELEASED');
      return { ...hold, status: 'RELEASED' as const };
    });
  }

  /** Saga "Crear reserva": hold vigente del dueño y descuento dentro del acuerdo (D35). Devuelve el monto a cobrar (BKG-08). */
  async validate(
    holdId: string,
    ownerId: string,
    promotion?: { partnerId: string; discountPercentage: number },
    requestedSeats: { segmentId: string; seatNumber: string }[] = [],
  ) {
    return this.store.transaction(async (tx) => {
      const hold = await this.usable(tx, holdId, ownerId);
      await this.checkRequestedSeats(tx, hold, requestedSeats);
      let expected: MoneyAmount = hold.lockedPrice;
      if (promotion && promotion.discountPercentage > 0) {
        const rule = await tx.promotionRule(promotion.partnerId);
        const today = localDate(this.now());
        const outOfAgreement =
          !rule ||
          !rule.allowsPromotions ||
          !(promotion.discountPercentage <= rule.maxDiscountPercentage) ||
          (rule.validUntil && rule.validUntil < today) ||
          hold.selections.some(
            (selection) =>
              (rule.cabins.length > 0 && !rule.cabins.includes(selection.cabinClass)) ||
              (rule.routes.length > 0 && !rule.routes.includes(`${selection.itinerary.segments[0].departure.iataCode}-${selection.itinerary.segments.at(-1)!.arrival.iataCode}`)),
          );
        if (outOfAgreement) {
          throw problem(422, 'PROMOTION_DISCOUNT_OUT_OF_RANGE', 'El descuento supera el acuerdo de promociones o no aplica a este hold.', {
            detail: rule ? `Máximo ${rule.maxDiscountPercentage} % (${rule.allowsPromotions ? 'con' : 'sin'} promociones).` : 'No hay acuerdo de promociones con el partner.',
            invalidParams: [{ name: 'salesChannel.discountPercentage', reason: `${promotion.discountPercentage} % fuera del acuerdo` }],
          });
        }
        expected = applyDiscount(hold.lockedPrice, promotion.discountPercentage);
      }
      return { hold, expectedAmount: expected };
    });
  }

  /**
   * Saga "Crear reserva": HELD → BOOKED y asientos (los pedidos o el primero libre de la cabina). Idempotente por `bookingId`:
   * repetirlo devuelve el mismo resultado. Todos los asientos o ninguno (SEAT_TAKEN revierte la operación entera).
   */
  async consume(input: { holdId: string; bookingId: string; ownerId: string; passengers: PassengerSeatRequest[] }) {
    if (!input.bookingId) throw validation('Falta bookingId.', 'bookingId', 'obligatorio (idempotencia)');
    const key = `consume:${input.bookingId}`;
    try {
      return await this.store.transaction(async (tx) => {
        const previous = await tx.sagaResult<{ hold: HoldRecord; seats: AssignedSeat[] }>(key);
        if (previous) return previous;
        const hold = await this.current(tx, input.holdId, input.ownerId);
        if (hold.status === 'CONSUMED') throw problem(409, 'HOLD_ALREADY_CONSUMED', 'El hold ya se usó para otra reserva.');
        if (hold.status !== 'HELD') throw problem(410, 'HOLD_EXPIRED', 'El hold venció o fue liberado.');
        this.checkPassengerList(hold, input.passengers);
        if (!(await tx.updateHoldIf(hold.holdId, 'HELD', { status: 'CONSUMED', bookingId: input.bookingId }))) {
          throw problem(409, 'HOLD_ALREADY_CONSUMED', 'El hold ya se usó para otra reserva.');
        }
        const seated = input.passengers.filter((passenger) => passenger.passengerType !== 'INFANT');
        const seats: AssignedSeat[] = [];
        for (const selection of hold.selections) {
          for (const segmentId of selection.segmentIds) {
            if (!(await tx.moveCupos(segmentId, selection.cabinClass, 'HELD', 'BOOKED', seated.length))) throw problem(500, 'INTERNAL_ERROR', 'Inventario inconsistente.');
            for (const passenger of seated) {
              const requested = passenger.requestedSeats.find((seat) => seat.segmentId === segmentId)?.seatNumber;
              seats.push(await this.placeSeat(tx, { bookingId: input.bookingId, segmentId, cabinClass: selection.cabinClass, passengerId: passenger.passengerId, status: 'BOOKED' }, requested));
            }
          }
        }
        const result = { hold: { ...hold, status: 'CONSUMED' as const, bookingId: input.bookingId }, seats };
        await tx.saveSagaResult(key, result);
        return result;
      });
    } catch (error) {
      throw error instanceof SeatTakenError ? seatTaken(error) : error;
    }
  }

  /** Barrido: vence los holds pasados de hora y devuelve sus cupos (cada uno en su transacción). */
  async sweep(): Promise<number> {
    let expired = 0;
    for (const holdId of await this.store.dueHolds(new Date(this.now()).toISOString(), 200)) {
      expired += await this.store.transaction(async (tx) => {
        const hold = await tx.hold(holdId);
        return hold && (await this.expireIfDue(tx, hold)).status === 'EXPIRED' && hold.status === 'HELD' ? 1 : 0;
      });
    }
    return expired;
  }

  /**
   * Cupo con asiento para un pasajero. Con asiento pedido: debe existir, ser de su cabina y estar libre (SEAT_TAKEN). Sin
   * asiento: el primero libre de la cabina (si otro cliente lo toma en ese instante, prueba con el siguiente).
   */
  async placeSeat(tx: OffersTx, base: Omit<BookingSeatRecord, 'id' | 'seatNumber'>, requested?: string): Promise<AssignedSeat> {
    const flight = (await tx.flight(base.segmentId))!;
    const layout = seatsOf(flight.aircraftType);
    if (requested) {
      const seat = layout.find((candidate) => candidate.seatNumber === requested);
      if (!seat) throw validation('El asiento no existe en el avión.', 'seatNumber', `${requested} en ${base.segmentId}`);
      if (seat.cabinClass !== base.cabinClass) {
        throw problem(422, 'SEAT_CABIN_MISMATCH', `El asiento ${requested} es de ${seat.cabinClass} y la tarifa es ${base.cabinClass}.`, { invalidParams: [{ name: 'seatNumber', reason: requested }] });
      }
      if (!(await tx.insertBookingSeat({ ...base, id: randomUUID(), seatNumber: requested }))) throw new SeatTakenError(base.segmentId, requested);
      return { passengerId: base.passengerId!, segmentId: base.segmentId, seatNumber: requested, status: base.status };
    }
    const taken = new Set((await tx.assignedSeats(base.segmentId)).map((seat) => seat.seatNumber));
    for (const seat of layout.filter((candidate) => candidate.cabinClass === base.cabinClass && !taken.has(candidate.seatNumber))) {
      if (await tx.insertBookingSeat({ ...base, id: randomUUID(), seatNumber: seat.seatNumber })) {
        return { passengerId: base.passengerId!, segmentId: base.segmentId, seatNumber: seat.seatNumber, status: base.status };
      }
    }
    throw noCupos();
  }

  /** Lee el hold (del dueño, si se indica) y lo vence si ya pasó su hora. */
  private async current(tx: OffersTx, holdId: string, ownerId?: string): Promise<HoldRecord> {
    const hold = await tx.hold(holdId);
    if (!hold || (ownerId !== undefined && ownerId !== '' && hold.ownerId !== ownerId)) throw holdNotFound();
    return this.expireIfDue(tx, hold);
  }

  /**
   * Revisión previa al pago (T-1): cada asiento pedido existe, es de la cabina comprada y está libre. No ocupa nada: el asiento se
   * toma de forma atómica al consumir el hold (si otro cliente lo toma en ese instante, ahí también responde SEAT_TAKEN).
   */
  private async checkRequestedSeats(tx: OffersTx, hold: HoldRecord, requested: { segmentId: string; seatNumber: string }[]) {
    if (!requested.length) return;
    const seen = new Set<string>();
    for (const { segmentId, seatNumber } of requested) {
      const key = `${segmentId}/${seatNumber}`;
      if (seen.has(key)) throw validation('Dos pasajeros pidieron el mismo asiento.', 'assignedSeats', `${seatNumber} en ${segmentId}`);
      seen.add(key);
      const selection = hold.selections.find((candidate) => candidate.segmentIds.includes(segmentId));
      if (!selection) throw validation('El segmento no es de la reserva temporal.', 'assignedSeats', segmentId);
      const flight = await tx.flight(segmentId);
      const seat = flight && seatsOf(flight.aircraftType).find((candidate) => candidate.seatNumber === seatNumber);
      if (!seat) throw validation('El asiento no existe en el avión.', 'seatNumber', `${seatNumber} en ${segmentId}`);
      if (seat.cabinClass !== selection.cabinClass) {
        throw problem(422, 'SEAT_CABIN_MISMATCH', `El asiento ${seatNumber} es de ${seat.cabinClass} y la tarifa es ${selection.cabinClass}.`, { invalidParams: [{ name: 'seatNumber', reason: seatNumber }] });
      }
      if ((await tx.assignedSeats(segmentId)).some((taken) => taken.seatNumber === seatNumber)) throw seatTaken(new SeatTakenError(segmentId, seatNumber));
    }
  }

  private async usable(tx: OffersTx, holdId: string, ownerId: string): Promise<HoldRecord> {
    const hold = await this.current(tx, holdId, ownerId);
    if (hold.status === 'CONSUMED') throw problem(409, 'HOLD_ALREADY_CONSUMED', 'El hold ya se usó para una reserva.');
    if (hold.status !== 'HELD') throw problem(410, 'HOLD_EXPIRED', 'El hold venció o fue liberado.');
    return hold;
  }

  private async expireIfDue(tx: OffersTx, hold: HoldRecord): Promise<HoldRecord> {
    if (hold.status !== 'HELD' || Date.parse(hold.expiresAt) > this.now()) return hold;
    if (await this.freeCupos(tx, hold, 'EXPIRED')) {
      await addEvent(tx, 'hold.expired', hold.holdId, { holdId: hold.holdId, seatsReleased: seatsRequired(hold.counts), expiredAt: new Date(this.now()).toISOString() }, hold.ownerId);
    }
    return { ...hold, status: 'EXPIRED' };
  }

  /** HELD → RELEASED/EXPIRED y devuelve los cupos. `false` si otro ya lo había cambiado (no se libera dos veces). */
  async freeCupos(tx: OffersTx, hold: HoldRecord, status: 'RELEASED' | 'EXPIRED'): Promise<boolean> {
    if (!(await tx.updateHoldIf(hold.holdId, 'HELD', { status }))) return false;
    const seats = seatsRequired(hold.counts);
    for (const selection of hold.selections) {
      for (const segmentId of selection.segmentIds) {
        await tx.moveCupos(segmentId, selection.cabinClass, 'HELD', 'AVAILABLE', seats);
        await markStock(tx, segmentId, [selection.cabinClass]);
      }
    }
    return true;
  }

  /** Los pasajeros de la reserva deben coincidir con el desglose del hold (PASSENGER_COUNT_MISMATCH); los infantes no ocupan asiento. */
  private checkPassengerList(hold: HoldRecord, passengers: PassengerSeatRequest[]): void {
    const count = (type: PassengerType) => passengers.filter((passenger) => passenger.passengerType === type).length;
    const matches = count('ADULT') === hold.counts.adults && count('YOUTH') === hold.counts.youths && count('CHILD') === hold.counts.children && count('INFANT') === hold.counts.infants;
    if (!matches || new Set(passengers.map((passenger) => passenger.passengerId)).size !== passengers.length) {
      throw problem(422, 'PASSENGER_COUNT_MISMATCH', 'Los pasajeros no coinciden con el desglose del hold.', {
        invalidParams: [{ name: 'passengers', reason: `se esperan ${hold.counts.adults} adultos, ${hold.counts.youths} jóvenes, ${hold.counts.children} niños y ${hold.counts.infants} infantes` }],
      });
    }
    const segments = new Set(hold.selections.flatMap((selection) => selection.segmentIds));
    for (const passenger of passengers) {
      if (passenger.passengerType === 'INFANT' && passenger.requestedSeats.length) {
        throw problem(422, 'INFANT_SEAT_NOT_ALLOWED', 'Un infante viaja en el regazo de un adulto: no ocupa asiento.', { invalidParams: [{ name: 'assignedSeats', reason: passenger.passengerId }] });
      }
      for (const seat of passenger.requestedSeats) {
        if (!segments.has(seat.segmentId)) throw validation('El asiento es de un segmento que no está en el hold.', 'assignedSeats.segmentId', seat.segmentId);
      }
      const perSegment = passenger.requestedSeats.map((seat) => seat.segmentId);
      if (new Set(perSegment).size !== perSegment.length) throw validation('Un pasajero pidió dos asientos en el mismo segmento.', 'assignedSeats', passenger.passengerId);
    }
    const requested = passengers.flatMap((passenger) => passenger.requestedSeats.map((seat) => `${seat.segmentId}/${seat.seatNumber}`));
    if (new Set(requested).size !== requested.length) throw validation('Dos pasajeros pidieron el mismo asiento.', 'assignedSeats', 'asiento repetido');
  }
}

export type { CabinClass };
