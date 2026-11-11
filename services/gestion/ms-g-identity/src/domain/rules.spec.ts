import type { ProblemDetailsException } from '@ecoairlines/shared';
import { PARTNER_SCOPES } from './model.js';
import { assertAdminChangeAllowed, assertCanLogin, grantedScopes, normalizeEmail, resolvePartnerScopes } from './rules.js';

/**
 * PU-1 (Informacion_General/Pruebas.md §5.1.1): casos de las reglas de Identity que `test/rules.spec.ts` no cubre (aquel ya
 * prueba LAST_ADMIN, CANNOT_MODIFY_SELF, scrypt y la configuración de producción).
 */

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
};

describe('normalizeEmail', () => {
  it('minúsculas y sin espacios: Ana@X.com y ana@x.com son la misma cuenta', () => expect(normalizeEmail('  Ana@X.Com ')).toBe('ana@x.com'));
  it('no toca lo que ya está normalizado', () => expect(normalizeEmail('ana@x.com')).toBe('ana@x.com'));
});

describe('assertCanLogin', () => {
  it('una cuenta activa inicia sesión', () => expect(codeOf(() => assertCanLogin({ status: 'ACTIVE' }))).toBeUndefined());
  it('una cuenta bloqueada → ACCOUNT_BLOCKED', () => expect(codeOf(() => assertCanLogin({ status: 'BLOCKED' }))).toBe('ACCOUNT_BLOCKED'));
});

describe('assertAdminChangeAllowed: casos que no rompen la regla', () => {
  const yo = { sub: 'admin-1', role: 'ADMIN' as const, status: 'ACTIVE' as const };
  it('guardar mi propio rol sin cambiarlo no es modificarme', () =>
    expect(codeOf(() => assertAdminChangeAllowed({ actorSub: 'admin-1', target: yo, change: { role: 'ADMIN' }, activeAdmins: 1 }))).toBeUndefined());
  it('poner ACTIVE a mi propia cuenta activa no es bloquearme', () =>
    expect(codeOf(() => assertAdminChangeAllowed({ actorSub: 'admin-1', target: yo, change: { status: 'ACTIVE' }, activeAdmins: 1 }))).toBeUndefined());
  it('cambiar el rol de un ADMIN ya bloqueado no deja sin administradores activos', () =>
    expect(
      codeOf(() => assertAdminChangeAllowed({ actorSub: 'admin-1', target: { sub: 'admin-2', role: 'ADMIN', status: 'BLOCKED' }, change: { role: 'CUSTOMER' }, activeAdmins: 1 })),
    ).toBeUndefined());
  it('bloquear a un CLIENTE nunca toca la regla de administradores', () =>
    expect(
      codeOf(() => assertAdminChangeAllowed({ actorSub: 'admin-1', target: { sub: 'c-1', role: 'CUSTOMER', status: 'ACTIVE' }, change: { status: 'BLOCKED' }, activeAdmins: 1 })),
    ).toBeUndefined());
});

describe('scopes de partner', () => {
  it('los scopes repetidos se guardan una sola vez', () => {
    const [scope] = PARTNER_SCOPES;
    expect(resolvePartnerScopes([scope!, scope!])).toEqual([scope]);
  });
  it('una lista vacía no da ningún scope', () => expect(resolvePartnerScopes([])).toEqual([]));
  it('se informan todos los scopes no permitidos', () => {
    try {
      resolvePartnerScopes(['flights:admin', 'ecoairlines:admin']);
      expect.unreachable();
    } catch (error) {
      expect((error as ProblemDetailsException).problem.invalidParams).toHaveLength(2);
    }
  });
  it('token: varios espacios entre scopes no importan y no se repiten', () => expect(grantedScopes(['a', 'b'], '  a   a b ')).toEqual(['a', 'b']));
  it('token: pedir una cadena vacía es pedir todos', () => expect(grantedScopes(['a', 'b'], '')).toEqual(['a', 'b']));
  it('token: un scope que no tiene → undefined (invalid_scope)', () => expect(grantedScopes(['a'], 'a c')).toBeUndefined());
});
