import { registerAirports, removeAirport, type ProblemDetailsException } from '@ecoairlines/shared';
import { addDays, formatLocalIso, localDateOf, localToUtcMs } from './dates.js';
import type { AircraftRecord } from './model.js';
import {
  assertActiveAirport,
  assertAircraftType,
  assertAirport,
  assertMultipliers,
  assertNotDuplicated,
  assertPromotionTerms,
  assertWithoutSoldSeats,
  MAX_PROMOTION_DISCOUNT,
  nextFlightNumbers,
  restoredFlightNumbers,
  routeAircraftType,
  routeLeg,
  timetableProblem,
  toRouteDefinition,
  type RouteRequest,
} from './rules.js';
import {
  aircraftFor,
  aircraftOn,
  findScheduledFlight,
  flightDurationMinutes,
  flightsOperatingOn,
  operatesOn,
  routeReturn,
  SALES_WINDOW_DAYS,
  salesWindow,
  TimetableError,
  weekdayOf,
  type ScheduledFlight,
  type Timetable,
} from './timetable.js';

/**
 * PU-1 (Informacion_General/Pruebas.md §5.1.1): reglas puras de MS.G.Schedule — rutas, números de vuelo, precios, promociones,
 * fechas y consultas del horario. El motor que arma el horario completo ya tiene su prueba en `test/timetable.spec.ts`.
 * Distancias usadas: UIO–GYE 282 km, UIO–MAD 8 737 km.
 */

const problemOf = (fn: () => unknown): ProblemDetailsException['problem'] | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem;
  }
};
const codeOf = (fn: () => unknown) => problemOf(fn)?.code;

type RouteLike = Parameters<typeof assertNotDuplicated>[0];
const ruta = (routeId: string, origin: string, destination: string, out: [string, string], back: [string, string]): RouteLike => ({
  routeId,
  origin,
  destination,
  outbound: { flightNumber: out[0], departureLocal: out[1] },
  inbound: { flightNumber: back[0], departureLocal: back[1] },
});
const pedido = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  origin: 'UIO',
  destination: 'GYE',
  outboundDepartureLocal: '08:00',
  inboundDepartureLocal: '10:00',
  weekdays: ['MON'],
  ...over,
});

describe('aeropuertos y tipos de avión', () => {
  it('un aeropuerto del catálogo pasa', () => expect(codeOf(() => assertAirport('UIO', 'origin'))).toBeUndefined());
  it('un aeropuerto desconocido → UNKNOWN_AIRPORT con el campo', () => {
    const problem = problemOf(() => assertAirport('XYZ', 'destination'));
    expect(problem?.code).toBe('UNKNOWN_AIRPORT');
    expect(problem?.invalidParams?.[0]?.name).toBe('destination');
  });
  it('un tipo de avión desconocido → UNKNOWN_AIRCRAFT_TYPE', () => expect(codeOf(() => assertAircraftType('Concorde', 'aircraftType'))).toBe('UNKNOWN_AIRCRAFT_TYPE'));
  it('un tipo del catálogo pasa', () => expect(codeOf(() => assertAircraftType('Boeing 787-9', 'aircraftType'))).toBeUndefined());

  describe('aeropuerto desactivado (M-1)', () => {
    beforeAll(() =>
      registerAirports([{ code: 'ZZA', city: 'Prueba', name: 'Aeropuerto de prueba', country: 'EC', lat: -1, lon: -78, utcOffsetMinutes: -300, active: false }]),
    );
    afterAll(() => removeAirport('ZZA'));
    it('no se usa en rutas nuevas → AIRPORT_INACTIVE', () => expect(codeOf(() => assertActiveAirport('ZZA', 'origin'))).toBe('AIRPORT_INACTIVE'));
    it('pero sigue existiendo para las rutas que ya lo usan', () => expect(codeOf(() => assertAirport('ZZA', 'origin'))).toBeUndefined());
    it('un aeropuerto activo pasa', () => expect(codeOf(() => assertActiveAirport('GYE', 'origin'))).toBeUndefined());
  });
});

