import { lastSaleDate, todayIso } from '../lib/format';
import { graphql } from './client';
import { ITINERARY, MONEY, PASSENGER, TICKET } from './operations';
import type { BookingStatus, CabinClass, FlightOperationalStatus, ItineraryOption, MoneyAmount, PassengerItem, Ticket } from './types';

/*
 * Administración sobre el GraphQL del gateway (`@auth(scopes: [ECOAIRLINES_ADMIN])` o `FLIGHTS_OPS`; → MS.Admin y MS.Vuelos).
 * Donde la forma del esquema difiere poco de la que ya usan los paneles (horario de la flota, eventos), se adapta aquí.
 */

// ── Indicadores ──
export interface AdminIndicators {
  generatedAt: string;
  totalBookings: number;
  bookingsByChannel: { web: number; booking: number };
  totalPassengers: number;
  revenue: MoneyAmount;
  refundsCalculated: MoneyAmount | null;
  byRoute: { origin: string; destination: string; bookings: number; revenue: string }[];
  usersTotal: number;
  customers: number;
  admins: number;
  flightsToday: number;
}

export const getIndicators = (token: string) =>
  graphql<{ adminIndicators: AdminIndicators }>(
    `query Indicadores {
      adminIndicators {
        generatedAt totalBookings bookingsByChannel { web booking } totalPassengers revenue { ${MONEY} } refundsCalculated { ${MONEY} }
        byRoute { origin destination bookings revenue } usersTotal customers admins flightsToday
      }
    }`,
    {},
    { token },
  ).then((data) => data.adminIndicators);

// ── Operaciones de vuelos (contrato v2: flightOperations y updateFlightStatus) ──
export interface SeatsByStatus {
  available: number;
  held: number;
  booked: number;
  ticketed: number;
  checkedIn: number;
  boarded: number;
}

export interface FlightOperation {
  flightNumber: string;
  date: string;
  origin: string;
  destination: string;
  departureAt: string;
  status: FlightOperationalStatus;
  aircraft: string | null;
  totalSeats: number;
  /** Porcentaje de asientos que no están AVAILABLE. */
  loadFactor: number;
  cabins: { cabinClass: CabinClass; totalSeats: number; seatsByStatus: SeatsByStatus }[];
  activeHolds: number;
  checkInOpen: boolean;
  alerts: { code: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; message: string }[];
}

export interface FlightOperationsPage {
  date: string;
  totalFlights: number;
  nextCursor: string | null;
  items: FlightOperation[];
}

export const getFlightOperations = (
  token: string,
  query: { date: string; origin?: string; destination?: string; limit?: number; cursor?: string },
) =>
  graphql<{ flightOperations: FlightOperationsPage }>(
    `query Operaciones($date: Date!, $origin: IataCode, $destination: IataCode, $limit: Int, $cursor: String) {
      flightOperations(date: $date, origin: $origin, destination: $destination, limit: $limit, cursor: $cursor) {
        date totalFlights nextCursor
        items {
          flightNumber date origin destination departureAt status aircraft totalSeats loadFactor activeHolds checkInOpen
          cabins { cabinClass totalSeats seatsByStatus { available held booked ticketed checkedIn boarded } }
          alerts { code severity message }
        }
      }
    }`,
    query,
    { token },
  ).then((data) => data.flightOperations);

export interface FlightStatusChange {
  date: string;
  status: FlightOperationalStatus;
  estimatedDepartureAt?: string;
  estimatedArrivalAt?: string;
  departureGate?: string;
  /** Obligatorio al cancelar. */
  reason?: string;
}

/** Impacto de un retraso (R-1, solo consulta): el siguiente vuelo del mismo avión y los pasajeros con poco margen. */
export interface FlightDelayImpact {
  flightNumber: string;
  date: string;
  delayMinutes: number;
  scheduledDepartureAt: string;
  scheduledArrivalAt: string;
  estimatedDepartureAt: string;
  estimatedArrivalAt: string;
  aircraft: { registration: string; aircraftType: string; turnaroundMinutes: number };
  nextFlight: {
    flightNumber: string;
    date: string;
    origin: string;
    destination: string;
    scheduledDepartureAt: string;
    departureAt: string;
    status: FlightOperationalStatus;
    readyAt: string;
    conflict: boolean;
    suggestedDelayMinutes: number | null;
  } | null;
  bookings: number;
  passengers: number;
  tightConnections: { bookingId: string; pnr: string; channel: string; kind: 'CONNECTION' | 'RETURN'; nextFlightNumber: string; nextDepartureAt: string; availableMinutes: number; requiredMinutes: number }[];
}

export const getFlightDelayImpact = (token: string, flightNumber: string, date: string, delayMinutes: number) =>
  graphql<{ flightDelayImpact: FlightDelayImpact }>(
    `query ImpactoDelRetraso($flightNumber: String!, $date: Date!, $delayMinutes: Int!) {
      flightDelayImpact(flightNumber: $flightNumber, date: $date, delayMinutes: $delayMinutes) {
        flightNumber date delayMinutes scheduledDepartureAt scheduledArrivalAt estimatedDepartureAt estimatedArrivalAt
        aircraft { registration aircraftType turnaroundMinutes }
        nextFlight { flightNumber date origin destination scheduledDepartureAt departureAt status readyAt conflict suggestedDelayMinutes }
        bookings passengers
        tightConnections { bookingId pnr channel kind nextFlightNumber nextDepartureAt availableMinutes requiredMinutes }
      }
    }`,
    { flightNumber, date, delayMinutes },
    { token },
  ).then((data) => data.flightDelayImpact);

