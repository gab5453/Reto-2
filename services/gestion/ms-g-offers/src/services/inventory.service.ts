import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { seatsByCabin } from '@ecoairlines/shared';
import { buildSegmentId, localDate, seatsOf } from '../domain/catalog.js';
import {
  available,
  type BookingSeatRecord,
  type CabinClass,
  type FlightRecord,
  type InventoryRecord,
  type PromotionRuleRecord,
  type SeatStatus,
  TAKEN_STATUSES,
  type TakenStatus,
} from '../domain/model.js';
import { OFFERS_STORE, type OffersStore, type OffersTx, SeatTakenError } from '../repositories/offers.store.js';
import { markStock, noCupos, problem, validation } from './common.js';
import { type AssignedSeat, HoldsService } from './holds.service.js';

/** Transiciones permitidas de los asientos de una reserva (contrato v2 §10) y su inversa para compensar. */
const FORWARD: [TakenStatus, TakenStatus][] = [
  ['BOOKED', 'TICKETED'],
  ['TICKETED', 'CHECKED_IN'],
  ['CHECKED_IN', 'BOARDED'],
];
const ALLOWED = new Set([...FORWARD, ...FORWARD.map(([from, to]) => [to, from] as const)].map(([from, to]) => `${from}>${to}`));

export interface SeatOperationResult {
  bookingId: string;
  seats: AssignedSeat[];
  seatsAffected: number;
}

const seatTaken = (error: SeatTakenError) =>
  problem(409, 'SEAT_TAKEN', `El asiento ${error.seatNumber} ya no está disponible.`, { invalidParams: [{ name: 'seatNumber', reason: `${error.seatNumber} en ${error.segmentId}` }] });

const toAssigned = (seat: BookingSeatRecord, previous?: string | null): AssignedSeat => ({
  passengerId: seat.passengerId ?? '',
  segmentId: seat.segmentId,
  seatNumber: seat.seatNumber ?? '',
  ...(previous ? { previousSeatNumber: previous } : {}),
  status: seat.status,
});

/**
 * Inventario y asientos de las reservas (`InventoryService` y `PublishingService` del proto). Las operaciones de saga llevan
 * `sagaId`: repetirlas devuelve el resultado anterior sin efecto doble.
 */
@Injectable()
export class InventoryService {
  constructor(
    @Inject(OFFERS_STORE) private readonly store: OffersStore,
    @Inject(HoldsService) private readonly holds: HoldsService,
  ) {}

  now = (): number => Date.now();

  /** Ocupa asientos concretos, todos o ninguno; el asiento anterior del pasajero en ese segmento se libera en la misma operación. */
  reserveSeats(input: {
    bookingId: string;
    sagaId: string;
    seats: { passengerId: string; segmentId: string; seatNumber: string }[];
    purchasedCabins: { passengerId: string; segmentId: string; cabinClass: CabinClass }[];
    targetStatus: SeatStatus;
  }): Promise<SeatOperationResult> {
    return this.saga(`reserve-seats:${input.sagaId}`, async (tx) => {
      const current = await tx.bookingSeats(input.bookingId);
      const result: AssignedSeat[] = [];
      for (const request of input.seats) {
        const purchased = input.purchasedCabins.find((cabin) => cabin.passengerId === request.passengerId && cabin.segmentId === request.segmentId);
        const flight = await tx.flight(request.segmentId);
        const seat = flight && seatsOf(flight.aircraftType).find((candidate) => candidate.seatNumber === request.seatNumber);
        if (!flight || !seat) throw validation('El asiento no existe en ese vuelo.', 'seats', `${request.seatNumber} en ${request.segmentId}`);
        if (!purchased || seat.cabinClass !== purchased.cabinClass) {
          throw problem(422, 'SEAT_CABIN_MISMATCH', `El asiento ${request.seatNumber} no es de la cabina comprada.`, { invalidParams: [{ name: 'seats', reason: request.seatNumber }] });
        }
        // El cupo del pasajero (con o sin asiento) o, si no tiene, uno de la reserva sin pasajero (cambio de fecha).
        const own =
          current.find((row) => row.segmentId === request.segmentId && row.passengerId === request.passengerId) ??
          current.find((row) => row.segmentId === request.segmentId && row.passengerId === null && row.cabinClass === purchased.cabinClass);
        if (!own) throw problem(404, 'NOT_FOUND', 'El pasajero no tiene cupo en ese segmento.');
        const previous = own.seatNumber;
        const updated: BookingSeatRecord = { ...own, passengerId: request.passengerId, seatNumber: request.seatNumber, status: await this.retarget(tx, own, input.targetStatus) };
        await tx.updateBookingSeat(updated);
        current.splice(current.indexOf(own), 1, updated);
        result.push(toAssigned(updated, previous !== request.seatNumber ? previous : null));
      }
      return { bookingId: input.bookingId, seats: result, seatsAffected: result.length };
    });
  }

