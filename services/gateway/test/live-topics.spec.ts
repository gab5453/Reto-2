import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { GraphQLError } from 'graphql';
import { type Client, createClient } from 'graphql-ws';
import WebSocket from 'ws';
import { tokens } from '../../../tests/support/response-service.js';
import type { GqlContext } from '../src/graphql/context.js';
import { journeyTopic, LiveTopics, systemMapTopic } from '../src/graphql/live-topics.js';
import type { GatewayRuntime } from '../src/runtime.js';
import { createGatewayApp, type FakeServices, problem, resetFakeServices, startFakeServices, stopFakeServices } from './support.js';

/**
 * Telemetría en tiempo real por WebSocket (PLAN_Telemetria_Asientos T-5, D-T13): `traceProgress` y `liveSystemMap`. El gateway
 * consulta a MS.Admin solo mientras hay suscriptores, una vez por tema para todos, y empuja lo nuevo.
 */
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const hop = (sequence: number, from: string, to: string, startMs: number) => ({ sequence, from, to, operation: 'POST /x', startMs, durationMs: 10, status: 'OK', httpStatus: 200, traceId: 'abc' });
const journey = (hops: Any[]) => ({ correlationId: 'corr-vivo', startedAt: '2026-11-10T09:00:00.000Z', durationMs: 100, traces: 1, nodes: [{ id: 'cliente', layer: 'CLIENT' }, { id: 'gateway', layer: 'GATEWAY' }, { id: 'esb', layer: 'ESB' }], hops, truncated: false });
const map = (rpm: number) => ({ generatedAt: '2026-11-10T09:00:00Z', windowMinutes: 5, edges: [{ from: 'gateway', to: 'ms-reservas', requestsPerMinute: rpm, errorsPerMinute: 0, p95Ms: 100 }] });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('LiveTopics (sondeo compartido)', () => {
  /** Un contexto de suscriptor con su `exp` y una consulta falsa a MS.Admin. */
  const context = (call: (service: string, method: string, path: string) => Promise<{ body: unknown }>, exp = Math.floor(Date.now() / 1000) + 3600) =>
    ({ claims: { exp }, correlationId: 'corr-sub', ms: { call } }) as unknown as GqlContext;

  it('★ sin suscriptores no consulta; dos suscriptores del mismo proceso comparten UNA consulta por vuelta; al irse el último se detiene', async () => {
    const live = new LiveTopics();
    let calls = 0;
    const call = async () => {
      calls++;
      return { body: journey([hop(1, 'cliente', 'gateway', 0)]) };
    };
    await wait(60);
    expect([calls, live.stats()]).toEqual([0, []]);
    const a = live.subscribe(context(call), 'traceProgress', journeyTopic('corr-vivo', 20));
    const b = live.subscribe(context(call), 'traceProgress', journeyTopic('corr-vivo', 20));
    expect((await a.next()).value.traceProgress.newHops).toHaveLength(1);
    expect((await b.next()).value.traceProgress.journey.hops).toHaveLength(1);
    await wait(100);
    const [stats] = live.stats();
    expect(stats).toMatchObject({ key: 'journey:corr-vivo', subscribers: 2 });
    expect(calls).toBe(stats.polls); // una consulta por vuelta, no una por suscriptor
    await a.return!();
    await b.return!();
    expect(live.stats()).toEqual([]);
    const after = calls;
    await wait(80);
    expect(calls).toBe(after);
  });

  it('★ solo lo nuevo: al llegar pasos nuevos manda el recorrido y cuáles son; si nada cambió, nada', async () => {
    const live = new LiveTopics();
    const answers = [journey([hop(1, 'cliente', 'gateway', 0)]), journey([hop(1, 'cliente', 'gateway', 0)]), journey([hop(1, 'cliente', 'gateway', 0), hop(2, 'gateway', 'esb', 5)])];
    let index = 0;
    const call = async () => ({ body: answers[Math.min(index++, answers.length - 1)] });
    const sub = live.subscribe(context(call), 'traceProgress', journeyTopic('corr-vivo', 20));
    expect((await sub.next()).value.traceProgress.newHops.map((item: Any) => item.to)).toEqual(['gateway']);
    const second = (await sub.next()).value.traceProgress;
    expect(second.newHops.map((item: Any) => `${item.from}→${item.to}`)).toEqual(['gateway→esb']);
    expect(second.journey.hops).toHaveLength(2);
    await sub.return!();
  });

  it('★ sin trazas todavía (404) sigue esperando; MS.Admin caído (503) se reintenta; el mapa solo se manda si cambia', async () => {
    const live = new LiveTopics();
    let index = 0;
    const call = async () => {
      index++;
      if (index === 1) throw new GraphQLError('Sin trazas.', { extensions: { code: 'NOT_FOUND' } });
      if (index === 2) throw new GraphQLError('MS.Admin no respondió.', { extensions: { code: 'PROVIDER_UNAVAILABLE' } });
      return { body: journey([hop(1, 'cliente', 'gateway', 0)]) };
    };
    const sub = live.subscribe(context(call), 'traceProgress', journeyTopic('corr-vivo', 15));
    expect((await sub.next()).value.traceProgress.newHops).toHaveLength(1);
    await sub.return!();

    const maps = [map(10), map(10), map(12)];
    let m = 0;
    const mapSub = live.subscribe(context(async () => ({ body: maps[Math.min(m++, maps.length - 1)] })), 'liveSystemMap', systemMapTopic(15));
    expect((await mapSub.next()).value.liveSystemMap.edges[0].requestsPerMinute).toBe(10);
    expect((await mapSub.next()).value.liveSystemMap.edges[0].requestsPerMinute).toBe(12); // el 10 repetido no se mandó
    await mapSub.return!();
  });

  it('★ un token vencido termina su suscripción con UNAUTHENTICATED; los demás siguen', async () => {
    let now = Date.now();
    const live = new LiveTopics(() => now);
    const call = async () => ({ body: map(1) });
    const soon = Math.floor(now / 1000) + 60;
    const short = live.subscribe(context(call, soon), 'liveSystemMap', systemMapTopic(20));
    const long = live.subscribe(context(call), 'liveSystemMap', systemMapTopic(20));
    await short.next();
    await long.next();
    now += 120_000;
    await expect(short.next()).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
    expect(live.stats()[0]).toMatchObject({ subscribers: 1 });
    await long.return!();
  });
});

