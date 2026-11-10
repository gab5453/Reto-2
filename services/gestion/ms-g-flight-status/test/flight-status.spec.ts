import 'reflect-metadata';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type CloudEvent, createCloudEvent, signJwt, verifyJwt } from '@ecoairlines/shared';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { FlightStatusModule, setupApp } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { FlightStatusService, type SchedulePublishedData } from '../src/services/flight-status.service.js';

/** Pruebas de MS.G.FlightStatus (V2.8) contra contract/ms-g-flight-status.openapi.yaml. */
const expectContract = contractValidator('ms-g-flight-status.openapi.yaml');
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TOKEN_OPTIONS = { issuer: 'ecoairlines-identity', audience: 'ecoairlines' };
const ESB = signJwt({ sub: 'ECOAIRLINES_ESB', token_use: 'service', scope: 'ecoairlines:internal' }, privateKey, { ...TOKEN_OPTIONS, ttlSeconds: 600 }).token;
const ADMIN = '6b0f1c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const DAY = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const NEXT = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

const flight = (flightNumber: string, date: string, origin: string, destination: string, dep: string, arr: string, routeId: string) => ({
  flightNumber, date, routeId, origin, destination, departureAt: `${date}T${dep}:00-05:00`, arrivalAt: `${date}T${arr}:00-05:00`, aircraftType: 'Airbus A320neo', registration: 'HC-N01',
});
const network = (date: string) => [
  flight('EA100', date, 'UIO', 'GYE', '07:00', '07:50', 'EA100-EA101'),
  flight('EA101', date, 'GYE', 'UIO', '09:00', '09:50', 'EA100-EA101'),
  flight('EA102', date, 'UIO', 'BOG', '13:00', '14:25', 'EA102-EA103'),
  flight('EA103', date, 'BOG', 'UIO', '16:30', '17:55', 'EA102-EA103'),
];
const published = (data: SchedulePublishedData): CloudEvent<SchedulePublishedData> => createCloudEvent({ name: 'schedule.published', visibility: 'internal', subject: data.routeId ?? 'timetable', data, correlationId: 'corr-publicar' });

