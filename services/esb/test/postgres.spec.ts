import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createCloudEvent } from '@ecoairlines/shared';
import { IDEMPOTENCY_TTL_MS, type InboundEventRecord, PostgresEsbStore, type SagaRecord } from '../src/repositories/esb.store.js';

/**
 * PostgreSQL real (opcional): `ESB_TEST_DATABASE_URL=postgres://esb_svc:dev-esb@localhost:5432/esb`.
 * Esquema propio que se borra al terminar.
 */
const url = process.env['ESB_TEST_DATABASE_URL'];

const record = (id: string, receivedAt = new Date().toISOString()): InboundEventRecord => ({
  id, type: 'ec.edu.epn.booking.pagos.payment.confirmed', source: '/booking-prototipo', bookingId: randomUUID(), correlationId: 'corr-pg', channel: 'WEBHOOK',
  event: { id }, status: 'PENDING', attempts: 0, nextAttemptAt: receivedAt, leaseUntil: null, outcome: null, receivedAt, processedAt: null,
});

describe.skipIf(!url)('PostgresEsbStore (concurrencia real)', () => {
  const schema = `prueba_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: url });
  let a: PostgresEsbStore;
  let b: PostgresEsbStore;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const conn = `${url}?options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    a = new PostgresEsbStore(conn); // dos "réplicas" del ESB, cada una con su pool
    b = new PostgresEsbStore(conn);
    await a.init();
  }, 60_000);

  afterAll(async () => {
    await a?.close();
    await b?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('8 peticiones simultáneas con la misma Idempotency-Key: UNA se ejecuta; luego todas ven la respuesta guardada', async () => {
    const key = randomUUID();
    const now = Date.now();
    const claims = await Promise.all([a, b, a, b, a, b, a, b].map((store) => store.claim('owner:x', key, 'hash-1', now)));
    expect(claims.filter((c) => c.kind === 'new')).toHaveLength(1);
    expect(claims.filter((c) => c.kind === 'in-progress')).toHaveLength(7);
    await a.complete('owner:x', key, { status: 201, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });
    expect(await b.claim('owner:x', key, 'hash-1', now + 1)).toEqual({ kind: 'replay', response: { status: 201, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' } });
    expect(await b.claim('owner:x', key, 'hash-2', now + 1)).toEqual({ kind: 'mismatch' });
  });

  it('una clave vencida (24 h) se reemplaza; un 5xx (release) libera la clave', async () => {
    const key = randomUUID();
    const now = Date.now();
    await a.claim('owner:y', key, 'h', now - IDEMPOTENCY_TTL_MS - 1);
    await a.complete('owner:y', key, { status: 200, headers: {}, body: 'viejo' });
    expect(await b.claim('owner:y', key, 'otro', now)).toEqual({ kind: 'new' });
    await b.release('owner:y', key);
    expect(await a.claim('owner:y', key, 'h3', now)).toEqual({ kind: 'new' });
  });

  it('el mismo evento de Booking llega 4 veces a la vez (dos réplicas): un solo registro', async () => {
    const id = `evt-${randomUUID()}`;
    const inserted = await Promise.all([a, b, a, b].map((store) => store.insertInbound(record(id))));
    expect(inserted.filter(Boolean)).toHaveLength(1);
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM ${schema}.inbound_events WHERE id = $1`, [id]);
    expect(rows[0].n).toBe(1);
  });

  it('dos réplicas toman eventos a la vez: cada uno lo procesa una sola; RETRY vuelve cuando vence su espera', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 12; i++) await a.insertInbound(record(`evt-lote-${i}-${randomUUID()}`, past));
    const now = new Date().toISOString();
    const [first, second] = await Promise.all([a.claimInbound(now, 10), b.claimInbound(now, 10)]);
    const ids = [...first, ...second].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(12);
    expect([...first, ...second].every((e) => e.status === 'PROCESSING' && e.attempts === 1)).toBe(true);
    expect(await a.claimInbound(now, 50)).toHaveLength(0); // ya tienen su plazo de 30 s
    const [one] = first;
    await a.finishInbound(one!.id, 'RETRY', { problem: { code: 'PROVIDER_UNAVAILABLE' } }, now, new Date(Date.now() - 1).toISOString());
    const again = await b.claimInbound(new Date().toISOString(), 50);
    expect(again.map((e) => e.id)).toEqual([one!.id]);
    expect(again[0]!.attempts).toBe(2);
    await b.finishInbound(one!.id, 'PROCESSED', { issued: 2 }, new Date().toISOString());
    expect(await a.inbound(one!.id)).toMatchObject({ status: 'PROCESSED', outcome: { issued: 2 } });
    expect(await a.lastInboundAt()).not.toBeNull();
  });

  const saga = (over: Partial<SagaRecord> = {}): SagaRecord => ({
    sagaId: randomUUID(), type: 'CANCEL_BOOKING', status: 'RUNNING', input: { bookingId: randomUUID() }, steps: [], result: null, error: null, ownerId: 'partner:BOOKING_PROTOTIPO:u1',
    actorId: null, correlationId: 'corr-pg', parentSagaId: null, attempts: 1, leaseUntil: new Date(Date.now() - 1000).toISOString(), nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
  });

  it('saga_log: el mismo sagaId una sola vez; los pasos y el error se guardan y se leen igual', async () => {
    const record = saga();
    expect(await Promise.all([a.insertSaga(record), b.insertSaga(record), a.insertSaga(record)])).toEqual(expect.arrayContaining([true, false, false]));
    const steps = [{ name: 'bookings.get', status: 'DONE' as const, result: { pnr: 'XK7P2Q' }, at: new Date().toISOString() }, { name: 'offers.release', status: 'STARTED' as const, at: new Date().toISOString() }];
    await b.saveSaga({ ...record, status: 'COMPENSATING', steps, error: { code: 'X' } });
    expect(await a.saga(record.sagaId)).toMatchObject({ status: 'COMPENSATING', steps, error: { code: 'X' }, input: record.input });
  });

  it('dos réplicas buscan sagas abandonadas a la vez: cada una la retoma una sola; las que esperan su reintento no se toman', async () => {
    const stale = Array.from({ length: 8 }, () => saga());
    for (const record of stale) await a.insertSaga(record);
    await a.insertSaga(saga({ nextAttemptAt: new Date(Date.now() + 60_000).toISOString() }));
    await a.insertSaga(saga({ status: 'COMPLETED' }));
    const now = new Date().toISOString();
    const [first, second] = await Promise.all([a.claimStaleSagas(now, 20), b.claimStaleSagas(now, 20)]);
    const ids = [...first, ...second].map((s) => s.sagaId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => stale.some((s) => s.sagaId === id))).toHaveLength(8);
    expect([...first, ...second].every((s) => s.attempts === 2 && s.leaseUntil > now)).toBe(true);
    expect(await a.claimStaleSagas(now, 20)).toHaveLength(0);
    expect((await a.listSagas({ status: 'COMPLETED', limit: 5 })).length).toBeGreaterThanOrEqual(1);
  });

  it('change_offers: guarda las alternativas de una oferta de cambio', async () => {
    const id = randomUUID();
    await a.saveChangeOffer({ changeOfferId: id, bookingId: randomUUID(), data: { replacements: [{ replacedItineraryId: 'I1' }] }, expiresAt: new Date(Date.now() + 900_000).toISOString() });
    expect((await b.changeOffer(id))!.data).toEqual({ replacements: [{ replacedItineraryId: 'I1' }] });
  });

  // Con la suite completa en paralelo y Docker encendido puede pasar de 5 s (sola tarda < 1 s).
  it('V2.11 — outbox: el mismo evento guardado dos veces queda una; dos réplicas del relé lo toman una sola vez', async () => {
    const events = Array.from({ length: 5 }, (_, n) => createCloudEvent({ name: 'booking.confirmed', visibility: 'public', subject: `s${n}`, data: { n }, correlationId: 'corr-pg' }));
    expect(await Promise.all([a.insertOutbox(events[0]!, 'partner:X:u', new Date().toISOString()), b.insertOutbox(events[0]!, 'partner:X:u', new Date().toISOString())])).toEqual(expect.arrayContaining([true, false]));
    for (const e of events.slice(1)) await a.insertOutbox(e, undefined, new Date().toISOString());
    const [first, second] = await Promise.all([a.claimOutbox(3, 30_000), b.claimOutbox(3, 30_000)]);
    const ids = [...first, ...second].map((e) => e.id);
    expect(new Set(ids).size).toBe(5);
    expect(first.concat(second).find((e) => e.id === events[0]!.id)!.ownerId).toBe('partner:X:u');
    for (const id of ids) await a.markOutboxPublished(id, new Date().toISOString());
    expect(await b.outboxStats()).toMatchObject({ pending: 0 });
  }, 30_000);
});
