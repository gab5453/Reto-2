import { Inject, Injectable } from '@nestjs/common';
import { ProblemDetailsException } from '@ecoairlines/shared';
import type { Caller } from '../clients/rest.client.js';
import { UPSTREAMS, type Upstreams } from '../clients/upstreams.js';
import { ESB_STORE, type EsbStore } from '../repositories/esb.store.js';
import type { BookingView } from '../sagas/support.js';
import { DATE, FLIGHT_NUMBER, IATA, localDate } from './dates.js';

const STATUSES = ['SCHEDULED', 'BOARDING', 'DEPARTED', 'DELAYED', 'ARRIVED', 'CANCELLED', 'DIVERTED'] as const;
type FlightOperationalStatus = (typeof STATUSES)[number];
const SEAT_STATES = ['AVAILABLE', 'HELD', 'BOOKED', 'TICKETED', 'CHECKED_IN', 'BOARDED'] as const;
const PARTNER_ID = 'BOOKING_PROTOTIPO';
const CHECK_IN_OPENS_MS = 48 * 3_600_000;

/** `FlightOccupancy` de ms-g-offers.proto (mapeo JSON: camelCase, enums por nombre). */
interface Occupancy {
  flightNumber: string;
  date: string;
  origin: string;
  destination: string;
  departureAt: string;
  aircraft: string;
  totalSeats: number;
  loadFactor: number;
  cabins: { cabinClass: string; totalSeats: number; seatsByStatus: Record<'available' | 'held' | 'booked' | 'ticketed' | 'checkedIn' | 'boarded', number> }[];
  activeHolds: number;
  nextHoldExpiryAt?: string | null;
  onSale: boolean;
}

interface FlightStatusItem {
  flightNumber: string;
  date: string;
  status: FlightOperationalStatus;
  delayMinutes?: number | null;
  departure: { scheduledAt: string; estimatedAt?: string | null };
}

type Alert = { code: 'OVERBOOKING_RISK' | 'LOW_AVAILABILITY' | 'DELAYED' | 'CHECKIN_OPEN' | 'CANCELLED'; severity: 'INFO' | 'WARNING' | 'CRITICAL'; message: string };

export interface OperationsQuery {
  date?: string;
  origin?: string;
  destination?: string;
  status?: string;
  limit?: string;
  cursor?: string;
}

const invalid = (name: string, reason: string) =>
  new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La consulta no es válida.', invalidParams: [{ name, reason }] });
const cabinName = (value: string) => value.replace(/^CABIN_CLASS_/, '');
const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Composición (solo lectura, PLAN.md §4.2): varios MS.G **en paralelo** y una respuesta. Ninguna escribe; si una fuente
 * indispensable falla, la consulta falla con su ProblemDetails (no se inventan datos).
 */
@Injectable()
export class CompositionService {
  constructor(
    @Inject(UPSTREAMS) private readonly upstreams: Upstreams,
    @Inject(ESB_STORE) private readonly store: EsbStore,
  ) {}

  /**
   * `GET /vuelos/operaciones/vuelos` (contrato v2 `listFlightOperations`): asientos por estado y cabina, ocupación, holds activos
   * con el próximo vencimiento (Offers), estado operativo y check-in abierto (FlightStatus) y alertas.
   * Schedule no se consulta: el avión y los asientos de cada vuelo ya están en Offers, copiados del horario que publicó Schedule.
   */
  async flightOperations(query: OperationsQuery, now = new Date()) {
    if (!query.date || !DATE.test(query.date)) throw invalid('date', 'obligatoria, AAAA-MM-DD');
    for (const name of ['origin', 'destination'] as const) if (query[name] !== undefined && !IATA.test(query[name]!)) throw invalid(name, 'código IATA de 3 letras');
    if (query.status !== undefined && !(STATUSES as readonly string[]).includes(query.status)) throw invalid('status', `uno de ${STATUSES.join(', ')}`);
    const limit = query.limit === undefined ? 10 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid('limit', 'entero entre 1 y 50');
    const offset = query.cursor === undefined ? 0 : decodeCursor(query.cursor);
    const filter = { date: query.date, ...(query.origin ? { origin: query.origin } : {}), ...(query.destination ? { destination: query.destination } : {}) };
    const search = new URLSearchParams(filter).toString();
    const [occupancy, statuses] = await Promise.all([
      this.upstreams.offers.call<{ flights: Occupancy[] }>('GetOccupancy', filter),
      this.upstreams.rest['flight-status'].json<{ items: FlightStatusItem[] }>('GET', `/flights?${search}`),
    ]);
    const statusOf = new Map(statuses.items.map((item) => [`${item.flightNumber}|${item.date}`, item]));
    const items = occupancy.flights
      .map((flight) => this.operationsItem(flight, statusOf.get(`${flight.flightNumber}|${flight.date}`), now))
      .filter((item) => !query.status || item.status === query.status)
      .sort((a, b) => a.departureAt.localeCompare(b.departureAt) || a.flightNumber.localeCompare(b.flightNumber));
    const page = items.slice(offset, offset + limit);
    return { date: query.date, totalFlights: items.length, nextCursor: offset + limit < items.length ? encodeCursor(offset + limit) : null, items: page };
  }

