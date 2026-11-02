import { generateKeyPairSync } from 'node:crypto';
import { ProblemDetailsException } from '@ecoairlines/shared';
import { loadConfig } from '../src/config/config.js';
import type { UserRecord } from '../src/domain/model.js';
import { assertAdminChangeAllowed, grantedScopes, resolvePartnerScopes } from '../src/domain/rules.js';
import { InMemoryIdentityRepository } from '../src/repositories/in-memory.repository.js';
import { AccountsService } from '../src/services/accounts.service.js';
import { hashSecret, seedSub, verifySecret } from '../src/services/security.js';
import { TokensService } from '../src/services/tokens.service.js';

/** Reglas de Identity (PLAN §4.10) sin HTTP. */
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
};

describe('LAST_ADMIN y CANNOT_MODIFY_SELF', () => {
  const admin = { sub: 'a', role: 'ADMIN' as const, status: 'ACTIVE' as const };

  it('quitar o bloquear al último ADMIN activo → LAST_ADMIN', () => {
    expect(codeOf(() => assertAdminChangeAllowed({ actorSub: 'otro', target: admin, change: { role: 'CUSTOMER' }, activeAdmins: 1 }))).toBe('LAST_ADMIN');
    expect(codeOf(() => assertAdminChangeAllowed({ actorSub: 'otro', target: admin, change: { status: 'BLOCKED' }, activeAdmins: 1 }))).toBe('LAST_ADMIN');
  });

  it('con otro ADMIN activo sí se permite; reactivar o subir de rol nunca rompe la regla', () => {
    expect(codeOf(() => assertAdminChangeAllowed({ actorSub: 'otro', target: admin, change: { status: 'BLOCKED' }, activeAdmins: 2 }))).toBeUndefined();
    const blocked = { ...admin, status: 'BLOCKED' as const };
    expect(codeOf(() => assertAdminChangeAllowed({ actorSub: 'otro', target: blocked, change: { status: 'ACTIVE' }, activeAdmins: 1 }))).toBeUndefined();
    const customer = { sub: 'c', role: 'CUSTOMER' as const, status: 'ACTIVE' as const };
    expect(codeOf(() => assertAdminChangeAllowed({ actorSub: 'otro', target: customer, change: { role: 'ADMIN' }, activeAdmins: 1 }))).toBeUndefined();
  });

  it('sobre sí mismo → CANNOT_MODIFY_SELF (se evalúa antes que LAST_ADMIN)', () => {
    expect(codeOf(() => assertAdminChangeAllowed({ actorSub: 'a', target: admin, change: { status: 'BLOCKED' }, activeAdmins: 1 }))).toBe('CANNOT_MODIFY_SELF');
  });

  it('dos ADMIN que se bloquean a la vez: uno gana y el otro recibe LAST_ADMIN (nunca quedan 0)', async () => {
    const repository = new InMemoryIdentityRepository();
    const accounts = new AccountsService(repository, new TokensService(loadConfig({ NODE_ENV: 'test' })), loadConfig({ NODE_ENV: 'test' }));
    const base = { passwordHash: 'x', role: 'ADMIN', status: 'ACTIVE', createdAt: new Date().toISOString(), createdBy: null } as const;
    const a: UserRecord = { ...base, sub: '11111111-1111-4111-a111-111111111111', email: 'a@x.com', fullName: 'A' };
    const b: UserRecord = { ...base, sub: '22222222-2222-4222-a222-222222222222', email: 'b@x.com', fullName: 'B' };
    await repository.insertUser(a);
    await repository.insertUser(b);
    const results = await Promise.allSettled([accounts.changeStatus(b.sub, 'BLOCKED', a.sub), accounts.changeStatus(a.sub, 'BLOCKED', b.sub)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as ProblemDetailsException).problem.code).toBe('LAST_ADMIN');
    expect((await repository.countUsers()).byStatus.ACTIVE).toBe(1);
  });
});

