import { Inject, Injectable } from '@nestjs/common';
import {
  AIRCRAFT_MAX_ROUTE_KM,
  AIRCRAFT_TYPES,
  AIRPORTS,
  type AircraftType,
  distanceKm,
  nextRegistration,
  ProblemDetailsException,
  REGISTRATION_PREFIX,
  seatsByCabin,
  totalSeats,
  TURNAROUND_MINUTES,
} from '@ecoairlines/shared';
import { addDays, formatLocalIso, localToUtcMs } from '../domain/dates.js';
import { type AircraftRecord, type RouteRecord, type ScheduleState, WEEKDAY_CODES } from '../domain/model.js';
import {
  assertAirport,
  assertNotDuplicated,
  assertWithoutSoldSeats,
  nextFlightNumbers,
  restoredFlightNumbers,
  type RouteRequest,
  routeAircraftType,
  routeLeg,
  timetableProblem,
  toRouteDefinition,
} from '../domain/rules.js';
import {
  buildTimetable,
  flightDurationMinutes,
  flightsOperatingOn,
  type RouteDefinition,
  type Timetable,
  TimetableError,
  weekdayOf,
} from '../domain/timetable.js';
import { SCHEDULE_REPOSITORY, type ScheduleRepository } from '../repositories/schedule.repository.js';

const MAX_RANGE_DAYS = 92;

/**
 * Rutas, flota y horario (contrato: Rutas, Flota, Horario). Cada cambio de rutas arma el horario completo con el cambio
 * (`buildTimetable` asigna los aviones y comprueba que ninguno quede en dos lugares a la vez) y solo si es operable lo guarda.
 * Publicar a Offers y emitir `schedule.published` lo hace el ESB (saga "Publicar horario").
 */
@Injectable()
export class ScheduleService {
  private cache?: { version: number; state: ScheduleState; timetable: Timetable };

  constructor(@Inject(SCHEDULE_REPOSITORY) private readonly repository: ScheduleRepository) {}

  // ------------------------------------------------------------------ rutas
  async listRoutes() {
    const { state } = await this.current();
    return state.routes.map(toRouteDto);
  }

  async getRoute(routeId: string) {
    const { state } = await this.current();
    return toRouteDto(this.requireRoute(state, routeId));
  }

  async createRoute(request: RouteRequest, actor: string, restoreRouteId?: string) {
    const route = await this.repository.changeSchedule((state) => {
      const [outbound, inbound] = restoreRouteId ? restoredFlightNumbers(restoreRouteId, state.routes) : nextFlightNumbers(state.routes);
      const now = new Date().toISOString();
      const definition = toRouteDefinition(request, outbound, inbound, routeAircraftType(request, state.fleet));
      assertNotDuplicated(definition, state.routes);
      // Sin aviones elegidos: el horario agrega los que hagan falta (con base en el origen).
      const planned: RouteDefinition = { ...definition, aircraft: request.aircraft ?? [], autoAddAircraft: !request.aircraft };
      const timetable = this.build([...state.routes, planned], state.fleet);
      const created: RouteRecord = {
        ...definition,
        aircraft: [...timetable.aircraftByRoute![definition.routeId]!],
        source: 'ADMIN',
        createdAt: now,
        updatedAt: now,
        updatedBy: actor,
      };
      return { changes: { saveAircraft: newAircraft(timetable, state, actor), saveRoutes: [created] }, result: created };
    });
    return toRouteDto(route);
  }

  async updateRoute(routeId: string, request: RouteRequest, soldSeats: number, actor: string) {
    const route = await this.repository.changeSchedule((state) => {
      const current = this.requireRoute(state, routeId);
      assertWithoutSoldSeats(routeId, soldSeats);
      const definition = toRouteDefinition(request, current.outbound.flightNumber, current.inbound.flightNumber, routeAircraftType(request, state.fleet));
      assertNotDuplicated(definition, state.routes);
      // Sin aviones elegidos: conserva los que ya tenía (si siguen sirviendo) y agrega los que falten.
      const keep = current.aircraft.filter((registration) => {
        const plane = state.fleet.find((candidate) => candidate.registration === registration);
        return plane?.aircraftType === definition.aircraftType && plane.base === definition.origin;
      });
      const planned: RouteDefinition = request.aircraft
        ? { ...definition, aircraft: request.aircraft }
        : { ...definition, aircraft: keep, autoAddAircraft: true };
      const timetable = this.build(state.routes.map((candidate) => (candidate.routeId === routeId ? planned : candidate)), state.fleet);
      const updated: RouteRecord = {
        ...current,
        ...definition,
        aircraft: [...timetable.aircraftByRoute![routeId]!],
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
      };
      return { changes: { saveAircraft: newAircraft(timetable, state, actor), saveRoutes: [updated] }, result: updated };
    });
    return toRouteDto(route);
  }