  private operationsItem(flight: Occupancy, status: FlightStatusItem | undefined, now: Date) {
    const operational: FlightOperationalStatus = status?.status ?? 'SCHEDULED';
    const departure = Date.parse(status?.departure.estimatedAt ?? status?.departure.scheduledAt ?? flight.departureAt);
    // Contrato v2 §5: el check-in abre 48 h antes de la salida y cierra a la hora de salida; nunca en un vuelo cancelado o ya salido.
    const checkInOpen = ['SCHEDULED', 'DELAYED', 'BOARDING'].includes(operational) && now.getTime() >= departure - CHECK_IN_OPENS_MS && now.getTime() < departure;
    const cabins = flight.cabins.map((cabin) => ({
      cabinClass: cabinName(cabin.cabinClass),
      totalSeats: cabin.totalSeats,
      seatsByStatus: {
        AVAILABLE: cabin.seatsByStatus.available,
        HELD: cabin.seatsByStatus.held,
        BOOKED: cabin.seatsByStatus.booked,
        TICKETED: cabin.seatsByStatus.ticketed,
        CHECKED_IN: cabin.seatsByStatus.checkedIn,
        BOARDED: cabin.seatsByStatus.boarded,
      } satisfies Record<(typeof SEAT_STATES)[number], number>,
    }));
    const alerts: Alert[] = [];
    if (operational === 'CANCELLED') alerts.push({ code: 'CANCELLED', severity: 'CRITICAL', message: `El vuelo ${flight.flightNumber} está cancelado: la venta está cerrada.` });
    if (operational === 'DELAYED') alerts.push({ code: 'DELAYED', severity: 'WARNING', message: `Demorado ${status?.delayMinutes ?? 0} min.` });
    if (checkInOpen) alerts.push({ code: 'CHECKIN_OPEN', severity: 'INFO', message: 'El check-in está abierto.' });
    if (operational !== 'CANCELLED') {
      if (flight.loadFactor >= 95) alerts.push({ code: 'OVERBOOKING_RISK', severity: 'CRITICAL', message: `Ocupación del ${round1(flight.loadFactor)} %: riesgo de sobreventa.` });
      for (const cabin of cabins) {
        if (cabin.totalSeats > 0 && cabin.seatsByStatus.AVAILABLE < 10) {
          alerts.push({ code: 'LOW_AVAILABILITY', severity: 'WARNING', message: `Quedan ${cabin.seatsByStatus.AVAILABLE} asientos en ${cabin.cabinClass}.` });
        }
      }
    }
    return {
      flightNumber: flight.flightNumber,
      date: flight.date,
      origin: flight.origin,
      destination: flight.destination,
      departureAt: flight.departureAt,
      status: operational,
      aircraft: flight.aircraft,
      totalSeats: flight.totalSeats,
      loadFactor: round1(flight.loadFactor),
      cabins,
      activeHolds: flight.activeHolds,
      nextHoldExpiryAt: flight.nextHoldExpiryAt || null,
      checkInOpen,
      alerts,
    };
  }