export const updateFlightStatus = (token: string, flightNumber: string, input: FlightStatusChange) =>
  graphql<{ updateFlightStatus: { previousStatus: FlightOperationalStatus; affectedBookings: number; flight: { status: FlightOperationalStatus } } }>(
    `mutation EstadoDeVuelo($flightNumber: String!, $input: FlightStatusUpdateInput!) {
      updateFlightStatus(flightNumber: $flightNumber, input: $input) { previousStatus affectedBookings flight { status } }
    }`,
    { flightNumber, input },
    { token },
  ).then((data) => data.updateFlightStatus);

// ── Telemetría (V2.16): cada parte tiene su backend y puede fallar sola ──
export interface ServiceHealth {
  service: string;
  status: 'UP' | 'DEGRADED' | 'DOWN';
  latencyMs: number | null;
  version: string | null;
  checkedAt: string;
}
export interface ServiceLatency {
  service: string;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  requests: number;
  errorRate: number;
}
export interface QueueStats {
  queue: string;
  messages: number;
  consumers: number;
  deadLetters: number | null;
}
export interface Alert {
  id: string;
  rule: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  service: string | null;
  message: string | null;
  startedAt: string;
}
export interface BookingIntegration {
  partnerId: string;
  lastTokenAt: string | null;
  webhooks: { subscriptions: number; pending: number; retrying: number; exhaustedLast24h: number; deliveredLast24h: number; lastDeliveredAt: string | null };
  lastStockPushAt: string | null;
  pendingStockPushes: number;
  lastInboundEventAt: string | null;
}
export interface CorrelationTrace {
  correlationId: string;
  /** Dónde se buscaron los pasos en Loki (T-2): RANGE el rango pedido, RECORDS sus sagas y eventos ±10 min, DEFAULT 3 h. */
  window: { from: string; to: string; source: 'RANGE' | 'RECORDS' | 'DEFAULT' } | null;
  /** Si Loki no respondió a tiempo: por qué faltan los pasos. */
  stepsError: string | null;
  steps: { timestamp: string; service: string; operation: string; status: string; latencyMs: number; requestId: string | null; traceId: string | null }[];
  sagas: { sagaId: string; type: string; status: string }[];
  events: { id: string; type: string; time: string }[];
}

export const getServicesHealth = (token: string) =>
  graphql<{ telemetry: { services: ServiceHealth[] } }>('query Salud { telemetry { services { service status latencyMs version checkedAt } } }', {}, { token }).then(
    (data) => data.telemetry.services,
  );

/** Latencia y errores de la última hora (Prometheus). */
export const getLatency = (token: string) =>
  graphql<{ telemetry: { latency: ServiceLatency[] } }>('query Latencia { telemetry { latency { service p50Ms p95Ms p99Ms requests errorRate } } }', {}, { token }).then(
    (data) => data.telemetry.latency,
  );

export const getQueues = (token: string) =>
  graphql<{ telemetry: { queues: QueueStats[] } }>('query Colas { telemetry { queues { queue messages consumers deadLetters } } }', {}, { token }).then((data) => data.telemetry.queues);

export const getAlerts = (token: string) =>
  graphql<{ telemetry: { alerts: Alert[] } }>('query Alertas { telemetry { alerts { id rule severity service message startedAt } } }', {}, { token }).then((data) => data.telemetry.alerts);

export const getBookingIntegration = (token: string) =>
  graphql<{ telemetry: { bookingIntegration: BookingIntegration } }>(
    `query Integracion {
      telemetry {
        bookingIntegration {
          partnerId lastTokenAt lastStockPushAt pendingStockPushes lastInboundEventAt
          webhooks { subscriptions pending retrying exhaustedLast24h deliveredLast24h lastDeliveredAt }
        }
      }
    }`,
    {},
    { token },
  ).then((data) => data.telemetry.bookingIntegration);

/** Todo lo que generó un proceso, por su `X-Correlation-Id`; `null` si no se encontró nada. */
export const getCorrelationTrace = (token: string, correlationId: string, range: { from?: string; to?: string } = {}) =>
  graphql<{ telemetry: { trace: CorrelationTrace | null } }>(
    `query Traza($correlationId: String!, $from: DateTime, $to: DateTime) {
      telemetry {
        trace(correlationId: $correlationId, from: $from, to: $to) {
          correlationId
          window { from to source }
          stepsError
          steps { timestamp service operation status latencyMs requestId traceId }
          sagas { sagaId type status }
          events { id type time }
        }
      }
    }`,
    { correlationId, ...range },
    { token },
  ).then((data) => data.telemetry.trace);

