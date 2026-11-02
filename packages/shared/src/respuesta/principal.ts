import type { Request } from 'express';
import { bearerToken, type TokenVerifier } from '../auth/service-token.guard.js';
import { scopesOf, type TokenClaims } from '../auth/jwt.js';
import { ProblemDetailsException } from '../problem-details/problem-details.js';
import type { Operation } from './contract.js';

/**
 * Quién llama a un MS de respuesta (D22, D29, D41; PLAN.md §4.3 y §4.10):
 * - **usuario** de la web (`token_use = user`): equivale al `BearerAuth` del contrato. Dueño = su `sub`; `X-User-Id` se ignora.
 * - **partner** (`token_use = partner`, Booking): dueño = `partner:<clientId>:<X-User-Id>` (o `partner:<clientId>` sin él).
 *   Solo con este token se lee `X-User-Id`.
 * - un **token de servicio** (del ESB o de otro MS) se rechaza con `401`: solo lo aceptan el ESB y los MS.G.
 * El dueño **nunca** sale del cuerpo.
 */
export type Principal =
  | { kind: 'anonymous' }
  | { kind: 'user'; sub: string; role?: string; scopes: string[] }
  | { kind: 'partner'; clientId: string; scopes: string[]; userId?: string; fingerprint?: string; userRoles?: string };

/** `X-User-Id`: el formato que acepta el ESB en `partner:<clientId>:<X-User-Id>` (visibles, sin espacios). */
const USER_ID = /^[\x21-\x7E]{1,120}$/;
const CLIENT_ID = /^[A-Z][A-Z0-9_]{2,39}$/;

/** Esquemas de seguridad de los contratos y qué tipo de token aceptan. */
const SCHEMES: Record<string, ('user' | 'partner')[]> = {
  PartnerOAuth2: ['partner', 'user'], // el contrato del grupo: Booking, o la web con BearerAuth equivalente (mismos scopes)
  BearerAuth: ['user'],
  UserJwt: ['user'],
};

const unauthorized = (title: string) => new ProblemDetailsException({ status: 401, code: 'UNAUTHORIZED', title });
const forbidden = (title: string) => new ProblemDetailsException({ status: 403, code: 'FORBIDDEN', title });

/** Sin autenticación: `security: []`, un requisito vacío `{}`, o solo credenciales del cliente (`/oauth2/token`). */
export function isPublic(operation: Operation): boolean {
  return !operation.security.length || operation.security.some((requirement) => !Object.keys(requirement).length);
}

export async function authenticate(operation: Operation, request: Request, verifier: TokenVerifier): Promise<Principal> {
  if (isPublic(operation)) return { kind: 'anonymous' };
  const token = bearerToken(request);
  if (!token) throw unauthorized('Se requiere un token (Authorization: Bearer).');
  let claims: TokenClaims;
  try {
    claims = await verifier.verify(token);
  } catch {
    throw unauthorized('El token no es válido o venció.');
  }
  if (claims.token_use === 'service') throw unauthorized('Un token de servicio no se acepta aquí: use un token de usuario o de partner.');
  const kind = claims.token_use;
  const scopes = scopesOf(claims);
  const usable = operation.security.filter((requirement) => Object.keys(requirement).some((scheme) => SCHEMES[scheme]?.includes(kind)));
  if (!usable.length) throw forbidden(kind === 'partner' ? 'Esta operación es solo de la web de EcoAirlines (token de usuario).' : 'Esta operación no acepta un token de usuario.');
  const missing = usable.map((requirement) => Object.values(requirement).flat().filter((scope) => !scopes.includes(scope)));
  if (!missing.some((list) => !list.length)) throw forbidden(`Falta el scope ${[...new Set(missing.flat())].join(' o ')}.`);

  if (kind === 'user') return { kind, sub: claims.sub, scopes, ...(claims.role ? { role: claims.role } : {}) };
  if (!CLIENT_ID.test(claims.sub)) throw unauthorized('El token de partner no tiene un client_id válido.');
  const userId = request.header('x-user-id');
  if (userId !== undefined && !USER_ID.test(userId)) {
    throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'Cabecera inválida.', invalidParams: [{ name: 'X-User-Id', reason: 'hasta 120 caracteres visibles, sin espacios' }] });
  }
  const fingerprint = request.header('x-device-fingerprint');
  if (fingerprint !== undefined && !USER_ID.test(fingerprint)) {
    throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'Cabecera inválida.', invalidParams: [{ name: 'X-Device-Fingerprint', reason: 'hasta 120 caracteres visibles, sin espacios' }] });
  }
  const userRoles = request.header('x-user-roles');
  return { kind, clientId: claims.sub, scopes, ...(userId ? { userId } : {}), ...(fingerprint ? { fingerprint } : {}), ...(userRoles ? { userRoles } : {}) };
}

/**
 * Dueño de reservas y holds (D29): `sub` del usuario o `partner:<clientId>:<X-User-Id>`. Sin `X-User-Id`, el contrato usa
 * `X-Device-Fingerprint` como "respaldo de propiedad": `partner:<clientId>:fp:<huella>`. Sin ninguno de los dos → `400`: las
 * reservas de los distintos usuarios de un partner nunca se mezclan en un mismo dueño.
 */
export function ownerOf(principal: Principal): string {
  if (principal.kind === 'user') return principal.sub;
  if (principal.kind === 'partner') {
    if (principal.userId) return `partner:${principal.clientId}:${principal.userId}`;
    if (principal.fingerprint) return `partner:${principal.clientId}:fp:${principal.fingerprint}`;
    throw new ProblemDetailsException({
      status: 400,
      code: 'VALIDATION_FAILED',
      title: 'Con token de partner falta el usuario final.',
      invalidParams: [{ name: 'X-User-Id', reason: 'obligatorio con token de partner (o X-Device-Fingerprint como respaldo)' }],
    });
  }
  throw unauthorized('Se requiere un token.');
}

/** Dueño de lo que es del partner completo (sus suscripciones de webhooks y su feed de eventos): `partner:<clientId>`. */
export function partnerOwnerOf(principal: Principal): string {
  if (principal.kind === 'partner') return `partner:${principal.clientId}`;
  return ownerOf(principal);
}

/** `sub` del administrador para `X-Actor-Id` (auditoría). Solo un usuario ADMIN lo tiene. */
export function actorOf(principal: Principal): string | undefined {
  return principal.kind === 'user' && principal.role === 'ADMIN' ? principal.sub : undefined;
}
