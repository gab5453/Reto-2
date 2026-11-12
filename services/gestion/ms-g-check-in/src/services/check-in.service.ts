import { Inject, Injectable } from '@nestjs/common';
import { ProblemDetailsException } from '@ecoairlines/shared';
import { type AssistanceReadyRecord, bcbp, boardingGroup, type CheckInRecord } from '../domain/boarding.js';
import { CHECK_IN_STORE, type CheckInStore, type CheckInTx } from '../repositories/check-in.store.js';

export interface RegisterCheckIn {
  sagaId: string;
  pnr: string;
  passengers: {
    passengerId: string;
    passengerType: CheckInRecord['passengerType'];
    firstName: string;
    lastName: string;
    eTicketNumber?: string | null;
    segments: { segmentId: string; flightNumber: string; origin: string; destination: string; departureAt: string; cabinClass?: string; seat: string | null; gate?: string | null; needsAssistance?: boolean }[];
  }[];
}

const problem = (status: number, code: string, title: string, detail?: string) => new ProblemDetailsException({ status, code, title, ...(detail ? { detail } : {}) });

/**
 * MS.G.CheckIn: registra el check-in por pasajero y segmento y genera los pases. No valida la ventana de 48 h ni los boletos
 * (lo hacen FlightStatus y Bookings en pasos anteriores de la saga); sí que no haya un check-in previo (sin duplicados).
 */
@Injectable()
export class CheckInService {
  constructor(@Inject(CHECK_IN_STORE) private readonly store: CheckInStore) {}

  now = (): number => Date.now();

  /**
   * Todos o ninguno. Un pasajero que ya tiene check-in en ese segmento → 409 CHECK_IN_NOT_AVAILABLE; el reintento de la MISMA
   * saga (mismo `sagaId`) devuelve el resultado anterior. Un vuelo que ya salió → 409 FLIGHT_ALREADY_DEPARTED.
   */
  register(bookingId: string, input: RegisterCheckIn) {
    return this.store.transaction(async (tx) => {
      const existing = await tx.checkIns(bookingId);
      const requested = input.passengers.flatMap((p) => p.segments.map((s) => ({ passengerId: p.passengerId, segmentId: s.segmentId })));
      const already = existing.filter((row) => requested.some((r) => r.passengerId === row.passengerId && r.segmentId === row.segmentId));
      if (already.length === requested.length && already.every((row) => row.sagaId === input.sagaId)) return this.response(bookingId, already);
      if (already.length) throw problem(409, 'CHECK_IN_NOT_AVAILABLE', 'El check-in ya fue realizado.', `Pasajero ${already[0].passengerId} en ${already[0].segmentId}.`);
      const now = new Date(this.now()).toISOString();
      const created: CheckInRecord[] = [];
      for (const segmentId of [...new Set(requested.map((r) => r.segmentId))].sort()) {
        await tx.lockSegment(segmentId);
        let position = await tx.countOnSegment(segmentId);
        for (const passenger of input.passengers) {
          const segment = passenger.segments.find((s) => s.segmentId === segmentId);
          if (!segment) continue;
          if (Date.parse(segment.departureAt) <= this.now()) throw problem(409, 'FLIGHT_ALREADY_DEPARTED', `El vuelo ${segment.flightNumber} ya salió.`);
          const record: CheckInRecord = {
            bookingId,
            segmentId,
            passengerId: passenger.passengerId,
            sagaId: input.sagaId,
            pnr: input.pnr,
            passengerType: passenger.passengerType,
            firstName: passenger.firstName,
            lastName: passenger.lastName,
            eTicketNumber: passenger.eTicketNumber ?? null,
            flightNumber: segment.flightNumber,
            origin: segment.origin,
            destination: segment.destination,
            departureAt: segment.departureAt,
            cabinClass: segment.cabinClass ?? 'ECONOMY',
            seat: passenger.passengerType === 'INFANT' ? null : segment.seat,
            gate: segment.gate ?? null,
            needsAssistance: segment.needsAssistance ?? false,
            boardingGroup: boardingGroup({ cabinClass: segment.cabinClass, seat: segment.seat, needsAssistance: segment.needsAssistance ?? false }),
            boardingPosition: ++position,
            checkedInAt: now,
          };
          if (!(await tx.insert(record))) throw problem(409, 'CHECK_IN_NOT_AVAILABLE', 'El check-in ya fue realizado.');
          created.push(record);
        }
      }
      return this.response(bookingId, created);
    });
  }