describe('tipo de avión de la ruta', () => {
  const flota = [{ registration: 'HC-N01', aircraftType: 'Airbus A320neo', base: 'UIO' }] as AircraftRecord[];
  it('el tipo pedido manda', () => expect(routeAircraftType(pedido({ aircraftType: 'Boeing 787-9', aircraft: ['HC-N01'] }), flota)).toBe('Boeing 787-9'));
  it('sin tipo, el del primer avión elegido', () => expect(routeAircraftType(pedido({ aircraft: ['HC-N01'] }), flota)).toBe('Airbus A320neo'));
  it('sin tipo ni aviones: lo decide la distancia (undefined)', () => expect(routeAircraftType(pedido(), flota)).toBeUndefined());
  it('un avión que no está en la flota → AIRCRAFT_NOT_IN_FLEET', () => expect(codeOf(() => routeAircraftType(pedido({ aircraft: ['HC-X99'] }), flota))).toBe('AIRCRAFT_NOT_IN_FLEET'));

  it('aircraftFor: el más chico que alcanza (alcance estrictamente menor)', () => {
    expect(aircraftFor(282)).toBe('Airbus A220-300');
    expect(aircraftFor(1_499)).toBe('Airbus A220-300');
    expect(aircraftFor(1_500)).toBe('Airbus A320neo');
    expect(aircraftFor(4_500)).toBe('Boeing 787-9');
    expect(aircraftFor(8_737)).toBe('Boeing 787-9');
  });
});

describe('toRouteDefinition', () => {
  it('convierte el pedido: id, vuelos, tipo por distancia y días ordenados sin repetir', () =>
    expect(toRouteDefinition(pedido({ weekdays: ['FRI', 'MON', 'MON', 'SUN'] }), 'EA300', 'EA301')).toEqual({
      routeId: 'EA300-EA301',
      origin: 'UIO',
      destination: 'GYE',
      outbound: { flightNumber: 'EA300', departureLocal: '08:00' },
      inbound: { flightNumber: 'EA301', departureLocal: '10:00' },
      weekdays: [0, 1, 5],
      aircraftType: 'Airbus A220-300',
    }));
  it('un tipo más grande que el necesario se acepta', () => expect(toRouteDefinition(pedido(), 'EA300', 'EA301', 'Boeing 787-9').aircraftType).toBe('Boeing 787-9'));
  it('origen igual al destino', () => expect(codeOf(() => toRouteDefinition(pedido({ destination: 'UIO' }), 'EA300', 'EA301'))).toBe('VALIDATION_FAILED'));
  it('un A220 no llega a Madrid → AIRCRAFT_RANGE_EXCEEDED', () =>
    expect(codeOf(() => toRouteDefinition(pedido({ destination: 'MAD' }), 'EA300', 'EA301', 'Airbus A220-300'))).toBe('AIRCRAFT_RANGE_EXCEEDED'));
  it('un aeropuerto desconocido', () => expect(codeOf(() => toRouteDefinition(pedido({ origin: 'XXX' }), 'EA300', 'EA301'))).toBe('UNKNOWN_AIRPORT'));
});

