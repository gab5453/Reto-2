import { STATUS_CODES } from 'node:http';
import { All, Controller, type DynamicModule, Inject, Logger, Module, Req, Res } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwksTokenVerifier, type TokenVerifier } from '../auth/service-token.guard.js';
import { ServiceTokenProvider, type TokenSource } from '../clients/service-token.js';
import { currentCorrelation } from '../correlation/correlation.js';
import type { HealthCheck } from '../health/health.js';
import { CONTRACT_PROBLEM_CODES, genericCode, type ProblemDetails, ProblemDetailsException } from '../problem-details/problem-details.js';
import { configureService, EcoServiceModule } from '../service/service.js';
import { ContractFiles, loadOperations, type Operation, OperationTable } from './contract.js';
import { EsbClient, type EsbCall, type EsbResponse } from './esb-client.js';
import { applyHttpSecurity, loadSecurityConfig, RateLimiter, sanitize, type SecurityConfig } from './http-security.js';
import { actorOf, authenticate, ownerOf, partnerOwnerOf, type Principal } from './principal.js';
import { ContractValidator, Projector } from './validation.js';

/**
 * Plantilla de los 5 MS de respuesta (V2.12, PLAN.md §4.3). Cada servicio declara su contrato y un handler por operación; esta
 * plantilla hace lo común, en este orden, igual que el monolito del Reto 1 (`EcoAirlines.API`, retirado en V2.21):
 * 1. busca la operación en el contrato (método y ruta; si no existe → 404, otro método → 405);
 * 2. verifica el token y los scopes de la operación (`principal.ts`) → 401/403;
 * 3. aplica el límite de peticiones → 429 con `Retry-After`;
 * 4. sanea y valida la entrada contra el contrato (`validation.ts`) → 400 `VALIDATION_FAILED`;
 * 5. el handler llama al ESB y arma la respuesta (`_links`, `Location`);
 * 6. publica solo lo que declara el schema de la respuesta, y todo error como `ProblemDetails` v2 del contrato.
 * `X-Correlation-Id` va en TODA respuesta (lo pone `configureService`).
 */
export const API_PREFIX = '/api/v2';

export interface OperationContext {
  operation: Operation;
  /** Parámetros ya validados (con sus tipos y `default`). Las cabeceras, en minúsculas. */
  params: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  query: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  principal: Principal;
  request: Request;
  /** Dueño (D29): `sub` o `partner:<clientId>:<X-User-Id>`. */
  owner(): string;
  /** Dueño a nivel de partner (webhooks, feed de eventos): `partner:<clientId>` o el `sub`. */
  partnerOwner(): string;
  /** `sub` del administrador, o `undefined`. */
  actor(): string | undefined;
  /** Llama al ESB (lanza si responde ≥ 400). */
  esb<T = any>(call: EsbCall): Promise<EsbResponse<T>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Llama al ESB sin lanzar. */
  esbRaw<T = any>(call: EsbCall): Promise<EsbResponse<T>>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** El cuerpo ya está en su formato final (p. ej. el error OAuth2 de `/oauth2/token`): no se proyecta. */
  raw?: boolean;
  contentType?: string;
}

export type Handler = (context: OperationContext) => Promise<Reply>;

export interface ResponseServiceDefinition {
  name: string;
  version: string;
  /** `contract/<archivo>`, p. ej. `ms-vuelos.openapi.yaml`. */
  contract: string;
  handlers: Record<string, Handler>;
  /**
   * Operaciones que validan su propio cuerpo porque su contrato no usa ProblemDetails para el `400` (p. ej. `/oauth2/token`, con
   * el formato de error de OAuth2). Los parámetros, el token y el límite se aplican igual.
   */
  selfValidated?: string[];
}

export interface ResponseConfig {
  port: number;
  production: boolean;
  esbUrl: string;
  identityUrl: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
  /** Cliente interno del MS en Identity (D44), p. ej. `ECOAIRLINES_MS_VUELOS`. */
  clientId: string;
  clientSecret: string;
  esbTimeoutMs: number;
  security: SecurityConfig;
}

