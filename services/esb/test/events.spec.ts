import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { load } from 'js-yaml';
import request from 'supertest';
import { createCloudEvent } from '@ecoairlines/shared';
import type { EventBus } from '@ecoairlines/shared/bus/amqp.js';
import { OutboxRelay } from '@ecoairlines/shared/bus/outbox.js';
import { EsbModule, setupApp } from '../src/app.module.js';
import { findContractFile } from '../src/clients/contract-files.js';
import { Upstreams } from '../src/clients/upstreams.js';
import { InMemoryEventsPublisher, OutboxEventsPublisher } from '../src/inbound/events-publisher.js';
import { InMemoryEsbStore, type SagaRecord } from '../src/repositories/esb.store.js';
import { DEFERRED_QUEUE, DeferredScheduler, waitQueue } from '../src/sagas/deferred.js';
import { RETRY_DELAYS_MS, SagaEngine } from '../src/sagas/engine.js';
import { FakeMsg, FakeOffers, FixedToken, testConfig, testVerifier } from './fakes.js';

/** Eventos del ESB (V2.11): outbox, eventos del enrutador, reintentos diferidos y el catálogo contra events.asyncapi.yaml. */
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const msg = new FakeMsg();
const offers = new FakeOffers();
const store = new InMemoryEsbStore();
const publisher = new InMemoryEventsPublisher();
let app: NestExpressApplication;
const ADMIN = '6b0f1c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const OWNER = 'partner:BOOKING_PROTOTIPO:usr-v211';
const http = () => request(app.getHttpServer());
const svc = (call: request.Test, headers: Record<string, string> = { 'X-Actor-Id': ADMIN }) => {
  call.set('Authorization', 'Bearer svc').set('X-Correlation-Id', 'corr-eventos-v211');
  for (const [k, v] of Object.entries(headers)) call.set(k, v);
  return call;
};
const types = () => publisher.published.map((p) => p.event.type);

beforeAll(async () => {
  const base = await msg.start();
  const address = await offers.start();
  const config = testConfig(base, address);
  const moduleRef = await Test.createTestingModule({ imports: [EsbModule.register(config, { store, verifier: testVerifier, upstreams: new Upstreams(config, new FixedToken()), publisher })] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, rawBody: true, bodyParser: false });
  setupApp(app);
  await app.init();
});
afterAll(async () => {
  await app.close();
  await msg.stop();
  await offers.stop();
});
beforeEach(() => {
  msg.reset();
  publisher.published.length = 0;
});

