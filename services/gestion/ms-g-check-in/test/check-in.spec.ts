import 'reflect-metadata';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { signJwt, verifyJwt } from '@ecoairlines/shared';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { CheckInModule, setupApp } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { bcbp, boardingGroup, julianDay } from '../src/domain/boarding.js';

/** Pruebas de MS.G.CheckIn (V2.6) contra contract/ms-g-check-in.openapi.yaml, con el almacén en memoria. */
const expectContract = contractValidator('ms-g-check-in.openapi.yaml');
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TOKEN_OPTIONS = { issuer: 'ecoairlines-identity', audience: 'ecoairlines' };
const ESB = signJwt({ sub: 'ECOAIRLINES_ESB', token_use: 'service', scope: 'ecoairlines:internal' }, privateKey, { ...TOKEN_OPTIONS, ttlSeconds: 600 }).token;
const ADMIN = '6b0f1c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const DAY = new Date(Date.now() - 5 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
const SEGMENT = `EA100-${DAY.replaceAll('-', '')}`;

let app: NestExpressApplication;
const esb = (method: 'get' | 'post' | 'put' | 'delete', path: string) => request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${ESB}`);
const segment = (overrides: Any = {}) => ({ segmentId: SEGMENT, flightNumber: 'EA100', origin: 'UIO', destination: 'GYE', departureAt: `${DAY}T07:00:00-05:00`, cabinClass: 'ECONOMY', seat: '12A', gate: 'A4', ...overrides });
const body = (sagaId: string, passengers: Any[]) => ({ sagaId, pnr: 'XK7P2Q', passengers });
const adult = (id: string, seat: string, extra: Any = {}) => ({ passengerId: id, passengerType: 'ADULT', firstName: 'María José', lastName: 'Torres Peña', eTicketNumber: '9990000000001', segments: [segment({ seat, ...extra })] });

beforeAll(async () => {
  const verifier = { verify: async (jwt: string) => verifyJwt(jwt, () => publicKey, TOKEN_OPTIONS) };
  const moduleRef = await Test.createTestingModule({ imports: [CheckInModule.register(loadConfig({ NODE_ENV: 'test' }), { verifier })] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  setupApp(app);
  await app.init();
});
afterAll(() => app.close());

describe('pase de abordar (BCBP)', () => {
  it('código de barras IATA BCBP de 60 caracteres con nombre, PNR, ruta, vuelo, día juliano, cabina, asiento y secuencia', () => {
    const code = bcbp({ firstName: 'María José', lastName: 'Torres Peña', pnr: 'XK7P2Q', origin: 'UIO', destination: 'GYE', flightNumber: 'EA100', departureAt: '2026-10-26T07:00:00-05:00', cabinClass: 'ECONOMY', seat: '12A', boardingPosition: 7 });
    expect(code).toBe('M1TORRESPENA/MARIAJOSEEXK7P2Q UIOGYEEA 0100 299Y012A0007 100');
    expect(code).toHaveLength(60);
    expect(julianDay('2026-01-01')).toBe('001');
    expect(julianDay('2024-12-31')).toBe('366');
  });

  it('grupos: Business y asistencia primero (A); Economy de atrás hacia adelante (B filas ≥ 20, C el resto)', () => {
    expect(boardingGroup({ cabinClass: 'BUSINESS', seat: '2A', needsAssistance: false })).toBe('A');
    expect(boardingGroup({ cabinClass: 'ECONOMY', seat: '25F', needsAssistance: true })).toBe('A');
    expect(boardingGroup({ cabinClass: 'ECONOMY', seat: '25F', needsAssistance: false })).toBe('B');
    expect(boardingGroup({ cabinClass: 'ECONOMY', seat: '8C', needsAssistance: false })).toBe('C');
  });
});

describe('check-in (saga "Check-in")', () => {
  const bookingId = randomUUID();
  const sagaId = randomUUID();

  it('sin check-in: el estado → 404 y los pases → 409 BOARDING_PASS_NOT_AVAILABLE', async () => {
    const state = await esb('get', `/check-ins/${bookingId}`);
    expect(state.status).toBe(404);
    expectContract('get', '/check-ins/{bookingId}', state);
    const passes = await esb('get', `/check-ins/${bookingId}/boarding-passes`);
    expect(passes.status).toBe(409);
    expect(passes.body.code).toBe('BOARDING_PASS_NOT_AVAILABLE');
    expectContract('get', '/check-ins/{bookingId}/boarding-passes', passes);
  });

  it('registra a todos los pasajeros (el infante sin asiento) con grupo y posición', async () => {
    const response = await esb('post', `/check-ins/${bookingId}`).send(
      body(sagaId, [adult('PAX-1', '12A', { needsAssistance: true }), { passengerId: 'PAX-2', passengerType: 'INFANT', firstName: 'Lucía', lastName: 'Torres', segments: [segment({ seat: null })] }]),
    );
    expect(response.status).toBe(200);
    expectContract('post', '/check-ins/{bookingId}', response);
    expect(response.body).toMatchObject({ status: 'COMPLETED', checkedInPassengers: [{ passengerId: 'PAX-1', status: 'CHECKED_IN' }, { passengerId: 'PAX-2', segments: [{ seat: null }] }] });
    const state = await esb('get', `/check-ins/${bookingId}`);
    expectContract('get', '/check-ins/{bookingId}', state);
    expect(state.body.items.map((item: Any) => item.boardingGroup)).toEqual(['A', 'B']);
  });

  it('el reintento de la misma saga devuelve lo mismo; un segundo check-in (otra saga) → 409 CHECK_IN_NOT_AVAILABLE sin duplicar', async () => {
    const retry = await esb('post', `/check-ins/${bookingId}`).send(body(sagaId, [adult('PAX-1', '12A', { needsAssistance: true }), { passengerId: 'PAX-2', passengerType: 'INFANT', firstName: 'Lucía', lastName: 'Torres', segments: [segment({ seat: null })] }]));
    expect(retry.status).toBe(200);
    const second = await esb('post', `/check-ins/${bookingId}`).send(body(randomUUID(), [adult('PAX-1', '12A')]));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CHECK_IN_NOT_AVAILABLE');
    expectContract('post', '/check-ins/{bookingId}', second);
    expect((await esb('get', `/check-ins/${bookingId}`)).body.items).toHaveLength(2);
  });

  it('pases de abordar en PDF417 con grupo, posición, puerta y BCBP', async () => {
    const response = await esb('get', `/check-ins/${bookingId}/boarding-passes`);
    expect(response.status).toBe(200);
    expectContract('get', '/check-ins/{bookingId}/boarding-passes', response);
    const [first, infant] = response.body.boardingPasses;
    expect(first).toMatchObject({ seat: '12A', boardingGroup: 'A', boardingPosition: '001', gate: 'A4', barcodeType: 'PDF417' });
    expect(first.barcode).toMatch(/^M1TORRESPENA\/MARIAJOSEEXK7P2Q UIOGYEEA 0100 \d{3}Y012A0001 100$/);
    expect(infant).toMatchObject({ seat: 'INF', boardingPosition: '002' });
  });

  it('otra reserva en el mismo vuelo sigue la numeración de abordaje', async () => {
    const other = randomUUID();
    await esb('post', `/check-ins/${other}`).send(body(randomUUID(), [adult('PAX-1', '22C')]));
    const passes = (await esb('get', `/check-ins/${other}/boarding-passes`)).body.boardingPasses;
    expect(passes[0]).toMatchObject({ boardingPosition: '003', boardingGroup: 'B' });
  });

  it('asistencia lista (administrador) y check-ins del vuelo para la composición', async () => {
    const ready = await esb('put', `/check-ins/${bookingId}/assistance-ready`).set('X-Actor-Id', ADMIN).send({ passengerId: 'PAX-1', segmentId: SEGMENT, ready: true });
    expect(ready.status).toBe(200);
    expectContract('put', '/check-ins/{bookingId}/assistance-ready', ready);
    expect(ready.body.items.find((item: Any) => item.passengerId === 'PAX-1').assistanceReady).toBe(true);
    expect((await esb('put', `/check-ins/${bookingId}/assistance-ready`).send({ passengerId: 'PAX-1', segmentId: SEGMENT, ready: true })).status).toBe(400);
    const flight = await esb('get', `/flights/EA100/${DAY}/check-ins`);
    expectContract('get', '/flights/{flightNumber}/{date}/check-ins', flight);
    expect(flight.body).toMatchObject({ checkedIn: 3, assistanceReady: 1 });
    expect(flight.body.bookingIds).toContain(bookingId);
  });

  it('compensación: deshace solo lo de esa saga (idempotente)', async () => {
    expect((await esb('delete', `/check-ins/${bookingId}?sagaId=${randomUUID()}`)).status).toBe(204);
    expect((await esb('get', `/check-ins/${bookingId}`)).body.items).toHaveLength(2);
    expect((await esb('delete', `/check-ins/${bookingId}?sagaId=${sagaId}`)).status).toBe(204);
    expect((await esb('delete', `/check-ins/${bookingId}?sagaId=${sagaId}`)).status).toBe(204);
    expect((await esb('get', `/check-ins/${bookingId}`)).status).toBe(404);
  });

  it('un vuelo que ya salió → 409 FLIGHT_ALREADY_DEPARTED; datos inválidos → 400; sin token → 401', async () => {
    const departed = await esb('post', `/check-ins/${randomUUID()}`).send(body(randomUUID(), [adult('PAX-1', '5A', { departureAt: '2020-01-01T07:00:00-05:00' })]));
    expect(departed.status).toBe(409);
    expect(departed.body.code).toBe('FLIGHT_ALREADY_DEPARTED');
    const invalid = await esb('post', `/check-ins/${randomUUID()}`).send({ sagaId: 'x', pnr: 'abc', passengers: [] });
    expect(invalid.status).toBe(400);
    expectContract('post', '/check-ins/{bookingId}', invalid);
    const none = await request(app.getHttpServer()).get(`/flights/EA100/${DAY}/check-ins`);
    expect(none.status).toBe(401);
  });
});