  /** Indicadores del panel (`DashboardIndicators` de ms-admin): reservas, ingresos y ventas por ruta y canal, usuarios por rol, vuelos de hoy. */
  async indicators(caller: Caller, range: { from?: string; to?: string }) {
    for (const name of ['from', 'to'] as const) if (range[name] !== undefined && !DATE.test(range[name]!)) throw invalid(name, 'AAAA-MM-DD');
    const search = new URLSearchParams(Object.entries(range).filter(([, v]) => v !== undefined) as [string, string][]).toString();
    const [bookings, users, flights] = await Promise.all([
      this.upstreams.rest.bookings.json('GET', `/indicators${search ? `?${search}` : ''}`, { caller }),
      this.upstreams.rest.identity.json('GET', '/users/summary', { caller }),
      this.upstreams.rest['flight-status'].json<{ total: number }>('GET', `/flights?date=${localDate()}`),
    ]);
    return { generatedAt: new Date().toISOString(), bookings, users, flightsToday: flights.total };
  }

  /**
   * Pasajeros con asistencia de un vuelo (dato de salud: solo con `X-Actor-Id` de un administrador; nunca se escribe en logs).
   * FlightStatus confirma que el vuelo existe en esa fecha (404 si no); Bookings da los pasajeros. CheckIn no se consulta: el
   * esquema del panel (`FlightAssistanceItem`) no lleva datos de check-in y el asiento ya está en la reserva.
   */
  async flightAssistance(flightNumber: string, date: string | undefined, caller: Caller) {
    if (!FLIGHT_NUMBER.test(flightNumber)) throw invalid('flightNumber', 'p. ej. EA100');
    if (!date || !DATE.test(date)) throw invalid('date', 'obligatoria, AAAA-MM-DD');
    if (!caller.actorId) throw invalid('X-Actor-Id', 'obligatorio: sub del administrador');
    const [, items] = await Promise.all([
      this.upstreams.rest['flight-status'].json('GET', `/flights/${flightNumber}/status?date=${date}`),
      this.upstreams.rest.bookings.json<unknown[]>('GET', `/flights/${flightNumber}/${date}/assistance`, { caller }),
    ]);
    return items;
  }

  /**
   * Pases de abordar con la puerta VIGENTE (contrato v2 `listBoardingPasses`, PLAN.md §4.3: CheckIn + FlightStatus). Bookings
   * comprueba el dueño (`404` si la reserva es de otro: CheckIn no conoce dueños); CheckIn da los pases (`409
   * BOARDING_PASS_NOT_AVAILABLE` sin check-in); FlightStatus, la puerta de cada vuelo, que puede cambiar después del check-in.
   * Si FlightStatus no responde, el pase sale con la puerta que tenía.
   */
  async boardingPasses(bookingId: string, caller: Caller) {
    const booking = await this.upstreams.rest.bookings.json<BookingView>('GET', `/bookings/${bookingId}`, { caller });
    const passes = await this.upstreams.rest['check-in'].json<{ bookingId: string; boardingPasses: { segmentId: string; gate?: string | null }[] }>('GET', `/check-ins/${bookingId}/boarding-passes`);
    const segments = new Map(booking.itineraries.flatMap((itinerary) => itinerary.segments).map((segment) => [segment.segmentId, segment]));
    const gates = new Map<string, Promise<string | null | undefined>>();
    const gateOf = (segmentId: string) => {
      const segment = segments.get(segmentId);
      if (!segment) return Promise.resolve(undefined);
      const key = `${segment.flightNumber}/status?date=${segment.departure.at.slice(0, 10)}`;
      if (!gates.has(key)) {
        gates.set(
          key,
          this.upstreams.rest['flight-status']
            .json<{ departure?: { gate?: string | null } }>('GET', `/flights/${key}`)
            .then((status) => status.departure?.gate)
            .catch(() => undefined),
        );
      }
      return gates.get(key)!;
    };
    const boardingPasses = await Promise.all(passes.boardingPasses.map(async (pass) => {
      const gate = await gateOf(pass.segmentId);
      return gate ? { ...pass, gate } : pass;
    }));
    return { bookingId: passes.bookingId, boardingPasses };
  }