describe('eventos internos del enrutador (los produce el ESB, nunca salen de EcoAirlines)', () => {
  const SUB = 'b711c16f-4a07-49d0-a8e4-75703687ad64';

  it('usuarios: user.created / user.role_changed / user.blocked con UserChange y el correlationid del proceso', async () => {
    msg.on('identity', 'POST', '/users', () => ({ status: 201, body: { sub: SUB, email: 'a@b.ec', fullName: 'Ana', role: 'CUSTOMER', status: 'ACTIVE', createdAt: '2026-10-25T00:00:00Z' } }));
    msg.on('identity', 'PUT', `/users/${SUB}/role`, () => ({ status: 200, body: { sub: SUB, role: 'ADMIN', status: 'ACTIVE' } }));
    msg.on('identity', 'PUT', `/users/${SUB}/status`, () => ({ status: 200, body: { sub: SUB, role: 'ADMIN', status: 'BLOCKED' } }));
    await svc(http().post('/router/identity/users')).send({ email: 'a@b.ec', fullName: 'Ana', password: 'Clave-segura-1' });
    await svc(http().put(`/router/identity/users/${SUB}/role`)).send({ role: 'ADMIN' });
    await svc(http().put(`/router/identity/users/${SUB}/status`)).send({ status: 'BLOCKED', reason: 'Fraude' });
    expect(types()).toEqual(['ec.ecoairlines.internal.user.created', 'ec.ecoairlines.internal.user.role_changed', 'ec.ecoairlines.internal.user.blocked']);
    expect(publisher.published[2]!.event).toMatchObject({ subject: SUB, correlationid: 'corr-eventos-v211', data: { sub: SUB, role: 'ADMIN', status: 'BLOCKED', actorId: ADMIN, reason: 'Fraude' } });
    // La contraseña del cuerpo nunca entra al evento.
    expect(JSON.stringify(publisher.published)).not.toContain('Clave-segura-1');
  });

  it('partners: el evento NUNCA lleva el secreto (aunque la respuesta de Identity sí)', async () => {
    msg.on('identity', 'POST', '/partners', () => ({ status: 201, body: { clientId: 'OTRO_PARTNER', name: 'Otro', scopes: [], status: 'ACTIVE', createdAt: 'x', clientSecret: 'secreto-que-no-debe-salir-01' } }));
    msg.on('identity', 'POST', '/partners/OTRO_PARTNER/secret', () => ({ status: 200, body: { clientId: 'OTRO_PARTNER', status: 'ACTIVE', clientSecret: 'secreto-rotado-02' } }));
    await svc(http().post('/router/identity/partners')).send({ clientId: 'OTRO_PARTNER', name: 'Otro', scopes: [] });
    await svc(http().post('/router/identity/partners/OTRO_PARTNER/secret')).send({});
    expect(types()).toEqual(['ec.ecoairlines.internal.partner.created', 'ec.ecoairlines.internal.partner.secret_rotated']);
    expect(publisher.published[0]!.event.data).toEqual({ clientId: 'OTRO_PARTNER', status: 'ACTIVE', actorId: ADMIN });
    expect(JSON.stringify(publisher.published)).not.toMatch(/secreto/);
  });

  it('asistencia: solo QUE cambió (REQUESTED / REMOVED), nunca el tipo ni las notas (dato de salud)', async () => {
    const id = randomUUID();
    msg.on('bookings', 'PUT', `/bookings/${id}/passengers/PAX-1/assistance`, () => ({ status: 200, body: { passengerId: 'PAX-1', type: 'WCHR', notes: 'NOTA-SALUD', status: 'REQUESTED' } }));
    msg.on('bookings', 'DELETE', `/bookings/${id}/passengers/PAX-1/assistance`, () => ({ status: 204 }));
    await svc(http().put(`/router/bookings/bookings/${id}/passengers/PAX-1/assistance`), { 'X-Owner-Id': OWNER }).send({ type: 'WCHR', notes: 'NOTA-SALUD' });
    await svc(http().delete(`/router/bookings/bookings/${id}/passengers/PAX-1/assistance`), { 'X-Owner-Id': OWNER });
    expect(publisher.published.map((p) => [p.event.type, p.event.data['action'], p.ownerId])).toEqual([
      ['ec.ecoairlines.internal.booking.assistance_requested', 'REQUESTED', OWNER],
      ['ec.ecoairlines.internal.booking.assistance_requested', 'REMOVED', OWNER],
    ]);
    expect(JSON.stringify(publisher.published)).not.toMatch(/WCHR|NOTA-SALUD/);
  });

  it('una escritura rechazada no publica; un reintento con la misma Idempotency-Key tampoco', async () => {
    msg.on('identity', 'PUT', `/users/${SUB}/role`, () => ({ status: 409, body: { type: 'about:blank', title: 'último admin', status: 409, code: 'LAST_ADMIN' } }));
    await svc(http().put(`/router/identity/users/${SUB}/role`)).send({ role: 'CUSTOMER' });
    expect(publisher.published).toHaveLength(0);
    msg.on('identity', 'PUT', `/users/${SUB}/status`, () => ({ status: 200, body: { sub: SUB, role: 'CUSTOMER', status: 'BLOCKED' } }));
    const key = randomUUID();
    await svc(http().put(`/router/identity/users/${SUB}/status`)).set('Idempotency-Key', key).send({ status: 'BLOCKED' });
    const replay = await svc(http().put(`/router/identity/users/${SUB}/status`)).set('Idempotency-Key', key).send({ status: 'BLOCKED' });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(types()).toEqual(['ec.ecoairlines.internal.user.blocked']);
  });
});

describe('outbox del ESB', () => {
  it('guardar dos veces el mismo id no lo duplica; el relé lo publica una vez, con el dueño, y queda marcado', async () => {
    const outboxStore = new InMemoryEsbStore();
    const relayed: { type: string; owner?: string }[] = [];
    const bus = { publish: async (e: { type: string }, owner?: string) => void relayed.push({ type: e.type, owner }) } as unknown as EventBus;
    const relay = new OutboxRelay(outboxStore, () => bus, { log: () => undefined, warn: () => undefined }, { intervalMs: 60_000 });
    const outbox = new OutboxEventsPublisher(outboxStore, () => undefined);
    const event = createCloudEvent({ name: 'booking.confirmed', visibility: 'public', subject: 'x', data: {}, correlationId: 'c' });
    await outbox.publish(event, OWNER);
    await outbox.publish(event, OWNER); // una saga reanudada vuelve a publicar el mismo id
    expect((await outboxStore.outboxStats()).pending).toBe(1);
    expect(await relay.runOnce()).toBe(1);
    expect(relayed).toEqual([{ type: event.type, owner: OWNER }]);
    expect(await outboxStore.outboxStats()).toMatchObject({ pending: 0, lastPublishedAt: expect.any(String) });
  });
});

