import { Inject, Injectable } from '@nestjs/common';
import { ProblemDetailsException } from '@ecoairlines/shared';
import { localDate } from '../composition/dates.js';
import { stableUuid } from '../transversal/ids.js';
import { CancelBookingSaga, SagaDeps } from './booking-sagas.js';
import { SagaEngine, type SagaContext, type SagaDefinition } from './engine.js';
import { problem, publishEvents } from './support.js';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const sub = (saga: SagaContext, label: string) => stableUuid(`${saga.sagaId}:${label}`);
/** Ventana de venta: hoy y 91 días más (92 días, la del horario de Schedule). */
const salesWindow = () => {
  const from = localDate();
  return { from, to: new Date(Date.parse(`${from}T00:00:00Z`) + 91 * 86_400_000).toISOString().slice(0, 10) };
};
const requireActor = (saga: SagaContext) => {
  if (!saga.actorId) throw problem(400, 'VALIDATION_FAILED', 'Falta X-Actor-Id: solo un administrador hace este cambio.');
  return saga.actorId;
};

// ================================================================================================= Cambiar estado de vuelo

export interface FlightStatusInput {
  flightNumber: string;
  request: { date: string; status: string; estimatedDepartureAt?: string; estimatedArrivalAt?: string; departureGate?: string; reason?: string };
}

/**
 * "Cambiar estado de vuelo" (D37): FlightStatus valida la transición y la guarda → Bookings da las reservas afectadas →
 * - `CANCELLED`: Offers **cierra la venta** (stock 0 para Booking) y se **cancela cada reserva** con `FLIGHT_CANCELLED`
 *   (reembolso completo, asientos liberados), cada una como saga hija;
 * - `DEPARTED`: los asientos `CHECKED_IN` pasan a `BOARDED`;
 * → `flight.status_changed` (+ `flight.cancelled` por compatibilidad). Compensación (si falla antes de cancelar reservas):
 * reabrir la venta y restaurar el estado anterior.
 */
@Injectable()
export class FlightStatusSaga implements SagaDefinition<FlightStatusInput, Any> {
  readonly type = 'UPDATE_FLIGHT_STATUS';
  constructor(
    @Inject(SagaDeps) private readonly d: SagaDeps,
    @Inject(SagaEngine) private readonly engine: SagaEngine,
    @Inject(CancelBookingSaga) private readonly cancel: CancelBookingSaga,
  ) {}

