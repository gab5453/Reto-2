import { AIRCRAFT_LAYOUTS, AIRCRAFT_TYPES, AIRPORTS, type AircraftType, distanceKm, ProblemDetailsException, reaches } from '@ecoairlines/shared';
import type { AircraftRecord, CabinClass, PromotionTerms, RouteRecord, WeekdayCode } from './model.js';
import { WEEKDAY_CODES } from './model.js';
import { aircraftFor, flightDurationMinutes, TimetableError, type TimetableIssueCode, type Weekday } from './timetable.js';

/**
 * Reglas de Schedule (de `AdminRoutesService` y `AdminFleetService` del monolito, con los códigos del contrato). Funciones
 * puras: se prueban sin base de datos.
 */

/** Las rutas del administrador usan números desde EA300 (la red base va de EA100 a EA297). */
const FIRST_ADMIN_FLIGHT_NUMBER = 300;
const LAST_FLIGHT_NUMBER = 999;
export const MIN_MULTIPLIER = 0.5;
export const MAX_MULTIPLIER = 10;
/** D35: el contrato v2 admite hasta 100 %, pero la aerolínea fija el máximo en 50 % (hallazgo BKG-12). */
export const MAX_PROMOTION_DISCOUNT = 50;

export interface RouteRequest {
  origin: string;
  destination: string;
  outboundDepartureLocal: string;
  inboundDepartureLocal: string;
  weekdays: WeekdayCode[];
  aircraftType?: AircraftType;
  aircraft?: string[];
}

const problem = (status: number, code: string, title: string, extra: { detail?: string; invalidParams?: { name: string; reason: string }[] } = {}) =>
  new ProblemDetailsException({ status, code, title, ...extra });

export function assertAirport(code: string, field: string): void {
  if (!AIRPORTS[code]) {
    throw problem(422, 'UNKNOWN_AIRPORT', 'EcoAirlines no opera en ese aeropuerto.', {
      invalidParams: [{ name: field, reason: `debe ser uno de ${Object.keys(AIRPORTS).join(', ')}` }],
    });
  }
}

/** El tipo existe en el catálogo (M-2). */
export function assertAircraftType(name: string, field: string): void {
  if (!AIRCRAFT_LAYOUTS[name]) {
    throw problem(422, 'UNKNOWN_AIRCRAFT_TYPE', `No existe el tipo de avión «${name}».`, { invalidParams: [{ name: field, reason: `debe ser uno de ${AIRCRAFT_TYPES.join(', ')}` }] });
  }
}

/** Una ruta nueva (o que cambia de aeropuerto) solo usa aeropuertos activos (M-1). */
export function assertActiveAirport(code: string, field: string): void {
  assertAirport(code, field);
  if (AIRPORTS[code]!.active === false) {
    throw problem(422, 'AIRPORT_INACTIVE', `El aeropuerto ${code} está desactivado.`, {
      detail: 'Un aeropuerto desactivado no se ofrece para rutas nuevas; actívalo en «Aeropuertos» si quieres volver a usarlo.',
      invalidParams: [{ name: field, reason: `${code} está desactivado` }],
    });
  }
}

/** Tipo de avión de la ruta: el pedido o, si se eligieron aviones, el del primero. */
export function routeAircraftType(request: RouteRequest, fleet: AircraftRecord[]): AircraftType | undefined {
  if (request.aircraftType) return request.aircraftType;
  const first = request.aircraft?.[0];
  if (!first) return undefined;
  const plane = fleet.find((candidate) => candidate.registration === first);
  if (!plane) {
    throw problem(422, 'AIRCRAFT_NOT_IN_FLEET', `El avión ${first} no está en la flota.`, { invalidParams: [{ name: 'aircraft', reason: `matrícula desconocida ${first}` }] });
  }
  return plane.aircraftType;
}

