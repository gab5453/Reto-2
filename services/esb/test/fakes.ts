import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import protobuf from 'protobufjs';
import * as soap from 'soap';
import type { TokenClaims } from '@ecoairlines/shared';
import { findContractFile } from '../src/clients/contract-files.js';
import type { TokenSource } from '../src/clients/service-token.js';
import { type EsbConfig, loadConfig, REST_SERVICES } from '../src/config/config.js';

/** Petición que recibió un MS.G falso. */
export interface Received {
  service: string;
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export type FakeHandler = (request: Received) => { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number } | undefined;

/**
 * Los 7 MS.G REST en un solo servidor HTTP: cada uno bajo su prefijo (`/bookings/...`, `/identity/...`). Cada prueba define las
 * respuestas con `on(service, method, path, handler)`; lo que no está definido responde 404 ProblemDetails. `down` simula un
 * servicio caído (se cierra la conexión).
 */
export class FakeMsg {
  readonly received: Received[] = [];
  readonly down = new Set<string>();
  private readonly handlers: { service: string; method: string; path: RegExp; handler: FakeHandler }[] = [];
  private server?: Server;
  base = '';

  on(service: string, method: string, path: string | RegExp, handler: FakeHandler): this {
    const regex = typeof path === 'string' ? new RegExp(`^${path.replace(/[.?]/g, '\\$&')}$`) : path;
    this.handlers.unshift({ service, method, path: regex, handler });
    return this;
  }

  reset(): void {
    this.received.length = 0;
    this.down.clear();
    this.handlers.length = 0;
  }

  calls(service: string, method?: string, path?: string | RegExp) {
    return this.received.filter((r) => r.service === service && (!method || r.method === method) && (!path || (typeof path === 'string' ? r.path === path : path.test(r.path))));
  }