// ── Vista «Recorrido» y mapa en vivo (PLAN_Telemetria_Asientos T-4) ──
export type JourneyLayer = 'CLIENT' | 'GATEWAY' | 'RESPONSE' | 'ESB' | 'MANAGEMENT' | 'EXTERNAL';
export interface JourneyHop {
  sequence: number;
  from: string;
  to: string;
  operation: string;
  /** Milisegundos desde el inicio del proceso. */
  startMs: number;
  durationMs: number;
  status: 'OK' | 'ERROR';
  httpStatus: number | null;
  traceId: string;
}
export interface Journey {
  correlationId: string;
  startedAt: string | null;
  durationMs: number;
  traces: number;
  nodes: { id: string; layer: JourneyLayer }[];
  hops: JourneyHop[];
  truncated: boolean;
}
export interface SystemMapEdge {
  from: string;
  to: string;
  requestsPerMinute: number;
  errorsPerMinute: number;
  p95Ms: number | null;
}
export interface SystemMap {
  generatedAt: string;
  windowMinutes: number;
  edges: SystemMapEdge[];
}

/** Recorrido de un proceso de servicio en servicio (Tempo); `null` si no tiene trazas. */
export const getJourney = (token: string, correlationId: string, range: { from?: string; to?: string } = {}) =>
  graphql<{ telemetry: { journey: Journey | null } }>(
    `query Recorrido($correlationId: String!, $from: DateTime, $to: DateTime) {
      telemetry {
        journey(correlationId: $correlationId, from: $from, to: $to) {
          correlationId startedAt durationMs traces truncated
          nodes { id layer }
          hops { sequence from to operation startMs durationMs status httpStatus traceId }
        }
      }
    }`,
    { correlationId, ...range },
    { token },
  ).then((data) => data.telemetry.journey);

/** Quién llama a quién en los últimos 5 minutos (grafo de servicios de Tempo, en Prometheus). */
export const getSystemMap = (token: string) =>
  graphql<{ telemetry: { systemMap: SystemMap } }>(
    'query MapaEnVivo { telemetry { systemMap { generatedAt windowMinutes edges { from to requestsPerMinute errorsPerMinute p95Ms } } } }',
    {},
    { token },
  ).then((data) => data.telemetry.systemMap);

// ── Eventos de dominio y entregas de webhooks ──
export interface EventDelivery {
  consumer: string;
  target: string;
  /** PENDING, DELIVERED, RETRYING o EXHAUSTED (MS.G.Webhooks). */
  outcome: string;
  httpStatus?: number;
  attempts?: number;
}

export interface DomainEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  correlationId?: string;
  /** El `bookingId` en los eventos de reserva; el vuelo, la ruta o el usuario en los demás. */
  subject?: string;
  data: Record<string, unknown>;
  deliveries: EventDelivery[];
}

/** Filtros de la bitácora (panel O-4). Las fechas son instantes ISO. */
export interface EventFilter {
  type?: string;
  correlationId?: string;
  from?: string;
  to?: string;
}

interface EventHistoryItem {
  id: string;
  type: string;
  time: string;
  subject: string | null;
  correlationId: string | null;
  data: Record<string, unknown> | null;
  deliveries: { subscriptionId: string; target: string | null; outcome: string; httpStatus: number | null; attempts: number }[];
}

export const getRecentEvents = (token: string, filter: EventFilter = {}) =>
  graphql<{ eventHistory: { items: EventHistoryItem[] } }>(
    `query Eventos($type: String, $correlationId: String, $from: DateTime, $to: DateTime, $limit: Int) {
      eventHistory(type: $type, correlationId: $correlationId, from: $from, to: $to, limit: $limit) {
        items { id type subject time correlationId data deliveries { subscriptionId target outcome httpStatus attempts } }
      }
    }`,
    { ...Object.fromEntries(Object.entries(filter).filter(([, value]) => value)), limit: 50 },
    { token },
  ).then((data) =>
    data.eventHistory.items.map(
      (item): DomainEvent => ({
        eventId: item.id,
        eventType: item.type,
        occurredAt: item.time,
        ...(item.correlationId ? { correlationId: item.correlationId } : {}),
        ...(item.subject ? { subject: item.subject } : {}),
        // null en los eventos con datos de salud: nunca llegan al panel.
        data: item.data ?? {},
        deliveries: item.deliveries.map((delivery) => ({
          consumer: delivery.subscriptionId,
          target: delivery.target ?? '—',
          outcome: delivery.outcome,
          ...(delivery.httpStatus ? { httpStatus: delivery.httpStatus } : {}),
          attempts: delivery.attempts,
        })),
      }),
    ),
  );

// ── Rutas programadas (saga "Publicar horario") ──
export type WeekdayCode = 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT';
/** Nombre de un tipo del catálogo (M-2: ya no es una lista fija). */
export type AircraftTypeName = string;

export interface ScheduledRouteRequest {
  origin: string;
  destination: string;
  outboundDepartureLocal: string;
  inboundDepartureLocal: string;
  weekdays: WeekdayCode[];
  aircraftType?: AircraftTypeName;
  /** Matrículas elegidas; si se omite, el sistema asigna los aviones. */
  aircraft?: string[];
}

export interface RouteLeg {
  flightNumber: string;
  origin: string;
  destination: string;
  departureLocal: string;
  arrivalLocal: string;
  arrivalDayOffset: number;
  /** Días en que sale el tramo: la vuelta puede salir días después de la ida. */
  weekdays?: WeekdayCode[] | null;
}

