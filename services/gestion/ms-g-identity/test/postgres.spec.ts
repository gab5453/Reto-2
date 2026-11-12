import { randomUUID } from 'node:crypto';
import type { ProblemDetailsException } from '@ecoairlines/shared';
import { loadConfig } from '../src/config/config.js';
import type { UserRecord } from '../src/domain/model.js';
import { assertAdminChangeAllowed } from '../src/domain/rules.js';
import { PostgresIdentityRepository } from '../src/repositories/postgres.repository.js';

/**
 * Integración con PostgreSQL real (opcional): `IDENTITY_TEST_DATABASE_URL=postgres://identity_svc:dev-identity@localhost:5432/identity`
 * con `npm run infra:up`. Sin la variable se omite.
 */
const url = process.env['IDENTITY_TEST_DATABASE_URL'];

describe.skipIf(!url)('PostgresIdentityRepository', () => {
  const repository = new PostgresIdentityRepository(url ?? '');
  const created: string[] = [];
  const newAdmin = async (): Promise<UserRecord> => {
    const user: UserRecord = {
      sub: randomUUID(),
      email: `admin-${randomUUID()}@prueba.test`,
      fullName: 'Admin de prueba',
      passwordHash: 'x',
      role: 'ADMIN',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      createdBy: null,
    };
    expect(await repository.insertUser(user)).toBe(true);
    created.push(user.sub);
    return user;
  };

  beforeAll(async () => {
    loadConfig({ NODE_ENV: 'test' });
    await repository.init();
    await repository.seedRoles([
      { name: 'CUSTOMER', displayName: 'Cliente', description: '-', scopes: ['flights:read'] },
      { name: 'ADMIN', displayName: 'Administrador', description: '-', scopes: ['flights:admin'] },
    ]);
  });
  afterAll(async () => {
    // Deja la base como estaba (las pruebas no tocan a los usuarios de la semilla).
    await (repository as unknown as { pool: { query: (q: string, v: unknown[]) => Promise<unknown> } }).pool.query('DELETE FROM users WHERE sub = ANY($1)', [created]);
    await repository.close();
  });

  it('el correo es único: el segundo insert devuelve false', async () => {
    const admin = await newAdmin();
    expect(await repository.insertUser({ ...admin, sub: randomUUID() })).toBe(false);
  });

  it('cambios simultáneos de rol/estado se serializan: el conteo de ADMIN activos nunca se lee viejo', async () => {
    const [a, b] = [await newAdmin(), await newAdmin()];
    const before = (await repository.countUsers()).byRole.ADMIN;
    // Cada cambio bloquea a otro admin; el último que queda activo (en esta base puede haber más, p. ej. el de la semilla)
    // no se toca. Lo que se prueba es que cada transacción ve el conteo que dejó la anterior.
    const seen: number[] = [];
    const block = (target: string, actor: string) =>
      repository.changeUser(target, (user, activeAdmins) => {
        seen.push(activeAdmins);
        assertAdminChangeAllowed({ actorSub: actor, target: user, change: { status: 'BLOCKED' }, activeAdmins });
        return { ...user, status: 'BLOCKED', updatedAt: new Date().toISOString(), updatedBy: actor };
      });
    const results = await Promise.allSettled([block(b.sub, a.sub), block(a.sub, b.sub)]);
    expect(new Set(seen).size).toBe(2); // dos lecturas distintas: la segunda vio el bloqueo de la primera
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    for (const r of rejected) expect((r.reason as ProblemDetailsException).problem.code).toBe('LAST_ADMIN');
    expect((await repository.countUsers()).byRole.ADMIN).toBe(before);
  });

  it('touchLastLogin no pisa un bloqueo hecho entre la lectura y la escritura', async () => {
    const user = await newAdmin();
    await newAdmin(); // otro admin activo para que el bloqueo sea válido
    await repository.changeUser(user.sub, (u) => ({ ...u, status: 'BLOCKED' }));
    await repository.touchLastLogin(user.sub, new Date().toISOString());
    const after = await repository.findUser(user.sub);
    expect(after).toMatchObject({ status: 'BLOCKED', lastLoginAt: expect.any(String) });
  });

  it('patchPartner cambia solo los campos indicados', async () => {
    const clientId = `PRUEBA_${randomUUID().slice(0, 8).toUpperCase()}`;
    await repository.insertPartner({
      clientId,
      name: 'Prueba',
      secretHash: 'h1',
      scopes: ['flights:read'],
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      createdBy: null,
    });
    const updated = await repository.patchPartner(clientId, { status: 'BLOCKED' });
    expect(updated).toMatchObject({ status: 'BLOCKED', secretHash: 'h1', scopes: ['flights:read'] });
    await (repository as unknown as { pool: { query: (q: string, v: unknown[]) => Promise<unknown> } }).pool.query('DELETE FROM partner_clients WHERE client_id = $1', [clientId]);
  });
});