  async run(saga: SagaContext, { flightNumber, request }: FlightStatusInput) {
    const actorId = requireActor(saga);
    const flightStatus = this.d.upstreams.rest['flight-status'];
    const changed = await saga.step(
      'flight-status.update',
      () => flightStatus.json<Any>('PATCH', `/flights/${flightNumber}/status`, { caller: { actorId }, json: request }),
      async (result) => {
        if (result) await flightStatus.json('POST', `/status-changes/${result['changeId']}/revert`, { caller: { actorId } });
      },
    );
    const affected = await saga.step('bookings.affected', () => this.d.bookings.json<{ items: Any[] }>('GET', `/flights/${flightNumber}/${request.date}/bookings`));
    const cancelled: Any[] = [];
    if (request.status === 'CANCELLED') {
      await saga.step(
        'offers.close-sales',
        () => this.d.offers.call('CloseFlightSales', { flight: { flightNumber, date: request.date, sagaId: sub(saga, 'close'), reason: request.reason ?? 'FLIGHT_CANCELLED' } }),
        () => this.d.offers.call('ReopenFlightSales', { flight: { flightNumber, date: request.date, sagaId: sub(saga, 'reopen'), reason: 'SAGA_COMPENSATION' } }),
      );
      saga.pointOfNoReturn();
      for (const booking of affected.items) {
        const outcome = await saga.step(`cancel:${booking['bookingId']}`, async () => {
          try {
            const result = await this.engine.run(this.cancel, { bookingId: booking['bookingId'], request: { reasonCode: 'FLIGHT_CANCELLED', reason: request.reason ?? `Vuelo ${flightNumber} cancelado.` } }, { sagaId: sub(saga, `cancel:${booking['bookingId']}`), parentSagaId: saga.sagaId, actorId });
            // La saga hija sigue pendiente (un MS.G caído): esta saga se reintenta y la espera.
            if (result.status === 'PENDING') throw problem(503, 'PROVIDER_UNAVAILABLE', `La cancelación de ${booking['pnr']} sigue pendiente.`);
            return { bookingId: booking['bookingId'], pnr: booking['pnr'], status: 'CANCELLED', refund: result.result['refund'] ?? null };
          } catch (error) {
            if (error instanceof ProblemDetailsException && error.problem.status < 500 && error.problem.code !== 'PROVIDER_UNAVAILABLE') {
              return { bookingId: booking['bookingId'], pnr: booking['pnr'], status: error.problem.code === 'ALREADY_CANCELLED' ? 'CANCELLED' : 'NOT_CANCELLED', error: error.problem.code };
            }
            throw error;
          }
        });
        cancelled.push(outcome);
      }
    } else if (request.status === 'DEPARTED') {
      saga.pointOfNoReturn();
      const segmentId = `${flightNumber}-${request.date.replaceAll('-', '')}`;
      for (const booking of affected.items) {
        await saga.step(`board:${booking['bookingId']}`, () =>
          this.d.offers.call('TransitionBookingSeats', { bookingId: booking['bookingId'], sagaId: sub(saga, `board:${booking['bookingId']}`), fromStatus: 'SEAT_STATUS_CHECKED_IN', toStatus: 'SEAT_STATUS_BOARDED', segmentIds: [segmentId], passengerIds: [] }),
        );
      }
    } else {
      saga.pointOfNoReturn();
    }
    // D40: los ids de las reservas de nuestra web no salen a Booking; el evento lleva solo los del canal Booking.
    const partnerBookings = affected.items.filter((b) => b['channel'] === 'BOOKING').map((b) => b['bookingId']);
    const data = {
      flightNumber,
      date: request.date,
      previousStatus: changed['previousStatus'],
      newStatus: changed['flight']['status'],
      estimatedDepartureAt: changed['flight']['departure']?.['estimatedAt'] ?? null,
      estimatedArrivalAt: changed['flight']['arrival']?.['estimatedAt'] ?? null,
      affectedBookingIds: partnerBookings,
    };
    const [eventId] = await publishEvents(saga, this.d.events, [
      { name: 'flight.status_changed', subject: flightNumber, data },
      ...(request.status === 'CANCELLED' ? [{ name: 'flight.cancelled', subject: flightNumber, data: { flightNumber, date: request.date, reason: request.reason ?? null, affectedBookingIds: partnerBookings } }] : []),
      // Compatibilidad con v1: una demora cambia el horario estimado (los suscriptores nuevos usan flight.status_changed).
      ...(request.status === 'DELAYED' ? [{ name: 'flight.schedule_changed', subject: flightNumber, data: { flightNumber, date: request.date, previousStatus: data.previousStatus, newStatus: data.newStatus, estimatedDepartureAt: data.estimatedDepartureAt, estimatedArrivalAt: data.estimatedArrivalAt } }] : []),
    ]);
    return { previousStatus: changed['previousStatus'], flight: changed['flight'], affectedBookings: affected.items.length, eventId, changeId: changed['changeId'], cancellations: cancelled };
  }
}

// =========================================================================================== Guardar precios y descuento

export type SavePricesInput =
  | { kind: 'fare-prices'; items: { cabinClass: string; fareBrand: string; multiplier: number }[] }
  | { kind: 'promotion-agreement'; partnerId: string; agreement: Any };

/**
 * "Guardar precios y descuento máximo": Schedule valida (multiplicadores; descuento ≤ 50 %, D35) y guarda con historial →
 * Offers recibe la copia (`PublishFarePrices`, con las reglas de promoción) → `pricing.changed` (interno). Compensación: volver
 * a guardar en Schedule los valores anteriores.
 */
@Injectable()
export class SavePricesSaga implements SagaDefinition<SavePricesInput, Any> {
  readonly type = 'SAVE_PRICES';
  constructor(@Inject(SagaDeps) private readonly d: SagaDeps) {}