/** Valida aeropuertos y alcance, y convierte el pedido en la definición que entiende el horario. */
export function toRouteDefinition(request: RouteRequest, outbound: string, inbound: string, chosenType?: AircraftType) {
  assertAirport(request.origin, 'origin');
  assertAirport(request.destination, 'destination');
  if (request.origin === request.destination) {
    throw problem(422, 'VALIDATION_FAILED', 'El origen y el destino deben ser distintos.', { invalidParams: [{ name: 'destination', reason: 'debe ser distinto del origen' }] });
  }
  const distance = distanceKm(AIRPORTS[request.origin]!, AIRPORTS[request.destination]!);
  const required = aircraftFor(distance);
  const aircraftType = chosenType ?? required;
  assertAircraftType(aircraftType, 'aircraftType');
  if (!reaches(aircraftType, distance)) {
    throw problem(422, 'AIRCRAFT_RANGE_EXCEEDED', `El ${aircraftType} no tiene alcance para ${distance} km: use ${required} o uno mayor.`, {
      invalidParams: [{ name: 'aircraftType', reason: `mínimo ${required}` }],
    });
  }
  return {
    routeId: `${outbound}-${inbound}`,
    origin: request.origin,
    destination: request.destination,
    outbound: { flightNumber: outbound, departureLocal: request.outboundDepartureLocal },
    inbound: { flightNumber: inbound, departureLocal: request.inboundDepartureLocal },
    weekdays: [...new Set(request.weekdays.map((code) => WEEKDAY_CODES.indexOf(code) as Weekday))].sort((a, b) => a - b),
    aircraftType,
  };
}

type RouteLike = Pick<RouteRecord, 'routeId' | 'origin' | 'destination' | 'outbound' | 'inbound'>;

/** Dos vuelos de la misma ruta y sentido a la misma hora serían el mismo vuelo duplicado (409 ROUTE_ALREADY_EXISTS). */
export function assertNotDuplicated(route: RouteLike, all: RouteLike[]): void {
  const legs = (candidate: RouteLike) => [
    { flightNumber: candidate.outbound.flightNumber, from: candidate.origin, to: candidate.destination, at: candidate.outbound.departureLocal },
    { flightNumber: candidate.inbound.flightNumber, from: candidate.destination, to: candidate.origin, at: candidate.inbound.departureLocal },
  ];
  for (const other of all.filter((candidate) => candidate.routeId !== route.routeId)) {
    for (const mine of legs(route)) {
      const clash = legs(other).find((leg) => leg.from === mine.from && leg.to === mine.to && leg.at === mine.at);
      if (clash) {
        throw problem(409, 'ROUTE_ALREADY_EXISTS', `Ya existe el vuelo ${clash.flightNumber} ${mine.from} → ${mine.to} a las ${mine.at} (ruta ${other.routeId}).`, {
          invalidParams: [{ name: 'route', reason: `duplica ${clash.flightNumber}` }],
        });
      }
    }
  }
}

/** Los dos primeros números de vuelo libres desde EA300. */
export function nextFlightNumbers(routes: RouteLike[]): [string, string] {
  const used = new Set(routes.flatMap((route) => [route.outbound.flightNumber, route.inbound.flightNumber]));
  const free: string[] = [];
  for (let number = FIRST_ADMIN_FLIGHT_NUMBER; number <= LAST_FLIGHT_NUMBER && free.length < 2; number++) {
    if (!used.has(`EA${number}`)) free.push(`EA${number}`);
  }
  if (free.length < 2) throw problem(422, 'VALIDATION_FAILED', 'No quedan números de vuelo disponibles (EA300–EA999).');
  return [free[0]!, free[1]!];
}

/** `restoreRouteId` (compensación de la saga): sus números de vuelo deben estar libres. */
export function restoredFlightNumbers(routeId: string, routes: RouteLike[]): [string, string] {
  const [outbound, inbound] = routeId.split('-') as [string, string];
  const used = new Set(routes.flatMap((route) => [route.outbound.flightNumber, route.inbound.flightNumber]));
  if (outbound === inbound || used.has(outbound) || used.has(inbound)) {
    throw problem(409, 'ROUTE_ALREADY_EXISTS', `La ruta ${routeId} no se puede restaurar: sus números de vuelo están en uso.`);
  }
  return [outbound, inbound];
}

/** Una ruta con cupos vendidos o retenidos de hoy en adelante (según Offers) no se edita ni se da de baja. */
export function assertWithoutSoldSeats(routeId: string, soldSeats: number): void {
  if (soldSeats > 0) {
    throw problem(409, 'ROUTE_HAS_SOLD_SEATS', 'La ruta tiene cupos vendidos y no se puede cambiar.', {
      detail: `${soldSeats} cupos vendidos o retenidos desde hoy en la ruta ${routeId}. Para un vuelo con pasajeros use su estado operativo (por ejemplo CANCELLED).`,
    });
  }
}