export interface ScheduledRoute {
  routeId: string;
  origin: string;
  destination: string;
  outbound: RouteLeg;
  inbound: RouteLeg;
  weekdays: WeekdayCode[];
  aircraftType: AircraftTypeName;
  aircraft: string[];
  distanceKm: number;
  durationMinutes: number;
  /** Días entre la ida y la vuelta (0 = el mismo día). */
  returnDelayDays?: number | null;
  /** Minutos que el avión pasa en tierra en el destino antes de la vuelta. */
  groundMinutes?: number | null;
  /** Mínimo en tierra de su tipo de avión. */
  turnaroundMinutes?: number | null;
  source: 'NETWORK' | 'ADMIN';
  createdAt: string;
  updatedAt: string;
}

const LEG = 'flightNumber origin destination departureLocal arrivalLocal arrivalDayOffset weekdays';
const ROUTE = `routeId origin destination outbound { ${LEG} } inbound { ${LEG} } weekdays aircraftType aircraft distanceKm durationMinutes returnDelayDays groundMinutes turnaroundMinutes source createdAt updatedAt`;

/** Todas las rutas; con `airport`, las que salen o llegan a ese aeropuerto (el esquema no filtra: se filtra aquí). */
export const listRoutes = (token: string, airport?: string) =>
  graphql<{ routes: ScheduledRoute[] }>(`query Rutas { routes { ${ROUTE} } }`, {}, { token }).then((data) =>
    airport ? data.routes.filter((route) => route.origin === airport || route.destination === airport) : data.routes,
  );

export const createRoute = (token: string, input: ScheduledRouteRequest) =>
  graphql<{ createRoute: ScheduledRoute }>(`mutation CrearRuta($input: ScheduledRouteInput!) { createRoute(input: $input) { ${ROUTE} } }`, { input }, { token }).then(
    (data) => data.createRoute,
  );

export const updateRoute = (token: string, routeId: string, input: ScheduledRouteRequest) =>
  graphql<{ updateRoute: ScheduledRoute }>(
    `mutation EditarRuta($routeId: String!, $input: ScheduledRouteInput!) { updateRoute(routeId: $routeId, input: $input) { ${ROUTE} } }`,
    { routeId, input },
    { token },
  ).then((data) => data.updateRoute);

/** Si la ruta tiene cupos vendidos responde ROUTE_HAS_SOLD_SEATS: esos vuelos se gestionan con su estado operativo. */
export const deleteRoute = (token: string, routeId: string) =>
  graphql<{ deleteRoute: boolean }>('mutation BajaDeRuta($routeId: String!) { deleteRoute(routeId: $routeId) }', { routeId }, { token }).then(() => undefined);

// ── Flota ──
export interface Aircraft {
  registration: string;
  aircraftType: AircraftTypeName;
  base: string;
  status: 'IN_SERVICE' | 'AVAILABLE';
  routes: string[];
  totalSeats: number;
  source: 'NETWORK' | 'ADMIN';
  createdAt: string;
  updatedAt: string;
}

export interface AircraftTypeInfo {
  aircraftType: AircraftTypeName;
  registrationPrefix: string;
  seats: { cabinClass: string; seats: number }[];
  totalSeats: number;
  maxRouteKm: number | null;
  turnaroundMinutes: number;
  inFleet: number;
  /** Distribución de cada cabina (M-2). */
  cabins: { cabinClass: string; seats: number; configuration: string; layout: string; firstRow: number; lastRow: number; exitRows: number[]; extraLegroomRows: number[] }[];
  source: string | null;
}

/** Lo que escribe el administrador de un tipo (M-2). */
export interface AircraftTypeInput {
  registrationPrefix: string;
  maxRouteKm: number | null;
  turnaroundMinutes: number;
  business: { seats: number; configuration: string };
  economy: { seats: number; configuration: string };
}
const AIRCRAFT_TYPE = 'aircraftType registrationPrefix seats { cabinClass seats } totalSeats maxRouteKm turnaroundMinutes inFleet source cabins { cabinClass seats configuration layout firstRow lastRow exitRows extraLegroomRows }';

export const createAircraftType = (token: string, input: AircraftTypeInput & { aircraftType: string }) =>
  graphql<{ createAircraftType: AircraftTypeInfo }>(`mutation AltaDeTipo($input: CreateAircraftTypeInput!) { createAircraftType(input: $input) { ${AIRCRAFT_TYPE} } }`, { input }, { token }).then(
    (data) => data.createAircraftType,
  );

export const updateAircraftType = (token: string, aircraftType: string, input: AircraftTypeInput) =>
  graphql<{ updateAircraftType: AircraftTypeInfo }>(
    `mutation EditarTipo($aircraftType: String!, $input: AircraftTypeInput!) { updateAircraftType(aircraftType: $aircraftType, input: $input) { ${AIRCRAFT_TYPE} } }`,
    { aircraftType, input },
    { token },
  ).then((data) => data.updateAircraftType);

export const deleteAircraftType = (token: string, aircraftType: string) =>
  graphql<{ deleteAircraftType: boolean }>('mutation BorrarTipo($aircraftType: String!) { deleteAircraftType(aircraftType: $aircraftType) }', { aircraftType }, { token }).then(() => undefined);

const AIRCRAFT = 'registration aircraftType base status routes totalSeats source createdAt updatedAt';

export const listAircraftTypes = (token: string) =>
  graphql<{ aircraftTypes: AircraftTypeInfo[] }>(
    `query TiposDeAvion { aircraftTypes { ${AIRCRAFT_TYPE} } }`,
    {},
    { token },
  ).then((data) => data.aircraftTypes);

