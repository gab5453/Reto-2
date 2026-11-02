import {
  AIRCRAFT_MAX_ROUTE_KM,
  AIRPORTS,
  type Airport,
  type AircraftType,
  aircraftFor as aircraftForDistance,
  distanceKm,
  nextRegistration,
  TURNAROUND_MINUTES,
} from '@ecoairlines/shared';
import { addDays, localToUtcMs } from './dates.js';

export { AIRCRAFT_MAX_ROUTE_KM, nextRegistration, TURNAROUND_MINUTES };

/**
 * Horario semanal de EcoAirlines: vuelos **y aviones**, generado automáticamente. Copiado de `seed/timetable.ts` del
 * monolito (V2.4): los datos de los aviones vienen de `@ecoairlines/shared` y los errores llevan el código del contrato.
 *
 * Reglas (pedidos del supervisor, 06/10):
 * - **Todos con todos:** cada aeropuerto tiene vuelos directos a cada uno de los demás.
 * - **2 vuelos diarios por ruta y sentido:** uno en la franja de mañana (06:00–11:45) y otro en la de tarde/noche
 *   (13:00–21:30), en hora local del origen, con horas variadas y sin repetir hora en un mismo aeropuerto.
 * - **Horario semanal fijo, también de los aviones:** cada vuelo dice qué avión lo opera cada día de la semana. El martes
 *   siempre vuela el mismo avión en el mismo vuelo, y ese horario se repite las 13 semanas de la ventana de venta.
 * - **Ventana de venta de 91 días (13 semanas exactas):** se reserva desde hoy hasta hoy + 90. Cada día que pasa entra un
 *   día nuevo al final, con el horario de su día de la semana.
 * - **Avión según la distancia:** regional (A220), medio (A320neo) o largo alcance (787-9).
 *
 * El horario se arma a partir de **rutas programadas** (`RouteDefinition`): una línea de ida y vuelta con sus días y su tipo
 * de avión. `generateRoutes()` crea la red base (todos con todos) y el administrador puede crear, editar o dar de baja rutas;
 * cada cambio vuelve a pasar por `buildTimetable`, que asigna los aviones y comprueba que ninguno quede en dos lugares a la vez.
 * A mano también se puede usar `TimetableBuilder.addFlight({ número, origen, destino, día, hora, avión })`.
 */

/** 0 = domingo … 6 = sábado (igual que `Date.prototype.getUTCDay`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const ALL_WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = {
  0: 'Domingo',
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes',
  6: 'Sábado',
};

/** Días que se pueden reservar, contando hoy: 13 semanas exactas. */
export const SALES_WINDOW_DAYS = 91;


export interface FleetAircraft {
  /** Matrícula ficticia (prefijo HC- de Ecuador). */
  registration: string;
  aircraftType: AircraftType;
  /** Aeropuerto donde el avión empieza y termina su rotación semanal. */
  base: string;
}

export interface ScheduledFlight {
  flightNumber: string;
  origin: string;
  destination: string;
  /** Hora local de salida en el aeropuerto de origen (HH:MM). */
  departureLocal: string;
  aircraft: AircraftType;
  /** Días de la semana en que opera. */
  operatingDays: readonly Weekday[];
  /** Matrícula del avión que lo opera cada día de la semana (siempre el mismo, semana tras semana). */
  aircraftByDay: Readonly<Partial<Record<Weekday, string>>>;
}

/** Un vuelo de la semana tipo: qué ruta, qué día, a qué hora y con qué avión. */
export interface WeeklyFlightInput {
  flightNumber: string;
  origin: string;
  destination: string;
  weekday: Weekday;
  departureLocal: string;
  /** Matrícula de un avión agregado con `addAircraft`. */
  registration: string;
}