  /**
   * Estado de la integración con Booking (`BookingIntegrationStatus` de ms-admin): último token del partner (Identity),
   * entregas de webhooks (Webhooks), stock enviado (Offers) y último evento recibido de Booking (este ESB).
   */
  async bookingIntegration(caller: Caller) {
    const [partner, webhooks, offers, lastInboundEventAt] = await Promise.all([
      this.upstreams.rest.identity.json<{ lastTokenAt?: string | null }>('GET', `/partners/${PARTNER_ID}`, { caller }).catch((error: unknown) => {
        if (error instanceof ProblemDetailsException && error.problem.status === 404) return { lastTokenAt: null };
        throw error;
      }),
      this.upstreams.rest.webhooks.json('GET', '/stats', { caller }),
      this.upstreams.offers.call<{ stats: { lastStockPushAt?: string | null; pendingStockPushes: number } }>('GetStats', {}),
      this.store.lastInboundAt(),
    ]);
    return {
      partnerId: PARTNER_ID,
      lastTokenAt: partner.lastTokenAt ?? null,
      webhooks,
      stock: { lastPushAt: offers.stats.lastStockPushAt || null, pendingPushes: offers.stats.pendingStockPushes },
      lastInboundEventAt,
    };
  }

  // ------------------------------------------------------------------------------- telemetría del panel (V2.16, D50)

  latency(from?: string, to?: string) {
    return this.upstreams.observability.latency(from, to);
  }

  queues() {
    return this.upstreams.observability.queues();
  }

  alerts() {
    return this.upstreams.observability.alerts();
  }

  /**
   * Todo lo que generó un proceso, por su X-Correlation-Id: los pasos (logs `api_request` de cada servicio, en Loki), sus sagas
   * (`saga_log`) y sus eventos (historial de Webhooks). `404` si no hay rastro.
   */
  async correlationTrace(correlationId: string, caller: Caller, range: { from?: string; to?: string } = {}) {
    const [steps, sagas, events] = await Promise.all([
      this.upstreams.observability.correlationSteps(correlationId, range),
      this.store.listSagas({ correlationId, limit: 50 }),
      this.upstreams.rest.webhooks.json<{ items: unknown[]; nextCursor?: string }>('GET', `/history?correlationId=${encodeURIComponent(correlationId)}&limit=100`, { caller }),
    ]);
    if (!steps.length && !sagas.length && !events.items.length) throw ProblemDetailsException.notFound('No hay rastro de ese X-Correlation-Id en los últimos 7 días.');
    return { correlationId, steps, sagas: sagas.map((saga) => ({ sagaId: saga.sagaId, type: saga.type, status: saga.status })), events };
  }

  /**
   * Panel O-2: el historial de una reserva — sus sagas (`saga_log`, con los pasos y su estado) y sus eventos con las entregas a
   * Booking (historial de Webhooks por `subject`). Nunca devuelve la entrada ni el resultado de una saga (datos personales y de
   * salud): solo nombres, estados y fechas. Lo que no exista responde listas vacías.
   */
  async bookingTimeline(bookingId: string, caller: Caller) {
    const [sagas, events] = await Promise.all([
      this.store.listSagas({ bookingId, limit: 50 }),
      this.upstreams.rest.webhooks.json<{ items: unknown[] }>('GET', `/history?subject=${encodeURIComponent(bookingId)}&limit=100`, { caller }),
    ]);
    return {
      bookingId,
      sagas: sagas
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((saga) => ({
          sagaId: saga.sagaId,
          type: saga.type,
          status: saga.status,
          correlationId: saga.correlationId,
          parentSagaId: saga.parentSagaId,
          createdAt: saga.createdAt,
          updatedAt: saga.updatedAt,
          errorCode: typeof saga.error?.['code'] === 'string' ? saga.error['code'] : null,
          steps: saga.steps.map((step) => ({ name: step.name, status: step.status, at: step.at })),
        })),
      events: events.items,
    };
  }
}

const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`).toString('base64url');
function decodeCursor(cursor: string): number {
  const match = /^o:(\d{1,6})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!match) throw invalid('cursor', 'el valor de nextCursor de la página anterior');
  return Number(match[1]);
}
