import { CircuitBreaker } from '@ecoairlines/shared/clients/circuit-breaker.js';
import { correlationHeaders, ProblemDetailsException } from '@ecoairlines/shared';
import { type GatewayConfig, RESPONSE_SERVICES, type ResponseService } from './config.js';

/**
 * Llamadas del gateway a los 5 MS de respuesta (la única red que conoce: nunca el ESB ni un MS.G). Cada llamada lleva el mismo
 * `X-Correlation-Id` del proceso y un `X-Request-Id` nuevo para el salto (D31), tiene plazo y pasa por el circuit breaker de
 * ese MS: si no responde (red o plazo), `503 PROVIDER_UNAVAILABLE` con `Retry-After`. Una respuesta del MS, aunque sea un
 * error, se devuelve tal cual: el MS ya respondió.
 */
export interface UpstreamRequest {
  method: string;
  /** Ruta con `/api/v2` y la query, p. ej. `/api/v2/vuelos/bookings?limit=5`. */
  path: string;
  headers: Record<string, string>;
  body?: Buffer | string;
}

export interface UpstreamResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

const withoutIds = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !/^x-(correlation|request)-id$/i.test(name)));

export class Upstreams {
  private readonly breakers = new Map<ResponseService, CircuitBreaker>();

  constructor(private readonly config: Pick<GatewayConfig, 'upstreams' | 'upstreamTimeoutMs'>) {
    for (const service of RESPONSE_SERVICES) this.breakers.set(service, new CircuitBreaker(service));
  }

  breaker(service: ResponseService): CircuitBreaker {
    return this.breakers.get(service)!;
  }

  async send(service: ResponseService, request: UpstreamRequest): Promise<UpstreamResponse> {
    return this.breaker(service).run(async () => {
      let response: Response;
      try {
        response = await fetch(`${this.config.upstreams[service]}${request.path}`, {
          method: request.method,
          // Los dos identificadores los pone siempre el gateway (nunca dos valores de la misma cabecera).
          headers: { ...withoutIds(request.headers), ...correlationHeaders() },
          ...(request.body !== undefined && request.method !== 'GET' && request.method !== 'HEAD' ? { body: typeof request.body === 'string' ? request.body : new Uint8Array(request.body) } : {}),
          redirect: 'manual',
          signal: AbortSignal.timeout(this.config.upstreamTimeoutMs),
        });
        return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
      } catch {
        throw new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title: `${service} no respondió a tiempo.`, retryAfterSeconds: 5 });
      }
    });
  }
}
