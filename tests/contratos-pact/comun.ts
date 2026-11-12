import { generateKeyPairSync } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signJwt, type TokenClaims, type TokenVerifier, verifyJwt } from '@ecoairlines/shared';

/** Lo común de las pruebas de contrato con Pact (CT-1). */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Los contratos generados se versionan en el repositorio: el proveedor los verifica sin un Pact Broker (decisión P-2). */
export const PACT_DIR = resolve(ROOT, 'contract/pacts');
export const pactFile = (consumer: string, provider: string) => resolve(PACT_DIR, `${consumer}-${provider}.json`);

/** Nombres de los participantes (aparecen en los archivos y en los reportes). */
export const PARTICIPANTES = {
  esb: 'esb',
  msRespuesta: 'ms-respuesta',
  identity: 'ms-g-identity',
  bookings: 'ms-g-bookings',
  offers: 'ms-g-offers',
  webhooks: 'ms-g-webhooks',
} as const;

/** El consumidor no conoce el token real: lo pide Identity. En el contrato basta con que sea un `Bearer`. */
export const TOKEN_DE_EJEMPLO = 'token-de-servicio-de-ejemplo';
export const tokenFijo = { token: async () => TOKEN_DE_EJEMPLO };

/** Datos de ejemplo que comparten un contrato y su verificación (el estado del proveedor los crea). */
export const RESERVA_ID = '5f1e6a0c-2b7d-4c3e-9f10-1a2b3c4d5e6f';
export const DUENO_RESERVA = 'partner:BOOKING_PROTOTIPO:usr-pact';
export const SAGA_COMPLETADA = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const SAGA_COMPENSADA = '8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';

// ------------------------------------------------------------------------------------------------ proveedor
const ISSUER = { issuer: 'ecoairlines-identity', audience: 'ecoairlines' };
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** Firma un token de servicio válido para el proveedor (el que en producción emitiría Identity). */
export const tokenDeServicio = (sub: string, scope: string) => `Bearer ${signJwt({ sub, token_use: 'service', scope }, keys.privateKey, { ...ISSUER, ttlSeconds: 600 }).token}`;

/** Verificador del proveedor con la misma clave (en producción, la JWKS de Identity). */
export const verificador: TokenVerifier = { verify: async (token: string): Promise<TokenClaims> => verifyJwt(token, () => keys.publicKey, ISSUER) };