  async start(): Promise<string> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const [, service, ...rest] = (req.url ?? '/').split('/');
        const path = `/${rest.join('/')}`;
        if (this.down.has(service!)) return req.socket.destroy();
        const received: Received = { service: service!, method: req.method!, path, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        if (!path.startsWith('/health')) this.received.push(received);
        const match = this.handlers.find((h) => h.service === service && h.method === req.method && h.path.test(path));
        const result = match?.handler(received) ??
          (path === '/health' ? { status: 200, body: { status: 'ok', service: `ms-g-${service}`, version: '1.0.0', uptime_seconds: 1, dependencies: {} } } : { status: 404, body: { type: 'about:blank', title: 'No existe.', status: 404, code: 'NOT_FOUND' } });
        const reply = () => {
          const problem = result.status >= 400;
          res.writeHead(result.status, { 'content-type': problem ? 'application/problem+json' : 'application/json', 'x-correlation-id': String(req.headers['x-correlation-id'] ?? ''), ...result.headers });
          res.end(result.body === undefined ? '' : JSON.stringify(result.body));
        };
        if (result.delayMs) setTimeout(reply, result.delayMs);
        else reply();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.base;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

type Unary = (request: Record<string, unknown>, metadata: grpc.Metadata) => Record<string, unknown> | Promise<Record<string, unknown>>;

/** Error de negocio de Offers: código gRPC + ProblemDetails en el trailer `x-problem-details-bin` (como el servidor real). */
export class OffersProblem extends Error {
  constructor(readonly problem: { status: number; code: string; title: string }, readonly grpcCode: grpc.status) {
    super(problem.title);
  }
}

/** MS.G.Offers falso, con el mismo `.proto` del contrato. Registra la metadata de cada llamada. */
export class FakeOffers {
  readonly calls: { rpc: string; request: Record<string, unknown>; metadata: Record<string, string> }[] = [];
  readonly handlers = new Map<string, Unary>();
  private server?: grpc.Server;
  address = '';

  async start(): Promise<string> {
    const file = findContractFile('ms-g-offers.proto');
    const definition = protoLoader.loadSync(file, { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true });
    const pkg = (grpc.loadPackageDefinition(definition) as unknown as { ecoairlines: { offers: { v1: Record<string, { service: grpc.ServiceDefinition }> } } }).ecoairlines.offers.v1;
    const problemType = protobuf.loadSync(file).lookupType('ecoairlines.offers.v1.ProblemDetails');
    this.server = new grpc.Server();
    for (const service of ['CatalogService', 'HoldService', 'InventoryService', 'PublishingService']) {
      const def = pkg[service]!.service;
      const impl: grpc.UntypedServiceImplementation = {};
      for (const rpc of Object.keys(def)) {
        impl[rpc] = (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, callback: grpc.sendUnaryData<unknown>) => {
          const metadata = Object.fromEntries(Object.entries(call.metadata.getMap()).map(([k, v]) => [k, String(v)]));
          this.calls.push({ rpc, request: call.request, metadata });
          Promise.resolve()
            .then(() => (this.handlers.get(rpc) ?? (() => ({})))(call.request, call.metadata))
            .then(
              (result) => callback(null, result),
              (error: unknown) => {
                if (error instanceof OffersProblem) {
                  const trailer = new grpc.Metadata();
                  trailer.set('x-problem-details-bin', Buffer.from(problemType.encode(problemType.fromObject({ type: 'about:blank', ...error.problem })).finish()));
                  callback({ code: error.grpcCode, details: error.problem.title, metadata: trailer });
                } else callback({ code: grpc.status.INTERNAL, details: String(error) });
              },
            );
        };
      }
      this.server.addService(def, impl);
    }
    const port = await new Promise<number>((resolve, reject) => this.server!.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
    this.address = `127.0.0.1:${port}`;
    return this.address;
  }

  reset(): void {
    this.calls.length = 0;
    this.handlers.clear();
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.tryShutdown(() => resolve()) ?? resolve());
  }
}

/** Token de servicio fijo (sin Identity) para las pruebas. */
export class FixedToken implements TokenSource {
  issued = 0;
  async token() {
    this.issued++;
    return 'token-de-servicio-del-esb';
  }
  invalidate() {}
}

/** Verificador de tokens de las pruebas: `svc` = token de servicio; `user` = token de usuario (lo rechaza el ESB). */
export const testVerifier = {
  async verify(token: string): Promise<TokenClaims> {
    const base = { iss: 'ecoairlines-identity', aud: 'ecoairlines', iat: 0, exp: 4_102_444_800, jti: 'x' };
    if (token === 'svc') return { ...base, sub: 'ECOAIRLINES_MS_RESERVAS', token_use: 'service', scope: 'ecoairlines:internal' };
    if (token === 'svc-ms') return { ...base, sub: 'ECOAIRLINES_MS_RESERVAS', token_use: 'service', scope: 'ecoairlines:esb' };
    if (token === 'svc-otro') return { ...base, sub: 'OTRO', token_use: 'service', scope: 'flights:read' };
    if (token === 'user') return { ...base, sub: '9d2c6a3e-1111-4222-8333-444455556666', token_use: 'user', scope: 'flights:read' };
    throw new Error('token inválido');
  },
};

export function testConfig(base: string, offersAddress: string, extra: Record<string, string> = {}): EsbConfig {
  return loadConfig({
    NODE_ENV: 'test',
    ...Object.fromEntries(REST_SERVICES.map((service) => [`${service.toUpperCase().replace(/-/g, '_')}_URL`, `${base}/${service}`])),
    OFFERS_GRPC_ADDRESS: offersAddress,
    OFFERS_URL: `${base}/offers`,
    POST_SALE_URL: `${base}/post-sale`,
    HEALTH_REFRESH_MS: '3600000',
    INBOUND_INTERVAL_MS: '3600000',
    UPSTREAM_TIMEOUT_MS: '1500',
    ...extra,
  });
}

type SoapHandler = (args: Record<string, unknown>) => Record<string, unknown>;

/** Falla de negocio de PostSale: `soap:Fault` con su `PostSaleFault` (como el servidor real). */
export class PostSaleProblem extends Error {
  constructor(readonly status: number, readonly code: string, title: string) {
    super(title);
  }
}

/**
 * MS.G.PostSale falso: un servidor SOAP armado con el WSDL del contrato (el mismo que usa el cliente del ESB) y `/health`.
 * Cada operación responde lo que defina la prueba en `handlers`; registra los argumentos de cada llamada.
 */
export class FakePostSale {
  readonly calls: { operation: string; args: Record<string, unknown> }[] = [];
  readonly handlers = new Map<string, SoapHandler>();
  private server?: Server;
  base = '';

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      if (req.url === '/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', service: 'ms-g-post-sale', version: '1.0.0', uptime_seconds: 1, dependencies: {} }));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const operations = ['CreateCancellationQuote', 'ConsumeCancellationQuote', 'CalculateCompensationRefund', 'CreateDateChangeOffers', 'ConsumeDateChangeOffer', 'ReleaseDateChangeOffer', 'GetBaggageOptions', 'ValidateBaggagePurchase'];
    const port = Object.fromEntries(
      operations.map((operation) => [
        operation,
        (args: Record<string, unknown>) => {
          this.calls.push({ operation, args });
          const handler = this.handlers.get(operation);
          try {
            if (!handler) throw new PostSaleProblem(500, 'INTERNAL_ERROR', `Sin respuesta definida para ${operation}`);
            return handler(args);
          } catch (error) {
            const problem = error instanceof PostSaleProblem ? error : new PostSaleProblem(500, 'INTERNAL_ERROR', String(error));
            throw {
              Fault: {
                faultcode: problem.status >= 500 ? 'soap:Server' : 'soap:Client',
                faultstring: problem.message,
                detail: { $xml: `<types:PostSaleFault xmlns:types="http://ecoairlines.com/soap/post-sale/v1/types"><types:code>${problem.code}</types:code><types:status>${problem.status}</types:status><types:title>${problem.message}</types:title><types:timestamp>2026-10-25T10:00:00Z</types:timestamp></types:PostSaleFault>` },
                statusCode: 500,
              },
            };
          }
        },
      ]),
    );
    const wsdl = findContractFile('ms-g-post-sale.wsdl');
    await new Promise<void>((resolve, reject) => {
      soap.listen(this.server!, { path: '/soap/post-sale', services: { PostSaleService: { PostSaleSoapPort: port } }, xml: readFileSync(wsdl, 'utf8'), uri: wsdl, callback: (error: unknown) => (error ? reject(error) : resolve()) });
    });
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.base;
  }

  reset(): void {
    this.calls.length = 0;
    this.handlers.clear();
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}
