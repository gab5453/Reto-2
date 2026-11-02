/**
 * Configuración de MS.G.CheckIn por variables de entorno. En producción `IDENTITY_JWKS_URL` es obligatoria (la dirección de
 * Identity llega por configuración: un MS.G no nombra a otro en el código).
 */
export interface CheckInConfig {
  port: number;
  databaseUrl?: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
}

export const CHECK_IN_CONFIG = Symbol('BOOKINGS_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CheckInConfig {
  const jwksUrl = env['IDENTITY_JWKS_URL']?.trim();
  if (env['NODE_ENV'] === 'production' && !jwksUrl) throw new Error('Configuración inválida de ms-g-check-in:\n - falta IDENTITY_JWKS_URL');
  return {
    port: Number(env['PORT'] ?? 4007),
    databaseUrl: env['DATABASE_URL']?.trim() || undefined,
    jwksUrl: jwksUrl ?? 'http://localhost:4001/.well-known/jwks.json',
    issuer: env['IDENTITY_ISSUER'] ?? 'ecoairlines-identity',
    audience: env['IDENTITY_AUDIENCE'] ?? 'ecoairlines',
  };
}
