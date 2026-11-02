import { ALL_WEEKDAYS, buildTimetable, type FleetAircraft, type RouteDefinition } from './timetable.js';

/**
 * Red de PRUEBA con la que arranca Schedule (decisión del responsable, 25/10): un solo avión con su horario, para probar el
 * flujo completo. En la nube el administrador agrega más rutas y aviones desde el panel. La red "todos con todos" del
 * monolito (`DEFAULT_ROUTES`, 90 rutas y 149 aviones) sigue en `timetable.ts` para las pruebas del motor.
 *
 * HC-N01 (Airbus A320neo, base Quito), todos los días:
 *   EA100 UIO 07:00 → GYE · EA101 GYE 09:00 → UIO   (nacional)
 *   EA102 UIO 13:00 → BOG · EA103 BOG 16:30 → UIO   (internacional: sirve para probar la regla de pasaporte)
 * Como el avión pasa por Quito entre las dos rutas, también hay conexión GYE → UIO → BOG.
 */
export const SEED_FLEET: readonly FleetAircraft[] = [{ registration: 'HC-N01', aircraftType: 'Airbus A320neo', base: 'UIO' }];

export const SEED_ROUTES: readonly (RouteDefinition & { aircraft: readonly string[] })[] = [
  {
    routeId: 'EA100-EA101',
    origin: 'UIO',
    destination: 'GYE',
    outbound: { flightNumber: 'EA100', departureLocal: '07:00' },
    inbound: { flightNumber: 'EA101', departureLocal: '09:00' },
    weekdays: ALL_WEEKDAYS,
    aircraftType: 'Airbus A320neo',
    aircraft: ['HC-N01'],
  },
  {
    routeId: 'EA102-EA103',
    origin: 'UIO',
    destination: 'BOG',
    outbound: { flightNumber: 'EA102', departureLocal: '13:00' },
    inbound: { flightNumber: 'EA103', departureLocal: '16:30' },
    weekdays: ALL_WEEKDAYS,
    aircraftType: 'Airbus A320neo',
    aircraft: ['HC-N01'],
  },
];

// Falla al cargar el módulo si el horario de prueba no es operable (el avión no llega a tiempo a su siguiente vuelo).
buildTimetable(SEED_ROUTES, SEED_FLEET);
