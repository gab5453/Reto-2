/**
 * Configuración de MS.G.Bookings por variables de entorno. En producción `IDENTITY_JWKS_URL` es obligatoria (la dirección de
 * Identity llega por configuración: un MS.G no nombra a otro en el código).
 */
export interface BookingsConfig {
  port: number;
  databaseUrl?: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
}

export const BOOKINGS_CONFIG = Symbol('BOOKINGS_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BookingsConfig {
  const jwksUrl = env['IDENTITY_JWKS_URL']?.trim();
  if (env['NODE_ENV'] === 'production' && !jwksUrl) throw new Error('Configuración inválida de ms-g-bookings:\n - falta IDENTITY_JWKS_URL');
  return {
    port: Number(env['PORT'] ?? 4006),
    databaseUrl: env['DATABASE_URL']?.trim() || undefined,
    jwksUrl: jwksUrl ?? 'http://localhost:4001/.well-known/jwks.json',
    issuer: env['IDENTITY_ISSUER'] ?? 'ecoairlines-identity',
    audience: env['IDENTITY_AUDIENCE'] ?? 'ecoairlines',
  };
}
