import { ProblemDetailsException, scopesOf, type TokenClaims, type TokenVerifier } from '@ecoairlines/shared';
import type { ResponseService } from '../config.js';
import type { Upstreams } from '../upstream.js';
import { forbidden, type Problem, problemError, unauthenticated } from './errors.js';

/**
 * Contexto de cada operación GraphQL (HTTP o WebSocket). La web usa **solo tokens de usuario** (D22, D23); el dueño es el
 * `sub` y lo resuelve el MS de respuesta con ese mismo token (ningún input acepta `ownerId`).
 */
export interface GqlContext {
  /** Token de usuario ya verificado (se reenvía al MS, que lo vuelve a verificar). */
  token?: string;
  claims?: TokenClaims;
  /** Por qué no hay usuario, para el error de `@auth`. */
  authProblem?: string;
  fingerprint?: string;
  ip?: string;
  /** X-Correlation-Id de una suscripción (WebSocket): cada consulta al feed lo reutiliza. En HTTP lo da el middleware. */
  correlationId?: string;
  ms: MsClient;
}

/** Lee `Authorization: Bearer` (HTTP) o `authorization` de `connectionParams` (graphql-ws) y lo verifica con la JWKS. */
export async function authenticateUser(authorization: string | undefined, verifier: TokenVerifier): Promise<Pick<GqlContext, 'token' | 'claims' | 'authProblem'>> {
  if (!authorization) return { authProblem: 'Se requiere un token de usuario (Authorization: Bearer).' };
  if (!authorization.startsWith('Bearer ') || !authorization.slice(7).trim()) return { authProblem: 'Authorization debe ser "Bearer <token>".' };
  const token = authorization.slice(7).trim();
  let claims: TokenClaims;
  try {
    claims = await verifier.verify(token);
  } catch {
    return { authProblem: 'El token no es válido o venció.' };
  }
  if (claims.token_use !== 'user') return { authProblem: 'GraphQL solo acepta tokens de usuario de la web (no de partner ni de servicio).' };
  return { token, claims };
}

/** `@auth(scopes)`: exige usuario y TODOS los scopes indicados. */
export function requireUser(context: GqlContext, scopes: string[]): TokenClaims {
  if (!context.claims) throw unauthenticated(context.authProblem ?? 'Se requiere un token de usuario.');
  const granted = scopesOf(context.claims);
  const missing = scopes.filter((scope) => !granted.includes(scope));
  if (missing.length) throw forbidden(`Falta el scope ${missing.join(' y ')}.`);
  return context.claims;
}

export interface MsCall {
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
}

export interface MsResult<T> {
  status: number;
  body: T;
}

/** Quita `null` y `undefined` de un input (GraphQL manda `null` cuando el campo opcional no se usa; el contrato REST no). */
export function clean<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clean) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, clean(v)])) as T;
  }
  return value;
}

/**
 * Llama a la operación REST de un MS de respuesta en nombre del usuario (su token, su huella y su IP). Un error del MS
 * (`ProblemDetails`) se lanza como error GraphQL con el mismo `code`.
 */
export class MsClient {
  constructor(
    private readonly upstreams: Upstreams,
    private readonly caller: { token?: string; fingerprint?: string; ip?: string },
  ) {}

  async call<T = any>(service: ResponseService, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, options: MsCall = {}): Promise<MsResult<T>> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(options.query ?? {})) if (value !== undefined && value !== null) query.set(name, String(value));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.caller.token) headers['authorization'] = `Bearer ${this.caller.token}`;
    if (this.caller.fingerprint) headers['x-device-fingerprint'] = this.caller.fingerprint;
    if (this.caller.ip) headers['x-forwarded-for'] = this.caller.ip;
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(clean(options.body));
    }
    const response = await this.upstreams
      .send(service, { method, path: `/api/v2${path}${query.size ? `?${query}` : ''}`, headers, ...(body !== undefined ? { body } : {}) })
      .catch((error: unknown) => {
        // El MS no respondió (red, plazo o circuito abierto): 503 PROVIDER_UNAVAILABLE.
        if (error instanceof ProblemDetailsException) throw problemError({ ...error.problem, ...(error.retryAfterSeconds !== undefined ? { retryAfter: error.retryAfterSeconds } : {}) });
        throw error;
      });
    const text = response.body.toString('utf8');
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (response.status >= 400) {
      const problem = (parsed && typeof parsed === 'object' ? parsed : {}) as Problem & { error_description?: string };
      const retryAfter = Number(response.headers.get('retry-after'));
      throw problemError({
        ...problem,
        status: response.status,
        title: problem.title ?? problem.error_description ?? `${service} respondió ${response.status}.`,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
      });
    }
    return { status: response.status, body: parsed as T };
  }
}
