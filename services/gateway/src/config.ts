import { loadSecurityConfig, type SecurityConfig } from '@ecoairlines/shared/respuesta/index.js';

/** Los 5 MS de respuesta (el `x-microservice` del contrato v2 y de `gateway.graphql`). */
export const RESPONSE_SERVICES = ['MS.Vuelos', 'MS.Reservas', 'MS.Postventa', 'MS.Clientes', 'MS.Admin'] as const;
export type ResponseService = (typeof RESPONSE_SERVICES)[number];

/** Contrato de cada MS de respuesta, variable de su URL y puerto local (CLAUDE.md). */
export const SERVICE_INFO: Record<ResponseService, { contract: string; urlVariable: string; localPort: number }> = {
  'MS.Vuelos': { contract: 'ms-vuelos.openapi.yaml', urlVariable: 'MS_VUELOS_URL', localPort: 5001 },
  'MS.Reservas': { contract: 'ms-reservas.openapi.yaml', urlVariable: 'MS_RESERVAS_URL', localPort: 5002 },
  'MS.Postventa': { contract: 'ms-postventa.openapi.yaml', urlVariable: 'MS_POSTVENTA_URL', localPort: 5003 },
  'MS.Clientes': { contract: 'ms-clientes.openapi.yaml', urlVariable: 'MS_CLIENTES_URL', localPort: 5004 },
  'MS.Admin': { contract: 'ms-admin.openapi.yaml', urlVariable: 'MS_ADMIN_URL', localPort: 5005 },
};

export interface GatewayConfig {
  port: number;
  production: boolean;
  /** URL base de cada MS de respuesta, sin `/api/v2` (p. ej. `http://ms-vuelos:8080`). */
  upstreams: Record<ResponseService, string>;
  /** Plazo de una llamada a un MS. Las sagas esperan hasta 4,5 s en el ESB (D36) y el MS consulta su estado después. */
  upstreamTimeoutMs: number;
  jwksUrl: string;
  issuer: string;
  audience: string;
  security: SecurityConfig;
  /** Swagger UI en `/api/docs` (por defecto sí: es la documentación del contrato v2 para Booking). */
  docsEnabled: boolean;
  /** Introspección de GraphQL: solo en desarrollo (contrato `gateway.graphql`), salvo que se pida. */
  introspection: boolean;
  /** Cada cuánto consulta la suscripción `bookingEvents` el feed de eventos de MS.Vuelos (D47). */
  subscriptionPollMs: number;
  /** T-5: cada cuánto consulta el gateway el recorrido y el mapa en vivo mientras hay suscriptores. */
  liveTracePollMs: number;
  liveMapPollMs: number;
}

const flag = (env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean => {
  const value = env[name]?.trim();
  if (value === undefined || value === '') return fallback;
  if (value !== 'true' && value !== 'false') throw new Error(`${name} debe ser "true" o "false".`);
  return value === 'true';
};

const positive = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const value = env[name]?.trim();
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} debe ser un entero positivo.`);
  return parsed;
};

/**
 * Configuración del gateway. En producción son obligatorias las URL de los 5 MS de respuesta y la JWKS de Identity; en local
 * valen los puertos de desarrollo (5001–5005 y 4001).
 */
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const production = env['NODE_ENV'] === 'production';
  const required = [...RESPONSE_SERVICES.map((service) => SERVICE_INFO[service].urlVariable), 'IDENTITY_JWKS_URL'];
  const missing = required.filter((name) => production && !env[name]?.trim());
  if (missing.length) throw new Error(`Configuración inválida del gateway:\n - falta ${missing.join('\n - falta ')}`);
  const url = (name: string, fallback: string) => (env[name]?.trim() || fallback).replace(/\/+$/, '');
  const upstreams = Object.fromEntries(
    RESPONSE_SERVICES.map((service) => [service, url(SERVICE_INFO[service].urlVariable, `http://localhost:${SERVICE_INFO[service].localPort}`)]),
  ) as Record<ResponseService, string>;
  for (const [service, value] of Object.entries(upstreams)) {
    if (!/^https?:\/\/[^/]+$/.test(value)) throw new Error(`La URL de ${service} debe ser http(s)://host[:puerto], sin ruta: ${value}`);
  }
  return {
    port: positive(env, 'PORT', 8080),
    production,
    upstreams,
    upstreamTimeoutMs: positive(env, 'UPSTREAM_TIMEOUT_MS', 15_000),
    jwksUrl: env['IDENTITY_JWKS_URL']?.trim() || 'http://localhost:4001/.well-known/jwks.json',
    issuer: env['IDENTITY_ISSUER'] ?? 'ecoairlines-identity',
    audience: env['IDENTITY_AUDIENCE'] ?? 'ecoairlines',
    security: loadSecurityConfig(env),
    docsEnabled: flag(env, 'DOCS_ENABLED', true),
    introspection: flag(env, 'GRAPHQL_INTROSPECTION', !production),
    subscriptionPollMs: positive(env, 'SUBSCRIPTION_POLL_MS', 3_000),
    // 10/11: cada consulta pide trazas a Tempo; cada 2 s ahogaba la VM de 4 GB.
    liveTracePollMs: positive(env, 'LIVE_TRACE_POLL_MS', 5_000),
    liveMapPollMs: positive(env, 'LIVE_MAP_POLL_MS', 10_000),
  };
}