const ISSUE_TITLES: Record<TimetableIssueCode, [string, string]> = {
  NOT_ENOUGH_AIRCRAFT: ['NOT_ENOUGH_AIRCRAFT', 'Faltan aviones del tipo y la base de la ruta para los días elegidos.'],
  AIRCRAFT_NOT_IN_FLEET: ['AIRCRAFT_NOT_IN_FLEET', 'Un avión elegido no está en la flota.'],
  AIRCRAFT_MISMATCH: ['AIRCRAFT_MISMATCH', 'Un avión elegido es de otro tipo o tiene otra base.'],
  TIMETABLE_CONFLICT: ['TIMETABLE_CONFLICT', 'Con esos aviones, alguno quedaría en dos lugares a la vez.'],
  INVALID_ROUTE: ['VALIDATION_FAILED', 'La ruta no es válida.'],
};

/** Convierte un horario imposible en un 422 con el código del primer problema y la lista completa en `invalidParams`. */
export function timetableProblem(error: TimetableError): ProblemDetailsException {
  const first = error.issues[0]!;
  const [code, title] = ISSUE_TITLES[first.code];
  return problem(422, code, title, {
    detail: first.code === 'NOT_ENOUGH_AIRCRAFT' ? `Faltan ${first.missing} avión(es). ${first.message}` : first.message,
    invalidParams: error.issues.slice(0, 10).map((issue) => ({ name: 'route', reason: issue.message })),
  });
}

/** Tramo con su hora de llegada local (la de su destino) y los días de diferencia. */
export function routeLeg(flightNumber: string, origin: string, destination: string, departureLocal: string) {
  const durationMinutes = flightDurationMinutes(origin, destination);
  const [hours, minutes] = departureLocal.split(':').map(Number) as [number, number];
  const arrival = hours * 60 + minutes + durationMinutes + AIRPORTS[destination]!.utcOffsetMinutes - AIRPORTS[origin]!.utcOffsetMinutes;
  const inDay = ((arrival % 1440) + 1440) % 1440;
  return {
    flightNumber,
    origin,
    destination,
    departureLocal,
    arrivalLocal: `${String(Math.floor(inDay / 60)).padStart(2, '0')}:${String(inDay % 60).padStart(2, '0')}`,
    arrivalDayOffset: Math.floor(arrival / 1440),
  };
}

/** Multiplicador entre 0,5 y 10 (422 MULTIPLIER_OUT_OF_RANGE). */
export function assertMultipliers(items: { cabinClass: string; fareBrand: string; multiplier: number }[]): void {
  const out = items.filter((item) => !(item.multiplier >= MIN_MULTIPLIER && item.multiplier <= MAX_MULTIPLIER));
  if (out.length) {
    throw problem(422, 'MULTIPLIER_OUT_OF_RANGE', 'El multiplicador debe estar entre 0,5 y 10.', {
      invalidParams: out.map((item) => ({ name: `${item.cabinClass}/${item.fareBrand}`, reason: `${item.multiplier} fuera de 0,5–10` })),
    });
  }
}

/**
 * Acuerdo de promociones (D35): descuento 0–50 %; las rutas habilitadas deben operarse (en cualquier sentido de una ruta);
 * las cabinas deben existir en la flota; la vigencia no puede haber pasado.
 */
export function assertPromotionTerms(terms: PromotionTerms, context: { routes: RouteLike[]; cabins: Set<CabinClass>; today: string }): void {
  const discount = terms.porcentaje_descuento_maximo;
  if (!(discount >= 0 && discount <= MAX_PROMOTION_DISCOUNT)) {
    throw problem(422, 'PROMOTION_DISCOUNT_OUT_OF_RANGE', `El descuento máximo debe estar entre 0 y ${MAX_PROMOTION_DISCOUNT} %.`, {
      invalidParams: [{ name: 'porcentaje_descuento_maximo', reason: `${discount} fuera de 0–${MAX_PROMOTION_DISCOUNT}` }],
    });
  }
  const operated = new Set(context.routes.flatMap((route) => [`${route.origin}-${route.destination}`, `${route.destination}-${route.origin}`]));
  const invalid = [
    ...(terms.rutas_habilitadas ?? []).filter((pair) => !operated.has(pair)).map((pair) => ({ name: 'rutas_habilitadas', reason: `${pair} no se opera` })),
    ...(terms.cabinas_habilitadas ?? []).filter((cabin) => !context.cabins.has(cabin)).map((cabin) => ({ name: 'cabinas_habilitadas', reason: `la flota no tiene cabina ${cabin}` })),
    ...(terms.vigencia_hasta && terms.vigencia_hasta < context.today ? [{ name: 'vigencia_hasta', reason: `${terms.vigencia_hasta} ya pasó` }] : []),
  ];
  if (invalid.length) throw problem(422, 'VALIDATION_FAILED', 'El acuerdo de promociones no es válido.', { invalidParams: invalid });
}
