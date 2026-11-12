import { randomUUID } from 'node:crypto';
import { connect } from 'amqplib';
import { createCloudEvent } from '../cloudevents/cloudevents.js';
import { ATTEMPTS_HEADER, type BusMessage, DEAD_LETTER_EXCHANGE, EventBus } from './amqp.js';
import { type OutboxEntry, OutboxRelay, type OutboxSource } from './outbox.js';

/**
 * Bus interno (V2.11): reintentos con espera, cola de fallidos y publicación confirmada, contra un RabbitMQ REAL (opcional:
 * `BUS_TEST_URL=amqp://ecoairlines:dev-rabbitmq-solo-local@localhost:5672`). Cada prueba usa su propio exchange y sus colas, que
 * se borran al terminar. El relé del outbox se prueba sin broker.
 */
const url = process.env['BUS_TEST_URL'];
const event = (name: string, data: Record<string, unknown> = {}) => createCloudEvent({ name, visibility: 'public', subject: 'x', data, correlationId: 'corr-bus-test' });
const waitFor = async (check: () => boolean, ms = 5_000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('tiempo agotado esperando la condición');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe.skipIf(!url)('EventBus con RabbitMQ real', () => {
  const exchange = `prueba.${randomUUID().slice(0, 8)}`;
  const queues: string[] = [];
  let bus: EventBus;

  beforeAll(async () => {
    bus = await EventBus.connect(url!, exchange);
  });
  afterAll(async () => {
    await bus.close();
    const connection = await connect(url!);
    const channel = await connection.createChannel();
    for (const q of queues) for (const suffix of ['', '.dlq', '.retry.50ms']) await channel.deleteQueue(`${q}${suffix}`).catch(() => undefined);
    await channel.deleteExchange(exchange).catch(() => undefined);
    await connection.close();
  });
  const queue = () => {
    const q = `prueba.${randomUUID().slice(0, 8)}`;
    queues.push(q);
    return q;
  };

  it('un handler que falla se reintenta con su número de intento y, al 5.º, va a la cola de fallidos con el motivo', async () => {
    const q = queue();
    const attempts: number[] = [];
    const dead: string[] = [];
    await bus.consume(q, ['booking.confirmed'], async (m: BusMessage) => {
      attempts.push(m.attempt);
      throw new Error('falla simulada');
    }, { retryDelaysMs: [50, 50, 50, 50], onDeadLetter: (info) => dead.push(`${info.queue}:${info.attempts}:${info.reason}`) });
    const sent = event('booking.confirmed');
    await bus.publish(sent, 'partner:BOOKING_PROTOTIPO:u1');
    await waitFor(() => dead.length === 1);
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(dead).toEqual([`${q}:5:falla simulada`]);
    expect(await bus.messageCount(`${q}.dlq`)).toBe(1);
    // El mensaje de la cola de fallidos conserva el evento, el dueño y el motivo.
    const connection = await connect(url!);
    const channel = await connection.createChannel();
    const got = await channel.get(`${q}.dlq`, { noAck: true });
    if (!got) throw new Error('la cola de fallidos está vacía');
    const failed = got;
    expect(JSON.parse(failed.content.toString()).id).toBe(sent.id);
    expect(failed.properties.headers).toMatchObject({ [ATTEMPTS_HEADER]: 5, 'x-last-error': 'falla simulada', 'x-owner-id': 'partner:BOOKING_PROTOTIPO:u1', 'x-original-routing-key': 'booking.confirmed' });
    expect(failed.fields.exchange).toBe(DEAD_LETTER_EXCHANGE);
    await connection.close();
  });

  it('el reintento vuelve SOLO a la cola que falló (los otros consumidores no lo reciben dos veces)', async () => {
    const failing = queue();
    const other = queue();
    let tries = 0;
    const seen: string[] = [];
    await bus.consume(failing, ['flight.status_changed'], async () => {
      if (tries++ === 0) throw new Error('una vez');
    }, { retryDelaysMs: [50, 50, 50, 50] });
    await bus.consume(other, ['flight.status_changed'], async (m) => void seen.push(m.event.id), { retryDelaysMs: [50, 50, 50, 50] });
    await bus.publish(event('flight.status_changed'));
    await waitFor(() => tries === 2 && seen.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).toHaveLength(1);
    expect(await bus.messageCount(`${failing}.dlq`)).toBe(0);
  });

  it('un mensaje ilegible va directo a la cola de fallidos (reintentarlo no lo arregla)', async () => {
    const q = queue();
    let called = false;
    await bus.consume(q, ['roto'], async () => void (called = true), { retryDelaysMs: [50, 50, 50, 50] });
    const connection = await connect(url!);
    const channel = await connection.createConfirmChannel();
    channel.publish(exchange, 'roto', Buffer.from('{no es json'));
    await channel.waitForConfirms();
    await connection.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(called).toBe(false);
    expect(await bus.messageCount(`${q}.dlq`)).toBe(1);
  });
});

describe('EventBus.connect sin broker', () => {
  it('la primera conexión se reintenta y, agotado el plazo, falla con el error del broker (no se cuelga)', async () => {
    const started = Date.now();
    // Puerto cerrado: ECONNREFUSED en cada intento; 3 intentos de 30 ms dentro de 100 ms.
    await expect(EventBus.connect('amqp://127.0.0.1:1', 'x', { initialTimeoutMs: 100, delaysMs: [30] })).rejects.toThrow(/ECONNREFUSED/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  });
});

describe('OutboxRelay', () => {
  class Source implements OutboxSource {
    rows: (OutboxEntry & { published?: string; lease?: number })[] = [];
    async claimOutbox(limit: number, leaseMs: number) {
      const ready = this.rows.filter((r) => !r.published && (r.lease ?? 0) <= Date.now()).slice(0, limit);
      for (const r of ready) r.lease = Date.now() + leaseMs;
      return ready;
    }
    async markOutboxPublished(id: string, at: string) {
      this.rows.find((r) => r.id === id)!.published = at;
    }
  }
  const quiet = { log: () => undefined, warn: () => undefined };

  it('publica en orden, con el dueño, y marca publicado solo después de la confirmación', async () => {
    const source = new Source();
    for (const n of [1, 2, 3]) {
      const e = event(`booking.confirmed`, { n });
      source.rows.push({ id: e.id, event: e, ownerId: `partner:BOOKING_PROTOTIPO:u${n}` });
    }
    const sent: { n: unknown; owner?: string }[] = [];
    const bus = { publish: async (e: { data: Record<string, unknown> }, owner?: string) => void sent.push({ n: e.data['n'], owner }) } as unknown as EventBus;
    const relay = new OutboxRelay(source, () => bus, quiet, { intervalMs: 60_000, leaseMs: 0 });
    expect(await relay.runOnce()).toBe(3);
    expect(sent.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(sent[0].owner).toBe('partner:BOOKING_PROTOTIPO:u1');
    expect(source.rows.every((r) => r.published)).toBe(true);
    expect(await relay.runOnce()).toBe(0);
  });

  it('si el bus falla, el evento queda pendiente y sale cuando el bus vuelve (no se pierde ni se salta el orden)', async () => {
    const source = new Source();
    for (const n of [1, 2]) {
      const e = event('hold.created', { n });
      source.rows.push({ id: e.id, event: e });
    }
    let down = true;
    const sent: unknown[] = [];
    const bus = { publish: async (e: { data: Record<string, unknown> }) => {
      if (down) throw new Error('broker caído');
      sent.push(e.data['n']);
    } } as unknown as EventBus;
    const relay = new OutboxRelay(source, () => bus, quiet, { intervalMs: 60_000, leaseMs: 0 });
    expect(await relay.runOnce()).toBe(0);
    expect(relay.lastError).toBe('broker caído');
    expect(source.rows.some((r) => r.published)).toBe(false);
    down = false;
    expect(await relay.runOnce()).toBe(2);
    expect(sent).toEqual([1, 2]);
    expect(relay.lastError).toBeUndefined();
  });

  it('si la BASE falla en una ronda de fondo, queda en lastError y no tumba el proceso (sin promesa rechazada suelta)', async () => {
    const failing: OutboxSource = { claimOutbox: async () => Promise.reject(new Error('Connection terminated due to connection timeout')), markOutboxPublished: async () => undefined };
    const warnings: string[] = [];
    const relay = new OutboxRelay(failing, () => ({}) as EventBus, { log: () => undefined, warn: (m) => void warnings.push(m) }, { intervalMs: 60_000 });
    relay.kick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(relay.lastError).toContain('connection timeout');
    expect(warnings[0]).toContain('se reintenta');
  });

  it('sin bus no hace nada (los eventos esperan en el outbox)', async () => {
    const source = new Source();
    const e = event('booking.failed');
    source.rows.push({ id: e.id, event: e });
    expect(await new OutboxRelay(source, () => undefined, quiet).runOnce()).toBe(0);
    expect(source.rows[0].published).toBeUndefined();
  });
});
