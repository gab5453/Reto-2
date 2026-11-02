import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { RESPONSE_CLIENT_IDS, type ResponseClientId } from '../domain/model.js';

/**
 * Configuración de MS.G.Identity por variables de entorno. En producción (NODE_ENV=production) los secretos son
 * OBLIGATORIOS: sin ellos el servicio no arranca (los valores por defecto solo sirven en local y están en el repositorio).
 */
export interface IdentityConfig {
  port: number;
  databaseUrl?: string;
  issuer: string;
  audience: string;
  tokenTtlSeconds: number;
  /** Clave privada RS256 vigente y, durante una rotación, la pública anterior (se sigue publicando en la JWKS). */
  signingKey: KeyObject;
  previousPublicKeys: KeyObject[];
  ephemeralKey: boolean;
  adminPassword: string;
  bookingClientSecret: string;
  esbClientSecret: string;
  /** Secreto de cada MS de respuesta (D44): `ECOAIRLINES_MS_VUELOS` → `MS_VUELOS_CLIENT_SECRET`. */
  responseClientSecrets: Record<ResponseClientId, string>;
  /** Intentos por minuto en login, registro y /oauth2/token. */
  attemptsPerMinute: number;
  /** Clientes de prueba (demo, maría, luis) con claves conocidas: en local sí; en producción solo con SEED_DEMO_USERS=true. */
  seedDemoUsers: boolean;
}

export const IDENTITY_CONFIG = Symbol('IDENTITY_CONFIG');

const DEV = {
  adminPassword: 'EcoAdmin2026',
  bookingClientSecret: 'secreto-booking-dev-solo-local-0001',
  esbClientSecret: 'secreto-esb-dev-solo-local-0001',
};

/** `ECOAIRLINES_MS_VUELOS` → `MS_VUELOS_CLIENT_SECRET` (la misma variable que lee ese MS de respuesta). */
export const responseSecretVariable = (clientId: string) => `${clientId.replace(/^ECOAIRLINES_/, '')}_CLIENT_SECRET`;
/** Secreto de desarrollo, p. ej. `secreto-ms-vuelos-dev-solo-local-0001` (solo local; en producción es obligatorio). */
export const devResponseSecret = (clientId: string) => `secreto-${clientId.replace(/^ECOAIRLINES_/, '').toLowerCase().replace(/_/g, '-')}-dev-solo-local-0001`;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const production = env['NODE_ENV'] === 'production';
  const errors: string[] = [];
  // Secretos de máquina: mínimo 16 caracteres. ADMIN_PASSWORD es una contraseña humana: mínimo 8, como `Password` del contrato.
  const secret = (name: string, fallback: string, minLength = 16): string => {
    const value = env[name]?.trim();
    if (value) {
      if (value.length < minLength) errors.push(`${name} debe tener al menos ${minLength} caracteres`);
      return value;
    }
    if (production) errors.push(`falta ${name}`);
    return fallback;
  };

  let signingKey: KeyObject;
  let ephemeralKey = false;
  const pem = env['IDENTITY_PRIVATE_KEY']?.replace(/\\n/g, '\n');
  if (pem) {
    signingKey = createPrivateKey(pem);
  } else {
    if (production) errors.push('falta IDENTITY_PRIVATE_KEY (clave privada RSA en PEM)');
    // En local: clave nueva en cada arranque. Los servicios la vuelven a leer de la JWKS al ver un kid desconocido.
    signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    ephemeralKey = true;
  }
  const previousPublicKeys = env['IDENTITY_PREVIOUS_PUBLIC_KEY']?.trim()
    ? [createPublicKey(env['IDENTITY_PREVIOUS_PUBLIC_KEY'].replace(/\\n/g, '\n'))]
    : [];

  const config: IdentityConfig = {
    port: Number(env['PORT'] ?? 4001),
    databaseUrl: env['DATABASE_URL']?.trim() || undefined,
    issuer: env['IDENTITY_ISSUER'] ?? 'ecoairlines-identity',
    audience: env['IDENTITY_AUDIENCE'] ?? 'ecoairlines',
    tokenTtlSeconds: Number(env['TOKEN_TTL_SECONDS'] ?? 3600),
    signingKey,
    previousPublicKeys,
    ephemeralKey,
    adminPassword: secret('ADMIN_PASSWORD', DEV.adminPassword, 8),
    bookingClientSecret: secret('BOOKING_CLIENT_SECRET', DEV.bookingClientSecret),
    esbClientSecret: secret('ESB_CLIENT_SECRET', DEV.esbClientSecret),
    responseClientSecrets: Object.fromEntries(
      RESPONSE_CLIENT_IDS.map((clientId) => [clientId, secret(responseSecretVariable(clientId), devResponseSecret(clientId))]),
    ) as Record<ResponseClientId, string>,
    attemptsPerMinute: Number(env['AUTH_ATTEMPTS_PER_MINUTE'] ?? 10),
    seedDemoUsers: env['SEED_DEMO_USERS'] ? env['SEED_DEMO_USERS'] === 'true' : !production,
  };
  if (errors.length) throw new Error(`Configuración inválida de ms-g-identity:\n - ${errors.join('\n - ')}`);
  return config;
}
