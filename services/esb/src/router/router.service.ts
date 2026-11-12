import { Inject, Injectable, Logger } from '@nestjs/common';
import { applyAirportWrite } from '../clients/airport-catalog.js';
import { completeProblem, ProblemDetailsException } from '@ecoairlines/shared';
import type { Caller } from '../clients/rest.client.js';
import { FORWARDED_RESPONSE_HEADERS } from '../clients/rest.client.js';
import { UPSTREAMS, type Upstreams } from '../clients/upstreams.js';
import { REST_SERVICES, type RestService } from '../config/config.js';
import type { StoredResponse } from '../repositories/esb.store.js';
import { type IdempotentResult, IdempotencyService } from '../transversal/idempotency.service.js';
import { EVENTS_PUBLISHER, type EventsPublisher } from '../inbound/events-publisher.js';
import { routeEvent } from './route-events.js';
import { matchRoute, OFFERS_ROUTES, pathExists } from './routes.js';

export interface RouterRequest {
  method: string;
  /** Ruta del MS.G sin el prefijo `/router/<servicio>`, con su query tal cual llegó. */
  path: string;
  body: Buffer;
  contentType?: string;
  caller: Caller;
  idempotencyKey?: string;
  /** `instance` de un ProblemDetails generado aquí. */
  instance: string;
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Un error del ESB (o del cliente gRPC) como respuesta HTTP, para guardarla igual que una del MS.G. */
export function problemResponse(error: ProblemDetailsException, instance: string): StoredResponse {
  return {
    status: error.problem.status,
    headers: { 'content-type': 'application/problem+json', ...(error.retryAfterSeconds ? { 'retry-after': String(error.retryAfterSeconds) } : {}) },
    body: JSON.stringify(completeProblem(error.problem, instance)),
  };
}

/** El dueño de la clave de idempotencia: la clave de un cliente nunca devuelve la respuesta de otro. */
const scopeOf = (caller: Caller) => (caller.ownerId ? `owner:${caller.ownerId}` : caller.actorId ? `actor:${caller.actorId}` : 'anonymous');

/**
 * Enrutador (PLAN.md §4.2): reenvía la petición a UN MS.G si está en la tabla de rutas. Transversal: idempotencia en las
 * escrituras con `Idempotency-Key` (D6), correlation ID sin cambios y `X-Request-Id` nuevo por salto (D31), y errores de gRPC
 * traducidos a ProblemDetails v2 (los de los MS.G REST ya vienen así y se devuelven tal cual).
 */
@Injectable()
export class RouterService {
  private readonly logger = new Logger('Router');

  constructor(
    @Inject(UPSTREAMS) private readonly upstreams: Upstreams,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(EVENTS_PUBLISHER) private readonly events: EventsPublisher,
  ) {}

  /** Evento interno de una escritura que salió bien (user.*, partner.*, asistencia), al outbox. Si falla, el cambio ya ocurrió: se registra. */
  private async emit(operationId: string, params: Record<string, string>, request: RouterRequest, response: StoredResponse): Promise<void> {
    if (response.status < 200 || response.status >= 300) return;
    const parse = (text: string) => {
      try {
        return text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      } catch {
        return undefined;
      }
    };
    const body = parse(response.body);
    applyAirportWrite(operationId, params, body);
    const event = routeEvent({ operationId, params, request: parse(request.body.toString('utf8')), response: body, caller: request.caller });
    if (!event) return;
    await this.events.publish(event.event, event.ownerId).catch((error: unknown) => this.logger.error(`No se guardó ${event.event.type} en el outbox: ${error instanceof Error ? error.message : String(error)}`));
  }

  async rest(service: string, request: RouterRequest): Promise<IdempotentResult> {
    const [pathOnly] = request.path.split('?');
    if (!(REST_SERVICES as readonly string[]).includes(service)) throw notFound(`El ESB no enruta al servicio "${service}".`);
    const matched = matchRoute(service, request.method, pathOnly);
    if (!matched) {
      if (pathExists(service, pathOnly)) throw new ProblemDetailsException({ status: 405, code: 'METHOD_NOT_ALLOWED', title: `${request.method} ${pathOnly} no pasa por el enrutador (es un paso de saga o de composición).` });
      throw notFound(`El enrutador no tiene la ruta ${request.method} ${pathOnly} de ${service} (o es un paso de saga o de composición).`);
    }
    const client = this.upstreams.rest[service as RestService];
    const execute = async (): Promise<StoredResponse> => {
      try {
        const response = await client.request({
          method: request.method,
          path: request.path,
          ...(request.body.length ? { raw: { body: request.body, contentType: request.contentType ?? 'application/json' } } : {}),
          caller: request.caller,
          serviceToken: !matched.route.withoutServiceToken,
        });
        const headers: Record<string, string> = {};
        for (const name of FORWARDED_RESPONSE_HEADERS) {
          const value = response.headers.get(name);
          if (value) headers[name] = value;
        }
        const stored = { status: response.status, headers, body: response.body.toString('utf8') };
        await this.emit(matched.route.operationId, matched.params, request, stored);
        return stored;
      } catch (error) {
        if (error instanceof ProblemDetailsException) return problemResponse(error, request.instance);
        throw error;
      }
    };
    if (!WRITE.has(request.method)) return { ...(await execute()), replayed: false };
    const hash = IdempotencyService.hash(service, request.method, request.path, request.body);
    return this.idempotency.run(request.idempotencyKey, scopeOf(request.caller), hash, execute);
  }

  async offers(rpc: string, request: Omit<RouterRequest, 'method' | 'path'>): Promise<IdempotentResult> {
    if (!(OFFERS_ROUTES as readonly string[]).includes(rpc)) throw notFound(`El enrutador no expone el RPC ${rpc} de MS.G.Offers (o es un paso de saga).`);
    let message: Record<string, unknown>;
    try {
      message = request.body.length ? (JSON.parse(request.body.toString('utf8')) as Record<string, unknown>) : {};
    } catch {
      throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'El cuerpo no es JSON válido.' });
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'El cuerpo debe ser un objeto JSON.' });
    const execute = async (): Promise<StoredResponse> => {
      try {
        const result = await this.upstreams.offers.call(rpc, message, request.caller);
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) };
      } catch (error) {
        if (error instanceof ProblemDetailsException) return problemResponse(error, request.instance);
        throw error;
      }
    };
    // Las lecturas (Search, GetSeatMap, GetHold) no necesitan idempotencia; CreateHold y ReleaseHold sí, si llega la clave.
    if (rpc === 'Search' || rpc === 'GetSeatMap' || rpc === 'GetHold') return { ...(await execute()), replayed: false };
    return this.idempotency.run(request.idempotencyKey, scopeOf(request.caller), IdempotencyService.hash('offers', rpc, request.body), execute);
  }
}

const notFound = (title: string) => new ProblemDetailsException({ status: 404, code: 'NOT_FOUND', title });
