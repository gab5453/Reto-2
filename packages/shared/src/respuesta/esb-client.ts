import { CircuitBreaker } from '../clients/circuit-breaker.js';
import type { TokenSource } from '../clients/service-token.js';
import { correlationHeaders } from '../correlation/correlation.js';
import { type ProblemDetails, ProblemDetailsException } from '../problem-details/problem-details.js';

/**
 * Cliente del ESB para los MS de respuesta (D43, `contract/esb.openapi.yaml`). Es su ÚNICA salida: nunca llaman a un MS.G.
 * Cada llamada lleva el token de servicio del MS (`ecoairlines:esb`, D44), el dueño (`X-Owner-Id`) y el administrador
 * (`X-Actor-Id`) calculados del token del cliente, el MISMO `X-Correlation-Id`, un `X-Request-Id` nuevo (D31) y la
 * `Idempotency-Key` recibida (el ESB la resuelve, D6). Con plazo y circuit breaker: si el ESB no responde → 503.
 */
export interface EsbCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Ruta del ESB con su query, p. ej. `/router/bookings/bookings?limit=5`. */
  path: string;
  json?: unknown;
  /** Cuerpo `application/x-www-form-urlencoded` (solo el token de partner). */
  form?: string;
  ownerId?: string;
  actorId?: string;
  idempotencyKey?: string;
  /** Plazo de esta llamada (por defecto el del cliente). */
  timeoutMs?: number;
}

export interface EsbResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  replayed: boolean;
}

const unavailable = (title: string, retryAfterSeconds = 5) => new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title, retryAfterSeconds });

/** Error que devolvió el ESB (o el MS.G detrás), con su ProblemDetails original y su `Retry-After`. */
export class EsbProblem extends ProblemDetailsException {
  constructor(
    readonly esbResponse: EsbResponse,
    problem: Partial<ProblemDetails>,
  ) {
    const retryAfter = Number(esbResponse.headers.get('retry-after'));
    super({
      status: esbResponse.status,
      code: typeof problem.code === 'string' ? problem.code : '',
      title: typeof problem.title === 'string' ? problem.title : '',
      ...(typeof problem.detail === 'string' ? { detail: problem.detail } : {}),
      ...(typeof problem.type === 'string' && problem.type !== 'about:blank' ? { type: problem.type } : {}),
      ...(Array.isArray(problem.invalidParams) ? { invalidParams: problem.invalidParams } : {}),
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    });
  }
}

export class EsbClient {
  readonly breaker = new CircuitBreaker('ESB');

  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenSource,
    private readonly timeoutMs = 4_500,
  ) {}

  /** Llama al ESB y devuelve su respuesta tal cual (también los errores). */
  async call<T = unknown>(call: EsbCall): Promise<EsbResponse<T>> {
    let response = await this.send<T>(call);
    // El ESB rechazó el token guardado (p. ej. Identity rotó sus claves): uno nuevo y un solo reintento.
    if (response.status === 401 && (response.body as { code?: string } | undefined)?.code === 'UNAUTHORIZED' && this.tokens.invalidate) {
      this.tokens.invalidate();
      response = await this.send<T>(call);
      if (response.status === 401 && (response.body as { code?: string } | undefined)?.code === 'UNAUTHORIZED') throw unavailable('El ESB rechazó el token de servicio de este microservicio.');
    }
    return response;
  }

  /** Como `call`, pero un status ≥ 400 se lanza como `EsbProblem`. */
  async expect<T = unknown>(call: EsbCall): Promise<EsbResponse<T>> {
    const response = await this.call<T>(call);
    if (response.status >= 400) throw new EsbProblem(response, (response.body ?? {}));
    return response;
  }

  private async send<T>(call: EsbCall): Promise<EsbResponse<T>> {
    const headers: Record<string, string> = { accept: 'application/json, application/problem+json', ...correlationHeaders() };
    headers['authorization'] = `Bearer ${await this.tokens.token()}`;
    if (call.ownerId) headers['x-owner-id'] = call.ownerId;
    if (call.actorId) headers['x-actor-id'] = call.actorId;
    if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey;
    let body: string | undefined;
    if (call.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = call.form;
    } else if (call.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(call.json);
    }
    return this.breaker.run(async () => {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${call.path}`, { method: call.method, headers, body, signal: AbortSignal.timeout(call.timeoutMs ?? this.timeoutMs) });
      } catch {
        throw unavailable('El ESB no respondió a tiempo.');
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      // Un 5xx que no es JSON (p. ej. un proxy delante) cuenta como ESB caído. Un 503 del ESB con su ProblemDetails (un MS.G
      // caído) o con el health DOWN NO abre este circuito: el ESB respondió, y lo de los demás MS.G debe seguir funcionando.
      if (response.status >= 500 && (!parsed || typeof parsed !== 'object')) throw unavailable('El ESB respondió con un error.');
      return { status: response.status, headers: response.headers, body: parsed as T, replayed: response.headers.get('idempotent-replayed') === 'true' };
    });
  }
}

/** `/ruta` + `?a=1&b=2` con los parámetros definidos (ya validados contra el contrato). */
export function withQuery(path: string, query: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null) search.set(name, String(value));
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}