  /** Check-in: el primer asiento libre de su cabina para los pasajeros que todavía no tienen. */
  autoAssignSeats(input: { bookingId: string; sagaId: string; passengers: { passengerId: string; segmentId: string; cabinClass: CabinClass }[]; targetStatus: SeatStatus }) {
    return this.saga(`auto-assign:${input.sagaId}`, async (tx) => {
      const current = await tx.bookingSeats(input.bookingId);
      const result: AssignedSeat[] = [];
      for (const passenger of input.passengers) {
        const own =
          current.find((row) => row.segmentId === passenger.segmentId && row.passengerId === passenger.passengerId) ??
          current.find((row) => row.segmentId === passenger.segmentId && row.passengerId === null && row.cabinClass === passenger.cabinClass);
        if (!own) throw problem(404, 'NOT_FOUND', 'El pasajero no tiene cupo en ese segmento.');
        if (own.seatNumber) continue;
        // Se borra el cupo sin asiento y se inserta con el primer asiento libre (si otro lo toma, se prueba el siguiente).
        const status = await this.retarget(tx, own, input.targetStatus);
        await tx.deleteBookingSeats([own.id]);
        const placed = await this.holds.placeSeat(tx, { bookingId: own.bookingId, segmentId: own.segmentId, cabinClass: own.cabinClass, passengerId: passenger.passengerId, status });
        current.splice(current.indexOf(own), 1);
        result.push(placed);
      }
      return { bookingId: input.bookingId, seats: result, seatsAffected: result.length };
    });
  }

  /** BOOKED → TICKETED → CHECKED_IN → BOARDED (y la inversa, para compensar), en los cupos y en los asientos. */
  transition(input: { bookingId: string; sagaId: string; from: SeatStatus; to: SeatStatus; segmentIds: string[]; passengerIds: string[] }) {
    if (!ALLOWED.has(`${input.from}>${input.to}`)) throw validation(`Transición no permitida: ${input.from} → ${input.to}.`, 'toStatus', 'un paso de la máquina de estados');
    return this.saga(`transition:${input.sagaId}`, async (tx) => {
      const rows = (await tx.bookingSeats(input.bookingId)).filter(
        (row) =>
          row.status === input.from &&
          (!input.segmentIds.length || input.segmentIds.includes(row.segmentId)) &&
          (!input.passengerIds.length || (row.passengerId !== null && input.passengerIds.includes(row.passengerId))),
      );
      for (const row of rows) {
        if (!(await tx.moveCupos(row.segmentId, row.cabinClass, input.from as TakenStatus, input.to as TakenStatus, 1))) throw problem(500, 'INTERNAL_ERROR', 'Inventario inconsistente.');
        await tx.updateBookingSeat({ ...row, status: input.to as TakenStatus });
      }
      return { bookingId: input.bookingId, seats: rows.filter((row) => row.seatNumber).map((row) => toAssigned({ ...row, status: input.to as TakenStatus })), seatsAffected: rows.length };
    });
  }