/** La flota; los filtros se aplican aquí (el esquema devuelve todos los aviones). */
export const listAircraft = (token: string, filter: { base?: string; aircraftType?: string } = {}) =>
  graphql<{ fleet: Aircraft[] }>(`query Flota { fleet { ${AIRCRAFT} } }`, {}, { token }).then((data) =>
    data.fleet.filter((plane) => (!filter.base || plane.base === filter.base) && (!filter.aircraftType || plane.aircraftType === filter.aircraftType)),
  );

export const registerAircraft = (token: string, input: { aircraftType: AircraftTypeName; base: string }) =>
  graphql<{ createAircraft: Aircraft }>(`mutation AltaDeAvion($input: AircraftInput!) { createAircraft(input: $input) { ${AIRCRAFT} } }`, { input }, { token }).then(
    (data) => data.createAircraft,
  );

export const moveAircraft = (token: string, registration: string, base: string) =>
  graphql<{ updateAircraftBase: Aircraft }>(
    `mutation MoverAvion($registration: String!, $base: IataCode!) { updateAircraftBase(registration: $registration, base: $base) { ${AIRCRAFT} } }`,
    { registration, base },
    { token },
  ).then((data) => data.updateAircraftBase);

export const retireAircraft = (token: string, registration: string) =>
  graphql<{ deleteAircraft: boolean }>('mutation RetirarAvion($registration: String!) { deleteAircraft(registration: $registration) }', { registration }, { token }).then(
    () => undefined,
  );

// ── Catálogo de aeropuertos (M-1) ──
export interface CatalogAirport {
  code: string;
  city: string;
  name: string;
  /** ISO 3166-1 alfa-2 (EC, CO, US…). */
  country: string;
  province: string | null;
  lat: number;
  lon: number;
  /** Desfase fijo respecto de UTC en minutos (−300 = UTC−5). */
  utcOffsetMinutes: number;
  active: boolean;
  updatedAt: string | null;
}
export type AirportInput = Omit<CatalogAirport, 'code' | 'updatedAt'>;
const AIRPORT = 'code city name country province lat lon utcOffsetMinutes active updatedAt';

export const listCatalogAirports = (token: string) =>
  graphql<{ airports: CatalogAirport[] }>(`query CatalogoAeropuertos { airports { ${AIRPORT} } }`, {}, { token }).then((data) => data.airports);

export const createAirport = (token: string, input: AirportInput & { code: string }) =>
  graphql<{ createAirport: CatalogAirport }>(`mutation AltaDeAeropuerto($input: CreateAirportInput!) { createAirport(input: $input) { ${AIRPORT} } }`, { input }, { token }).then(
    (data) => data.createAirport,
  );

export const updateAirport = (token: string, code: string, input: AirportInput) =>
  graphql<{ updateAirport: CatalogAirport }>(`mutation EditarAeropuerto($code: IataCode!, $input: AirportInput!) { updateAirport(code: $code, input: $input) { ${AIRPORT} } }`, { code, input }, { token }).then(
    (data) => data.updateAirport,
  );

export const deleteAirport = (token: string, code: string) =>
  graphql<{ deleteAirport: boolean }>('mutation BorrarAeropuerto($code: IataCode!) { deleteAirport(code: $code) }', { code }, { token }).then(() => undefined);

// ── Rotación de la flota en un día ──
export interface FleetLeg {
  segmentId: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
}

export interface FleetSchedule {
  date: string;
  /** Ventana de venta publicada (de hoy al último día con vuelos a la venta). */
  salesWindow: { from: string; to: string; days: number };
  totalFlights: number;
  aircraft: { registration: string; aircraftType: string; base: string; flights: FleetLeg[] }[];
}

export const getFleetSchedule = (token: string, date: string) =>
  graphql<{
    fleetSchedule: {
      date: string;
      totalFlights: number;
      aircraft: { registration: string; aircraftType: string; base: string; flights: { flightNumber: string; date: string; origin: string; destination: string; departureAt: string; arrivalAt: string }[] }[];
    };
  }>(
    `query Rotacion($date: Date!) {
      fleetSchedule(date: $date) { date totalFlights aircraft { registration aircraftType base flights { flightNumber date origin destination departureAt arrivalAt } } }
    }`,
    { date },
    { token },
  ).then(({ fleetSchedule: schedule }): FleetSchedule => {
    const from = todayIso();
    const to = lastSaleDate();
    return {
      date: schedule.date,
      salesWindow: { from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 },
      totalFlights: schedule.totalFlights,
      aircraft: schedule.aircraft.map((plane) => ({
        ...plane,
        flights: plane.flights.map((flight) => ({
          // El id del segmento del contrato: vuelo y fecha de salida.
          segmentId: `${flight.flightNumber}-${flight.date.replaceAll('-', '')}`,
          flightNumber: flight.flightNumber,
          origin: flight.origin,
          destination: flight.destination,
          departure: flight.departureAt,
          arrival: flight.arrivalAt,
        })),
      })),
    };
  });

// ── Usuarios y roles ──
export type RoleName = 'CUSTOMER' | 'ADMIN';
export type AccountStatus = 'ACTIVE' | 'BLOCKED';

export interface User {
  sub: string;
  email: string;
  fullName: string;
  role: RoleName;
  status: AccountStatus;
  createdAt: string;
  lastLoginAt: string | null;
}