/**
 * Configuración común. En producción son obligatorias la URL del ESB, la de Identity (token de servicio), la JWKS y el
 * secreto del cliente del MS; en local valen los valores de desarrollo del repositorio.
 */
export function loadResponseConfig(env: NodeJS.ProcessEnv, service: { clientId: string; defaultPort: number }): ResponseConfig {
  const production = env['NODE_ENV'] === 'production';
  const secretVariable = `${service.clientId.replace(/^ECOAIRLINES_/, '')}_CLIENT_SECRET`;
  const devSecret = `secreto-${service.clientId.replace(/^ECOAIRLINES_/, '').toLowerCase().replace(/_/g, '-')}-dev-solo-local-0001`;
  const missing = ['ESB_URL', 'IDENTITY_URL', 'IDENTITY_JWKS_URL', secretVariable].filter((name) => production && !env[name]?.trim());
  if (missing.length) throw new Error(`Configuración inválida de ${service.clientId}:\n - falta ${missing.join('\n - falta ')}`);
  const value = (name: string) => env[name]?.trim() || undefined;
  return {
    port: Number(env['PORT'] ?? service.defaultPort),
    production,
    esbUrl: (value('ESB_URL') ?? 'http://localhost:4000').replace(/\/+$/, ''),
    identityUrl: (value('IDENTITY_URL') ?? 'http://localhost:4001').replace(/\/+$/, ''),
    jwksUrl: value('IDENTITY_JWKS_URL') ?? 'http://localhost:4001/.well-known/jwks.json',
    issuer: env['IDENTITY_ISSUER'] ?? 'ecoairlines-identity',
    audience: env['IDENTITY_AUDIENCE'] ?? 'ecoairlines',
    clientId: service.clientId,
    clientSecret: value(secretVariable) ?? devSecret,
    esbTimeoutMs: Number(env['ESB_TIMEOUT_MS'] ?? 4_900),
    security: loadSecurityConfig(env),
  };
}

// ------------------------------------------------------------------------------------------------------- errores públicos

const PUBLIC_CODES = new Set<string>(CONTRACT_PROBLEM_CODES);

/**
 * ProblemDetails v2 del contrato: `code` es un enum cerrado. Un código propio de un MS.G (p. ej. `EMAIL_ALREADY_REGISTERED`)
 * pasa al `type` como `urn:ecoairlines:problema:<CODE>` (RFC 7807: `type` identifica el problema) y `code` queda el genérico
 * del status. `instance` es la ruta pública y `correlation_id` el del proceso.
 */
export function publicProblem(problem: Partial<ProblemDetails> & { status: number }, instance: string): ProblemDetails {
  const status = problem.status;
  const own = typeof problem.code === 'string' && problem.code && !PUBLIC_CODES.has(problem.code) ? problem.code : undefined;
  const code = typeof problem.code === 'string' && PUBLIC_CODES.has(problem.code) ? problem.code : genericCode(status);
  return {
    type: own ? `urn:ecoairlines:problema:${own}` : problem.type && problem.type !== '' ? problem.type : 'about:blank',
    title: problem.title || STATUS_CODES[status] || 'Error',
    status,
    code,
    ...(problem.detail ? { detail: problem.detail } : {}),
    instance,
    correlation_id: currentCorrelation()?.correlationId,
    timestamp: new Date().toISOString(),
    ...(problem.invalidParams?.length ? { invalidParams: problem.invalidParams.map(({ name, reason }) => ({ name, reason })) } : {}),
  };
}

// ------------------------------------------------------------------------------------------------------------ despachador

export const RESPONSE_RUNTIME = Symbol('RESPONSE_RUNTIME');