  /** Cambio de fecha: retiene cupos (sin asiento) en los segmentos nuevos, todos o ninguno. */
  reserveInventory(input: { bookingId: string; sagaId: string; segments: { segmentId: string; cabinClass: CabinClass; count: number }[]; targetStatus: SeatStatus }) {
    return this.saga(`reserve-inventory:${input.sagaId}`, async (tx) => {
      const status = this.status(input.targetStatus, 'BOOKED');
      for (const segment of input.segments) {
        const flight = await tx.flight(segment.segmentId);
        if (!flight || !flight.onSale) throw problem(410, 'OFFER_NO_LONGER_AVAILABLE', `El vuelo ${segment.segmentId} ya no está a la venta.`);
        if (!(await tx.moveCupos(segment.segmentId, segment.cabinClass, 'AVAILABLE', status, segment.count))) throw noCupos();
        for (let index = 0; index < segment.count; index++) {
          await tx.insertBookingSeat({ id: randomUUID(), bookingId: input.bookingId, segmentId: segment.segmentId, cabinClass: segment.cabinClass, status, passengerId: null, seatNumber: null });
        }
        await markStock(tx, segment.segmentId, [segment.cabinClass]);
      }
      const total = input.segments.reduce((sum, segment) => sum + segment.count, 0);
      return { bookingId: input.bookingId, seats: [], seatsAffected: total };
    });
  }

  /** Cancelar, cambio de fecha y compensaciones: libera cupos y asientos → AVAILABLE. */
  release(input: { bookingId: string; sagaId: string; segmentIds: string[]; reason: string }) {
    return this.saga(`release:${input.sagaId}`, async (tx) => {
      const rows = (await tx.bookingSeats(input.bookingId)).filter((row) => !input.segmentIds.length || input.segmentIds.includes(row.segmentId));
      for (const row of rows) await tx.moveCupos(row.segmentId, row.cabinClass, row.status, 'AVAILABLE', 1);
      await tx.deleteBookingSeats(rows.map((row) => row.id));
      for (const segmentId of new Set(rows.map((row) => row.segmentId))) await markStock(tx, segmentId);
      return { seatsReleased: rows.length, newSeatStatus: 'AVAILABLE' as const };
    });
  }

  /** D37: cierra la venta (stock 0 para Booking) y libera los holds vigentes del vuelo. Reabrir es la compensación. */
  setSales(input: { flightNumber: string; date: string; sagaId: string; reason: string }, onSale: boolean) {
    return this.saga(`${onSale ? 'reopen' : 'close'}:${input.sagaId}`, async (tx) => {
      const segmentId = buildSegmentId(input.flightNumber, input.date);
      const flight = await tx.flight(segmentId);
      if (!flight) throw problem(404, 'NOT_FOUND', 'Vuelo no encontrado.');
      let released = 0;
      if (!onSale) {
        for (const hold of await tx.activeHoldsOn(segmentId)) if (await this.holds.freeCupos(tx, hold, 'RELEASED')) released++;
      }
      await tx.saveFlight({ ...flight, onSale, closedReason: onSale ? null : input.reason || 'CLOSED' });
      await markStock(tx, segmentId);
      return { flightNumber: input.flightNumber, date: input.date, onSale, activeHoldsReleased: released };
    });
  }

  /** Saga "Publicar horario": cupos vendidos o retenidos de hoy en adelante en esos vuelos. */
  countSoldSeats(flightNumbers: string[], fromDate: string) {
    return this.store.transaction(async (tx) => {
      let sold = 0;
      for (const flight of await tx.flightsByNumbers(flightNumbers, fromDate)) {
        for (const row of await tx.inventory(flight.segmentId)) sold += row.total - available(row);
      }
      return sold;
    });
  }