  async run(saga: SagaContext, input: SavePricesInput) {
    const actorId = requireActor(saga);
    const schedule = this.d.upstreams.rest.schedule;
    const partnerId = input.kind === 'promotion-agreement' ? input.partnerId : 'BOOKING_PROTOTIPO';
    const agreementOf = (id: string) => schedule.json<Any>('GET', `/promotion-agreements/${id}`).catch((error: unknown) => {
      if (error instanceof ProblemDetailsException && error.problem.status === 404) return null;
      throw error;
    });
    const before = await saga.step('schedule.snapshot', async () => ({ prices: await schedule.json<{ items: Any[] }>('GET', '/fare-prices'), agreement: await agreementOf(partnerId) }));
    const saved = await saga.step(
      'schedule.save',
      () =>
        input.kind === 'fare-prices'
          ? schedule.json<Any>('PUT', '/fare-prices', { caller: { actorId }, json: { items: input.items } })
          : schedule.json<Any>('PUT', `/promotion-agreements/${input.partnerId}`, { caller: { actorId }, json: input.agreement }),
      async () => {
        if (input.kind === 'fare-prices') {
          await schedule.json('PUT', '/fare-prices', { caller: { actorId }, json: { items: before.prices.items.map((p) => ({ cabinClass: p['cabinClass'], fareBrand: p['fareBrand'], multiplier: p['multiplier'] })) } });
        } else if (before.agreement) {
          await schedule.json('PUT', `/promotion-agreements/${input.partnerId}`, { caller: { actorId }, json: agreementRequest(before.agreement) });
        }
      },
    );
    await publishPrices(saga, this.d, 'offers.publish-prices');
    saga.pointOfNoReturn();
    const after = input.kind === 'fare-prices' ? (saved['items'] as Any[]) : before.prices.items;
    const changedPrices = after
      .map((p) => ({ p, old: before.prices.items.find((o) => o['cabinClass'] === p['cabinClass'] && o['fareBrand'] === p['fareBrand']) }))
      .filter(({ p, old }) => old && old['multiplier'] !== p['multiplier'])
      .map(({ p, old }) => ({ cabinClass: p['cabinClass'], fareBrand: p['fareBrand'], oldMultiplier: old!['multiplier'], newMultiplier: p['multiplier'] }));
    await publishEvents(saga, this.d.events, [{ name: 'pricing.changed', visibility: 'internal', subject: 'fare-prices', data: { actorId, promotionUpdated: input.kind === 'promotion-agreement', changedPrices } }]);
    return saved;
  }
}

/** El acuerdo como lo pide `PUT /promotion-agreements/{partnerId}` (solo los campos del contrato v2). */
const agreementRequest = (agreement: Any) =>
  Object.fromEntries(['permite_promociones', 'porcentaje_descuento_maximo', 'destinos_habilitados', 'rutas_habilitadas', 'cabinas_habilitadas', 'vigencia_hasta', 'condiciones_combo'].filter((k) => agreement[k] !== undefined && agreement[k] !== null).map((k) => [k, agreement[k]]));

/** Lee de Schedule los precios y el acuerdo con Booking y los publica en Offers (la copia de lectura, D35). */
async function publishPrices(saga: SagaContext, d: SagaDeps, name: string) {
  const schedule = d.upstreams.rest.schedule;
  const current = await saga.step(`${name}:read`, async () => ({
    prices: await schedule.json<{ items: Any[] }>('GET', '/fare-prices'),
    agreement: await schedule.json<Any>('GET', '/promotion-agreements/BOOKING_PROTOTIPO').catch(() => null),
  }));
  return saga.step(name, () =>
    d.offers.call<Any>('PublishFarePrices', {
      publishId: sub(saga, name),
      prices: current.prices.items.map((p) => ({ cabinClass: `CABIN_CLASS_${p['cabinClass']}`, fareBrand: p['fareBrand'], multiplier: p['multiplier'] })),
      promotions: current.agreement
        ? [
            {
              partnerId: 'BOOKING_PROTOTIPO',
              allowsPromotions: !!current.agreement['permite_promociones'],
              maxDiscountPercentage: Number(current.agreement['porcentaje_descuento_maximo'] ?? 0),
              routes: current.agreement['rutas_habilitadas'] ?? [],
              cabins: (current.agreement['cabinas_habilitadas'] ?? []).map((c: string) => `CABIN_CLASS_${c}`),
              ...(current.agreement['vigencia_hasta'] ? { validUntil: current.agreement['vigencia_hasta'] } : {}),
            },
          ]
        : [],
    }),
  );
}

// ========================================================================================================= Publicar horario

export type PublishTimetableInput =
  | { action: 'create'; route: Any }
  | { action: 'update'; routeId: string; route: Any }
  | { action: 'delete'; routeId: string }
  | { action: 'publish-all' };

