import { AIRPORTS, BASE_NETWORK_AIRPORTS } from '@ecoairlines/shared';
import {
  DEFAULT_FLEET,
  DEFAULT_ROUTES,
  DEFAULT_ROUTES_WITH_AIRCRAFT,
  DEFAULT_TIMETABLE,
  buildTimetable,
  flightDurationMinutes,
  flightsOperatingOn,
  generateTimetable,
  SALES_WINDOW_DAYS,
  TimetableBuilder,
  TimetableError,
  validateRotations,
  aircraftOn,
  TURNAROUND_MINUTES,
  type Timetable,
} from '../src/domain/timetable.js';
import { addDays, localToUtcMs } from '../src/domain/dates.js';

/** Pruebas del motor de horario, migradas de `fleet-planner.spec.ts` del monolito (mismo comportamiento). */
const fleetPlan = (timetable: Timetable) => ({ aircraft: timetable.fleet, registrationFor: (date: string, flight: string) => aircraftOn(timetable, flight, date) });

describe('Horario semanal de vuelos y aviones', () => {
  const plan = fleetPlan(DEFAULT_TIMETABLE);
  const start = '2026-10-06';

  it('genera 2 vuelos diarios por ruta, todos con todos, y todos operan los 7 días', () => {
    // La red «todos con todos» se genera con los 10 aeropuertos originales (PLAN_Provincias: la red nacional se arma con rutas).
    const airports: string[] = [...BASE_NETWORK_AIRPORTS];
    const { flights } = generateTimetable();
    expect(flights).toHaveLength(airports.length * (airports.length - 1) * 2);
    for (const origin of airports) {
      for (const destination of airports.filter((code) => code !== origin)) {
        expect(flights.filter((flight) => flight.origin === origin && flight.destination === destination)).toHaveLength(2);
      }
    }
    expect(new Set(flights.map((flight) => flight.flightNumber)).size).toBe(flights.length);
    expect(flights.every((flight) => flight.operatingDays.length === 7)).toBe(true);
  });

  it('la ventana de venta es de 13 semanas exactas', () => {
    expect(SALES_WINDOW_DAYS).toBe(91);
    expect(SALES_WINDOW_DAYS % 7).toBe(0);
  });

  it('cada vuelo lo opera el mismo avión el mismo día de la semana durante las 13 semanas', () => {
    for (let day = 0; day < 7; day++) {
      const date = addDays(start, day);
      for (const flight of flightsOperatingOn(DEFAULT_TIMETABLE, date)) {
        const registration = plan.registrationFor(date, flight.flightNumber);
        for (let week = 1; week < SALES_WINDOW_DAYS / 7; week++) {
          expect(plan.registrationFor(addDays(date, week * 7), flight.flightNumber)).toBe(registration);
        }
      }
    }
  });

  // Recorre toda la ventana de venta día por día: con la suite completa en paralelo puede pasar de 5 s.
  it('ningún avión está en dos lugares a la vez durante toda la ventana de venta', () => {
    expect(validateRotations(generateTimetable())).toEqual([]);

    type Flown = { origin: string; destination: string; departure: number; ready: number; flightNumber: string };
    const byAircraft = new Map<string, Flown[]>();
    const types = new Map(plan.aircraft.map((aircraft) => [aircraft.registration, aircraft.aircraftType]));
    for (let day = 0; day < SALES_WINDOW_DAYS + 7; day++) {
      const date = addDays(start, day);
      for (const flight of flightsOperatingOn(DEFAULT_TIMETABLE, date)) {
        const registration = plan.registrationFor(date, flight.flightNumber);
        expect(registration, `${flight.flightNumber} ${date} sin avión`).toBeDefined();
        expect(types.get(registration!)).toBe(flight.aircraft);
        const departure = localToUtcMs(date, flight.departureLocal, AIRPORTS[flight.origin].utcOffsetMinutes);
        const ready = departure + (flightDurationMinutes(flight.origin, flight.destination) + TURNAROUND_MINUTES[flight.aircraft]) * 60_000;
        if (!byAircraft.has(registration!)) byAircraft.set(registration!, []);
        byAircraft.get(registration!)!.push({ ...flight, departure, ready });
      }
    }
    for (const [registration, flights] of byAircraft) {
      flights.sort((a, b) => a.departure - b.departure);
      for (let index = 1; index < flights.length; index++) {
        const previous = flights[index - 1];
        const current = flights[index];
        expect(current.origin, `${registration}: ${previous.flightNumber} llega a ${previous.destination} y ${current.flightNumber} sale de ${current.origin}`).toBe(previous.destination);
        expect(current.departure, `${registration}: ${current.flightNumber} sale antes de terminar ${previous.flightNumber}`).toBeGreaterThanOrEqual(previous.ready);
      }
    }
    expect(byAircraft.size).toBe(plan.aircraft.length);
  }, 30_000);

  describe('rutas programadas (buildTimetable)', () => {
    const route = (extra: Partial<(typeof DEFAULT_ROUTES)[number]> = {}) => ({
      routeId: 'EA900-EA901',
      origin: 'UIO',
      destination: 'CUE',
      outbound: { flightNumber: 'EA900', departureLocal: '07:00' },
      inbound: { flightNumber: 'EA901', departureLocal: '12:00' },
      weekdays: [1, 3, 5] as const,
      aircraftType: 'Airbus A220-300' as const,
      ...extra,
    });

    it('la red base son 90 rutas de ida y vuelta, cada una con sus aviones', () => {
      expect(DEFAULT_ROUTES).toHaveLength(90);
      expect(DEFAULT_TIMETABLE.aircraftByRoute!['EA100-EA121']).toEqual(['HC-J01']);
      expect(Object.values(DEFAULT_TIMETABLE.aircraftByRoute!).flat()).toHaveLength(DEFAULT_TIMETABLE.fleet.length);
    });

    it('agregar una ruta suma sus vuelos y un avión propio, sin tocar los aviones de las demás', () => {
      const timetable = buildTimetable([...DEFAULT_ROUTES, route()]);
      expect(timetable.flights.find((flight) => flight.flightNumber === 'EA900')!.operatingDays).toEqual([1, 3, 5]);
      expect(timetable.aircraftByRoute!['EA900-EA901']).toEqual(['HC-J27']);
      expect(timetable.aircraftByRoute!['EA116-EA281']).toEqual(DEFAULT_TIMETABLE.aircraftByRoute!['EA116-EA281']);
    });

    it('una ruta larga con vuelta al día siguiente suma los aviones necesarios', () => {
      const timetable = buildTimetable([
        route({ routeId: 'EA902-EA903', destination: 'MAD', outbound: { flightNumber: 'EA902', departureLocal: '20:00' }, inbound: { flightNumber: 'EA903', departureLocal: '15:00' }, weekdays: [0, 1, 2, 3, 4, 5, 6], aircraftType: 'Boeing 787-9' }),
      ]);
      expect(validateRotations(timetable)).toEqual([]);
      expect(timetable.aircraftByRoute!['EA902-EA903'].length).toBeGreaterThan(1);
    });

    it('rechaza números de vuelo repetidos, rutas sin días y aeropuertos inválidos', () => {
      expect(() => buildTimetable([route(), route({ routeId: 'X', inbound: { flightNumber: 'EA900', departureLocal: '12:00' } })])).toThrow(TimetableError);
      expect(() => buildTimetable([route({ weekdays: [] })])).toThrow(/no tiene días/);
      expect(() => buildTimetable([route({ destination: 'UIO' })])).toThrow(/ruta inválida/);
    });
  });

  describe('flota registrada y aviones por ruta', () => {
    const route = (extra: Partial<(typeof DEFAULT_ROUTES)[number]> = {}) => ({
      routeId: 'EA900-EA901',
      origin: 'UIO',
      destination: 'CUE',
      outbound: { flightNumber: 'EA900', departureLocal: '07:00' },
      inbound: { flightNumber: 'EA901', departureLocal: '09:00' },
      weekdays: [1, 2, 3, 4, 5, 6, 0] as const,
      aircraftType: 'Airbus A220-300' as const,
      ...extra,
    });
    const plane = (registration: string, base = 'UIO') => ({ registration, aircraftType: 'Airbus A220-300' as const, base });

    it('la red base reconstruida con su flota y sus aviones fijos es idéntica a la generada', () => {
      const rebuilt = buildTimetable(DEFAULT_ROUTES_WITH_AIRCRAFT, DEFAULT_FLEET);
      expect(rebuilt.flights).toEqual(DEFAULT_TIMETABLE.flights);
      expect(rebuilt.aircraftByRoute).toEqual(DEFAULT_TIMETABLE.aircraftByRoute);
    });

    it('usa el avión elegido; un avión sin rutas queda disponible (no es un error)', () => {
      const timetable = buildTimetable([route({ aircraft: ['HC-X01'] })], [plane('HC-X01'), plane('HC-X02')]);
      expect(timetable.aircraftByRoute!['EA900-EA901']).toEqual(['HC-X01']);
      expect(timetable.fleet.map((aircraft) => aircraft.registration)).toEqual(['HC-X01', 'HC-X02']);
    });

    it('un mismo avión puede hacer dos rutas si sus horarios encajan, y se rechaza si se superponen', () => {
      const fleet = [plane('HC-X01')];
      const second = route({ routeId: 'EA902-EA903', destination: 'GYE', outbound: { flightNumber: 'EA902', departureLocal: '13:00' }, inbound: { flightNumber: 'EA903', departureLocal: '16:00' }, aircraft: ['HC-X01'] });
      expect(() => buildTimetable([route({ aircraft: ['HC-X01'] }), second], fleet)).not.toThrow();
      const overlapping = { ...second, outbound: { flightNumber: 'EA902', departureLocal: '07:30' } };
      expect(() => buildTimetable([route({ aircraft: ['HC-X01'] }), overlapping], fleet)).toThrow(TimetableError);
    });

    it('rechaza aviones que no alcanzan, de otra base, de otro tipo o inexistentes', () => {
      const longRoute = route({ destination: 'MAD', aircraftType: 'Boeing 787-9', outbound: { flightNumber: 'EA900', departureLocal: '20:00' }, inbound: { flightNumber: 'EA901', departureLocal: '15:00' } });
      const wide = { registration: 'HC-Y01', aircraftType: 'Boeing 787-9' as const, base: 'UIO' };
      expect(() => buildTimetable([{ ...longRoute, aircraft: ['HC-Y01'] }], [wide])).toThrow(/necesita \d avión\(es\)/);
      expect(buildTimetable([{ ...longRoute, aircraft: ['HC-Y01'], autoAddAircraft: true }], [wide]).aircraftByRoute!['EA900-EA901'][0]).toBe('HC-Y01');
      expect(() => buildTimetable([route({ aircraft: ['HC-X01'] })], [plane('HC-X01', 'GYE')])).toThrow(/tiene base en GYE/);
      expect(() => buildTimetable([route({ aircraft: ['HC-Y01'] })], [wide])).toThrow(/es un Boeing 787-9/);
      expect(() => buildTimetable([route({ aircraft: ['HC-Z99'] })], [])).toThrow(/no está en la flota/);
    });

    it('los aviones nuevos no repiten matrículas de la flota registrada', () => {
      const timetable = buildTimetable([route()], [{ registration: 'HC-J01', aircraftType: 'Airbus A220-300', base: 'GYE' }]);
      expect(timetable.aircraftByRoute!['EA900-EA901']).toEqual(['HC-J02']);
    });
  });

  describe('TimetableBuilder (agregar rutas a mano)', () => {
    it('acepta una ruta de ida y vuelta con un avión que vuelve a tiempo', () => {
      const builder = new TimetableBuilder();
      const plane = builder.addAircraft('Airbus A220-300', 'UIO');
      for (const weekday of [1, 2, 3, 4, 5] as const) {
        builder
          .addFlight({ flightNumber: 'EA900', origin: 'UIO', destination: 'CUE', weekday, departureLocal: '07:00', registration: plane })
          .addFlight({ flightNumber: 'EA901', origin: 'CUE', destination: 'UIO', weekday, departureLocal: '12:00', registration: plane });
      }
      const timetable = builder.build();
      expect(timetable.flights.find((flight) => flight.flightNumber === 'EA900')!.operatingDays).toEqual([1, 2, 3, 4, 5]);
    });

    it('rechaza un avión en dos lugares a la vez o que no vuelve a su base', () => {
      const overlap = new TimetableBuilder();
      const plane = overlap.addAircraft('Airbus A220-300', 'UIO');
      overlap
        .addFlight({ flightNumber: 'EA900', origin: 'UIO', destination: 'CUE', weekday: 1, departureLocal: '07:00', registration: plane })
        .addFlight({ flightNumber: 'EA902', origin: 'UIO', destination: 'GYE', weekday: 1, departureLocal: '07:30', registration: plane });
      expect(() => overlap.build()).toThrow(/Horario inválido/);

      const oneWay = new TimetableBuilder();
      const other = oneWay.addAircraft('Airbus A220-300', 'UIO');
      oneWay.addFlight({ flightNumber: 'EA900', origin: 'UIO', destination: 'CUE', weekday: 1, departureLocal: '07:00', registration: other });
      expect(() => oneWay.build()).toThrow(/llega a CUE/);
    });
  });
});
