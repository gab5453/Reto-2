import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type CloudEvent, ProblemDetailsException } from '@ecoairlines/shared';
import { applyUpdate, type FlightOperationalStatus, INITIAL_STATE, type ScheduledFlightRecord, type StatusChangeRecord, type StatusUpdate, toFlightStatus } from '../domain/status.js';
import { FLIGHT_STATUS_STORE, type FlightStatusStore, type FlightStatusTx } from '../repositories/flight-status.store.js';

const notFound = () => new ProblemDetailsException({ status: 404, code: 'NOT_FOUND', title: 'El vuelo no opera en esa fecha.' });

export interface SchedulePublishedData {
  publishId: string;
  routeId?: string;
  from: string;
  to: string;
  flights: ScheduledFlightRecord[];
}

/**
 * MS.G.FlightStatus: estado operativo de cada vuelo y fecha, cambios con transiciones válidas e historial. El horario es la
 * proyección de `schedule.published` (D4). Emitir `flight.status_changed` y calcular las reservas afectadas lo hace el ESB.
 */
@Injectable()
export class FlightStatusService {
  constructor(@Inject(FLIGHT_STATUS_STORE) private readonly store: FlightStatusStore) {}

  now = (): Date => new Date();

  /** Consumidor de `schedule.published`: reemplaza los vuelos del rango (idempotente por el `id` del CloudEvent). */
  applySchedulePublished(event: CloudEvent<SchedulePublishedData>): Promise<boolean> {
    return this.store.transaction(async (tx) => {
      if (!(await tx.markEventApplied(event.id, this.now().toISOString()))) return false;
      const { from, to, routeId, flights } = event.data;
      await tx.replaceFlights(from, to, routeId, flights.filter((f) => f.date >= from && f.date <= to && (!routeId || f.routeId === routeId)));
      return true;
    });
  }

  get(flightNumber: string, date: string) {
    return this.store.transaction(async (tx) => {
      const flight = await this.flight(tx, flightNumber, date);
      return toFlightStatus(flight, (await tx.state(flightNumber, date)) ?? INITIAL_STATE);
    });
  }

  list(date: string, filter: { origin?: string; destination?: string; status?: FlightOperationalStatus }) {
    return this.store.transaction(async (tx) => {
      const items = [];
      for (const flight of await tx.flightsOn(date)) {
        if ((filter.origin && flight.origin !== filter.origin) || (filter.destination && flight.destination !== filter.destination)) continue;
        const status = toFlightStatus(flight, (await tx.state(flight.flightNumber, date)) ?? INITIAL_STATE);
        if (!filter.status || status.status === filter.status) items.push(status);
      }
      return { date, total: items.length, items };
    });
  }

  /** Primer paso de "Cambiar estado de vuelo": valida, guarda y deja el historial; devuelve el `changeId` para compensar. */
  update(flightNumber: string, date: string, update: StatusUpdate, actor: string) {
    return this.store.transaction(async (tx) => {
      const flight = await this.flight(tx, flightNumber, date);
      const previous = (await tx.state(flightNumber, date)) ?? INITIAL_STATE;
      const now = this.now();
      const next = applyUpdate(previous, flight, update, actor, now);
      const change: StatusChangeRecord = { changeId: randomUUID(), flightNumber, date, previous, next, reason: update.reason?.trim() || null, changedBy: actor, changedAt: now.toISOString(), reverted: false };
      await tx.saveState(flightNumber, date, next);
      await tx.saveChange(change);
      return { changeId: change.changeId, previousStatus: previous.status, flight: toFlightStatus(flight, next) };
    });
  }

  history(flightNumber: string, date: string) {
    return this.store.transaction(async (tx) => {
      await this.flight(tx, flightNumber, date);
      return (await tx.changes(flightNumber, date)).map((change) => ({
        changeId: change.changeId,
        previousStatus: change.previous.status,
        newStatus: change.next.status,
        departureGate: change.next.departureGate,
        estimatedDepartureAt: change.next.estimatedDepartureAt,
        reason: change.reason,
        changedBy: change.changedBy,
        changedAt: change.changedAt,
        reverted: change.reverted,
      }));
    });
  }

  /**
   * Compensación: vuelve al estado exacto anterior, solo si es el último cambio vigente (409 CHANGE_NOT_LATEST). Revertir uno ya
   * revertido devuelve el mismo resultado (idempotente).
   */
  revert(changeId: string, actor: string) {
    return this.store.transaction(async (tx) => {
      const change = await tx.change(changeId);
      if (!change) throw notFound();
      const flight = await this.flight(tx, change.flightNumber, change.date);
      await tx.state(change.flightNumber, change.date); // candado del vuelo
      const later = (await tx.changes(change.flightNumber, change.date)).filter((other) => !other.reverted && other.changeId !== changeId && other.changedAt >= change.changedAt);
      if (!change.reverted) {
        if (later.length) throw new ProblemDetailsException({ status: 409, code: 'CHANGE_NOT_LATEST', title: 'Hubo un cambio posterior: no se puede revertir este.', detail: `Último cambio: ${later.at(-1)!.changeId}.` });
        await tx.saveState(change.flightNumber, change.date, { ...change.previous, updatedAt: this.now().toISOString(), updatedBy: actor });
        await tx.saveChange({ ...change, reverted: true });
      }
      return { changeId, previousStatus: change.next.status, flight: toFlightStatus(flight, (await tx.state(change.flightNumber, change.date)) ?? INITIAL_STATE) };
    });
  }

  projectionUpdatedAt() {
    return this.store.projectionUpdatedAt();
  }

  private async flight(tx: FlightStatusTx, flightNumber: string, date: string): Promise<ScheduledFlightRecord> {
    const flight = await tx.flight(flightNumber, date);
    if (!flight) throw notFound();
    return flight;
  }
}