const USER = 'sub email fullName role status createdAt lastLoginAt';

export const listUsers = (token: string, query: { q?: string; role?: string; status?: string; limit?: number; cursor?: string }) => {
  const { limit, cursor, ...rest } = query;
  const filter = Object.fromEntries(Object.entries(rest).filter(([, value]) => value));
  return graphql<{ users: { items: User[]; nextCursor: string | null } }>(
    `query Usuarios($filter: UserFilterInput, $limit: Int, $cursor: String) { users(filter: $filter, limit: $limit, cursor: $cursor) { nextCursor items { ${USER} } } }`,
    { filter, limit, cursor },
    { token },
  ).then((data) => data.users);
};

export const createUser = (token: string, input: { fullName: string; email: string; password: string; role: RoleName }) =>
  graphql<{ createUser: User }>(`mutation CrearUsuario($input: CreateUserInput!) { createUser(input: $input) { ${USER} } }`, { input }, { token }).then((data) => data.createUser);

export const changeUserRole = (token: string, sub: string, role: RoleName) =>
  graphql<{ changeUserRole: User }>(`mutation CambiarRol($sub: UUID!, $role: RoleName!) { changeUserRole(sub: $sub, role: $role) { ${USER} } }`, { sub, role }, { token }).then(
    (data) => data.changeUserRole,
  );

export const changeUserStatus = (token: string, sub: string, input: { status: AccountStatus; reason?: string }) =>
  graphql<{ changeUserStatus: User }>(`mutation EstadoDeUsuario($sub: UUID!, $input: ChangeStatusInput!) { changeUserStatus(sub: $sub, input: $input) { ${USER} } }`, { sub, input }, { token }).then(
    (data) => data.changeUserStatus,
  );

// ── Partners (sistemas B2B como Booking) ──
export const PARTNER_SCOPES = ['FLIGHTS_READ', 'FLIGHTS_HOLD', 'FLIGHTS_BOOK', 'FLIGHTS_CANCEL', 'FLIGHTS_WEBHOOKS', 'FLIGHTS_OPS'] as const;
export type PartnerScope = (typeof PARTNER_SCOPES)[number];

export interface Partner {
  clientId: string;
  name: string;
  scopes: PartnerScope[];
  status: AccountStatus;
  createdAt: string;
  secretRotatedAt: string | null;
  lastTokenAt: string | null;
}

const PARTNER = 'clientId name scopes status createdAt secretRotatedAt lastTokenAt';

export const listPartners = (token: string) => graphql<{ partners: Partner[] }>(`query Partners { partners { ${PARTNER} } }`, {}, { token }).then((data) => data.partners);

/** El secreto se devuelve UNA sola vez: la pantalla lo muestra y no lo guarda en ningún lado. */
export const createPartner = (token: string, input: { clientId: string; name: string; scopes: PartnerScope[] }) =>
  graphql<{ createPartner: { partner: Partner; clientSecret: string } }>(
    `mutation CrearPartner($input: CreatePartnerInput!) { createPartner(input: $input) { clientSecret partner { ${PARTNER} } } }`,
    { input },
    { token },
  ).then((data) => data.createPartner);

export const changePartnerStatus = (token: string, clientId: string, input: { status: AccountStatus; reason?: string }) =>
  graphql<{ changePartnerStatus: Partner }>(
    `mutation EstadoDePartner($clientId: String!, $input: ChangeStatusInput!) { changePartnerStatus(clientId: $clientId, input: $input) { ${PARTNER} } }`,
    { clientId, input },
    { token },
  ).then((data) => data.changePartnerStatus);

export const rotatePartnerSecret = (token: string, clientId: string) =>
  graphql<{ rotatePartnerSecret: { partner: Partner; clientSecret: string } }>(
    `mutation RotarSecreto($clientId: String!) { rotatePartnerSecret(clientId: $clientId) { clientSecret partner { ${PARTNER} } } }`,
    { clientId },
    { token },
  ).then((data) => data.rotatePartnerSecret);

// ── Precios por clase y promociones ──
export interface FareClassPrice {
  cabinClass: CabinClass;
  fareBrand: string;
  referenceMultiplier: number;
  multiplier: number;
  updatedAt: string;
}

export interface PromotionAgreement {
  partnerId: string;
  allowsPromotions: boolean;
  maxDiscountPercentage: number;
  enabledDestinations: string[];
  enabledRoutes: string[];
  enabledCabins: CabinClass[];
  validUntil: string | null;
  comboConditions: string | null;
}

export interface PricesView {
  prices: FareClassPrice[];
  updatedAt: string;
  /** Tarifa base y precios exactos por ruta (P-1). */
  pricing: PricingSettings;
  promotions: PromotionAgreement[];
}

export interface RoutePrices {
  routeId: string;
  prices: { fareBrand: string; amount: number }[];
}

export interface PricingSettings {
  fixedCharge: number;
  perKm: number;
  routePrices: RoutePrices[];
  updatedAt: string | null;
  updatedBy: string | null;
  history: { id: string; field: 'FIXED_CHARGE' | 'PER_KM' | 'ROUTE_PRICE'; routeId: string | null; fareBrand: string | null; oldValue: number | null; newValue: number | null; changedBy: string; changedAt: string }[];
}