  /** Quitar una ruta nunca hace inoperable el horario: sus aviones quedan disponibles. */
  async deleteRoute(routeId: string, soldSeats: number): Promise<void> {
    await this.repository.changeSchedule((state) => {
      this.requireRoute(state, routeId);
      assertWithoutSoldSeats(routeId, soldSeats);
      return { changes: { deleteRoutes: [routeId] }, result: undefined };
    });
  }

  // ------------------------------------------------------------------ flota
  async listAircraftTypes() {
    const { state } = await this.current();
    return AIRCRAFT_TYPES.map((aircraftType) => ({
      aircraftType,
      registrationPrefix: REGISTRATION_PREFIX[aircraftType],
      seats: seatsByCabin(aircraftType),
      totalSeats: totalSeats(aircraftType),
      maxRouteKm: AIRCRAFT_MAX_ROUTE_KM[aircraftType],
      turnaroundMinutes: TURNAROUND_MINUTES[aircraftType],
      inFleet: state.fleet.filter((plane) => plane.aircraftType === aircraftType).length,
    }));
  }

  async listAircraft() {
    const { state } = await this.current();
    const routes = routesByAircraft(state);
    return state.fleet.map((plane) => toAircraftDto(plane, routes.get(plane.registration) ?? []));
  }

  async getAircraft(registration: string) {
    const { state } = await this.current();
    return toAircraftDto(this.requireAircraft(state, registration), routesByAircraft(state).get(registration) ?? []);
  }

  /** La matrícula es la siguiente libre del tipo. Un avión nuevo sin rutas no cambia el horario. */
  async createAircraft(request: { aircraftType: AircraftType; base: string }, actor: string) {
    assertAirport(request.base, 'base');
    const plane = await this.repository.changeSchedule((state) => {
      const used = new Set(state.fleet.map((candidate) => candidate.registration));
      let sequence = 1;
      while (used.has(nextRegistration(request.aircraftType, sequence))) sequence++;
      const now = new Date().toISOString();
      const created: AircraftRecord = {
        registration: nextRegistration(request.aircraftType, sequence),
        aircraftType: request.aircraftType,
        base: request.base,
        source: 'ADMIN',
        createdAt: now,
        updatedAt: now,
        updatedBy: actor,
      };
      return { changes: { saveAircraft: [created] }, result: created };
    });
    return toAircraftDto(plane, []);
  }

  async updateAircraft(registration: string, base: string, actor: string) {
    assertAirport(base, 'base');
    const plane = await this.repository.changeSchedule((state) => {
      const current = this.requireAircraft(state, registration);
      assertAvailable(current, routesByAircraft(state).get(registration) ?? [], 'cambiar de base');
      const updated = { ...current, base, updatedAt: new Date().toISOString(), updatedBy: actor };
      return { changes: { saveAircraft: [updated] }, result: updated };
    });
    return toAircraftDto(plane, []);
  }

  async deleteAircraft(registration: string): Promise<void> {
    await this.repository.changeSchedule((state) => {
      const current = this.requireAircraft(state, registration);
      assertAvailable(current, routesByAircraft(state).get(registration) ?? [], 'retirar');
      return { changes: { deleteAircraft: [registration] }, result: undefined };
    });
  }

  // ------------------------------------------------------------------ horario
  /** Vuelos con fecha y avión entre `from` y `to` (inclusive), para `PublishTimetable` y `schedule.published`. */
  async timetable(from: string, to: string, routeId?: string) {
    if (to < from || addDays(from, MAX_RANGE_DAYS - 1) < to) {
      throw new ProblemDetailsException({
        status: 400,
        code: 'VALIDATION_FAILED',
        title: `El rango debe tener entre 1 y ${MAX_RANGE_DAYS} días (from ≤ to).`,
        invalidParams: [{ name: 'to', reason: `máximo ${MAX_RANGE_DAYS} días desde from` }],
      });
    }
    const { state, timetable } = await this.current();
    const routeOf = flightRouteIndex(state);
    const flights = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      for (const flight of datedFlights(timetable, routeOf, date)) if (!routeId || flight.routeId === routeId) flights.push(flight);
    }
    return { from, to, generatedAt: new Date().toISOString(), flights };
  }

  /** Rotación de cada avión en una fecha (todos los aviones, aunque no vuelen ese día). */
  async fleetSchedule(date: string) {
    const { state, timetable } = await this.current();
    const flights = datedFlights(timetable, flightRouteIndex(state), date);
    return {
      date,
      totalFlights: flights.length,
      aircraft: state.fleet.map((plane) => ({
        registration: plane.registration,
        aircraftType: plane.aircraftType,
        base: plane.base,
        flights: flights.filter((flight) => flight.registration === plane.registration),
      })),
    };
  }

  /** Estado y horario semanal; se reconstruye solo si la base cambió (versión), así varias réplicas siguen consistentes. */
  async current(): Promise<{ state: ScheduleState; timetable: Timetable }> {
    const version = await this.repository.version();
    if (this.cache?.version !== version) {
      const state = await this.repository.loadState();
      this.cache = { version, state, timetable: this.build(state.routes, state.fleet) };
    }
    return this.cache;
  }

  /** Rutas operadas, para validar el acuerdo de promociones. */
  async operatedRoutes(): Promise<RouteRecord[]> {
    return (await this.current()).state.routes;
  }

  private build(routes: readonly RouteDefinition[], fleet: readonly AircraftRecord[]): Timetable {
    try {
      return buildTimetable(routes, fleet);
    } catch (error) {
      if (error instanceof TimetableError) throw timetableProblem(error);
      throw error;
    }
  }

  private requireRoute(state: ScheduleState, routeId: string): RouteRecord {
    const route = state.routes.find((candidate) => candidate.routeId === routeId);
    if (!route) throw ProblemDetailsException.notFound('Ruta no encontrada.');
    return route;
  }

  private requireAircraft(state: ScheduleState, registration: string): AircraftRecord {
    const plane = state.fleet.find((candidate) => candidate.registration === registration);
    if (!plane) throw ProblemDetailsException.notFound('Avión no encontrado.');
    return plane;
  }
}

