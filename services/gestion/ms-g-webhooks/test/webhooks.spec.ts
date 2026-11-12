import 'reflect-metadata';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createCloudEvent, signJwt, verifyJwt, verifyWebhookSignature } from '@ecoairlines/shared';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { WebhooksModule, setupApp } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { assertAllowedUrl, canReadFeed, canReceive } from '../src/domain/rules.js';
import { WebhooksService } from '../src/services/webhooks.service.js';

/** Pruebas de MS.G.Webhooks (V2.8) contra contract/ms-g-webhooks.openapi.yaml, con un receptor HTTP que verifica la firma. */
const expectContract = contractValidator('ms-g-webhooks.openapi.yaml');
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TOKEN_OPTIONS = { issuer: 'ecoairlines-identity', audience: 'ecoairlines' };
const ESB = signJwt({ sub: 'ECOAIRLINES_ESB', token_use: 'service', scope: 'ecoairlines:internal' }, privateKey, { ...TOKEN_OPTIONS, ttlSeconds: 600 }).token;
const ADMIN = '6b0f1c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const PARTNER = 'partner:BOOKING_PROTOTIPO';
const SECRET = 'secreto-del-partner-de-prueba-01';

// ------------------------------------------------------------------ receptor (como Booking)
interface Received {
  path: string;
  body: Any;
  raw: string;
  signatureOk: boolean;
  correlationId: string | undefined;
}
const received: Received[] = [];
let failNext = 0;
let receiver: Server;
let receiverUrl: string;