/** Lo que el despachador necesita, armado una vez al arrancar. */
export class ResponseRuntime {
  readonly files: ContractFiles;
  readonly table: OperationTable;
  readonly validator: ContractValidator;
  readonly projector: Projector;
  readonly limiter: RateLimiter;

  constructor(
    readonly definition: ResponseServiceDefinition,
    readonly config: ResponseConfig,
    readonly verifier: TokenVerifier,
    readonly esb: EsbClient,
    files = new ContractFiles(),
  ) {
    this.files = files;
    this.table = new OperationTable(loadOperations(definition.contract, files));
    const missing = this.table.operations.filter((op) => !definition.handlers[op.operationId]).map((op) => op.operationId);
    const extra = Object.keys(definition.handlers).filter((id) => !this.table.operations.some((op) => op.operationId === id));
    if (missing.length || extra.length) throw new Error(`${definition.name}: handlers distintos del contrato. Faltan: ${missing.join(', ') || '—'}; sobran: ${extra.join(', ') || '—'}`);
    this.validator = new ContractValidator(files);
    this.validator.precompile(this.table.operations);
    this.projector = new Projector(files);
    this.limiter = new RateLimiter(config.security.rateLimit.windowMs);
  }
}

/** El contrato documenta `429` con un límite propio en estas operaciones (como el monolito). */
const SPECIAL_LIMITS: Record<string, 'searchLimit' | 'seatmapLimit'> = { searchFlights: 'searchLimit', getSeatMap: 'seatmapLimit' };

const keyOf = (principal: Principal, request: Request) =>
  principal.kind === 'partner' ? `p:${principal.clientId}:${principal.userId ?? ''}` : principal.kind === 'user' ? `u:${principal.sub}` : `ip:${request.ip}`;

@Controller()
export class ContractController {
  private readonly logger = new Logger('Respuesta');

  constructor(@Inject(RESPONSE_RUNTIME) private readonly runtime: ResponseRuntime) {}

