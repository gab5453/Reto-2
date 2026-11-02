import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createCloudEvent, type ProblemDetailsException } from '@ecoairlines/shared';
import { PostgresFlightStatusStore } from '../src/repositories/flight-status.store.js';
import { FlightStatusService, type SchedulePublishedData } from '../src/services/flight-status.service.js';

/**
 * PostgreSQL real (opcional): `FLIGHT_STATUS_TEST_DATABASE_URL=postgres://flight_status_svc:dev-flight-status@localhost:5432/flight_status`.
 * Esquema propio que se borra al terminar.
 */
const url = process.env['FLIGHT_STATUS_TEST_DATABASE_URL'];
const DAY = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const ACTOR = '6b0f1c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? (r.reason as ProblemDetailsException).problem?.code : 'OK');

describe.skipIf(!url)('PostgresFlightStatusStore (concurrencia real)', () => {
  const schema = `prueba_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: url });
  let store: PostgresFlightStatusStore;
  let service: FlightStatusService;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = new PostgresFlightStatusStore(`${url}?options=${encodeURIComponent(`-c search_path=${schema}`)}`);
    await store.init();
    service = new FlightStatusService(store);
    const data: SchedulePublishedData = {
      publishId: randomUUID(), from: DAY, to: DAY,
      flights: [{ flightNumber: 'EA100', date: DAY, routeId: 'EA100-EA101', origin: 'UIO', destination: 'GYE', departureAt: `${DAY}T07:00:00-05:00`, arrivalAt: `${DAY}T07:50:00-05:00`, aircraftType: 'Airbus A320neo', registration: 'HC-N01' }],
    };
    const event = createCloudEvent({ name: 'schedule.published', visibility: 'internal', subject: 'timetable', data, correlationId: 'corr-pg' });
    expect(await Promise.all([service.applySchedulePublished(event), service.applySchedulePublished(event)])).toEqual(expect.arrayContaining([true, false]));
  }, 60_000);

  afterAll(async () => {
    await store?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('cambios simultáneos se serializan: el historial es una cadena sin huecos (cada uno parte del estado del anterior)', async () => {
    const results = await Promise.allSettled([
      service.update('EA100', DAY, { status: 'CANCELLED', reason: 'Falla técnica' }, ACTOR),
      service.update('EA100', DAY, { status: 'CANCELLED', reason: 'Falla técnica' }, ACTOR),
      service.update('EA100', DAY, { status: 'BOARDING' }, ACTOR),
      service.update('EA100', DAY, { status: 'DELAYED', estimatedDepartureAt: `${DAY}T08:00:00-05:00` }, ACTOR),
    ]);
    const history = await service.history('EA100', DAY);
    expect(history).toHaveLength(results.filter((r) => r.status === 'fulfilled').length);
    expect(history[0]!.previousStatus).toBe('SCHEDULED');
    for (let i = 1; i < history.length; i++) expect(history[i]!.previousStatus).toBe(history[i - 1]!.newStatus);
    // Sin el candado, las dos cancelaciones leerían SCHEDULED a la vez y las dos "ganarían".
    expect(history.filter((c) => c.newStatus === 'CANCELLED')).toHaveLength(1);
    expect(results.map(codeOf).filter((c) => c !== 'OK').every((c) => c === 'INVALID_STATUS_TRANSITION')).toBe(true);
  });
});
