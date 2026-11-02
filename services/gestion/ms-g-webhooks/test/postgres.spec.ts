import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createCloudEvent } from '@ecoairlines/shared';
import { toEventRecord } from '../src/domain/rules.js';
import { PostgresWebhooksStore } from '../src/repositories/webhooks.store.js';

/**
 * PostgreSQL real (opcional): `WEBHOOKS_TEST_DATABASE_URL=postgres://webhooks_svc:dev-webhooks@localhost:5432/webhooks`.
 * Esquema propio que se borra al terminar.
 */
const url = process.env['WEBHOOKS_TEST_DATABASE_URL'];

describe.skipIf(!url)('PostgresWebhooksStore (concurrencia real)', () => {
  const schema = `prueba_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: url });
  let a: PostgresWebhooksStore;
  let b: PostgresWebhooksStore;
  const subscriptionId = randomUUID();

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const conn = `${url}?options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    a = new PostgresWebhooksStore(conn); // dos "réplicas" con su propio pool
    b = new PostgresWebhooksStore(conn);
    await a.init();
    await a.insertSubscription({ id: subscriptionId, ownerId: 'partner:BOOKING_PROTOTIPO', url: 'https://example.com/h', events: ['booking.confirmed'], secretEncrypted: 'x', active: true, createdAt: new Date().toISOString() });
  }, 60_000);

  afterAll(async () => {
    await a?.close();
    await b?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('el mismo evento llega 4 veces a la vez: un solo registro y una sola entrega', async () => {
    const event = createCloudEvent({ name: 'booking.confirmed', visibility: 'public', subject: randomUUID(), data: {}, correlationId: 'corr-pg' });
    const record = toEventRecord(event, 'partner:BOOKING_PROTOTIPO:u1');
    const results = await Promise.all([a, b, a, b].map((store) => store.ingest(record, [subscriptionId], new Date().toISOString())));
    expect(results.filter(Boolean)).toHaveLength(1);
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM ${schema}.deliveries`);
    expect(rows[0].n).toBe(1);
  });

  it('dos réplicas toman entregas a la vez: cada entrega la toma una sola', async () => {
    for (let i = 0; i < 20; i++) {
      const event = createCloudEvent({ name: 'booking.confirmed', visibility: 'public', subject: randomUUID(), data: { i }, correlationId: 'corr-pg' });
      await a.ingest(toEventRecord(event, 'partner:BOOKING_PROTOTIPO:u1'), [subscriptionId], new Date(Date.now() - 1000).toISOString());
    }
    const now = new Date().toISOString();
    const [first, second] = await Promise.all([a.claimDue(now, 15), b.claimDue(now, 15)]);
    const seqs = [...first, ...second].map((d) => d.eventSeq);
    expect(seqs).toHaveLength(21); // 20 nuevas + la de la prueba anterior
    expect(new Set(seqs).size).toBe(21);
    expect(await a.claimDue(now, 50)).toHaveLength(0); // ya tienen su plazo de 30 s
  });
});