export interface Timetable {
  flights: ScheduledFlight[];
  fleet: FleetAircraft[];
  /** Matrículas asignadas a cada ruta programada (`routeId` → aviones), cuando el horario se arma con `buildTimetable`. */
  aircraftByRoute?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Ruta programada: una línea de ida y vuelta. La ida sale de `origin` los `weekdays` indicados y la vuelta regresa a `origin`
 * (la base de sus aviones) en cuanto el avión está listo. Los aviones se asignan solos: tantos como hagan falta para cubrir los días.
 */
export interface RouteDefinition {
  /** `<vuelo de ida>-<vuelo de vuelta>`, p. ej. `EA104-EA123`. */
  routeId: string;
  origin: string;
  destination: string;
  outbound: { flightNumber: string; departureLocal: string };
  inbound: { flightNumber: string; departureLocal: string };
  /** Días de la semana en que sale la ida. */
  weekdays: readonly Weekday[];
  aircraftType: AircraftType;
  /**
   * Aviones de la flota que operan la ruta, en orden. Si se omite, el horario agrega aviones nuevos (con base en el origen)
   * según hagan falta. Si se indican, deben ser de `aircraftType`, tener base en `origin` y alcanzar para los días elegidos.
   */
  aircraft?: readonly string[];
  /** Con `aircraft`: si no alcanzan, agrega aviones nuevos en vez de rechazar la ruta (al crear o editar sin elegir aviones). */
  autoAddAircraft?: boolean;
}

/** Códigos de un horario que no se puede operar (los del contrato de Schedule). */
export type TimetableIssueCode = 'INVALID_ROUTE' | 'AIRCRAFT_NOT_IN_FLEET' | 'AIRCRAFT_MISMATCH' | 'NOT_ENOUGH_AIRCRAFT' | 'TIMETABLE_CONFLICT';

export interface TimetableIssue {
  code: TimetableIssueCode;
  message: string;
  /** Con NOT_ENOUGH_AIRCRAFT: cuántos aviones faltan. */
  missing?: number;
}

/** Error de un horario que no se puede operar; `issues` explica cada conflicto con su código. */
export class TimetableError extends Error {
  readonly problems: string[];

  constructor(readonly issues: TimetableIssue[]) {
    super(`Horario inválido:\n- ${issues.slice(0, 10).map((issue) => issue.message).join('\n- ')}`);
    this.problems = issues.map((issue) => issue.message);
  }
}

const issue = (code: TimetableIssueCode, message: string, missing?: number): TimetableIssue => ({ code, message, ...(missing ? { missing } : {}) });

/** Lunes de referencia para calcular horas reales (sin horario de verano, todas las semanas son iguales). */
const ANCHOR_MONDAY = '2026-01-05';
const WEEK_MS = 7 * 86_400_000;
/** Día de la semana de un índice de día contado desde el lunes de referencia. */
const weekdayOfIndex = (dayIndex: number) => ((((dayIndex % 7) + 7) % 7) + 1) % 7 as Weekday;
/** Índice (0 = lunes … 6 = domingo) de un día de la semana. */
const indexOfWeekday = (weekday: Weekday) => (weekday + 6) % 7;

/** Duración del vuelo en minutos (distancia a ~800 km/h más 30 min de rodaje, redondeada a 5 min). */
export function flightDurationMinutes(origin: string, destination: string): number {
  const distance = distanceKm(AIRPORTS[origin]!, AIRPORTS[destination]!);
  return Math.round(((distance / 800) * 60 + 30) / 5) * 5;
}

/** Avión por distancia de la ruta: el más chico que la alcanza. */
export const aircraftFor = (distance: number): AircraftType => aircraftForDistance(distance);

/** Salida (ms UTC) de un vuelo en el día `dayIndex` contado desde el lunes de referencia. */
function departureUtc(flight: { origin: string; departureLocal: string }, dayIndex: number): number {
  return localToUtcMs(addDays(ANCHOR_MONDAY, dayIndex), flight.departureLocal, AIRPORTS[flight.origin]!.utcOffsetMinutes);
}

/** Momento en que el avión queda listo para volver a salir: llegada + tiempo en tierra. */
function readyUtc(flight: { origin: string; destination: string; departureLocal: string; aircraft: AircraftType }, dayIndex: number): number {
  return (
    departureUtc(flight, dayIndex) +
    (flightDurationMinutes(flight.origin, flight.destination) + TURNAROUND_MINUTES[flight.aircraft]) * 60_000
  );
}

/**
 * Arma el horario semanal vuelo por vuelo, cada uno con su avión. `build()` valida que cada avión encadene sus vuelos
 * (sale de donde aterrizó, después de su tiempo en tierra) y que su semana cierre donde empezó, para repetirse igual.
 */
export class TimetableBuilder {
  private readonly fleet = new Map<string, FleetAircraft>();
  private readonly perType = new Map<AircraftType, number>();
  private readonly flights = new Map<string, Omit<ScheduledFlight, 'operatingDays' | 'aircraftByDay'> & { aircraftByDay: Partial<Record<Weekday, string>> }>();

