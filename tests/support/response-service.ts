import 'reflect-metadata';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { publicJwk, signJwt, type TokenClaims, type TokenVerifier, verifyJwt } from '@ecoairlines/shared';
import { EsbClient, loadResponseConfig, type ResponseServiceDefinition, ResponseServiceModule, setupResponseApp } from '@ecoairlines/shared/respuesta/index.js';

/**
 * Soporte de pruebas de los MS de respuesta (V2.12): un ESB falso (registra cada llamada y responde lo que se le programe),
 * tokens RS256 de usuario, administrador, partner y servicio, y la app del MS con su plantilla real. Código de pruebas
 * compartido (como `openapi-contract.ts`): solo lo importan los `test/` de los servicios.
 */
export interface EsbCallRecord {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

type FakeHandler = (call: EsbCallRecord) => FakeReply | undefined;

export class FakeEsb {
  readonly calls: EsbCallRecord[] = [];
  private handlers: { method: string; path: RegExp; handler: FakeHandler }[] = [];
  private server?: Server;
  down = false;
  base = '';

  /** `path` exacto (sin query) o una expresión regular sobre la ruta completa con su query. */
  on(method: string, path: string | RegExp, reply: FakeReply | FakeHandler): this {
    const regex = typeof path === 'string' ? new RegExp(`^${path.replace(/[.?*+()[\]]/g, '\\$&')}(\\?.*)?$`) : path;
    this.handlers.unshift({ method, path: regex, handler: typeof reply === 'function' ? reply : () => reply });
    return this;
  }

  reset(): void {
    this.calls.length = 0;
    this.handlers = [];
    this.down = false;
  }

  last(method?: string, path?: string | RegExp): EsbCallRecord | undefined {
    return this.calls.filter((c) => (!method || c.method === method) && (!path || (typeof path === 'string' ? c.path.split('?')[0] === path : path.test(c.path)))).at(-1);
  }

  async start(): Promise<string> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (this.down) return req.socket.destroy();
        const body = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try {
          json = body ? JSON.parse(body) : undefined;
        } catch {
          json = undefined;
        }
        const call: EsbCallRecord = { method: req.method!, path: req.url ?? '/', headers: req.headers, body, json };
        if (call.path !== '/health') this.calls.push(call);
        const match = this.handlers.find((h) => h.method === req.method && h.path.test(call.path));
        const result = match?.handler(call) ?? (call.path === '/health' ? { status: 200, body: { status: 'ok' } } : { status: 404, body: { type: 'about:blank', title: 'No existe (ESB falso).', status: 404, code: 'NOT_FOUND' } });
        const status = result.status ?? 200;
        const reply = () => {
          res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...result.headers });
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

// --------------------------------------------------------------------------------------------------------------- tokens

const ISSUER = { issuer: 'ecoairlines-identity', audience: 'ecoairlines' };
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = publicJwk(keys.publicKey).kid;

/** Verifica con la clave de prueba (como la JWKS de Identity). */
export const testVerifier: TokenVerifier = { verify: async (token: string): Promise<TokenClaims> => verifyJwt(token, (k) => (k === kid ? keys.publicKey : undefined), ISSUER) };

type Claims = Omit<TokenClaims, 'iss' | 'aud' | 'iat' | 'exp' | 'jti'>;
const sign = (claims: Claims, options: { key?: 'other'; ttlSeconds?: number; now?: number } = {}) =>
  `Bearer ${signJwt(claims, options.key === 'other' ? other.privateKey : keys.privateKey, { ...ISSUER, ttlSeconds: options.ttlSeconds ?? 3600, ...(options.now ? { now: options.now } : {}) }).token}`;

export const CUSTOMER_SUB = '1f0a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
export const OTHER_CUSTOMER_SUB = '2a1b0c9d-8e7f-4a65-b432-10fedcba9876';
export const ADMIN_SUB = '6b0f1c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
export const PARTNER_ID = 'BOOKING_PROTOTIPO';

export const tokens = {
  customer: (scopes = 'flights:read flights:hold flights:book flights:cancel ecoairlines:profile', sub = CUSTOMER_SUB) => sign({ sub, token_use: 'user', scope: scopes, role: 'CUSTOMER', name: 'Ana Paz', email: 'ana.paz@ecoairlines.test' }),
  admin: (scopes = 'flights:read flights:webhooks flights:ops flights:admin ecoairlines:admin') => sign({ sub: ADMIN_SUB, token_use: 'user', scope: scopes, role: 'ADMIN', name: 'Admin', email: 'admin@ecoairlines.test' }),
  partner: (scopes = 'flights:read flights:hold flights:book flights:cancel flights:webhooks flights:ops', clientId = PARTNER_ID) => sign({ sub: clientId, token_use: 'partner', scope: scopes, name: 'Booking Prototipo' }),
  service: (scope = 'ecoairlines:internal') => sign({ sub: 'ECOAIRLINES_ESB', token_use: 'service', scope }),
  expired: () => sign({ sub: CUSTOMER_SUB, token_use: 'user', scope: 'flights:read', role: 'CUSTOMER' }, { now: Math.floor(Date.now() / 1000) - 7200 }),
  otherKey: () => sign({ sub: CUSTOMER_SUB, token_use: 'user', scope: 'flights:read', role: 'CUSTOMER' }, { key: 'other' }),
};

// ------------------------------------------------------------------------------------------------------------------ app

export const FIXED_SERVICE_TOKEN = 'token-de-servicio-de-prueba';

/** La app del MS con la plantilla real, contra el ESB falso. `env` cambia la configuración (p. ej. los límites). */
export async function createResponseApp(definition: ResponseServiceDefinition, esb: FakeEsb, env: NodeJS.ProcessEnv = {}): Promise<NestExpressApplication> {
  const config = loadResponseConfig({ NODE_ENV: 'test', ESB_URL: esb.base, ...env }, { clientId: 'ECOAIRLINES_MS_PRUEBA', defaultPort: 0 });
  const serviceTokens = { token: async () => FIXED_SERVICE_TOKEN, invalidate: () => undefined };
  const moduleRef = await Test.createTestingModule({
    imports: [ResponseServiceModule.register(definition, config, { verifier: testVerifier, tokens: serviceTokens, esb: new EsbClient(esb.base, serviceTokens, 2_000) })],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  setupResponseApp(app, definition, config);
  await app.init();
  return app;
}

export const newKey = () => randomUUID();
