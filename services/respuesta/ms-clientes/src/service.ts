import { currentCorrelation } from '@ecoairlines/shared';
import { type EsbResponse, type Handler, replayHeaders, type Reply, type ResponseServiceDefinition } from '@ecoairlines/shared/respuesta/index.js';

/**
 * MS.Clientes (contract/ms-clientes.openapi.yaml): las 3 operaciones de webhooks del contrato v2, el token de partner
 * (`POST /oauth2/token`, el `tokenUrl` del contrato) y las propias de la web: registro, login y perfil.
 */
export const SERVICE = { name: 'ms-clientes', version: '1.0.0' };
export const CLIENT_ID = 'ECOAIRLINES_MS_CLIENTES';
export const DEFAULT_PORT = 5004;

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Un token o un secreto nunca se guarda en cachés (RFC 6749 §5.1): se respeta el `Cache-Control` de Identity. */
const cacheHeaders = (response: EsbResponse): Record<string, string> => {
  const value = response.headers.get('cache-control');
  return value ? { 'Cache-Control': value } : {};
};

// ------------------------------------------------------------------------------------------------- token de partner

const OAUTH_FIELDS = new Set(['grant_type', 'scope', 'client_id', 'client_secret']);

/** Error de OAuth2 (RFC 6749 §5.2): el formato de `/oauth2/token`, que no es ProblemDetails. */
const oauthError = (status: number, error: 'invalid_request' | 'invalid_client', description: string, basic = false): Reply => ({
  status,
  raw: true,
  body: { error, error_description: description, correlation_id: currentCorrelation()?.correlationId, timestamp: new Date().toISOString() },
  headers: { 'Cache-Control': 'no-store', ...(basic ? { 'WWW-Authenticate': 'Basic realm="ecoairlines"' } : {}) },
});

/**
 * El partner se autentica con `Authorization: Basic` (o con `client_id`/`client_secret` en el formulario, RFC 6749 §2.3.1).
 * Este MS llama al ESB con su propio token de servicio (como en todo el router; el ESB llama a Identity sin él), así que
 * convierte el Basic a `client_secret_post` (D43). Identity
 * valida todo lo demás y responde con su formato de error.
 */
const issuePartnerToken: Handler = async (context) => {
  const form = (context.body && typeof context.body === 'object' ? context.body : {}) as Record<string, unknown>;
  const unknown = Object.keys(form).filter((key) => !OAUTH_FIELDS.has(key));
  if (unknown.length) return oauthError(400, 'invalid_request', `Parámetros no permitidos: ${unknown.join(', ')}.`);
  if (Object.values(form).some((value) => typeof value !== 'string')) return oauthError(400, 'invalid_request', 'Cada parámetro aparece una sola vez.');
  const fields = new URLSearchParams(form as Record<string, string>);
  const authorization = context.request.header('authorization');
  const basic = authorization?.startsWith('Basic ') ?? false;
  if (basic) {
    if (fields.has('client_id') || fields.has('client_secret')) return oauthError(400, 'invalid_request', 'Las credenciales del cliente llegaron en la cabecera y en el cuerpo.');
    const decoded = Buffer.from(authorization!.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    try {
      if (separator < 1) throw new Error('sin separador');
      fields.set('client_id', decodeURIComponent(decoded.slice(0, separator)));
      fields.set('client_secret', decodeURIComponent(decoded.slice(separator + 1)));
    } catch {
      return oauthError(401, 'invalid_client', 'Credenciales del cliente inválidas.', true);
    }
  }
  const response = await context.esbRaw<Any>({ method: 'POST', path: '/router/identity/oauth2/token', form: fields.toString() });
  const headers = { ...cacheHeaders(response), ...(response.status === 401 && basic ? { 'WWW-Authenticate': 'Basic realm="ecoairlines"' } : {}) };
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) Object.assign(headers, { 'Retry-After': retryAfter });
  // 429 es ProblemDetails (el límite de intentos); el resto, la respuesta o el error OAuth2 de Identity tal cual.
  return response.status === 429
    ? { status: 429, body: response.body, headers, contentType: 'application/problem+json', raw: true }
    : { status: response.status, body: response.body, headers, raw: response.status >= 400 };
};

// ------------------------------------------------------------------------------------------------------------ handlers

export const clientesHandlers: Record<string, Handler> = {
  /** Las suscripciones son del partner completo (`partner:<clientId>`), como las guarda Webhooks. El `secret` nunca se devuelve. */
  listWebhooks: async (context) => {
    const response = await context.esb({ method: 'GET', path: '/router/webhooks/subscriptions', ownerId: context.partnerOwner() });
    return { status: 200, body: response.body };
  },

  createWebhook: async (context) => {
    const response = await context.esb({ method: 'POST', path: '/router/webhooks/subscriptions', json: context.body, ownerId: context.partnerOwner(), idempotencyKey: context.headers['idempotency-key'] });
    return { status: 201, body: response.body, headers: replayHeaders(response.replayed) };
  },

  /** Propia de la web (V2.14): las mismas suscripciones con `secretHint` (últimos 4 caracteres), que `listWebhooks` no publica. */
  listOwnWebhooks: async (context) => {
    const response = await context.esb({ method: 'GET', path: '/router/webhooks/subscriptions', ownerId: context.partnerOwner() });
    return { status: 200, body: response.body };
  },

  deleteWebhook: async (context) => {
    await context.esb({ method: 'DELETE', path: `/router/webhooks/subscriptions/${context.params['id']}`, ownerId: context.partnerOwner() });
    return { status: 204 };
  },

  issuePartnerToken,

  register: async (context) => {
    const response = await context.esb({ method: 'POST', path: '/router/identity/auth/register', json: context.body });
    return { status: 201, body: response.body, headers: cacheHeaders(response) };
  },

  login: async (context) => {
    const response = await context.esb({ method: 'POST', path: '/router/identity/auth/login', json: context.body });
    return { status: 200, body: response.body, headers: cacheHeaders(response) };
  },

  /** Solo token de usuario (`UserJwt`): un partner recibe `403`. El dueño del perfil es el `sub`. */
  getMyProfile: async (context) => {
    const response = await context.esb({ method: 'GET', path: '/router/customers/profile', ownerId: context.owner() });
    return { status: 200, body: response.body };
  },

  saveMyProfile: async (context) => {
    const response = await context.esb({ method: 'PUT', path: '/router/customers/profile', json: context.body, ownerId: context.owner() });
    return { status: 200, body: response.body };
  },
};

export function definition(_env: NodeJS.ProcessEnv = process.env): ResponseServiceDefinition {
  return { ...SERVICE, contract: 'ms-clientes.openapi.yaml', handlers: clientesHandlers, selfValidated: ['issuePartnerToken'] };
}