export interface PriceChange {
  id: string;
  cabinClass: CabinClass;
  fareBrand: string;
  oldMultiplier: number;
  newMultiplier: number;
  changedAt: string;
}

const PRICES = `prices { cabinClass fareBrand referenceMultiplier multiplier updatedAt } updatedAt
  pricing { fixedCharge perKm routePrices { routeId prices { fareBrand amount } } updatedAt updatedBy history { id field routeId fareBrand oldValue newValue changedBy changedAt } }
  promotions { partnerId allowsPromotions maxDiscountPercentage enabledDestinations enabledRoutes enabledCabins validUntil comboConditions }`;

export const getPrices = (token: string) => graphql<{ prices: PricesView }>(`query Precios { prices { ${PRICES} } }`, {}, { token }).then((data) => data.prices);

export const getReferencePrices = (token: string) =>
  graphql<{ referencePrices: { cabinClass: CabinClass; fareBrand: string; multiplier: number }[] }>('query PreciosDeReferencia { referencePrices { cabinClass fareBrand multiplier } }', {}, { token }).then(
    (data) => data.referencePrices,
  );

export const getPriceHistory = (token: string, limit = 20) =>
  graphql<{ priceHistory: { items: PriceChange[] } }>(
    'query HistorialDePrecios($limit: Int) { priceHistory(limit: $limit) { items { id cabinClass fareBrand oldMultiplier newMultiplier changedAt } } }',
    { limit },
    { token },
  ).then((data) => data.priceHistory.items);

/** Un solo «Guardar»: los precios que cambiaron y el acuerdo de promociones. */
export const savePrices = (
  token: string,
  input: {
    prices?: { cabinClass: CabinClass; fareBrand: string; multiplier: number }[];
    pricing?: { fixedCharge?: number; perKm?: number; route?: RoutePrices };
    promotion?: Omit<PromotionAgreement, 'validUntil' | 'comboConditions'> & { validUntil?: string; comboConditions?: string };
  },
) => graphql<{ savePrices: PricesView }>(`mutation GuardarPrecios($input: SavePricesInput!) { savePrices(input: $input) { ${PRICES} } }`, { input }, { token }).then((data) => data.savePrices);

// ── Asistencia por vuelo (dato de salud) ──
export interface FlightAssistanceItem {
  bookingId: string;
  pnr: string;
  passengerId: string;
  passengerName: string;
  segmentId: string;
  seatNumber: string | null;
  assistance: { type: string; needsCompanion: boolean; notes: string | null; status: 'REQUESTED' | 'READY' };
}

export const getFlightAssistance = (token: string, flightNumber: string, date: string) =>
  graphql<{ flightAssistance: FlightAssistanceItem[] }>(
    `query AsistenciaDeVuelo($flightNumber: String!, $date: Date!) {
      flightAssistance(flightNumber: $flightNumber, date: $date) {
        bookingId pnr passengerId passengerName segmentId seatNumber assistance { type needsCompanion notes status }
      }
    }`,
    { flightNumber, date },
    { token },
  ).then((data) => data.flightAssistance);

export const markAssistanceReady = (token: string, bookingId: string, input: { passengerId: string; segmentId: string; ready: boolean }) =>
  graphql<{ markAssistanceReady: boolean }>('mutation AsistenciaLista($id: UUID!, $input: AssistanceReadyInput!) { markAssistanceReady(bookingId: $id, input: $input) }', { id: bookingId, input }, { token }).then(
    () => undefined,
  );

// ── Reservas de todos los canales (panel O-1, solo lectura; → MS.Admin listAdminBookings y getAdminBooking) ──
export type SalesChannelCode = 'WEB' | 'BOOKING';

export interface AdminBookingFilter {
  /** PNR, orden de Booking o referencia del pago de la reserva, exactos. */
  reference?: string;
  status?: BookingStatus;
  channel?: SalesChannelCode;
  createdFrom?: string;
  createdTo?: string;
}

export interface AdminBookingSummary {
  bookingId: string;
  pnr: string;
  status: BookingStatus;
  channel: SalesChannelCode;
  partnerId: string | null;
  partnerOrderId: string | null;
  origin: string | null;
  destination: string | null;
  departureAt: string | null;
  passengerCount: number;
  grandTotal: MoneyAmount;
  refundTotal: string | null;
  createdAt: string;
}

export interface AdminPayment {
  paymentReference: string;
  provider: string;
  operation: string;
  amount: MoneyAmount;
  claimedAt: string;
}

export interface AdminRefund {
  refundId: string;
  amount: string;
  penaltyAmount: string;
  currency: string;
  percentage: number | null;
  status: 'CALCULATED' | 'SETTLED' | 'NOT_REFUNDABLE';
}

export interface AdminBooking {
  bookingId: string;
  pnr: string;
  status: BookingStatus;
  channel: SalesChannelCode;
  ownerId: string;
  partnerUserId: string | null;
  salesChannel: { partnerId: string | null; partnerOrderId: string | null; packageId: string | null; promotionApplied: boolean | null; discountPercentage: number | null } | null;
  paymentReference: string | null;
  grandTotal: MoneyAmount;
  createdAt: string;
  updatedAt: string | null;
  itineraries: ItineraryOption[];
  passengers: PassengerItem[];
  fares: { itineraryId: string; cabinClass: CabinClass; fareBrand: string; segmentIds: string[]; isRefundable: boolean; isChangeable: boolean; price: MoneyAmount }[];
  tickets: Ticket[];
  refunds: AdminRefund[];
  payments: AdminPayment[];
  changes: { changedAt: string; description: string | null }[];
  /** Solo los ids: la asistencia médica es un dato de salud. */
  passengersWithAssistance: string[];
}