describe('rutas duplicadas y números de vuelo', () => {
  const existente = ruta('EA100-EA101', 'UIO', 'GYE', ['EA100', '08:00'], ['EA101', '10:00']);

  it('la misma ida a la misma hora → ROUTE_ALREADY_EXISTS', () =>
    expect(codeOf(() => assertNotDuplicated(ruta('EA300-EA301', 'UIO', 'GYE', ['EA300', '08:00'], ['EA301', '18:00']), [existente]))).toBe('ROUTE_ALREADY_EXISTS'));
  it('la misma vuelta a la misma hora, aunque la ruta esté escrita al revés', () =>
    expect(codeOf(() => assertNotDuplicated(ruta('EA300-EA301', 'GYE', 'UIO', ['EA300', '10:00'], ['EA301', '20:00']), [existente]))).toBe('ROUTE_ALREADY_EXISTS'));
  it('la misma hora en otro sentido no es duplicado', () =>
    expect(codeOf(() => assertNotDuplicated(ruta('EA300-EA301', 'GYE', 'UIO', ['EA300', '08:00'], ['EA301', '18:00']), [existente]))).toBeUndefined());
  it('una ruta no choca consigo misma (al editarla)', () => expect(codeOf(() => assertNotDuplicated(existente, [existente]))).toBeUndefined());

  it('nextFlightNumbers: los dos primeros libres desde EA300', () => expect(nextFlightNumbers([existente])).toEqual(['EA300', 'EA301']));
  it('nextFlightNumbers: rellena los huecos', () =>
    expect(nextFlightNumbers([ruta('a', 'UIO', 'GYE', ['EA300', '08:00'], ['EA302', '10:00'])])).toEqual(['EA301', 'EA303']));
  it('nextFlightNumbers: sin números libres hasta EA999', () => {
    const todas = Array.from({ length: 350 }, (_, i) => ruta(`r${i}`, 'UIO', 'GYE', [`EA${300 + 2 * i}`, '08:00'], [`EA${301 + 2 * i}`, '10:00']));
    expect(codeOf(() => nextFlightNumbers(todas))).toBe('VALIDATION_FAILED');
  });
  it('restoredFlightNumbers: devuelve los números de la ruta borrada', () => expect(restoredFlightNumbers('EA400-EA401', [existente])).toEqual(['EA400', 'EA401']));
  it('restoredFlightNumbers: si alguien tomó un número ya no se restaura', () =>
    expect(codeOf(() => restoredFlightNumbers('EA100-EA401', [existente]))).toBe('ROUTE_ALREADY_EXISTS'));
  it('restoredFlightNumbers: el mismo número en ida y vuelta no es válido', () => expect(codeOf(() => restoredFlightNumbers('EA400-EA400', []))).toBe('ROUTE_ALREADY_EXISTS'));
});

describe('asientos vendidos y horario imposible', () => {
  it('una ruta sin cupos vendidos se puede cambiar', () => expect(codeOf(() => assertWithoutSoldSeats('EA100-EA101', 0))).toBeUndefined());
  it('una ruta con un solo cupo vendido no → ROUTE_HAS_SOLD_SEATS', () => {
    const problem = problemOf(() => assertWithoutSoldSeats('EA100-EA101', 1));
    expect(problem).toMatchObject({ status: 409, code: 'ROUTE_HAS_SOLD_SEATS' });
    expect(problem?.detail).toContain('1 cupos');
  });
  it('timetableProblem: NOT_ENOUGH_AIRCRAFT dice cuántos faltan', () => {
    const problem = timetableProblem(new TimetableError([{ code: 'NOT_ENOUGH_AIRCRAFT', message: 'UIO–GYE los lunes', missing: 2 }]))
      .problem;
    expect(problem).toMatchObject({ status: 422, code: 'NOT_ENOUGH_AIRCRAFT', detail: 'Faltan 2 avión(es). UIO–GYE los lunes' });
  });
  it('timetableProblem: INVALID_ROUTE sale como VALIDATION_FAILED, con todos los problemas (máximo 10)', () => {
    const issues = Array.from({ length: 12 }, (_, i) => ({ code: 'INVALID_ROUTE' as const, message: `problema ${i}` }));
    const problem = timetableProblem(new TimetableError(issues)).problem;
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.invalidParams).toHaveLength(10);
  });
});

describe('routeLeg: hora de llegada local', () => {
  it('UIO → GYE 08:00 llega 08:50 el mismo día (50 min de vuelo)', () =>
    expect(routeLeg('EA100', 'UIO', 'GYE', '08:00')).toMatchObject({ arrivalLocal: '08:50', arrivalDayOffset: 0 }));
  it('UIO → MAD 20:00 llega a las 13:25 hora de Madrid del día siguiente', () =>
    expect(routeLeg('EA500', 'UIO', 'MAD', '20:00')).toMatchObject({ arrivalLocal: '13:25', arrivalDayOffset: 1 }));
  it('MAD → UIO 13:00 llega 18:25 hora de Quito el mismo día', () =>
    expect(routeLeg('EA501', 'MAD', 'UIO', '13:00')).toMatchObject({ arrivalLocal: '18:25', arrivalDayOffset: 0 }));
  it('flightDurationMinutes: distancia a 800 km/h + 30 min de rodaje, redondeado a 5 min', () => {
    expect(flightDurationMinutes('UIO', 'GYE')).toBe(50);
    expect(flightDurationMinutes('UIO', 'MAD')).toBe(685);
    expect(flightDurationMinutes('UIO', 'GYE') % 5).toBe(0);
  });
});