describe('por WebSocket (graphql-ws)', () => {
  let fakes: FakeServices;
  let app: NestExpressApplication;
  let runtime: GatewayRuntime;
  let url: string;
  const clients: Client[] = [];
  const connect = (authorization: string) => {
    const client = createClient({ url, webSocketImpl: WebSocket, connectionParams: { authorization }, retryAttempts: 0, lazy: true });
    clients.push(client);
    return client;
  };
  const receive = (client: Client, query: string, count: number) =>
    new Promise<{ events: Any[]; error?: Any }>((resolve) => {
      const events: Any[] = [];
      const dispose = client.subscribe(
        { query },
        {
          next: (value) => {
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
          error: (error) => resolve({ events, error: error as Any }),
          complete: () => resolve({ events }),
        },
      );
    });

  beforeAll(async () => {
    fakes = await startFakeServices();
    ({ app, runtime } = await createGatewayApp(fakes, { LIVE_TRACE_POLL_MS: '40', LIVE_MAP_POLL_MS: '40' }, true));
    url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/graphql`;
  });
  afterAll(async () => {
    await Promise.all(clients.map(async (client) => client.dispose()));
    await app.close();
    await stopFakeServices(fakes);
  });
  beforeEach(() => resetFakeServices(fakes));

  it('★ traceProgress: el recorrido llega en vivo (primero lo que hay, luego los saltos nuevos) y el mapa en vivo', async () => {
    let calls = 0;
    fakes['MS.Admin'].on('GET', /\/telemetry\/journeys\/corr-vivo/, () => (calls++ < 2 ? { body: journey([hop(1, 'cliente', 'gateway', 0)]) } : { body: journey([hop(1, 'cliente', 'gateway', 0), hop(2, 'gateway', 'esb', 5)]) }));
    const admin = tokens.admin();
    const { events, error } = await receive(connect(admin), 'subscription { traceProgress(correlationId: "corr-vivo") { journey { hops { sequence } } newHops { from to } } }', 2);
    expect(error).toBeUndefined();
    expect(events.map((event) => event['data']['traceProgress']['newHops'])).toEqual([[{ from: 'cliente', to: 'gateway' }], [{ from: 'gateway', to: 'esb' }]]);
    // Consulta a MS.Admin con el token del administrador suscrito.
    expect(fakes['MS.Admin'].last()!.headers['authorization']).toBe(admin);
    fakes['MS.Admin'].on('GET', '/api/v2/ecoairlines/admin/telemetry/system-map', { body: map(7) });
    const live = await receive(connect(tokens.admin()), 'subscription { liveSystemMap { edges { from to requestsPerMinute } } }', 1);
    expect(live.events[0]['data']['liveSystemMap']['edges']).toEqual([{ from: 'gateway', to: 'ms-reservas', requestsPerMinute: 7 }]);
    // Al cerrar las suscripciones, el gateway deja de consultar.
    await wait(100);
    expect(runtime.live.stats()).toEqual([]);
  });

  it('solo administradores: un cliente recibe FORBIDDEN y no se consulta nada', async () => {
    fakes['MS.Admin'].on('GET', '/api/v2/ecoairlines/admin/telemetry/system-map', { status: 500, body: problem(500, 'INTERNAL_ERROR', 'No debería llamarse.') });
    const denied = await receive(connect(tokens.customer()), 'subscription { liveSystemMap { windowMinutes } }', 1);
    expect(denied.error?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(fakes['MS.Admin'].calls).toHaveLength(0);
  });
});