export const listAdminBookings = (token: string, filter: AdminBookingFilter, cursor?: string) =>
  graphql<{ adminBookings: { nextCursor: string | null; items: AdminBookingSummary[] } }>(
    `query ReservasDelPanel($filter: AdminBookingFilterInput, $limit: Int, $cursor: String) {
      adminBookings(filter: $filter, limit: $limit, cursor: $cursor) {
        nextCursor
        items {
          bookingId pnr status channel partnerId partnerOrderId origin destination departureAt passengerCount
          grandTotal { ${MONEY} } refundTotal createdAt
        }
      }
    }`,
    { filter, limit: 20, ...(cursor ? { cursor } : {}) },
    { token },
  ).then((data) => data.adminBookings);

export const getAdminBooking = (token: string, bookingId: string) =>
  graphql<{ adminBooking: AdminBooking }>(
    `query ReservaDelPanel($id: UUID!) {
      adminBooking(bookingId: $id) {
        bookingId pnr status channel ownerId partnerUserId paymentReference createdAt updatedAt grandTotal { ${MONEY} }
        salesChannel { partnerId partnerOrderId packageId promotionApplied discountPercentage }
        itineraries { ${ITINERARY} }
        passengers { ${PASSENGER} }
        fares { itineraryId cabinClass fareBrand segmentIds isRefundable isChangeable price { ${MONEY} } }
        tickets { ${TICKET} }
        refunds { refundId amount penaltyAmount currency percentage status }
        payments { paymentReference provider operation claimedAt amount { ${MONEY} } }
        changes { changedAt description }
        passengersWithAssistance
      }
    }`,
    { id: bookingId },
    { token },
  ).then((data) => data.adminBooking);

// ── Historial de una reserva (panel O-2; → MS.Admin getAdminBookingTimeline) ──
export interface AdminSaga {
  sagaId: string;
  type: string;
  status: 'RUNNING' | 'COMPLETED' | 'COMPENSATING' | 'COMPENSATED' | 'FAILED';
  correlationId: string;
  parentSagaId: string | null;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
  steps: { name: string; status: 'STARTED' | 'DONE' | 'COMPENSATED'; at: string }[];
}

export interface AdminTimelineEvent {
  id: string;
  type: string;
  time: string;
  correlationId: string | null;
  public: boolean;
  deliveries: { subscriptionId: string; target: string | null; outcome: string; httpStatus: number | null; attempts: number; nextRetryAt: string | null }[];
}

export interface AdminBookingTimeline {
  sagas: AdminSaga[];
  events: AdminTimelineEvent[];
}

export const getAdminBookingTimeline = (token: string, bookingId: string) =>
  graphql<{ adminBooking: { timeline: AdminBookingTimeline } }>(
    `query HistorialDeReserva($id: UUID!) {
      adminBooking(bookingId: $id) {
        timeline {
          sagas { sagaId type status correlationId parentSagaId createdAt updatedAt errorCode steps { name status at } }
          events { id type time correlationId public deliveries { subscriptionId target outcome httpStatus attempts nextRetryAt } }
        }
      }
    }`,
    { id: bookingId },
    { token },
  ).then((data) => data.adminBooking.timeline);

// ── Reporte de ventas y liquidación con Booking (panel O-3; → MS.Admin getSalesReport) ──
export interface SettlementItem {
  bookingId: string;
  pnr: string;
  partnerOrderId: string | null;
  paymentReference: string;
  status: BookingStatus;
  createdAt: string;
  charged: string;
  refunded: string;
  penalty: string;
  net: string;
}

export interface SalesReport {
  from: string;
  to: string;
  currency: string;
  generatedAt: string;
  totals: { bookings: number; cancelled: number; passengers: number; charged: string; refunded: string; net: string };
  byChannel: { channel: SalesChannelCode; bookings: number; charged: string; refunded: string; net: string }[];
  byDay: { date: string; channel: SalesChannelCode; bookings: number; charged: string }[];
  byRoute: { origin: string; destination: string; bookings: number; passengers: number; charged: string }[];
  bookingSettlement: {
    partnerId: string;
    bookings: number;
    charged: string;
    refunded: string;
    penalties: string;
    net: string;
    pendingRefunds: { count: number; amount: string };
    items: SettlementItem[];
  };
}

export const getSalesReport = (token: string, from: string, to: string) =>
  graphql<{ adminSalesReport: SalesReport }>(
    `query ReporteDeVentas($from: Date!, $to: Date!) {
      adminSalesReport(from: $from, to: $to) {
        from to currency generatedAt
        totals { bookings cancelled passengers charged refunded net }
        byChannel { channel bookings charged refunded net }
        byDay { date channel bookings charged }
        byRoute { origin destination bookings passengers charged }
        bookingSettlement {
          partnerId bookings charged refunded penalties net pendingRefunds { count amount }
          items { bookingId pnr partnerOrderId paymentReference status createdAt charged refunded penalty net }
        }
      }
    }`,
    { from, to },
    { token },
  ).then((data) => data.adminSalesReport);
