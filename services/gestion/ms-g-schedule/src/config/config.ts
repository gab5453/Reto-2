/**
 * Configuración de MS.G.Schedule por variables de entorno. En producción (NODE_ENV=production) `IDENTITY_JWKS_URL` es
 * obligatoria. La URL de Identity llega por configuración: un MS.G no nombra a otro en el código (prueba de arquitectura).
 */
export interface ScheduleConfig {
  port: number;
  databaseUrl?: string;
  /** JWKS de MS.G.Identity para verificar el token de servicio del ESB. */
  jwksUrl: string;
  issuer: string;
  audience: string;
  /** Código con que la aerolínea se identifica ante Booking en el acuerdo de promociones. */
  providerCode: string;
  /** Desfase de la "fecha de hoy" de la aerolínea (Ecuador, UTC−5) para validar la vigencia de un acuerdo. */
  utcOffsetMinutes: number;
}

export const SCHEDULE_CONFIG = Symbol('SCHEDULE_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ScheduleConfig {
  const production = env['NODE_ENV'] === 'production';
  const jwksUrl = env['IDENTITY_JWKS_URL']?.trim();
  if (production && !jwksUrl) throw new Error('Configuración inválida de ms-g-schedule:\n - falta IDENTITY_JWKS_URL');
  return {
    port: Number(env['PORT'] ?? 4004),
    databaseUrl: env['DATABASE_URL']?.trim() || undefined,
    jwksUrl: jwksUrl ?? 'http://localhost:4001/.well-known/jwks.json',
    issuer: env['IDENTITY_ISSUER'] ?? 'ecoairlines-identity',
    audience: env['IDENTITY_AUDIENCE'] ?? 'ecoairlines',
    providerCode: env['PROMOTIONS_PROVIDER_CODE'] ?? 'NODE_VUE_ECOAIRLINES',
    utcOffsetMinutes: -300,
  };
}