  /** Composición "Operaciones": asientos por estado, ocupación, holds activos y próximo vencimiento de cada vuelo del día. */
  occupancy(date: string, origin?: string, destination?: string) {
    return this.store.transaction(async (tx) => {
      const flights = (await tx.flightsOn(date)).filter((flight) => (!origin || flight.origin === origin) && (!destination || flight.destination === destination));
      const result = [];
      for (const flight of flights) {
        const inventory = await tx.inventory(flight.segmentId);
        const holds = await tx.activeHoldsOn(flight.segmentId);
        const total = inventory.reduce((sum, row) => sum + row.total, 0);
        const free = inventory.reduce((sum, row) => sum + available(row), 0);
        result.push({
          flightNumber: flight.flightNumber,
          date: flight.date,
          origin: flight.origin,
          destination: flight.destination,
          departureAt: flight.departureAt,
          aircraft: flight.aircraftType,
          totalSeats: total,
          loadFactor: total ? Math.round(((total - free) / total) * 1000) / 10 : 0,
          cabins: inventory.map((row) => ({ cabinClass: row.cabinClass, totalSeats: row.total, seatsByStatus: byStatus(row) })),
          activeHolds: holds.length,
          ...(holds.length ? { nextHoldExpiryAt: holds.map((hold) => hold.expiresAt).sort()[0] } : {}),
          onSale: flight.onSale,
        });
      }
      return { date, flights: result };
    });
  }

  stats() {
    return this.store.stats(localDate(this.now()));
  }

  /**
   * Saga "Publicar horario": reemplaza los vuelos a la venta del rango (o de una ruta). Un vuelo con cupos vendidos no se borra
   * ni cambia de tipo de avión (`keptWithSales`). Cada vuelo nuevo o cambiado deja pendiente su stock para Booking.
   */
  publishTimetable(input: { publishId: string; from: string; to: string; routeId?: string; flights: Omit<FlightRecord, 'segmentId' | 'onSale' | 'closedReason'>[] }) {
    return this.saga(`publish-timetable:${input.publishId}`, async (tx) => {
      const existing = new Map((await tx.flightsInRange(input.from, input.to, input.routeId)).map((flight) => [flight.segmentId, flight]));
      const counters = { added: 0, updated: 0, removed: 0, keptWithSales: 0 };
      const touched: string[] = [];
      for (const incoming of input.flights) {
        if (incoming.date < input.from || incoming.date > input.to || (input.routeId && incoming.routeId !== input.routeId)) continue;
        const segmentId = buildSegmentId(incoming.flightNumber, incoming.date);
        const current = existing.get(segmentId);
        existing.delete(segmentId);
        const capacity = seatsByCabin(incoming.aircraftType);
        if (!current) {
          await tx.saveFlight({ ...incoming, segmentId, onSale: true, closedReason: null });
          for (const cabin of capacity) await tx.saveInventory(emptyInventory(segmentId, cabin.cabinClass, cabin.seats));
          counters.added++;
          touched.push(segmentId);
          continue;
        }
        const inventory = await tx.inventory(segmentId);
        const fits = capacity.every((cabin) => {
          const row = inventory.find((candidate) => candidate.cabinClass === cabin.cabinClass);
          return !row || row.total - available(row) <= cabin.seats;
        }) && inventory.every((row) => capacity.some((cabin) => cabin.cabinClass === row.cabinClass) || row.total === available(row));
        const changed = ['routeId', 'departureAt', 'arrivalAt', 'aircraftType', 'registration'].some((field) => current[field as keyof FlightRecord] !== incoming[field as keyof typeof incoming]);
        if (!changed) continue;
        if (incoming.aircraftType !== current.aircraftType && !fits) {
          counters.keptWithSales++;
          continue;
        }
        await tx.saveFlight({ ...current, ...incoming, segmentId });
        if (incoming.aircraftType !== current.aircraftType) {
          for (const cabin of capacity) {
            const row = inventory.find((candidate) => candidate.cabinClass === cabin.cabinClass) ?? emptyInventory(segmentId, cabin.cabinClass, 0);
            await tx.saveInventory({ ...row, total: cabin.seats });
          }
        }
        counters.updated++;
        touched.push(segmentId);
      }
      // Los que ya no están en el horario: se quitan si nadie compró; si no, se conservan.
      for (const flight of existing.values()) {
        const inventory = await tx.inventory(flight.segmentId);
        if (inventory.some((row) => row.total !== available(row))) {
          counters.keptWithSales++;
          continue;
        }
        for (const row of inventory) {
          await tx.markStock({ segmentId: flight.segmentId, cabinClass: row.cabinClass, flightNumber: flight.flightNumber, date: flight.date, timeSlot: flight.departureAt.slice(11, 16), units: 0 });
        }
        await tx.deleteFlight(flight.segmentId);
        counters.removed++;
      }
      for (const segmentId of touched) await markStock(tx, segmentId);
      return { publishId: input.publishId, ...counters, publishedAt: new Date(this.now()).toISOString() };
    });
  }