  @All('api/v2/*path')
  async handle(@Req() request: Request, @Res() response: Response): Promise<void> {
    const instance = request.originalUrl.split('?')[0];
    try {
      const reply = await this.dispatch(request);
      this.send(response, reply);
    } catch (error) {
      if (error instanceof ProblemDetailsException) {
        if (error.retryAfterSeconds !== undefined) response.setHeader('Retry-After', String(error.retryAfterSeconds));
        if (error.problem.status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
        response.status(error.problem.status).contentType('application/problem+json').json(publicProblem(error.problem, instance));
        return;
      }
      this.logger.error(`${request.method} ${instance} → ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      response.status(500).contentType('application/problem+json').json(publicProblem({ status: 500, code: 'INTERNAL_ERROR', title: 'Error interno.' }, instance));
    }
  }

  private async dispatch(request: Request): Promise<Reply & { operation: Operation }> {
    const { runtime } = this;
    const path = request.path.slice(API_PREFIX.length) || '/';
    const matched = runtime.table.match(request.method, path);
    if (!matched) throw ProblemDetailsException.notFound('La ruta no existe.');
    if ('methodNotAllowed' in matched) {
      throw new ProblemDetailsException({ status: 405, code: 'VALIDATION_FAILED', title: `Método no permitido. Permitidos: ${matched.methodNotAllowed.join(', ')}.` });
    }
    const { operation } = matched;

    const principal = await authenticate(operation, request, runtime.verifier);

    const limits = runtime.config.security.rateLimit;
    const special = SPECIAL_LIMITS[operation.operationId];
    const fingerprint = request.header('x-device-fingerprint');
    const wait = special
      ? runtime.limiter.hit(`${operation.operationId}:${special === 'searchLimit' && fingerprint ? `fp:${fingerprint}` : keyOf(principal, request)}`, limits[special])
      : runtime.limiter.hit(`all:${keyOf(principal, request)}`, limits.limit);
    if (wait !== undefined) {
      throw new ProblemDetailsException({ status: 429, code: 'RATE_LIMIT_EXCEEDED', title: 'Demasiadas peticiones.', detail: `Reintente en ${wait} s.`, retryAfterSeconds: wait });
    }

    const input = runtime.validator.validate(operation, {
      params: sanitize(matched.params, '') as Record<string, string>,
      query: sanitize(request.query, '') as Record<string, unknown>,
      headers: request.headers,
      body: sanitize(request.body, ''),
      contentType: request.header('content-type'),
      skipBody: runtime.definition.selfValidated?.includes(operation.operationId) ?? false,
    });
    if (Array.isArray(input)) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La petición no cumple el contrato.', invalidParams: input });

    // El cuerpo publicado al ESB solo lleva lo que declara el contrato (nunca, p. ej., un `ownerId` inventado por el cliente).
    const selfValidated = runtime.definition.selfValidated?.includes(operation.operationId) ?? false;
    const body = input.body !== undefined && operation.requestBody && !selfValidated ? runtime.projector.project(input.body, Object.values(operation.requestBody.content)[0], 'request') : input.body;
    const context: OperationContext = {
      operation,
      params: input.params,
      query: input.query,
      headers: input.headers,
      body,
      principal,
      request,
      owner: () => ownerOf(principal),
      partnerOwner: () => partnerOwnerOf(principal),
      actor: () => actorOf(principal),
      esb: (call) => runtime.esb.expect(call),
      esbRaw: (call) => runtime.esb.call(call),
    };
    const reply = await runtime.definition.handlers[operation.operationId](context);
    return { ...reply, operation };
  }

  private send(response: Response, reply: Reply & { operation: Operation }): void {
    for (const [name, value] of Object.entries(reply.headers ?? {})) response.setHeader(name, value);
    response.status(reply.status);
    if (reply.body === undefined || reply.status === 204) {
      response.end();
      return;
    }
    if (reply.raw) {
      response.contentType(reply.contentType ?? 'application/json').send(JSON.stringify(reply.body));
      return;
    }
    const schema = reply.operation.responses[String(reply.status)] ?? reply.operation.responses['default'];
    response.contentType(reply.contentType ?? 'application/json').send(JSON.stringify(this.runtime.projector.project(reply.body, schema)));
  }
}

// ------------------------------------------------------------------------------------------------------------------ módulo

export interface ResponseModuleOptions {
  verifier?: TokenVerifier;
  tokens?: TokenSource;
  esb?: EsbClient;
}

@Module({})
export class ResponseServiceModule {
  static register(definition: ResponseServiceDefinition, config: ResponseConfig, options: ResponseModuleOptions = {}): DynamicModule {
    const tokens = options.tokens ?? new ServiceTokenProvider(config.identityUrl, config.clientId, config.clientSecret);
    const esb = options.esb ?? new EsbClient(config.esbUrl, tokens, config.esbTimeoutMs);
    const verifier = options.verifier ?? new JwksTokenVerifier(config.jwksUrl, { issuer: config.issuer, audience: config.audience });
    const runtime = new ResponseRuntime(definition, config, verifier, esb);
    const checks: HealthCheck[] = [
      {
        name: 'esb',
        check: async () => {
          try {
            return (await fetch(`${config.esbUrl}/health`, { signal: AbortSignal.timeout(2_000) })).ok ? 'up' : 'down';
          } catch {
            return 'down';
          }
        },
      },
    ];
    return {
      module: ResponseServiceModule,
      imports: [EcoServiceModule.forRoot({ name: definition.name, version: definition.version, healthChecks: checks })],
      controllers: [ContractController],
      providers: [{ provide: RESPONSE_RUNTIME, useValue: runtime }],
    };
  }
}

/** Se llama antes de `listen` (la app se crea con `bodyParser: false`). */
export function setupResponseApp(app: INestApplication, definition: ResponseServiceDefinition, config: ResponseConfig): void {
  configureService(app, { name: definition.name, version: definition.version });
  applyHttpSecurity(app, config.security);
}
