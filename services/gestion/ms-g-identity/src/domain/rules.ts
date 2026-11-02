import { ProblemDetailsException } from '@ecoairlines/shared';
import type { AccountStatus, PartnerScope, RoleName, UserRecord } from './model.js';
import { PARTNER_SCOPES } from './model.js';

/**
 * Reglas de negocio de Identity (PLAN.md §4.10 y contrato). Son funciones puras: se prueban sin base de datos.
 */

/** Correo en minúsculas y sin espacios (así `Ana@X.com` y `ana@x.com` son la misma cuenta). */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Un administrador no puede cambiar su propio rol ni bloquearse (409 CANNOT_MODIFY_SELF), y la aerolínea nunca se queda
 * sin administradores activos (409 LAST_ADMIN). `activeAdmins` = cantidad actual de ADMIN con estado ACTIVE.
 */
export function assertAdminChangeAllowed(input: {
  actorSub: string;
  target: Pick<UserRecord, 'sub' | 'role' | 'status'>;
  change: { role?: RoleName; status?: AccountStatus };
  activeAdmins: number;
}): void {
  const { actorSub, target, change, activeAdmins } = input;
  const changesRole = change.role !== undefined && change.role !== target.role;
  const blocks = change.status === 'BLOCKED' && target.status !== 'BLOCKED';
  if (target.sub === actorSub && (changesRole || blocks)) {
    throw new ProblemDetailsException({ status: 409, code: 'CANNOT_MODIFY_SELF', title: 'No puede cambiar su propio rol ni bloquear su propia cuenta.' });
  }
  const removesAdmin = target.role === 'ADMIN' && target.status === 'ACTIVE' && ((changesRole && change.role !== 'ADMIN') || blocks);
  if (removesAdmin && activeAdmins <= 1) {
    throw new ProblemDetailsException({ status: 409, code: 'LAST_ADMIN', title: 'Debe quedar al menos un administrador activo.' });
  }
}

/** Un usuario bloqueado no inicia sesión (403), pero solo se informa si la contraseña era correcta. */
export function assertCanLogin(user: Pick<UserRecord, 'status'>): void {
  if (user.status === 'BLOCKED') {
    throw new ProblemDetailsException({ status: 403, code: 'ACCOUNT_BLOCKED', title: 'La cuenta está bloqueada. Contacte al administrador.' });
  }
}

/** Scopes de un partner: solo los del contrato v2, nunca `flights:admin` ni `ecoairlines:*` (D35). */
export function resolvePartnerScopes(requested: string[] | undefined): PartnerScope[] {
  if (!requested) return [...PARTNER_SCOPES];
  const invalid = requested.filter((scope) => !(PARTNER_SCOPES as readonly string[]).includes(scope));
  if (invalid.length) {
    throw new ProblemDetailsException({
      status: 400,
      code: 'VALIDATION_FAILED',
      title: 'Un partner solo puede tener scopes del contrato de vuelos (nunca flights:admin ni ecoairlines:*).',
      invalidParams: invalid.map((scope) => ({ name: 'scopes', reason: `scope no permitido: ${scope}` })),
    });
  }
  return [...new Set(requested)] as PartnerScope[];
}

/**
 * Scopes del token de partner: todos los suyos o el subconjunto pedido. Devuelve `undefined` si pide alguno que no tiene
 * (→ invalid_scope de OAuth2).
 */
export function grantedScopes(allowed: readonly string[], requested: string | undefined): string[] | undefined {
  if (!requested) return [...allowed];
  const asked = requested.split(' ').filter(Boolean);
  return asked.every((scope) => allowed.includes(scope)) ? [...new Set(asked)] : undefined;
}