let app: NestExpressApplication;
let service: WebhooksService;
const esb = (method: 'get' | 'post' | 'delete', path: string, owner?: string) => {
  const call = request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${ESB}`);
  return owner ? call.set('X-Owner-Id', owner) : call;
};
const event = (name: string, data: Any = {}, subject: string = randomUUID(), visibility: 'public' | 'internal' = 'public') =>
  createCloudEvent({ name, visibility, subject, data, correlationId: `corr-${name}-${subject.slice(0, 6)}` });
const flush = async () => {
  await service.deliverDue();
};

beforeAll(async () => {
  receiver = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const secret = req.url?.includes('/admin') ? 'secreto-del-administrador-0001' : SECRET;
      received.push({ path: req.url ?? '', body: JSON.parse(raw), raw, signatureOk: verifyWebhookSignature(secret, raw, String(req.headers['x-webhook-signature'])), correlationId: req.headers['x-correlation-id'] as string });
      if (failNext > 0) {
        failNext--;
        res.writeHead(500).end();
      } else res.writeHead(204).end();
    });
  }).listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  const verifier = { verify: async (jwt: string) => verifyJwt(jwt, () => publicKey, TOKEN_OPTIONS) };
  const config = { ...loadConfig({ NODE_ENV: 'test' }), dispatchIntervalMs: 3_600_000 };
  const moduleRef = await Test.createTestingModule({ imports: [WebhooksModule.register(config, { verifier })] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  setupApp(app);
  await app.init();
  service = app.get(WebhooksService);
});
afterAll(async () => {
  await app.close();
  receiver.close();
});

describe('suscripciones', () => {
  it('registrar (el secreto nunca se devuelve), listar por dueño y dar de baja', async () => {
    const created = await esb('post', '/subscriptions', PARTNER).send({ url: `${receiverUrl}/booking`, events: ['booking.confirmed', 'booking.cancelled', 'hold.created', 'flight.status_changed'], secret: SECRET });
    expect(created.status).toBe(201);
    expectContract('post', '/subscriptions', created);
    expect(created.body).not.toHaveProperty('secret');
    expect(created.body.secretHint).toBe(SECRET.slice(-4)); // V2.14: solo los últimos 4 caracteres
    const admin = await esb('post', '/subscriptions', ADMIN).send({ url: `${receiverUrl}/admin`, events: ['booking.confirmed'], secret: 'secreto-del-administrador-0001' });
    expect(admin.status).toBe(201);
    const list = await esb('get', '/subscriptions', PARTNER);
    expectContract('get', '/subscriptions', list);
    expect(list.body).toHaveLength(1);
    const other = await esb('post', '/subscriptions', PARTNER).send({ url: `${receiverUrl}/temporal`, events: ['hold.expired'], secret: SECRET });
    expect((await esb('delete', `/subscriptions/${other.body.id}`, ADMIN)).status).toBe(404); // de otro dueño
    expect((await esb('delete', `/subscriptions/${other.body.id}`, PARTNER)).status).toBe(204);
  });

  it('datos inválidos → 400; sin X-Owner-Id → 400; sin token → 401', async () => {
    const short = await esb('post', '/subscriptions', PARTNER).send({ url: `${receiverUrl}/x`, events: ['booking.confirmed'], secret: 'corto' });
    expect(short.status).toBe(400);
    expectContract('post', '/subscriptions', short);
    expect((await esb('post', '/subscriptions', PARTNER).send({ url: `${receiverUrl}/x`, events: ['schedule.published'], secret: SECRET })).status).toBe(400);
    expect((await esb('get', '/subscriptions')).status).toBe(400);
    expect((await request(app.getHttpServer()).get('/subscriptions').set('X-Owner-Id', PARTNER)).status).toBe(401);
  });

  it('en producción la URL debe ser https y pública (contra SSRF)', async () => {
    for (const url of ['http://booking.example.com/hook', 'https://localhost/hook', 'https://10.0.0.5/hook', 'https://192.168.1.10/hook', 'https://user:pass@example.com/hook']) {
      await expect(assertAllowedUrl(url, true)).rejects.toMatchObject({ problem: { code: 'WEBHOOK_URL_NOT_ALLOWED' } });
    }
    await expect(assertAllowedUrl('https://8.8.8.8/hook', true)).resolves.toBeUndefined();
  });
});

describe('entrega firmada y filtro D40', () => {
  it('reserva de Booking → se entrega a Booking firmada, con X-Correlation-Id y SIN el dueño en el cuerpo', async () => {
    received.length = 0;
    const confirmed = event('booking.confirmed', { bookingId: randomUUID(), pnr: 'XK7P2Q', status: 'CONFIRMED' });
    await service.ingest(confirmed, `${PARTNER}:usr-4f9a2c`);
    await flush();
    const toBooking = received.filter((r) => r.path === '/booking');
    expect(toBooking).toHaveLength(1);
    expect(toBooking[0]).toMatchObject({ signatureOk: true, correlationId: confirmed.correlationid, body: { id: confirmed.id, type: 'ec.edu.epn.booking.vuelos.booking.confirmed' } });
    expect(toBooking[0].raw).not.toMatch(/usr-4f9a2c|partner:/);
    expect(received.filter((r) => r.path === '/admin')).toHaveLength(1); // el administrador recibe todo
  });

  it('una reserva de la WEB no se entrega a Booking (sí al administrador); los vuelos sí; los internos nunca', async () => {
    received.length = 0;
    await service.ingest(event('booking.confirmed', { bookingId: randomUUID() }), '9d2c6a3e-1111-4222-8333-444455556666');
    await service.ingest(event('flight.status_changed', { flightNumber: 'EA100', newStatus: 'DELAYED' }), undefined);
    await service.ingest(event('schedule.published', { publishId: randomUUID(), flights: [] }, 'timetable', 'internal'), undefined);
    await service.ingest(event('booking.confirmed', { bookingId: randomUUID() }), 'partner:OTRO_PARTNER:u1');
    await flush();
    expect(received.filter((r) => r.path === '/booking').map((r) => r.body.type)).toEqual(['ec.edu.epn.booking.vuelos.flight.status_changed']);
    expect(received.filter((r) => r.path === '/admin')).toHaveLength(2);
    expect(received.every((r) => r.signatureOk)).toBe(true);
  });

  it('regla D40 pura: canReceive', () => {
    const booking = { name: 'booking.confirmed', public: true, ownerId: `${PARTNER}:u1` };
    expect(canReceive(PARTNER, booking)).toBe(true);
    expect(canReceive('partner:BOOKING', booking)).toBe(false); // prefijo que no es el mismo partner
    expect(canReceive(PARTNER, { ...booking, ownerId: 'web-user' })).toBe(false);
    expect(canReceive(PARTNER, { ...booking, ownerId: null })).toBe(false);
    expect(canReceive(ADMIN, { ...booking, ownerId: 'web-user' })).toBe(true);
    expect(canReceive(ADMIN, { name: 'user.created', public: false, ownerId: null })).toBe(false);
  });

  it('★ feed (V2.13): un CLIENTE solo lee sus reservas; el ADMIN (X-Actor-Id = su sub) todo lo público; el partner, su canal', () => {
    const CUSTOMER = '1f0a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
    const mine = { name: 'booking.confirmed', public: true, ownerId: CUSTOMER };
    const other = { name: 'booking.confirmed', public: true, ownerId: 'partner:BOOKING_PROTOTIPO:usr-1' };
    const flight = { name: 'flight.status_changed', public: true, ownerId: null };
    expect(canReadFeed(CUSTOMER, undefined, mine)).toBe(true);
    expect(canReadFeed(CUSTOMER, undefined, other)).toBe(false);
    expect(canReadFeed(CUSTOMER, undefined, flight)).toBe(false);
    expect(canReadFeed(CUSTOMER, undefined, { ...mine, public: false })).toBe(false);
    expect(canReadFeed(ADMIN, ADMIN, other)).toBe(true);
    expect(canReadFeed(ADMIN, undefined, other)).toBe(false); // sin X-Actor-Id no hay privilegios
    expect(canReadFeed(PARTNER, undefined, other)).toBe(true);
    expect(canReadFeed(PARTNER, undefined, mine)).toBe(false);
  });

  it('el mismo evento dos veces se guarda y se entrega una sola vez', async () => {
    received.length = 0;
    const once1 = event('hold.created', { holdId: randomUUID(), seatsHeld: 2 });
    expect(await service.ingest(once1, `${PARTNER}:u2`)).toBeDefined();
    expect(await service.ingest(once1, `${PARTNER}:u2`)).toBeUndefined();
    await flush();
    await flush();
    expect(received.filter((r) => r.body.id === once1.id)).toHaveLength(1);
  });

  it('reintentos 1 min → 5 min → 30 min → 2 h → 6 h y luego EXHAUSTED; el evento sigue en el feed', async () => {
    received.length = 0;
    failNext = 100;
    const cancelled = event('booking.cancelled', { bookingId: randomUUID() });
    await service.ingest(cancelled, `${PARTNER}:u3`);
    const realNow = service.now;
    let clock = Date.now();
    service.now = () => clock;
    try {
      await flush();
      const steps = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];
      for (const step of steps) {
        clock += step - 1_000;
        await flush(); // todavía no toca
        clock += 1_000;
        await flush();
      }
      expect(received.filter((r) => r.body.id === cancelled.id)).toHaveLength(6);
      const history = await esb('get', `/history?correlationId=${cancelled.correlationid}`).set('X-Actor-Id', ADMIN);
      expectContract('get', '/history', history);
      const delivery = history.body.items[0].deliveries.find((d: Any) => d.outcome !== 'DELIVERED');
      expect(delivery).toMatchObject({ outcome: 'EXHAUSTED', attempts: 6, httpStatus: 500, nextRetryAt: null, target: expect.stringMatching(/^127\.0\.0\.1:\d+$/) });
    } finally {
      service.now = realNow;
      failNext = 0;
    }
    const feed = await esb('get', '/events?limit=100', PARTNER);
    expect(feed.body.events.map((e: Any) => e.id)).toContain(cancelled.id);
  });
});

describe('feed de respaldo e historial', () => {
  it('feed del partner: solo lo público de su canal, en orden, con cursor `after`; `after` desconocido → 400', async () => {
    const page = await esb('get', '/events?limit=2', PARTNER);
    expect(page.status).toBe(200);
    expectContract('get', '/events', page);
    expect(page.body.events).toHaveLength(2);
    const rest = await esb('get', `/events?after=${page.body.metadata.next_after}&limit=100`, PARTNER);
    const all = [...page.body.events, ...rest.body.events];
    expect(new Set(all.map((e: Any) => e.id)).size).toBe(all.length);
    expect(all.some((e: Any) => e.type.includes('schedule.published'))).toBe(false);
    expect(all.filter((e: Any) => e.type.endsWith('booking.confirmed'))).toHaveLength(1); // solo la de su canal
    const filtered = await esb('get', '/events?type=flight.status_changed', PARTNER);
    expect(filtered.body.events.every((e: Any) => e.type.endsWith('flight.status_changed'))).toBe(true);
    const unknown = await esb('get', '/events?after=no-existe', PARTNER);
    expect(unknown.status).toBe(400);
    expectContract('get', '/events', unknown);
  });

  it('historial del administrador con los internos; booking.assistance_requested sin datos de salud', async () => {
    await service.ingest(event('booking.assistance_requested', { bookingId: randomUUID(), type: 'MEDA', notes: 'dato de salud' }, randomUUID(), 'internal'), undefined);
    const history = await esb('get', '/history?limit=50').set('X-Actor-Id', ADMIN);
    expectContract('get', '/history', history);
    const assistance = history.body.items.find((item: Any) => item.type.endsWith('booking.assistance_requested'));
    expect(assistance).toMatchObject({ public: false, data: null, deliveries: [] });
    expect(JSON.stringify(history.body)).not.toContain('dato de salud');
    expect(history.body.items.some((item: Any) => item.type.endsWith('schedule.published'))).toBe(true);
    expect((await esb('get', '/history')).status).toBe(400); // sin X-Actor-Id
  });

  it('panel O-2: el historial de UNA reserva por su `subject` (bookingId), con sus entregas', async () => {
    const bookingId = randomUUID();
    await service.ingest(event('booking.confirmed', { bookingId, status: 'CONFIRMED' }, bookingId), 'partner:BOOKING_PROTOTIPO:usr-o2');
    await service.ingest(event('booking.cancelled', { bookingId, status: 'CANCELLED' }, bookingId), 'partner:BOOKING_PROTOTIPO:usr-o2');
    await service.ingest(event('booking.confirmed', { bookingId: randomUUID() }), undefined);
    const history = await esb('get', `/history?subject=${bookingId}&limit=50`).set('X-Actor-Id', ADMIN);
    expectContract('get', '/history', history);
    expect(history.body.items.map((item: Any) => item.type.split('.').slice(-2).join('.'))).toEqual(['booking.cancelled', 'booking.confirmed']);
    expect(history.body.items.every((item: Any) => item.subject === bookingId && Array.isArray(item.deliveries))).toBe(true);
  });

  it('estadísticas de entrega', async () => {
    const stats = await esb('get', '/stats');
    expectContract('get', '/stats', stats);
    expect(stats.body).toMatchObject({ subscriptions: 2, exhaustedLast24h: 1 });
    expect(stats.body.deliveredLast24h).toBeGreaterThan(0);
  });
});