describe('reintentos diferidos (esb.deferred, TTL + dead letter)', () => {
  it('una saga pendiente se programa en la cola de espera de su demora; al llegar, el ESB la retoma', async () => {
    const sent: { queue: string; body: Any }[] = [];
    const bus = { sendToQueue: async (queue: string, body: Any) => void sent.push({ queue, body }) } as unknown as EventBus;
    const scheduler = new DeferredScheduler(() => bus);
    const record = { sagaId: randomUUID(), type: 'CANCEL_BOOKING', steps: [{ name: 'offers.release', status: 'STARTED', at: '' }], attempts: 2, nextAttemptAt: '2026-10-25T10:00:10Z', correlationId: 'corr-x' } as unknown as SagaRecord;
    await scheduler.schedule(record, 10_000);
    expect(sent).toEqual([{ queue: waitQueue(10_000), body: { sagaId: record.sagaId, sagaType: 'CANCEL_BOOKING', step: 'offers.release', attempt: 2, notBefore: '2026-10-25T10:00:10Z', correlationId: 'corr-x' } }]);
    expect(waitQueue(RETRY_DELAYS_MS[0]!)).toBe(`${DEFERRED_QUEUE}.wait.2s`);

    // engine.resume: solo retoma la saga si ya le toca (y no la tiene otra réplica).
    const engine = app.get(SagaEngine);
    const waiting: SagaRecord = { sagaId: randomUUID(), type: 'PAYMENT_FAILED', status: 'RUNNING', input: { bookingId: randomUUID() }, steps: [], result: null, error: null, ownerId: null, actorId: null, correlationId: 'c', parentSagaId: null, attempts: 1, leaseUntil: new Date(Date.now() + 60_000).toISOString(), nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await store.insertSaga(waiting);
    expect(await engine.resume(waiting.sagaId)).toBe(false);
    await store.saveSaga({ ...waiting, leaseUntil: new Date(Date.now() - 1).toISOString(), nextAttemptAt: new Date(Date.now() - 1).toISOString() });
    expect(await engine.resume(waiting.sagaId)).toBe(true);
  });
});

describe('catálogo de eventos contra events.asyncapi.yaml', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const asyncapi = load(readFileSync(findContractFile('events.asyncapi.yaml'), 'utf8')) as Any;
  const v2 = load(readFileSync(findContractFile('vuelos-openapi-v2.yaml'), 'utf8')) as Any;
  const messages = Object.values(asyncapi.components.messages as Record<string, Any>);
  const files = (dir: string) => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).map((f) => ({ file: f, code: readFileSync(join(dir, f), 'utf8') }));
  // name: 'booking.confirmed' (ESB) y addEvent(tx, 'hold.created', …) (Offers); visibility: 'internal' en la misma llamada. En
  // route-events.ts todos son internos (la visibilidad se fija una vez para todos).
  const produced = ({ file, code }: { file: string; code: string }) =>
    [...code.matchAll(/(?:name: |addEvent\(tx, )'([a-z_]+\.[a-z_]+)'([^\n]{0,160})/g)].map(([, name, rest]) => ({ name: name!, internal: file.endsWith('route-events.ts') || /visibility: 'internal'/.test(rest!) }));
  const all = [...files(join(ROOT, 'services/esb/src')), ...files(join(ROOT, 'services/gestion/ms-g-offers/src'))].flatMap(produced);

  it('cada evento que produce el código existe en el contrato de eventos con su misma visibilidad', () => {
    const byName = new Map(messages.map((m) => [m['name'] as string, m]));
    const problems = all.filter((e) => {
      const message = byName.get(e.name);
      if (!message) return true;
      const internal = message['x-public'] === false || String(message['x-cloudevent-type'] ?? '').startsWith('ec.ecoairlines.internal.');
      return internal !== e.internal;
    });
    expect(problems).toEqual([]);
    expect(new Set(all.map((e) => e.name)).size).toBeGreaterThanOrEqual(20);
  });

  it('todo evento público es uno de los VuelosEventName del contrato del grupo (no se inventan eventos hacia Booking)', () => {
    const allowed: string[] = v2.components.schemas.VuelosEventName.enum;
    expect(all.filter((e) => !e.internal && !allowed.includes(e.name))).toEqual([]);
    expect(allowed.filter((name) => !all.some((e) => e.name === name))).toEqual([]); // y ninguno queda sin productor
  });
});