describe('routeReturn: cuándo vuelve el avión (C-3)', () => {
  const base = { origin: 'UIO', destination: 'GYE', aircraftType: 'Airbus A220-300', outbound: { flightNumber: 'EA300', departureLocal: '08:00' } };
  it('vuelta el mismo día si hay tiempo en tierra suficiente', () =>
    expect(routeReturn({ ...base, inbound: { flightNumber: 'EA301', departureLocal: '10:00' } })).toEqual({ returnDelayDays: 0, groundMinutes: 70, turnaroundMinutes: 35 }));
  it('si la vuelta sale antes de que el avión esté listo, vuelve al día siguiente', () => {
    const vuelta = routeReturn({ ...base, inbound: { flightNumber: 'EA301', departureLocal: '09:00' } });
    expect(vuelta.returnDelayDays).toBe(1);
    expect(vuelta.groundMinutes).toBe(24 * 60 + 10);
  });
  it('el tiempo en tierra nunca es menor que el mínimo del tipo', () => {
    for (const hora of ['08:51', '09:24', '09:25', '12:00', '07:00']) {
      const vuelta = routeReturn({ ...base, inbound: { flightNumber: 'EA301', departureLocal: hora } });
      expect(vuelta.groundMinutes).toBeGreaterThanOrEqual(vuelta.turnaroundMinutes);
    }
  });
});

describe('precios y promociones', () => {
  it('multiplicadores de 0,5 y 10 son válidos (límites incluidos)', () =>
    expect(codeOf(() => assertMultipliers([{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 0.5 }, { cabinClass: 'BUSINESS', fareBrand: 'DOSEL', multiplier: 10 }]))).toBeUndefined());
  it.each([0.49, 10.01, 0, -1, Number.NaN])('multiplicador %s → MULTIPLIER_OUT_OF_RANGE', (multiplier) =>
    expect(codeOf(() => assertMultipliers([{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier }]))).toBe('MULTIPLIER_OUT_OF_RANGE'));
  it('se informan todos los multiplicadores fuera de rango, no solo el primero', () =>
    expect(
      problemOf(() =>
        assertMultipliers([
          { cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 0.1 },
          { cabinClass: 'ECONOMY', fareBrand: 'BROTE', multiplier: 1 },
          { cabinClass: 'BUSINESS', fareBrand: 'DOSEL', multiplier: 20 },
        ]),
      )?.invalidParams?.map((p) => p.name),
    ).toEqual(['ECONOMY/SEMILLA', 'BUSINESS/DOSEL']));

  const contexto = { routes: [ruta('EA100-EA101', 'UIO', 'GYE', ['EA100', '08:00'], ['EA101', '10:00'])], cabins: new Set(['ECONOMY', 'BUSINESS'] as const), today: '2026-11-11' };
  const terminos = (over = {}) => ({ permite_promociones: true, porcentaje_descuento_maximo: 20, ...over });

  it('un acuerdo válido pasa', () =>
    expect(codeOf(() => assertPromotionTerms(terminos({ rutas_habilitadas: ['GYE-UIO'], cabinas_habilitadas: ['ECONOMY'], vigencia_hasta: '2026-11-11' }), contexto))).toBeUndefined());
  it(`descuento de ${MAX_PROMOTION_DISCOUNT} % pasa; ${MAX_PROMOTION_DISCOUNT + 1} % no (D35)`, () => {
    expect(codeOf(() => assertPromotionTerms(terminos({ porcentaje_descuento_maximo: 50 }), contexto))).toBeUndefined();
    expect(codeOf(() => assertPromotionTerms(terminos({ porcentaje_descuento_maximo: 51 }), contexto))).toBe('PROMOTION_DISCOUNT_OUT_OF_RANGE');
  });
  it('descuento negativo', () => expect(codeOf(() => assertPromotionTerms(terminos({ porcentaje_descuento_maximo: -1 }), contexto))).toBe('PROMOTION_DISCOUNT_OUT_OF_RANGE'));
  it('una ruta que no se opera, una cabina que no existe y una vigencia vencida se informan juntas', () =>
    expect(
      problemOf(() => assertPromotionTerms(terminos({ rutas_habilitadas: ['UIO-MAD'], cabinas_habilitadas: ['FIRST'], vigencia_hasta: '2026-11-10' }), contexto))?.invalidParams?.map(
        (p) => p.name,
      ),
    ).toEqual(['rutas_habilitadas', 'cabinas_habilitadas', 'vigencia_hasta']));
});

