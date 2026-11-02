import { All, Controller, Inject, Logger, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { bearerToken, ProblemDetailsException } from '@ecoairlines/shared';
import { API_PREFIX, isPublic, publicProblem } from '@ecoairlines/shared/respuesta/index.js';
import { GATEWAY_RUNTIME, type GatewayRuntime } from '../runtime.js';
import { PARTNER_TOKEN_OPERATION } from './routes.js';

/** Cabeceras del cliente que viajan al MS (las del contrato v2). El resto (cookies, `Host`, etc.) no sale del gateway. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'authorization', 'content-type', 'idempotency-key', 'x-user-id', 'x-user-roles', 'x-device-fingerprint', 'user-agent'];
/** Cabeceras de la respuesta del MS que ve el cliente. Las de seguridad (helmet, CORS) y los identificadores las pone el gateway. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'location', 'retry-after', 'idempotent-replayed', 'www-authenticate', 'cache-control', 'pragma', 'expires', 'etag', 'last-modified'];

/**
 * Fachada REST del contrato v2 (PLAN.md §4.4): `/api/v2/vuelos/*` y `/api/v2/oauth2/token`, con el alias `/oauth2/token` en la
 * raíz mientras Booking no responda BKG-03. Por cada petición:
 * 1. busca la operación en la tabla cerrada (`404` si no existe, `405` con `Allow` si es otro método);
 * 2. en una operación protegida verifica el token con la JWKS de Identity: de usuario o de partner (`401` sin token, con uno
 *    inválido o vencido, o con un token de servicio). Los scopes, el dueño y el contrato los valida el MS, que vuelve a
 *    verificar el token (defensa en profundidad);
 * 3. `searchFlights`: límite por `X-Device-Fingerprint` (`429` con `Retry-After`);
 * 4. reenvía al MS de respuesta de su `x-microservice` y devuelve su respuesta. `X-Correlation-Id` va en TODA respuesta.
 */
@Controller()
export class RestController {
  private readonly logger = new Logger('REST');

  constructor(@Inject(GATEWAY_RUNTIME) private readonly runtime: GatewayRuntime) {}

  @All('api/v2/*path')
  contract(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.handle(request, response, request.path.slice(API_PREFIX.length) || '/');
  }

  /** Alias de `POST /api/v2/oauth2/token` (BKG-03: el `tokenUrl` del contrato es relativo). */
  @All('oauth2/token')
  tokenAlias(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.handle(request, response, '/oauth2/token');
  }

  private async handle(request: Request, response: Response, path: string): Promise<void> {
    const instance = request.originalUrl.split('?')[0]!;
    try {
      await this.forward(request, response, path);
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

  private async forward(request: Request, response: Response, path: string): Promise<void> {
    const { routes, verifier, limiter, upstreams, config } = this.runtime;
    const matched = routes.table.match(request.method, path);
    if (!matched) throw ProblemDetailsException.notFound('La ruta no existe.');
    if ('methodNotAllowed' in matched) {
      response.setHeader('Allow', matched.methodNotAllowed.join(', '));
      throw new ProblemDetailsException({ status: 405, code: 'VALIDATION_FAILED', title: `Método no permitido. Permitidos: ${matched.methodNotAllowed.join(', ')}.` });
    }
    const { operation } = matched;

    if (!isPublic(operation)) {
      const token = bearerToken(request);
      if (!token) throw new ProblemDetailsException({ status: 401, code: 'UNAUTHORIZED', title: 'Se requiere un token (Authorization: Bearer).' });
      const claims = await verifier.verify(token).catch(() => {
        throw new ProblemDetailsException({ status: 401, code: 'UNAUTHORIZED', title: 'El token no es válido o venció.' });
      });
      if (claims.token_use === 'service') throw new ProblemDetailsException({ status: 401, code: 'UNAUTHORIZED', title: 'Un token de servicio no se acepta aquí: use un token de partner o de usuario.' });
    }

    if (operation.operationId === 'searchFlights') {
      const fingerprint = request.header('x-device-fingerprint');
      const wait = fingerprint ? limiter.hit(`search:fp:${fingerprint}`, config.security.rateLimit.searchLimit) : undefined;
      if (wait !== undefined) throw new ProblemDetailsException({ status: 429, code: 'RATE_LIMIT_EXCEEDED', title: 'Demasiadas búsquedas.', detail: `Reintente en ${wait} s.`, retryAfterSeconds: wait });
    }

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.header(name);
      if (value !== undefined) headers[name] = value;
    }
    // Quién llamó (para el límite por IP de los MS, que confían en un salto: TRUST_PROXY=1).
    headers['x-forwarded-for'] = request.ip ?? '';
    headers['x-forwarded-proto'] = request.protocol;
    const query = request.originalUrl.includes('?') ? request.originalUrl.slice(request.originalUrl.indexOf('?')) : '';
    const body = Buffer.isBuffer(request.body) && request.body.length ? request.body : undefined;
    const upstreamPath = `${API_PREFIX}${operation.operationId === PARTNER_TOKEN_OPERATION ? '/oauth2/token' : path}${query}`;
    const result = await upstreams.send(routes.targets.get(operation.operationId)!, { method: request.method, path: upstreamPath, headers, ...(body ? { body } : {}) });

    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = result.headers.get(name);
      if (value !== null) response.setHeader(name, value);
    }
    response.status(result.status);
    if (result.body.length && result.status !== 204 && result.status !== 304) response.end(result.body);
    else response.end();
  }
}
