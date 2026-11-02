/**
 * Configuración de MS.G.Webhooks. En producción son obligatorias `IDENTITY_JWKS_URL`, `BUS_URL` (de ahí llegan los eventos) y
 * `WEBHOOKS_ENCRYPTION_KEY` (cifra los secretos de las suscripciones); las URL de suscripción deben ser https y públicas.
 */
export interface WebhooksConfig {
  port: number;
  production: boolean;
  databaseUrl?: string;
  busUrl?: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
  encryptionKey: string;
  /**
   * URLs de suscripción `http` y de red privada (contra SSRF, solo en local: el simulador de Booking vive en la red de Docker).
   * Fuera de producción siempre; en producción solo si se pide explícitamente con WEBHOOKS_ALLOW_PRIVATE_URLS=true.
   */
  allowPrivateUrls: boolean;
  /** Cada cuánto se revisan las entregas pendientes (ms). */
  dispatchIntervalMs: number;
}

export const WEBHOOKS_CONFIG = Symbol('WEBHOOKS_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WebhooksConfig {
  const production = env['NODE_ENV'] === 'production';
  const missing = ['IDENTITY_JWKS_URL', 'BUS_URL', 'WEBHOOKS_ENCRYPTION_KEY'].filter((name) => production && !env[name]?.trim());
  if (missing.length) throw new Error(`Configuración inválida de ms-g-webhooks:\n - falta ${missing.join('\n - falta ')}`);
  const key = env['WEBHOOKS_ENCRYPTION_KEY']?.trim();
  if (key && key.length < 32) throw new Error('Configuración inválida de ms-g-webhooks:\n - WEBHOOKS_ENCRYPTION_KEY debe tener al menos 32 caracteres');
  return {
    port: Number(env['PORT'] ?? 4003),
    production,
    databaseUrl: env['DATABASE_URL']?.trim() || undefined,
    busUrl: env['BUS_URL']?.trim() || undefined,
    jwksUrl: env['IDENTITY_JWKS_URL']?.trim() || 'http://localhost:4001/.well-known/jwks.json',
    issuer: env['IDENTITY_ISSUER'] ?? 'ecoairlines-identity',
    audience: env['IDENTITY_AUDIENCE'] ?? 'ecoairlines',
    encryptionKey: key ?? 'clave-de-cifrado-de-desarrollo-solo-local-0001',
    allowPrivateUrls: !production || env['WEBHOOKS_ALLOW_PRIVATE_URLS'] === 'true',
    dispatchIntervalMs: Number(env['WEBHOOK_DISPATCH_INTERVAL_MS'] ?? 2_000),
  };
}
