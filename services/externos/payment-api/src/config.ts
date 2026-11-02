/**
 * Configuración de la Payment API simulada (contract/payment-api.openapi.yaml). Es un sistema externo con sus propias claves:
 * `pk_test_…` para el navegador y `sk_test_…` para el ESB. En producción las dos y `DATABASE_URL` son obligatorias.
 */
export interface PaymentApiConfig {
  port: number;
  production: boolean;
  databaseUrl?: string;
  publishableKey: string;
  secretKey: string;
  /** Orígenes del navegador (la web). Nunca `*`. */
  corsOrigins: string[];
  /** Tarjeta "pendiente": cuánto tarda en autorizarse (contrato: ~30 s). */
  pendingMs: number;
  /** Una autorización sin capturar vence a los 30 min. */
  authorizationTtlMs: number;
  /** Un token de tarjeta vence a los 15 min. */
  methodTtlMs: number;
  /** Intentos por minuto y por IP en las operaciones del navegador (contra pruebas masivas de tarjetas). */
  browserLimitPerMinute: number;
  trustProxy: boolean | number;
}

export const PAYMENT_API_CONFIG = Symbol('PAYMENT_API_CONFIG');

const DEV = { publishableKey: 'pk_test_dev_solo_local_ecoairlines_0001', secretKey: 'sk_test_dev_solo_local_ecoairlines_0001' };

const positive = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} debe ser un entero positivo.`);
  return parsed;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PaymentApiConfig {
  const production = env['NODE_ENV'] === 'production';
  const errors = ['DATABASE_URL', 'PAYMENT_PUBLISHABLE_KEY', 'PAYMENT_SECRET_KEY'].filter((name) => production && !env[name]?.trim()).map((name) => `falta ${name}`);
  const publishableKey = env['PAYMENT_PUBLISHABLE_KEY']?.trim() || DEV.publishableKey;
  const secretKey = env['PAYMENT_SECRET_KEY']?.trim() || DEV.secretKey;
  if (!/^pk_test_[A-Za-z0-9_-]{16,}$/.test(publishableKey)) errors.push('PAYMENT_PUBLISHABLE_KEY debe empezar con pk_test_ y tener 16+ caracteres más');
  if (!/^sk_test_[A-Za-z0-9_-]{16,}$/.test(secretKey)) errors.push('PAYMENT_SECRET_KEY debe empezar con sk_test_ y tener 16+ caracteres más');
  if (production && (publishableKey === DEV.publishableKey || secretKey === DEV.secretKey)) errors.push('en producción las claves no pueden ser las de desarrollo');
  const corsOrigins = (env['CORS_ORIGINS'] ?? (production ? '' : 'http://localhost:5173')).split(',').map((o) => o.trim()).filter(Boolean);
  if (corsOrigins.includes('*')) errors.push('CORS_ORIGINS no admite "*"');
  if (errors.length) throw new Error(`Configuración inválida de payment-api:\n - ${errors.join('\n - ')}`);
  const trust = env['TRUST_PROXY'];
  return {
    port: Number(env['PORT'] ?? 4010),
    production,
    databaseUrl: env['DATABASE_URL']?.trim() || undefined,
    publishableKey,
    secretKey,
    corsOrigins,
    pendingMs: positive(env, 'PAYMENT_PENDING_MS', 30_000),
    authorizationTtlMs: positive(env, 'PAYMENT_AUTHORIZATION_TTL_MS', 30 * 60_000),
    methodTtlMs: positive(env, 'PAYMENT_METHOD_TTL_MS', 15 * 60_000),
    browserLimitPerMinute: positive(env, 'PAYMENT_BROWSER_LIMIT', 20),
    trustProxy: trust === 'true' ? true : trust && /^\d+$/.test(trust) ? Number(trust) : false,
  };
}
