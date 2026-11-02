/**
 * Configuración de MS.G.FlightStatus. En producción `IDENTITY_JWKS_URL` y `BUS_URL` son obligatorias (sin el bus no llega el
 * horario: `schedule.published`, D4). La dirección de Identity llega por configuración, nunca escrita en el código.
 */
export interface FlightStatusConfig {
  port: number;
  databaseUrl?: string;
  busUrl?: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
}

export const FLIGHT_STATUS_CONFIG = Symbol('FLIGHT_STATUS_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FlightStatusConfig {
  const missing = ['IDENTITY_JWKS_URL', 'BUS_URL'].filter((name) => env['NODE_ENV'] === 'production' && !env[name]?.trim());
  if (missing.length) throw new Error(`Configuración inválida de ms-g-flight-status:\n - falta ${missing.join('\n - falta ')}`);
  return {
    port: Number(env['PORT'] ?? 4005),
    databaseUrl: env['DATABASE_URL']?.trim() || undefined,
    busUrl: env['BUS_URL']?.trim() || undefined,
    jwksUrl: env['IDENTITY_JWKS_URL']?.trim() || 'http://localhost:4001/.well-known/jwks.json',
    issuer: env['IDENTITY_ISSUER'] ?? 'ecoairlines-identity',
    audience: env['IDENTITY_AUDIENCE'] ?? 'ecoairlines',
  };
}