  /** Agrega un avión nuevo a la flota y devuelve su matrícula (la siguiente libre de su tipo, p. ej. HC-J27). */
  addAircraft(aircraftType: AircraftType, base: string): string {
    let sequence = this.perType.get(aircraftType) ?? 0;
    let registration: string;
    do {
      sequence++;
      registration = nextRegistration(aircraftType, sequence);
    } while (this.fleet.has(registration));
    this.perType.set(aircraftType, sequence);
    this.fleet.set(registration, { registration, aircraftType, base });
    return registration;
  }

  /** Incorpora un avión que ya existe en la flota (con su matrícula). Puede quedar sin vuelos: está disponible. */
  registerAircraft(aircraft: FleetAircraft): this {
    if (this.fleet.has(aircraft.registration)) throw new Error(`El avión ${aircraft.registration} está repetido en la flota.`);
    this.fleet.set(aircraft.registration, { ...aircraft });
    return this;
  }

  hasAircraft(registration: string): FleetAircraft | undefined {
    return this.fleet.get(registration);
  }

  /** Programa un vuelo un día de la semana con un avión concreto. */
  addFlight(input: WeeklyFlightInput): this {
    const aircraft = this.fleet.get(input.registration);
    if (!aircraft) throw new Error(`El avión ${input.registration} no está en la flota.`);
    if (!AIRPORTS[input.origin] || !AIRPORTS[input.destination] || input.origin === input.destination) {
      throw new Error(`Ruta inválida ${input.origin} → ${input.destination}.`);
    }
    const existing = this.flights.get(input.flightNumber);
    if (existing) {
      if (existing.origin !== input.origin || existing.destination !== input.destination || existing.departureLocal !== input.departureLocal) {
        throw new Error(`${input.flightNumber} ya existe con otra ruta u hora.`);
      }
      if (existing.aircraft !== aircraft.aircraftType) throw new Error(`${input.flightNumber} ya opera con ${existing.aircraft}.`);
      if (existing.aircraftByDay[input.weekday]) throw new Error(`${input.flightNumber} ya tiene avión el día ${WEEKDAY_NAMES[input.weekday]}.`);
      existing.aircraftByDay[input.weekday] = input.registration;
      return this;
    }
    this.flights.set(input.flightNumber, {
      flightNumber: input.flightNumber,
      origin: input.origin,
      destination: input.destination,
      departureLocal: input.departureLocal,
      aircraft: aircraft.aircraftType,
      aircraftByDay: { [input.weekday]: input.registration },
    });
    return this;
  }