/** Definición de una ruta como la pide Schedule para crearla o reemplazarla (para la compensación). */
const routeRequest = (route: Any) => ({
  origin: route['origin'],
  destination: route['destination'],
  outboundDepartureLocal: route['outbound']['departureLocal'],
  inboundDepartureLocal: route['inbound']['departureLocal'],
  weekdays: route['weekdays'],
  aircraftType: route['aircraftType'],
  ...(route['aircraft']?.length ? { aircraft: route['aircraft'] } : {}),
});

/**
 * "Publicar horario" (admin de rutas): Offers cuenta los cupos vendidos → Schedule valida y guarda → Offers recibe el horario
 * (`PublishTimetable`) → `schedule.published` (FlightStatus arma su proyección, D4). Compensación: restaurar la ruta anterior.
 * `publish-all` publica la ventana completa y los precios (reemplaza al script de desarrollo de V2.4).
 */
@Injectable()
export class PublishTimetableSaga implements SagaDefinition<PublishTimetableInput, Any> {
  readonly type = 'PUBLISH_TIMETABLE';
  constructor(@Inject(SagaDeps) private readonly d: SagaDeps) {}

  async run(saga: SagaContext, input: PublishTimetableInput) {
    const actorId = requireActor(saga);
    const schedule = this.d.upstreams.rest.schedule;
    const { from, to } = salesWindow();
    const existing = input.action === 'update' || input.action === 'delete' ? await saga.step('schedule.get-route', () => schedule.json<Any>('GET', `/routes/${input.routeId}`)) : undefined;
    const sold = existing
      ? await saga.step('offers.count-sold', () => this.d.offers.call<{ soldSeats: number }>('CountSoldSeats', { flightNumbers: [existing['outbound']['flightNumber'], existing['inbound']['flightNumber']], fromDate: from }))
      : { soldSeats: 0 };
    let saved: Any | undefined;
    if (input.action === 'create') {
      saved = await saga.step('schedule.save-route', () => schedule.json<Any>('POST', '/routes', { caller: { actorId }, json: input.route }), async (route) => {
        if (route) await schedule.request({ method: 'DELETE', path: `/routes/${route['routeId']}?soldSeats=0`, caller: { actorId } });
      });
    } else if (input.action === 'update') {
      saved = await saga.step('schedule.save-route', () => schedule.json<Any>('PUT', `/routes/${input.routeId}`, { caller: { actorId }, json: { route: input.route, soldSeats: sold.soldSeats } }), () =>
        schedule.json('PUT', `/routes/${input.routeId}`, { caller: { actorId }, json: { route: routeRequest(existing!), soldSeats: 0 } }),
      );
    } else if (input.action === 'delete') {
      await saga.step(
        'schedule.save-route',
        async () => {
          await schedule.json('DELETE', `/routes/${input.routeId}?soldSeats=${sold.soldSeats}`, { caller: { actorId } });
          return { routeId: input.routeId, deleted: true };
        },
        () => schedule.json('POST', `/routes?restoreRouteId=${encodeURIComponent(input.routeId)}`, { caller: { actorId }, json: routeRequest(existing!) }),
      );
    }
    const routeId = input.action === 'publish-all' ? undefined : (saved?.['routeId'] ?? (input as { routeId: string }).routeId);
    const timetable = await saga.step('schedule.timetable', () => schedule.json<{ flights: Any[] }>('GET', `/timetable?from=${from}&to=${to}`));
    const flights = routeId ? timetable.flights.filter((f) => f['routeId'] === routeId) : timetable.flights;
    const published = await saga.step('offers.publish-timetable', () => this.d.offers.call<Any>('PublishTimetable', { publishId: saga.sagaId, from, to, ...(routeId ? { routeId } : {}), flights }));
    if (input.action === 'publish-all') await publishPrices(saga, this.d, 'offers.publish-prices');
    saga.pointOfNoReturn();
    await publishEvents(saga, this.d.events, [
      { name: 'schedule.published', visibility: 'internal', subject: routeId ?? 'timetable', data: { publishId: saga.sagaId, ...(routeId ? { routeId } : {}), from, to, flights } },
    ]);
    return { ...(saved ? { route: saved } : {}), ...(input.action === 'delete' ? { deletedRouteId: input.routeId } : {}), published: published['result'] ?? null, flights: flights.length };
  }
}