let app: NestExpressApplication;
let service: FlightStatusService;
const esb = (method: 'get' | 'patch' | 'post', path: string, actor = true) => {
  const call = request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${ESB}`);
  return actor ? call.set('X-Actor-Id', ADMIN) : call;
};
const patch = (flightNumber: string, body: Any) => esb('patch', `/flights/${flightNumber}/status`).send({ date: DAY, ...body });

beforeAll(async () => {
  const verifier = { verify: async (jwt: string) => verifyJwt(jwt, () => publicKey, TOKEN_OPTIONS) };
  const moduleRef = await Test.createTestingModule({ imports: [FlightStatusModule.register(loadConfig({ NODE_ENV: 'test' }), { verifier })] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  setupApp(app);
  await app.init();
  service = app.get(FlightStatusService);
  await service.applySchedulePublished(published({ publishId: randomUUID(), from: DAY, to: NEXT, flights: [...network(DAY), ...network(NEXT)] }));
});
afterAll(() => app.close());

describe('proyección del horario (schedule.published, D4)', () => {
  it('lista los vuelos de una fecha con su estado (SCHEDULED al empezar)', async () => {
    const response = await esb('get', `/flights?date=${DAY}`, false);
    expect(response.status).toBe(200);
    expectContract('get', '/flights', response);
    expect(response.body.total).toBe(4);
    expect(response.body.items[0]).toMatchObject({ flightNumber: 'EA100', status: 'SCHEDULED', departure: { iataCode: 'UIO', scheduledAt: `${DAY}T07:00:00-05:00` }, aircraft: 'Airbus A320neo' });
    const filtered = await esb('get', `/flights?date=${DAY}&destination=BOG`, false);
    expect(filtered.body.items.map((f: Any) => f.flightNumber)).toEqual(['EA102']);
  });

  it('el mismo evento dos veces no se aplica dos veces; publicar una ruta solo reemplaza sus vuelos', async () => {
    const event = published({ publishId: randomUUID(), routeId: 'EA102-EA103', from: NEXT, to: NEXT, flights: [flight('EA102', NEXT, 'UIO', 'BOG', '13:30', '14:55', 'EA102-EA103')] });
    expect(await service.applySchedulePublished(event)).toBe(true);
    expect(await service.applySchedulePublished(event)).toBe(false);
    const day = await esb('get', `/flights?date=${NEXT}`, false);
    expect(day.body.items.map((f: Any) => f.flightNumber)).toEqual(['EA100', 'EA101', 'EA102']); // EA103 quitado; EA100/101 intactos
    expect(day.body.items[2].departure.scheduledAt).toBe(`${NEXT}T13:30:00-05:00`);
  });

  it('un vuelo que no está en la proyección → 404; sin token → 401; health con la base y el bus en memoria', async () => {
    const missing = await esb('get', `/flights/EA999/status?date=${DAY}`, false);
    expect(missing.status).toBe(404);
    expectContract('get', '/flights/{flightNumber}/status', missing);
    expect((await request(app.getHttpServer()).get(`/flights?date=${DAY}`)).status).toBe(401);
    const health = await request(app.getHttpServer()).get('/health');
    expectContract('get', '/health', health);
    expect(health.body.dependencies).toMatchObject({ database: { status: 'memory' }, bus: { status: 'memory' } });
  });
});

describe('cambios de estado (saga "Cambiar estado de vuelo")', () => {
  it('DELAYED con hora estimada posterior: delayMinutes, puerta y changeId para compensar', async () => {
    const response = await patch('EA100', { status: 'DELAYED', estimatedDepartureAt: `${DAY}T07:45:00-05:00`, departureGate: 'A6', reason: 'Meteorología en GYE' });
    expect(response.status).toBe(200);
    expectContract('patch', '/flights/{flightNumber}/status', response);
    expect(response.body).toMatchObject({ previousStatus: 'SCHEDULED', flight: { status: 'DELAYED', delayMinutes: 45, departure: { gate: 'A6', estimatedAt: `${DAY}T07:45:00-05:00` } } });
    const read = await esb('get', `/flights/EA100/status?date=${DAY}`, false);
    expectContract('get', '/flights/{flightNumber}/status', read);
    expect(read.body.status).toBe('DELAYED');
  });

  it('una transición inválida → 409 INVALID_STATUS_TRANSITION (p. ej. DELAYED → ARRIVED)', async () => {
    const response = await patch('EA100', { status: 'ARRIVED' });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'INVALID_STATUS_TRANSITION', detail: 'No se puede pasar de DELAYED a ARRIVED.' });
    expectContract('patch', '/flights/{flightNumber}/status', response);
  });

  it('el recorrido completo BOARDING → DEPARTED → ARRIVED guarda las horas reales; ARRIVED es final', async () => {
    expect((await patch('EA100', { status: 'BOARDING' })).status).toBe(200);
    const departed = await patch('EA100', { status: 'DEPARTED' });
    expect(departed.body.flight.departure.actualAt).toEqual(expect.any(String));
    const arrived = await patch('EA100', { status: 'ARRIVED' });
    expect(arrived.body.flight.arrival.actualAt).toEqual(expect.any(String));
    for (const status of ['ARRIVED', 'BOARDING', 'CANCELLED']) {
      const final = await patch('EA100', { status });
      expect(final.status).toBe(409);
      expect(final.body.code).toBe('INVALID_STATUS_TRANSITION');
    }
  });

  it('reglas: DELAYED sin hora posterior y CANCELLED sin motivo → 400; sin X-Actor-Id → 400', async () => {
    expect((await patch('EA101', { status: 'DELAYED', estimatedDepartureAt: `${DAY}T08:00:00-05:00` })).status).toBe(400);
    const cancelled = await patch('EA101', { status: 'CANCELLED' });
    expect(cancelled.status).toBe(400);
    expectContract('patch', '/flights/{flightNumber}/status', cancelled);
    expect((await esb('patch', '/flights/EA101/status', false).send({ date: DAY, status: 'BOARDING' })).status).toBe(400);
  });

  it('el mismo estado solo cambia la puerta (queda en el historial)', async () => {
    const response = await patch('EA101', { status: 'SCHEDULED', departureGate: 'B3' });
    expect(response.status).toBe(200);
    expect(response.body.flight).toMatchObject({ status: 'SCHEDULED', departure: { gate: 'B3' } });
  });

  it('historial del más antiguo al más reciente', async () => {
    const response = await esb('get', `/flights/EA100/status/history?date=${DAY}`, false);
    expectContract('get', '/flights/{flightNumber}/status/history', response);
    expect(response.body.map((c: Any) => c.newStatus)).toEqual(['DELAYED', 'BOARDING', 'DEPARTED', 'ARRIVED']);
    expect(response.body[0]).toMatchObject({ previousStatus: 'SCHEDULED', reason: 'Meteorología en GYE', changedBy: ADMIN, reverted: false });
  });
});

describe('compensación (revert)', () => {
  it('revierte el último cambio al estado exacto anterior; es idempotente; uno anterior → 409 CHANGE_NOT_LATEST', async () => {
    const first = await patch('EA102', { status: 'DELAYED', estimatedDepartureAt: `${DAY}T14:00:00-05:00`, departureGate: 'C1' });
    const second = await patch('EA102', { status: 'CANCELLED', reason: 'Falla técnica' });
    const notLatest = await esb('post', `/status-changes/${first.body.changeId}/revert`);
    expect(notLatest.status).toBe(409);
    expect(notLatest.body.code).toBe('CHANGE_NOT_LATEST');
    expectContract('post', '/status-changes/{changeId}/revert', notLatest);

    const reverted = await esb('post', `/status-changes/${second.body.changeId}/revert`);
    expect(reverted.status).toBe(200);
    expectContract('post', '/status-changes/{changeId}/revert', reverted);
    expect(reverted.body.flight).toMatchObject({ status: 'DELAYED', departure: { gate: 'C1' }, delayMinutes: 60 });
    expect((await esb('post', `/status-changes/${second.body.changeId}/revert`)).body.flight.status).toBe('DELAYED');
    // Ya revertido el último, el anterior pasa a ser el último vigente.
    expect((await esb('post', `/status-changes/${first.body.changeId}/revert`)).body.flight).toMatchObject({ status: 'SCHEDULED', departure: { gate: null } });
    const history = await esb('get', `/flights/EA102/status/history?date=${DAY}`, false);
    expect(history.body.map((c: Any) => c.reverted)).toEqual([true, true]);
    expect((await esb('post', `/status-changes/${randomUUID()}/revert`)).status).toBe(404);
  });
});

describe('retrasos (PLAN_Telemetria_Asientos R-1)', () => {
  const patchNext = (flightNumber: string, body: Any) => esb('patch', `/flights/${flightNumber}/status`).send({ date: NEXT, ...body });
  const impact = (flightNumber: string, minutes: number) => esb('get', `/flights/${flightNumber}/delay-impact?date=${NEXT}&delayMinutes=${minutes}`, false);

  it('★ impacto: con 20 min el avión (A320neo, 45 min en tierra) llega a su siguiente vuelo; con 30 min no, y sugiere cuánto atrasarlo', async () => {
    const fits = await impact('EA100', 20);
    expect(fits.status).toBe(200);
    expectContract('get', '/flights/{flightNumber}/delay-impact', fits);
    expect(fits.body).toMatchObject({
      delayMinutes: 20,
      estimatedDepartureAt: `${NEXT}T07:20:00-05:00`,
      estimatedArrivalAt: `${NEXT}T08:10:00-05:00`,
      aircraft: { registration: 'HC-N01', aircraftType: 'Airbus A320neo', turnaroundMinutes: 45 },
      nextFlight: { flightNumber: 'EA101', conflict: false, suggestedDelayMinutes: null, readyAt: `${NEXT}T08:55:00-05:00` },
    });
    // 07:50 + 30 = 08:20 de llegada + 45 = 09:05 listo; EA101 sale 09:00 → atrasarlo al menos 5 min.
    expect((await impact('EA100', 30)).body.nextFlight).toMatchObject({ flightNumber: 'EA101', conflict: true, suggestedDelayMinutes: 5 });
    // El último vuelo del día: su siguiente es el primero del día siguiente (EA103 17:55 → EA100 de mañana, sin conflicto).
    const last = await esb('get', `/flights/EA103/delay-impact?date=${DAY}&delayMinutes=60`, false);
    expect(last.body.nextFlight).toMatchObject({ flightNumber: 'EA100', date: NEXT, conflict: false });
    // Solo consulta: nada cambió.
    expect((await esb('get', `/flights/EA100/status?date=${NEXT}`, false)).body.status).toBe('SCHEDULED');
    expect((await impact('EA100', 0)).status).toBe(400);
  });

  it('★ el retraso corre también la llegada; si el siguiente ya está atrasado, se compara con su hora nueva; quitar el retraso vuelve a la hora programada', async () => {
    const delayed = await patchNext('EA101', { status: 'DELAYED', estimatedDepartureAt: `${NEXT}T09:40:00-05:00`, reason: 'Tráfico en UIO' });
    expect(delayed.status).toBe(200);
    expect(delayed.body.flight).toMatchObject({ status: 'DELAYED', delayMinutes: 40, arrival: { estimatedAt: `${NEXT}T10:30:00-05:00` } });
    // EA100 con 30 min: listo 09:05, y EA101 ahora sale 09:40 → ya no hay conflicto.
    expect((await impact('EA100', 30)).body.nextFlight).toMatchObject({ flightNumber: 'EA101', status: 'DELAYED', conflict: false });
    // Un retraso nuevo (DELAYED → DELAYED) recalcula la llegada. Aunque la hora llegue en UTC (como la manda la web), se devuelve
    // con la hora local del aeropuerto (si no, la web y Booking mostrarían 15:00 en vez de 10:00).
    const again = await patchNext('EA101', { status: 'DELAYED', estimatedDepartureAt: new Date(`${NEXT}T10:00:00-05:00`).toISOString() });
    expect(again.body.flight.departure.estimatedAt).toBe(`${NEXT}T10:00:00-05:00`);
    expect(again.body.flight.arrival.estimatedAt).toBe(`${NEXT}T10:50:00-05:00`);

    const onTime = await patchNext('EA101', { status: 'SCHEDULED', reason: 'Se recuperó el horario' });
    expect(onTime.status).toBe(200);
    expect(onTime.body.flight).toMatchObject({ status: 'SCHEDULED', delayMinutes: null, departure: { estimatedAt: null }, arrival: { estimatedAt: null } });
  });
});

describe('tiempo en tierra de cada tipo (PLAN_Telemetria_Asientos M-2)', () => {
  it('★ un tipo nuevo trae su tiempo en tierra con el vuelo y el impacto de un retraso lo usa', async () => {
    const DAY3 = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
    const embraer = (f: ReturnType<typeof flight>) => ({ ...f, aircraftType: 'Embraer E195-E2', registration: 'HC-E01', turnaroundMinutes: 20 });
    await service.applySchedulePublished(published({ publishId: randomUUID(), from: DAY3, to: DAY3, routeId: 'EA900-EA901', flights: [embraer(flight('EA900', DAY3, 'UIO', 'GYE', '07:00', '07:50', 'EA900-EA901')), embraer(flight('EA901', DAY3, 'GYE', 'UIO', '08:30', '09:20', 'EA900-EA901'))] }));
    // 07:50 + 15 = 08:05 de llegada + 20 min en tierra = 08:25: llega a EA901 (08:30). Con los 45 de antes no llegaría.
    const impact = await esb('get', `/flights/EA900/delay-impact?date=${DAY3}&delayMinutes=15`, false);
    expect(impact.body).toMatchObject({ aircraft: { aircraftType: 'Embraer E195-E2', turnaroundMinutes: 20 }, nextFlight: { flightNumber: 'EA901', conflict: false } });
  });
});
