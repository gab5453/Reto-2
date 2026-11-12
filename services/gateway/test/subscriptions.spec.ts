import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type Client, createClient } from 'graphql-ws';
import WebSocket from 'ws';
import { tokens } from '../../../tests/support/response-service.js';
import { createGatewayApp, type FakeServices, problem, resetFakeServices, startFakeServices, stopFakeServices } from './support.js';

/**
 * Suscripción `bookingEvents` (D47, propuesta) por graphql-ws en `/api/graphql`: el gateway consulta el feed de MS.Vuelos con
 * el token del usuario y entrega solo los eventos nuevos; sin token de usuario la conexión no se abre.
 */
let fakes: FakeServices;
let app: NestExpressApplication;
let url: string;
const clients: Client[] = [];

const cloudEvent = (id: string, name: string, data: Record<string, unknown> = {}) => ({
  specversion: '1.0',
  type: `ec.edu.epn.booking.vuelos.${name}`,
  source: '/ecoairlines/vuelos',
  id,
  time: '2026-10-26T10:00:00Z',
  correlationid: `corr-${id}`,
  data,
});

const connect = (connectionParams: Record<string, unknown>) => {
  const client = createClient({ url, webSocketImpl: WebSocket, connectionParams, retryAttempts: 0, lazy: true });
  clients.push(client);
  return client;
};

/** Recibe `count` eventos (o el error) de una suscripción. */
function receive(client: Client, query: string, count: number): Promise<{ events: unknown[]; error?: unknown }> {
  return new Promise((resolve) => {
    const events: unknown[] = [];
    const dispose = client.subscribe(
      { query },
      {
        next: (value) => {
          // Un error de `subscribe` (scopes, token vencido) llega como un resultado con `errors` y luego `complete`.
          if (value.errors) {
            dispose();
            resolve({ events, error: value.errors });
            return;
          }
          events.push(value);
          if (events.length === count) {
            dispose();
            resolve({ events });
          }
        },
        error: (error) => resolve({ events, error }),
        complete: () => resolve({ events }),
      },
    );
  });
}

beforeAll(async () => {
  fakes = await startFakeServices();
  ({ app } = await createGatewayApp(fakes, { SUBSCRIPTION_POLL_MS: '50' }, true));
  url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/graphql`;
});
afterAll(async () => {
  await Promise.all(clients.map(async (client) => client.dispose()));
  await app.close();
  await stopFakeServices(fakes);
});
beforeEach(() => resetFakeServices(fakes));

it('★ solo eventos NUEVOS de las reservas del usuario, traducidos a WebhookEvent y filtrados por tipo', async () => {
  const old = cloudEvent('ev-viejo', 'booking.confirmed', { bookingId: '7bc123b6-ec50-4676-8b88-8f82a8c00ac7', pnr: 'OLD001', status: 'CONFIRMED' });
  let delivered = false;
  fakes['MS.Vuelos'].on('GET', /^\/api\/v2\/vuelos\/eventos/, (call) => {
    const after = new URL(call.path, 'http://x').searchParams.get('after');
    if (!after) return { body: { events: [old], metadata: { total: 1, next_after: 'ev-viejo' } } };
    if (after === 'ev-viejo' && !delivered) {
      delivered = true;
      return { body: { events: [cloudEvent('ev-hold', 'hold.created', { holdId: 'h' }), cloudEvent('ev-nuevo', 'booking.cancelled', { bookingId: '7bc123b6-ec50-4676-8b88-8f82a8c00ac7', pnr: 'NEW001', status: 'CANCELLED', refundAmount: '75.00' })], metadata: { total: 2, next_after: 'ev-nuevo' } } };
    }
    return { body: { events: [], metadata: { total: 0, next_after: after } } };
  });
  const customer = tokens.customer();
  const { events, error } = await receive(connect({ authorization: customer, 'x-correlation-id': 'corr-sub-1' }), 'subscription { bookingEvents(events: [BOOKING_CANCELLED]) { eventId eventType correlationId data { pnr status refundAmount } } }', 1);
  expect(error).toBeUndefined();
  expect(events).toEqual([{ data: { bookingEvents: { eventId: 'ev-nuevo', eventType: 'BOOKING_CANCELLED', correlationId: 'corr-ev-nuevo', data: { pnr: 'NEW001', status: 'CANCELLED', refundAmount: '75.00' } } } }]);
  const call = fakes['MS.Vuelos'].last()!;
  expect(call.headers['authorization']).toBe(customer);
  expect(call.headers['x-correlation-id']).toBe('corr-sub-1');
});

it('sin token de usuario (o con uno de partner) la conexión se rechaza', async () => {
  const partner = tokens.partner();
  for (const params of [{}, { authorization: partner }]) {
    const { events, error } = await receive(connect(params), 'subscription { bookingEvents { eventId } }', 1);
    expect(error).toBeDefined();
    expect(events).toHaveLength(0);
  }
  expect(fakes['MS.Vuelos'].calls.filter((call) => !call.headers['authorization'] || call.headers['authorization'] === partner)).toHaveLength(0);
});

it('un token sin flights:read → FORBIDDEN; si el MS responde 401 (token vencido) la suscripción termina con UNAUTHENTICATED', async () => {
  const forbidden = await receive(connect({ authorization: tokens.customer('ecoairlines:profile') }), 'subscription { bookingEvents { eventId } }', 1);
  expect((forbidden.error as { extensions?: { code?: string } }[])[0].extensions!.code).toBe('FORBIDDEN');
  fakes['MS.Vuelos'].on('GET', /^\/api\/v2\/vuelos\/eventos/, { status: 401, body: problem(401, 'UNAUTHORIZED', 'El token no es válido o venció.') });
  const expired = await receive(connect({ authorization: tokens.customer() }), 'subscription { bookingEvents { eventId } }', 1);
  expect((expired.error as { extensions?: { code?: string } }[])[0].extensions!.code).toBe('UNAUTHENTICATED');
});