/** Aviones que el horario agregó a la flota para cubrir una ruta (no estaban en el estado). */
function newAircraft(timetable: Timetable, state: ScheduleState, actor: string): AircraftRecord[] {
  const known = new Set(state.fleet.map((plane) => plane.registration));
  const now = new Date().toISOString();
  return timetable.fleet
    .filter((plane) => !known.has(plane.registration))
    .map((plane) => ({ ...plane, source: 'ADMIN' as const, createdAt: now, updatedAt: now, updatedBy: actor }));
}

function routesByAircraft(state: ScheduleState): Map<string, string[]> {
  const byAircraft = new Map<string, string[]>();
  for (const route of state.routes) {
    for (const registration of route.aircraft) byAircraft.set(registration, [...(byAircraft.get(registration) ?? []), route.routeId]);
  }
  return byAircraft;
}

function assertAvailable(plane: AircraftRecord, routes: string[], action: string): void {
  if (routes.length > 0) {
    throw new ProblemDetailsException({
      status: 409,
      code: 'AIRCRAFT_IN_SERVICE',
      title: `No se puede ${action} ${plane.registration}: opera ${routes.length} ruta(s).`,
      detail: `Rutas: ${routes.slice(0, 5).join(', ')}. Primero asigne otros aviones a esas rutas o déles de baja.`,
    });
  }
}

const flightRouteIndex = (state: ScheduleState) =>
  new Map(state.routes.flatMap((route) => [[route.outbound.flightNumber, route.routeId], [route.inbound.flightNumber, route.routeId]] as const));

/** Vuelos que salen en una fecha local, con hora de salida y de llegada con el desfase de cada aeropuerto. */
function datedFlights(timetable: Timetable, routeOf: Map<string, string>, date: string) {
  const weekday = weekdayOf(date);
  return flightsOperatingOn(timetable, date)
    .map((flight) => {
      const origin = AIRPORTS[flight.origin]!;
      const destination = AIRPORTS[flight.destination]!;
      const departure = localToUtcMs(date, flight.departureLocal, origin.utcOffsetMinutes);
      const arrival = departure + flightDurationMinutes(flight.origin, flight.destination) * 60_000;
      const dated = {
        flightNumber: flight.flightNumber,
        date,
        routeId: routeOf.get(flight.flightNumber)!,
        origin: flight.origin,
        destination: flight.destination,
        departureAt: formatLocalIso(departure, origin.utcOffsetMinutes),
        arrivalAt: formatLocalIso(arrival, destination.utcOffsetMinutes),
        aircraftType: flight.aircraft,
        registration: flight.aircraftByDay[weekday]!,
      };
      return { departure, dated };
    })
    .sort((a, b) => a.departure - b.departure || a.dated.flightNumber.localeCompare(b.dated.flightNumber))
    .map(({ dated }) => dated);
}

function toRouteDto(route: RouteRecord) {
  return {
    routeId: route.routeId,
    origin: route.origin,
    destination: route.destination,
    outbound: routeLeg(route.outbound.flightNumber, route.origin, route.destination, route.outbound.departureLocal),
    inbound: routeLeg(route.inbound.flightNumber, route.destination, route.origin, route.inbound.departureLocal),
    weekdays: route.weekdays.map((weekday) => WEEKDAY_CODES[weekday]!),
    aircraftType: route.aircraftType,
    aircraft: [...route.aircraft],
    distanceKm: distanceKm(AIRPORTS[route.origin]!, AIRPORTS[route.destination]!),
    durationMinutes: flightDurationMinutes(route.origin, route.destination),
    source: route.source,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
    updatedBy: route.updatedBy,
  };
}

function toAircraftDto(plane: AircraftRecord, routes: string[]) {
  return {
    registration: plane.registration,
    aircraftType: plane.aircraftType,
    base: plane.base,
    status: routes.length > 0 ? ('IN_SERVICE' as const) : ('AVAILABLE' as const),
    routes,
    totalSeats: totalSeats(plane.aircraftType),
    source: plane.source,
    createdAt: plane.createdAt,
    updatedAt: plane.updatedAt,
  };
}