  build(): Timetable {
    const flights: ScheduledFlight[] = [...this.flights.values()].map((flight) => ({
      ...flight,
      operatingDays: ALL_WEEKDAYS.filter((weekday) => flight.aircraftByDay[weekday]),
    }));
    const timetable = { flights, fleet: [...this.fleet.values()] };
    const problems = validateRotations(timetable);
    if (problems.length) throw new TimetableError(problems.map((message) => issue('TIMETABLE_CONFLICT', message)));
    return timetable;
  }
}

/**
 * Comprueba la semana de cada avión: cada vuelo sale del aeropuerto donde aterrizó el anterior y después de su tiempo en
 * tierra, y el último de la semana lo deja listo, en el mismo aeropuerto, antes del primero de la semana siguiente.
 * Devuelve la lista de problemas (vacía si el horario es válido).
 */
export function validateRotations(timetable: Timetable): string[] {
  const problems: string[] = [];
  for (const plane of timetable.fleet) {
    const legs = timetable.flights
      .flatMap((flight) =>
        flight.operatingDays
          .filter((weekday) => flight.aircraftByDay[weekday] === plane.registration)
          .map((weekday) => ({ flight, dayIndex: indexOfWeekday(weekday) })),
      )
      .map(({ flight, dayIndex }) => ({ flight, departure: departureUtc(flight, dayIndex), ready: readyUtc(flight, dayIndex) }))
      .sort((a, b) => a.departure - b.departure);
    if (legs.length === 0) continue; // disponible: sin vuelos asignados
    legs.forEach((leg, index) => {
      const next = legs[(index + 1) % legs.length]!;
      const nextDeparture = next.departure + (index === legs.length - 1 ? WEEK_MS : 0);
      if (next.flight.origin !== leg.flight.destination) {
        problems.push(`${plane.registration}: ${leg.flight.flightNumber} llega a ${leg.flight.destination} y ${next.flight.flightNumber} sale de ${next.flight.origin}.`);
      }
      if (nextDeparture < leg.ready) {
        problems.push(`${plane.registration}: ${next.flight.flightNumber} sale antes de que termine ${leg.flight.flightNumber}.`);
      }
    });
  }
  return problems;
}

export interface TimetableRules {
  /**
   * Una franja por vuelo diario de cada ruta, con sus horas locales posibles. Cada franja debe tener al menos tantas horas
   * como destinos por aeropuerto (9), para que un aeropuerto no repita hora dentro de la franja.
   */
  bands: readonly [readonly string[], readonly string[]];
}

export const DEFAULT_TIMETABLE_RULES: TimetableRules = {
  bands: [
    ['06:00', '06:45', '07:30', '08:15', '09:00', '09:45', '10:30', '11:00', '11:45'],
    ['13:00', '13:45', '14:30', '15:15', '16:00', '17:00', '18:00', '19:30', '20:30', '21:30'],
  ],
};

interface RouteSlot {
  flightNumber: string;
  origin: string;
  destination: string;
  departureLocal: string;
  aircraft: AircraftType;
}

/**
 * Genera la red base de rutas programadas (el bucle "todos con todos").
 *
 * 1. **Vuelos:** para cada origen y cada destino, uno por franja. La hora rota con el origen, así cada aeropuerto reparte sus
 *    salidas por toda la franja. Números deterministas: `EA` + (100 + 20 × origen + 2 × destino + franja), p. ej. Quito →
 *    Bogotá: EA104 (mañana) y EA105 (tarde); con 10 aeropuertos van de EA100 a EA297.
 * 2. **Rutas:** cada par de ciudades A–B tiene dos líneas de ida y vuelta: "A→B de mañana + B→A de tarde" (base A) y
 *    "B→A de mañana + A→B de tarde" (base B), los 7 días, con el avión que corresponde a la distancia. En rutas cortas un
 *    avión hace la ida y la vuelta el mismo día; en las largas la vuelta es al día siguiente y se suman aviones.
 */
export function generateRoutes(
  airports: readonly Airport[] = Object.values(AIRPORTS),
  rules: TimetableRules = DEFAULT_TIMETABLE_RULES,
): RouteDefinition[] {
  const slots = new Map<string, RouteSlot>();
  const slotKey = (origin: string, destination: string, band: number) => `${origin}-${destination}-${band}`;
  airports.forEach((origin, originIndex) => {
    airports
      .filter((destination) => destination.code !== origin.code)
      .forEach((destination, slot) => {
        rules.bands.forEach((times, band) => {
          slots.set(slotKey(origin.code, destination.code, band), {
            flightNumber: `EA${100 + originIndex * 20 + slot * rules.bands.length + band}`,
            origin: origin.code,
            destination: destination.code,
            departureLocal: times[(slot + originIndex * (band + 1)) % times.length]!,
            aircraft: aircraftFor(distanceKm(origin, destination)),
          });
        });
      });
  });

  const routes: RouteDefinition[] = [];
  airports.forEach((a, i) => {
    airports.slice(i + 1).forEach((b) => {
      for (const [base, other] of [[a.code, b.code], [b.code, a.code]] as const) {
        const outbound = slots.get(slotKey(base, other, 0))!;
        const inbound = slots.get(slotKey(other, base, 1))!;
        routes.push({
          routeId: `${outbound.flightNumber}-${inbound.flightNumber}`,
          origin: base,
          destination: other,
          outbound: { flightNumber: outbound.flightNumber, departureLocal: outbound.departureLocal },
          inbound: { flightNumber: inbound.flightNumber, departureLocal: inbound.departureLocal },
          weekdays: ALL_WEEKDAYS,
          aircraftType: outbound.aircraft,
        });
      }
    });
  });
  return routes;
}

/**
 * Arma el horario semanal (vuelos y aviones) a partir de las rutas programadas. Lanza `TimetableError` si una ruta es
 * inválida o si algún avión quedaría en dos lugares a la vez.
 */
export function buildTimetable(routes: readonly RouteDefinition[], fleet: readonly FleetAircraft[] = []): Timetable {
  const problems: TimetableIssue[] = [];
  const numbers = new Map<string, string>();
  for (const route of routes) {
    if (!AIRPORTS[route.origin] || !AIRPORTS[route.destination] || route.origin === route.destination) {
      problems.push(issue('INVALID_ROUTE', `${route.routeId}: ruta inválida ${route.origin} → ${route.destination}.`));
    }
    if (route.weekdays.length === 0) problems.push(issue('INVALID_ROUTE', `${route.routeId}: no tiene días de operación.`));
    for (const { flightNumber } of [route.outbound, route.inbound]) {
      const owner = numbers.get(flightNumber);
      if (owner) problems.push(issue('INVALID_ROUTE', `El vuelo ${flightNumber} está en las rutas ${owner} y ${route.routeId}.`));
      numbers.set(flightNumber, route.routeId);
    }
  }
  if (problems.length) throw new TimetableError(problems);

  const builder = new TimetableBuilder();
  for (const aircraft of fleet) builder.registerAircraft(aircraft);
  const aircraftByRoute: Record<string, string[]> = {};
  for (const route of routes) {
    const outbound: RouteSlot = { ...route.outbound, origin: route.origin, destination: route.destination, aircraft: route.aircraftType };
    const inbound: RouteSlot = { ...route.inbound, origin: route.destination, destination: route.origin, aircraft: route.aircraftType };
    const plan = planRoundTrips(outbound, inbound, route.weekdays);
    if (route.aircraft) {
      for (const registration of route.aircraft) {
        const plane = builder.hasAircraft(registration);
        if (!plane) problems.push(issue('AIRCRAFT_NOT_IN_FLEET', `${route.routeId}: el avión ${registration} no está en la flota.`));
        else if (plane.aircraftType !== route.aircraftType) problems.push(issue('AIRCRAFT_MISMATCH', `${route.routeId}: ${registration} es un ${plane.aircraftType} y la ruta usa ${route.aircraftType}.`));
        else if (plane.base !== route.origin) problems.push(issue('AIRCRAFT_MISMATCH', `${route.routeId}: ${registration} tiene base en ${plane.base} y la ruta sale de ${route.origin}.`));
      }
      if (!route.autoAddAircraft && plan.groups.length > route.aircraft.length) {
        problems.push(
          issue(
            'NOT_ENOUGH_AIRCRAFT',
            `${route.routeId}: necesita ${plan.groups.length} avión(es) para cubrir los días elegidos y tiene ${route.aircraft.length}.`,
            plan.groups.length - route.aircraft.length,
          ),
        );
      }
      if (problems.length) continue;
    }
    aircraftByRoute[route.routeId] = assignRoundTrips(builder, outbound, inbound, plan, route.aircraft);
  }
  if (problems.length) throw new TimetableError(problems);
  return { ...builder.build(), aircraftByRoute };
}

/** Horario completo de la red base. */
export function generateTimetable(
  airports: readonly Airport[] = Object.values(AIRPORTS),
  rules: TimetableRules = DEFAULT_TIMETABLE_RULES,
): Timetable {
  return buildTimetable(generateRoutes(airports, rules));
}

interface RoundTripPlan {
  /** Días entre la ida y la vuelta. */
  returnDelay: number;
  /** Días de la ida (0 = lunes … 6 = domingo) que cubre cada avión. */
  groups: number[][];
}

/**
 * Reparte los días de una línea de ida y vuelta entre aviones de horario semanal fijo. `returnDelay` = días entre la ida y
 * la vuelta; `cycle` = días hasta que el mismo avión puede repetir la ida. Cada avión toma días separados por `cycle` mientras
 * su última vuelta lo deje listo antes de su primera ida de la semana siguiente. `groups.length` = aviones necesarios.
 */
function planRoundTrips(outbound: RouteSlot, inbound: RouteSlot, weekdays: readonly Weekday[]): RoundTripPlan {
  let returnDelay = 0;
  while (departureUtc(inbound, returnDelay) < readyUtc(outbound, 0)) returnDelay++;
  let cycle = 1;
  while (departureUtc(outbound, cycle) < readyUtc(inbound, returnDelay)) cycle++;

  const groups: number[][] = [];
  const pending = new Set(weekdays.map(indexOfWeekday));
  while (pending.size > 0) {
    const first = Math.min(...pending);
    const days = [first];
    for (let day = first + cycle; day <= 6; day += cycle) {
      if (!pending.has(day)) continue;
      // La vuelta de ese día debe dejar al avión listo para su primera ida de la semana siguiente.
      if (readyUtc(inbound, day + returnDelay) > departureUtc(outbound, first + 7)) break;
      days.push(day);
    }
    days.forEach((day) => pending.delete(day));
    groups.push(days);
  }
  return { returnDelay, groups };
}

/** Programa los vuelos del plan: cada grupo de días con un avión de `pool` (en orden) o con uno nuevo si no hay pool. */
function assignRoundTrips(
  builder: TimetableBuilder,
  outbound: RouteSlot,
  inbound: RouteSlot,
  plan: RoundTripPlan,
  pool?: readonly string[],
): string[] {
  return plan.groups.map((days, index) => {
    const registration = pool?.[index] ?? builder.addAircraft(outbound.aircraft, outbound.origin);
    for (const day of days) {
      builder.addFlight({ ...outbound, weekday: weekdayOfIndex(day), registration });
      builder.addFlight({ ...inbound, weekday: weekdayOfIndex(day + plan.returnDelay), registration });
    }
    return registration;
  });
}

/** Red base de rutas programadas y su horario: el punto de partida del GDS al arrancar. */
export const DEFAULT_ROUTES: readonly RouteDefinition[] = generateRoutes();
export const DEFAULT_TIMETABLE: Timetable = buildTimetable(DEFAULT_ROUTES);
/** Flota base (149 aviones) y rutas base con sus aviones fijos: el estado inicial que guarda el dominio admin. */
export const DEFAULT_FLEET: readonly FleetAircraft[] = DEFAULT_TIMETABLE.fleet;
export const DEFAULT_ROUTES_WITH_AIRCRAFT: readonly RouteDefinition[] = DEFAULT_ROUTES.map((route) => ({
  ...route,
  aircraft: DEFAULT_TIMETABLE.aircraftByRoute![route.routeId]!,
}));

/** Día de la semana de una fecha `YYYY-MM-DD`. */
export function weekdayOf(localDate: string): Weekday {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() as Weekday;
}

export function operatesOn(flight: ScheduledFlight, localDate: string): boolean {
  return flight.operatingDays.includes(weekdayOf(localDate));
}

/** Vuelo programado con ese número que opera esa fecha. */
export function findScheduledFlight(timetable: Timetable, flightNumber: string, localDate: string): ScheduledFlight | undefined {
  return timetable.flights.find((flight) => flight.flightNumber === flightNumber && operatesOn(flight, localDate));
}

/** Vuelos que salen en una fecha local (la del aeropuerto de origen). */
export function flightsOperatingOn(timetable: Timetable, localDate: string): ScheduledFlight[] {
  return timetable.flights.filter((flight) => operatesOn(flight, localDate));
}

/** Avión que opera un vuelo en una fecha (el mismo todas las semanas ese día). */
export function aircraftOn(timetable: Timetable, flightNumber: string, localDate: string): string | undefined {
  return findScheduledFlight(timetable, flightNumber, localDate)?.aircraftByDay[weekdayOf(localDate)];
}

/** Primer y último día reservable desde una fecha local "hoy". */
export function salesWindow(today: string): { from: string; to: string } {
  return { from: today, to: addDays(today, SALES_WINDOW_DAYS - 1) };
}