  async state(bookingId: string) {
    return this.store.transaction(async (tx) => {
      const state = await this.stateOf(tx, bookingId);
      if (!state.items.length) throw problem(404, 'NOT_FOUND', 'La reserva no tiene check-ins.');
      return state;
    });
  }

  /** Compensación: borra solo lo que registró esa saga. Idempotente. */
  async undo(bookingId: string, sagaId: string): Promise<void> {
    await this.store.transaction((tx) => tx.deleteBySaga(bookingId, sagaId));
  }

  /** Pases de la reserva; sin check-in → 409 BOARDING_PASS_NOT_AVAILABLE (contrato v2). */
  async boardingPasses(bookingId: string) {
    const rows = await this.store.transaction((tx) => tx.checkIns(bookingId));
    if (!rows.length) throw problem(409, 'BOARDING_PASS_NOT_AVAILABLE', 'El pase de abordar aún no está disponible.', 'Primero debe realizarse el check-in.');
    return {
      bookingId,
      boardingPasses: rows.map((row) => ({
        passengerId: row.passengerId,
        segmentId: row.segmentId,
        seat: row.seat ?? 'INF',
        boardingGroup: row.boardingGroup,
        boardingPosition: String(row.boardingPosition).padStart(3, '0'),
        gate: row.gate,
        barcode: bcbp(row),
        barcodeType: 'PDF417' as const,
      })),
    };
  }

  /** El aeropuerto confirmó (o retiró) la asistencia de un pasajero; antes o después del check-in. */
  markAssistanceReady(bookingId: string, input: { passengerId: string; segmentId: string; ready: boolean }, actorId: string) {
    return this.store.transaction(async (tx) => {
      const record: AssistanceReadyRecord = { bookingId, ...input, updatedBy: actorId, updatedAt: new Date(this.now()).toISOString() };
      await tx.saveAssistanceReady(record);
      return this.stateOf(tx, bookingId);
    });
  }

  flight(flightNumber: string, date: string) {
    const segmentId = `${flightNumber}-${date.replaceAll('-', '')}`;
    return this.store.transaction(async (tx) => {
      const rows = await tx.onSegment(segmentId);
      return { flightNumber, date, checkedIn: rows.length, assistanceReady: await tx.readyOnSegment(segmentId), bookingIds: [...new Set(rows.map((row) => row.bookingId))] };
    });
  }

  private async stateOf(tx: CheckInTx, bookingId: string) {
    const rows = await tx.checkIns(bookingId);
    const ready = await tx.assistanceReady(bookingId);
    return {
      bookingId,
      items: rows.map((row) => ({
        passengerId: row.passengerId,
        segmentId: row.segmentId,
        seat: row.seat,
        checkedInAt: row.checkedInAt,
        boardingGroup: row.boardingGroup,
        assistanceReady: ready.some((r) => r.passengerId === row.passengerId && r.segmentId === row.segmentId && r.ready),
      })),
    };
  }

  private response(bookingId: string, rows: CheckInRecord[]) {
    const passengers = [...new Set(rows.map((row) => row.passengerId))];
    return {
      bookingId,
      status: 'COMPLETED' as const,
      checkedInPassengers: passengers.map((passengerId) => ({
        passengerId,
        status: 'CHECKED_IN' as const,
        segments: rows.filter((row) => row.passengerId === passengerId).map((row) => ({ segmentId: row.segmentId, seat: row.seat, status: 'CHECKED_IN' as const })),
      })),
    };
  }
}