describe('fechas (dates.ts)', () => {
  const sieteDeQuito = localToUtcMs('2026-12-01', '07:00', -300);
  it('localToUtcMs: las 07:00 de Quito son las 12:00 UTC', () => expect(new Date(sieteDeQuito).toISOString()).toBe('2026-12-01T12:00:00.000Z'));
  it('formatLocalIso con desfase negativo, positivo y de media hora', () => {
    expect(formatLocalIso(sieteDeQuito, -300)).toBe('2026-12-01T07:00:00-05:00');
    expect(formatLocalIso(sieteDeQuito, 60)).toBe('2026-12-01T13:00:00+01:00');
    expect(formatLocalIso(sieteDeQuito, 330)).toBe('2026-12-01T17:30:00+05:30');
  });
  it('ida y vuelta: formatLocalIso(localToUtcMs(x)) devuelve la misma hora local', () =>
    expect(formatLocalIso(localToUtcMs('2027-01-01', '23:45', -360), -360)).toBe('2027-01-01T23:45:00-06:00'));
  it('localDateOf: a las 03:00 UTC todavía es el día anterior en Quito', () => expect(localDateOf(Date.parse('2026-11-12T03:00:00Z'), -300)).toBe('2026-11-11'));
  it('addDays cruza fin de mes y de año', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('consultas del horario', () => {
  const vuelo: ScheduledFlight = {
    flightNumber: 'EA100',
    origin: 'UIO',
    destination: 'GYE',
    departureLocal: '08:00',
    aircraft: 'Airbus A220-300',
    operatingDays: [1, 3],
    aircraftByDay: { 1: 'HC-J01', 3: 'HC-J02' },
  };
  const horario = { flights: [vuelo] } as unknown as Timetable;

  it('weekdayOf: 11/11/2026 es miércoles (3); 15/11/2026, domingo (0)', () => {
    expect(weekdayOf('2026-11-11')).toBe(3);
    expect(weekdayOf('2026-11-15')).toBe(0);
  });
  it('operatesOn solo los días programados', () => {
    expect(operatesOn(vuelo, '2026-11-11')).toBe(true);
    expect(operatesOn(vuelo, '2026-11-12')).toBe(false);
  });
  it('findScheduledFlight y flightsOperatingOn', () => {
    expect(findScheduledFlight(horario, 'EA100', '2026-11-16')).toBe(vuelo);
    expect(findScheduledFlight(horario, 'EA100', '2026-11-17')).toBeUndefined();
    expect(flightsOperatingOn(horario, '2026-11-17')).toEqual([]);
  });
  it('aircraftOn: el avión de ese día de la semana, el mismo todas las semanas', () => {
    expect(aircraftOn(horario, 'EA100', '2026-11-11')).toBe('HC-J02');
    expect(aircraftOn(horario, 'EA100', '2026-11-18')).toBe('HC-J02');
    expect(aircraftOn(horario, 'EA100', '2026-11-16')).toBe('HC-J01');
  });
  it(`salesWindow: ${SALES_WINDOW_DAYS} días contando hoy`, () => expect(salesWindow('2026-11-11')).toEqual({ from: '2026-11-11', to: '2027-02-09' }));
});