  /** Saga "Guardar precios y descuento máximo": reemplaza la copia de precios y de reglas de promoción. */
  publishFarePrices(input: { publishId: string; prices: { cabinClass: CabinClass; fareBrand: string; multiplier: number }[]; promotions: PromotionRuleRecord[] }) {
    const outOfRange = input.prices.filter((price) => !(price.multiplier >= 0.5 && price.multiplier <= 10));
    if (outOfRange.length) throw validation('Multiplicador fuera de 0,5–10.', 'prices', outOfRange.map((price) => `${price.cabinClass}/${price.fareBrand}`).join(', '));
    const discount = input.promotions.find((rule) => !(rule.maxDiscountPercentage >= 0 && rule.maxDiscountPercentage <= 50));
    if (discount) throw problem(422, 'PROMOTION_DISCOUNT_OUT_OF_RANGE', 'El descuento máximo debe estar entre 0 y 50 %.', { invalidParams: [{ name: 'promotions', reason: discount.partnerId }] });
    return this.saga(`publish-prices:${input.publishId}`, async (tx) => {
      const before = await tx.farePrices();
      await tx.replaceFarePrices(input.prices);
      await tx.replacePromotionRules(input.promotions);
      const updated = input.prices.filter((price) => before.some((old) => old.cabinClass === price.cabinClass && old.fareBrand === price.fareBrand)).length;
      return { publishId: input.publishId, added: input.prices.length - updated, updated, removed: Math.max(0, before.length - updated), keptWithSales: 0, publishedAt: new Date(this.now()).toISOString() };
    });
  }

  /** Ejecuta una operación de saga una sola vez por clave: repetirla devuelve el resultado guardado. */
  private async saga<T>(key: string, work: (tx: OffersTx) => Promise<T>): Promise<T> {
    if (key.endsWith(':')) throw validation('Falta sagaId.', 'sagaId', 'obligatorio (idempotencia)');
    try {
      return await this.store.transaction(async (tx) => {
        const previous = await tx.sagaResult<T>(key);
        if (previous !== undefined) return previous;
        const result = await work(tx);
        await tx.saveSagaResult(key, result);
        return result;
      });
    } catch (error) {
      throw error instanceof SeatTakenError ? seatTaken(error) : error;
    }
  }

  /** Estado destino de un cupo: el pedido o, si no llega, el que ya tenía. */
  private status(target: SeatStatus | undefined, fallback: TakenStatus): TakenStatus {
    return target && target !== 'AVAILABLE' ? target : fallback;
  }

  /** Si el asiento cambia de estado, su cupo también (los conteos por estado siempre cuadran con los asientos). */
  private async retarget(tx: OffersTx, row: BookingSeatRecord, target: SeatStatus | undefined): Promise<TakenStatus> {
    const status = this.status(target, row.status);
    if (status !== row.status && !(await tx.moveCupos(row.segmentId, row.cabinClass, row.status, status, 1))) throw problem(500, 'INTERNAL_ERROR', 'Inventario inconsistente.');
    return status;
  }
}

function emptyInventory(segmentId: string, cabinClass: CabinClass, total: number): InventoryRecord {
  return { segmentId, cabinClass, total, counts: { HELD: 0, BOOKED: 0, TICKETED: 0, CHECKED_IN: 0, BOARDED: 0 } };
}

function byStatus(row: InventoryRecord) {
  return {
    available: available(row),
    ...Object.fromEntries(TAKEN_STATUSES.map((status) => [{ HELD: 'held', BOOKED: 'booked', TICKETED: 'ticketed', CHECKED_IN: 'checkedIn', BOARDED: 'boarded' }[status], row.counts[status]])),
  } as Record<'available' | 'held' | 'booked' | 'ticketed' | 'checkedIn' | 'boarded', number>;
}
