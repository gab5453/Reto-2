import { correlationHeaders, type ProblemDetails, ProblemDetailsException } from '@ecoairlines/shared';
import { CircuitBreaker } from './circuit-breaker.js';
import type { TokenSource } from './service-token.js';

/** Quién origina la llamada (D29, D41): lo calcula el MS de respuesta y el ESB lo reenvía tal cual. */
export interface Caller {
  ownerId?: string;
  actorId?: string;
}

export interface RestRequest {
  method: string;
  /** Ruta del MS.G con su query, p. ej. `/bookings/123?limit=5` (ya codificada). */
  path: string;
  /** Cuerpo JSON (se serializa) o los bytes exactos recibidos (enrutador). */
  json?: unknown;
  raw?: { body: Buffer; contentType: string };
  caller?: Caller;
  /**
   * `true` (por defecto): token de servicio del ESB. `false`: sin `Authorization` (solo `POST /oauth2/token`, donde el partner se
   * autentica con su `client_id`/`client_secret` en el cuerpo, `client_secret_post` de RFC 6749 §2.3.1).
   */
  serviceToken?: boolean;
}

export interface RestResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

/** Cabeceras de la respuesta de un MS.G que el enrutador devuelve (el resto son de ese salto). */
export const FORWARDED_RESPONSE_HEADERS = ['content-type', 'location', 'retry-after', 'www-authenticate', 'cache-control'];

/**
 * Cliente REST hacia un MS.G. Cada llamada lleva el token de servicio, `X-Owner-Id`/`X-Actor-Id`, el MISMO `X-Correlation-Id`
 * y un `X-Request-Id` nuevo (D31), con plazo (`timeoutMs`) y circuit breaker. Si el MS.G no responde → 503
 * `PROVIDER_UNAVAILABLE`; sus respuestas (también los errores, ya en ProblemDetails v2) se devuelven sin cambios.
 */
export class RestClient {
  readonly breaker: CircuitBreaker;

  constructor(
    readonly name: string,
    readonly baseUrl: string,
    private readonly tokens: TokenSource,
    private readonly timeoutMs: number,
  ) {
    this.breaker = new CircuitBreaker(name);
  }

  /**
   * Si el MS.G rechaza el token de servicio guardado (401 `UNAUTHORIZED`, p. ej. Identity rotó sus claves), se pide uno nuevo y
   * se reintenta una sola vez. Otro 401 (como `INVALID_CREDENTIALS` del login) es la respuesta y no se repite.
   */
  async request(request: RestRequest): Promise<RestResponse> {
    const response = await this.send(request);
    if (response.status !== 401 || request.serviceToken === false || !this.tokens.invalidate || (parse(response.body) as { code?: string } | undefined)?.code !== 'UNAUTHORIZED') return response;
    this.tokens.invalidate();
    return this.send(request);
  }

  private send(request: RestRequest): Promise<RestResponse> {
    return this.breaker.run(async () => {
      const headers: Record<string, string> = { accept: 'application/json, application/problem+json', ...correlationHeaders() };
      if (request.serviceToken !== false) headers['authorization'] = `Bearer ${await this.tokens.token()}`;
      if (request.caller?.ownerId) headers['x-owner-id'] = request.caller.ownerId;
      if (request.caller?.actorId) headers['x-actor-id'] = request.caller.actorId;
      let body: Uint8Array<ArrayBuffer> | string | undefined;
      if (request.raw && request.raw.body.length) {
        body = new Uint8Array(request.raw.body);
        headers['content-type'] = request.raw.contentType;
      } else if (request.json !== undefined) {
        body = JSON.stringify(request.json);
        headers['content-type'] = 'application/json';
      }
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${request.path}`, { method: request.method, headers, body, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'manual' });
      } catch (error) {
        const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw new ProblemDetailsException({
          status: 503,
          code: 'PROVIDER_UNAVAILABLE',
          title: timeout ? `${this.name} no respondió a tiempo.` : `${this.name} no está disponible.`,
          retryAfterSeconds: 5,
        });
      }
      return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
    });
  }

  /** Para la composición y la entrada de eventos: el JSON de un 2xx; cualquier otro status se lanza como su ProblemDetails. */
  async json<T>(method: string, path: string, options: Omit<RestRequest, 'method' | 'path'> = {}): Promise<T> {
    const response = await this.request({ method, path, ...options });
    const parsed = parse(response.body);
    if (response.status >= 200 && response.status < 300) return parsed as T;
    throw problemFrom(response.status, parsed, this.name);
  }
}

const parse = (body: Buffer): unknown => {
  if (!body.length) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
};

/** Un error de un MS.G como ProblemDetailsException: conserva su `code` (los MS.G ya responden ProblemDetails v2). */
export function problemFrom(status: number, body: unknown, service: string): ProblemDetailsException {
  const problem = (body ?? {}) as Partial<ProblemDetails>;
  if (typeof problem.code === 'string' && typeof problem.title === 'string') {
    return new ProblemDetailsException({
      status,
      code: problem.code,
      title: problem.title,
      ...(problem.detail ? { detail: problem.detail } : {}),
      ...(problem.type ? { type: problem.type } : {}),
      ...(problem.invalidParams ? { invalidParams: problem.invalidParams } : {}),
    });
  }
  return new ProblemDetailsException({
    status: status >= 500 ? 502 : status,
    code: status >= 500 ? 'INTERNAL_ERROR' : status === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED',
    title: `${service} respondió ${status} sin ProblemDetails.`,
  });
}