describe('scopes de partner', () => {
  it('sin lista → todos los PartnerScope; flights:admin o ecoairlines:* → 400', () => {
    expect(resolvePartnerScopes(undefined)).toHaveLength(6);
    expect(codeOf(() => resolvePartnerScopes(['flights:admin']))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => resolvePartnerScopes(['ecoairlines:internal']))).toBe('VALIDATION_FAILED');
  });

  it('token: subconjunto pedido, o undefined si pide uno que no tiene', () => {
    expect(grantedScopes(['flights:read', 'flights:book'], undefined)).toEqual(['flights:read', 'flights:book']);
    expect(grantedScopes(['flights:read', 'flights:book'], 'flights:read')).toEqual(['flights:read']);
    expect(grantedScopes(['flights:read'], 'flights:read flights:admin')).toBeUndefined();
  });
});

describe('contraseñas, sub de semilla y configuración', () => {
  it('scrypt con sal propia: dos hashes de la misma clave son distintos y ambos verifican', async () => {
    const [h1, h2] = [await hashSecret('EcoDemo2026'), await hashSecret('EcoDemo2026')];
    expect(h1).not.toBe(h2);
    expect(await verifySecret('EcoDemo2026', h1)).toBe(true);
    expect(await verifySecret('otra', h1)).toBe(false);
    expect(await verifySecret('EcoDemo2026', undefined)).toBe(false);
  });

  it('el sub de semilla es el mismo que generaba dev-auth (las reservas siguen siendo del usuario)', () => {
    expect(seedSub('demo@ecoairlines.test')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(seedSub('demo@ecoairlines.test')).toBe(seedSub('demo@ecoairlines.test'));
  });

  // Genera dos claves RSA de 2048 bits: con la suite completa en paralelo puede pasar de 5 s.
  it('en producción sin secretos ni clave no arranca; secretos de menos de 16 caracteres tampoco', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/IDENTITY_PRIVATE_KEY[\s\S]*ADMIN_PASSWORD|ADMIN_PASSWORD[\s\S]*IDENTITY_PRIVATE_KEY/);
    expect(() => loadConfig({ NODE_ENV: 'test', ESB_CLIENT_SECRET: 'corto' })).toThrow(/ESB_CLIENT_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'test', ADMIN_PASSWORD: 'corta' })).toThrow(/ADMIN_PASSWORD debe tener al menos 8/);
    expect(loadConfig({ NODE_ENV: 'test', ADMIN_PASSWORD: 'EcoAdmin2026' }).adminPassword).toBe('EcoAdmin2026');
    expect(loadConfig({ NODE_ENV: 'production', SEED_DEMO_USERS: 'true', ...prodSecrets() }).seedDemoUsers).toBe(true);
    expect(loadConfig({ NODE_ENV: 'production', ...prodSecrets() }).seedDemoUsers).toBe(false);
    // D44: el secreto de cada MS de respuesta también es obligatorio en producción.
    const withoutVuelos: Record<string, string> = prodSecrets();
    delete withoutVuelos['MS_VUELOS_CLIENT_SECRET'];
    expect(() => loadConfig({ NODE_ENV: 'production', ...withoutVuelos })).toThrow(/falta MS_VUELOS_CLIENT_SECRET/);
  }, 30_000);
});

function prodSecrets() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    IDENTITY_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    ADMIN_PASSWORD: 'clave-admin-produccion-1',
    BOOKING_CLIENT_SECRET: 'secreto-booking-produccion-1',
    ESB_CLIENT_SECRET: 'secreto-esb-produccion-0001',
    ...Object.fromEntries(['VUELOS', 'RESERVAS', 'POSTVENTA', 'CLIENTES', 'ADMIN'].map((ms) => [`MS_${ms}_CLIENT_SECRET`, `secreto-ms-${ms.toLowerCase()}-produccion-1`])),
  };
}
