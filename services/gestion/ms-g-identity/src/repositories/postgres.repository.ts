import { guardPool } from '@ecoairlines/shared';
import pg from 'pg';
import type { AccountStatus, PartnerRecord, PartnerScope, RoleName, UserRecord } from '../domain/model.js';
import { type AdminChange, encodeCursor, type IdentityRepository, type Page, type PartnerPatch, type UserFilter } from './identity.repository.js';

/**
 * PostgreSQL (base `identity`, usuario `identity_svc`; D10). Tablas del modelo conceptual v4: `roles`, `role_scopes`,
 * `users` (un solo rol por `role_id`) y `partner_clients`. Se crean al arrancar si no existen.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles (
  role_id     text PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text NOT NULL
);
CREATE TABLE IF NOT EXISTS role_scopes (
  role_id text NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
  scope   text NOT NULL,
  PRIMARY KEY (role_id, scope)
);
CREATE TABLE IF NOT EXISTS users (
  sub           uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  password_hash text NOT NULL,
  role_id       text NOT NULL REFERENCES roles(role_id),
  status        text NOT NULL CHECK (status IN ('ACTIVE', 'BLOCKED')),
  created_at    timestamptz NOT NULL,
  created_by    uuid,
  updated_at    timestamptz,
  updated_by    uuid,
  last_login_at timestamptz
);
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at DESC);
CREATE TABLE IF NOT EXISTS partner_clients (
  client_id         text PRIMARY KEY,
  name              text NOT NULL,
  secret_hash       text NOT NULL,
  scopes            text[] NOT NULL,
  status            text NOT NULL CHECK (status IN ('ACTIVE', 'BLOCKED')),
  created_at        timestamptz NOT NULL,
  created_by        uuid,
  updated_at        timestamptz,
  updated_by        uuid,
  secret_rotated_at timestamptz,
  last_token_at     timestamptz
);
`;

type Row = Record<string, unknown>;
const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value));

function toUserRecord(row: Row): UserRecord {
  return {
    sub: String(row['sub']),
    email: String(row['email']),
    fullName: String(row['full_name']),
    passwordHash: String(row['password_hash']),
    role: row['role_id'] as RoleName,
    status: row['status'] as AccountStatus,
    createdAt: iso(row['created_at'])!,
    createdBy: (row['created_by'] as string | null) ?? null,
    ...(row['updated_at'] ? { updatedAt: iso(row['updated_at'])!, updatedBy: (row['updated_by'] as string | null) ?? null } : {}),
    lastLoginAt: iso(row['last_login_at']),
  };
}

function toPartnerRecord(row: Row): PartnerRecord {
  return {
    clientId: String(row['client_id']),
    name: String(row['name']),
    secretHash: String(row['secret_hash']),
    scopes: row['scopes'] as PartnerScope[],
    status: row['status'] as AccountStatus,
    createdAt: iso(row['created_at'])!,
    createdBy: (row['created_by'] as string | null) ?? null,
    ...(row['updated_at'] ? { updatedAt: iso(row['updated_at'])!, updatedBy: (row['updated_by'] as string | null) ?? null } : {}),
    secretRotatedAt: iso(row['secret_rotated_at']),
    lastTokenAt: iso(row['last_token_at']),
  };
}

export class PostgresIdentityRepository implements IdentityRepository {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = guardPool(new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000 }), 'ms-g-identity');
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }
  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }
  async close(): Promise<void> {
    await this.pool.end();
  }

  async findUserByEmail(email: string) {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] ? toUserRecord(rows[0]) : undefined;
  }
  async findUser(sub: string) {
    if (!/^[0-9a-f-]{36}$/i.test(sub)) return undefined;
    const { rows } = await this.pool.query('SELECT * FROM users WHERE sub = $1', [sub]);
    return rows[0] ? toUserRecord(rows[0]) : undefined;
  }
  async insertUser(u: UserRecord) {
    const result = await this.pool.query(
      `INSERT INTO users (sub, email, full_name, password_hash, role_id, status, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [u.sub, u.email, u.fullName, u.passwordHash, u.role, u.status, u.createdAt, u.createdBy],
    );
    return result.rowCount === 1;
  }
  async updateUser(u: UserRecord) {
    await this.pool.query(
      `UPDATE users SET full_name = $2, password_hash = $3, role_id = $4, status = $5, updated_at = $6, updated_by = $7, last_login_at = $8
       WHERE sub = $1`,
      [u.sub, u.fullName, u.passwordHash, u.role, u.status, u.updatedAt ?? null, u.updatedBy ?? null, u.lastLoginAt ?? null],
    );
  }
  async touchLastLogin(sub: string, at: string) {
    await this.pool.query('UPDATE users SET last_login_at = $2 WHERE sub = $1', [sub, at]);
  }
  async changeUser(sub: string, change: AdminChange) {
    if (!/^[0-9a-f-]{36}$/i.test(sub)) return undefined;
    return this.transaction(async (client) => {
      // Un candado por transacción para todos los cambios de rol/estado: el conteo de ADMIN activos no cambia hasta el COMMIT.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('identity:admin-changes'))`);
      const { rows } = await client.query('SELECT * FROM users WHERE sub = $1', [sub]);
      if (!rows[0]) return undefined;
      const target = toUserRecord(rows[0]);
      const admins = await client.query(`SELECT count(*)::int AS n FROM users WHERE role_id = 'ADMIN' AND status = 'ACTIVE'`);
      const updated = change(target, (admins.rows[0] as { n: number }).n);
      if (!updated) return target;
      await client.query('UPDATE users SET role_id = $2, status = $3, updated_at = $4, updated_by = $5 WHERE sub = $1', [
        sub,
        updated.role,
        updated.status,
        updated.updatedAt ?? null,
        updated.updatedBy ?? null,
      ]);
      return updated;
    });
  }
  async listUsers(filter: UserFilter, limit: number, offset: number): Promise<Page<UserRecord>> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.q) {
      values.push(`%${filter.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(email LIKE $${values.length} OR lower(full_name) LIKE $${values.length})`);
    }
    if (filter.role) where.push(`role_id = $${values.push(filter.role)}`);
    if (filter.status) where.push(`status = $${values.push(filter.status)}`);
    values.push(limit + 1, offset);
    const { rows } = await this.pool.query(
      `SELECT * FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, sub LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    const items = rows.slice(0, limit).map(toUserRecord);
    return rows.length > limit ? { items, nextCursor: encodeCursor(offset + limit) } : { items };
  }
  async countUsers() {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE role_id = 'CUSTOMER')::int AS customer, count(*) FILTER (WHERE role_id = 'ADMIN')::int AS admin,
              count(*) FILTER (WHERE status = 'ACTIVE')::int AS active, count(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked
       FROM users`,
    );
    const r = rows[0] as Record<string, number>;
    return { total: r['total'], byRole: { CUSTOMER: r['customer'], ADMIN: r['admin'] }, byStatus: { ACTIVE: r['active'], BLOCKED: r['blocked'] } };
  }
  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async seedRoles(roles: { name: RoleName; displayName: string; description: string; scopes: string[] }[]) {
    await this.transaction(async (client) => {
      for (const role of roles) {
        await client.query(
          `INSERT INTO roles (role_id, name, display_name, description) VALUES ($1, $1, $2, $3)
           ON CONFLICT (role_id) DO UPDATE SET display_name = EXCLUDED.display_name, description = EXCLUDED.description`,
          [role.name, role.displayName, role.description],
        );
        await client.query('DELETE FROM role_scopes WHERE role_id = $1', [role.name]);
        for (const scope of role.scopes) await client.query('INSERT INTO role_scopes (role_id, scope) VALUES ($1, $2)', [role.name, scope]);
      }
    });
  }
  async listRoles() {
    const { rows } = await this.pool.query(
      `SELECT r.role_id, r.display_name, r.description, coalesce(array_agg(s.scope ORDER BY s.scope) FILTER (WHERE s.scope IS NOT NULL), '{}') AS scopes
       FROM roles r LEFT JOIN role_scopes s ON s.role_id = r.role_id GROUP BY r.role_id ORDER BY r.role_id DESC`,
    );
    return rows.map((row: Row) => ({
      name: row['role_id'] as RoleName,
      displayName: String(row['display_name']),
      description: String(row['description']),
      scopes: row['scopes'] as string[],
    }));
  }

  async findPartner(clientId: string) {
    const { rows } = await this.pool.query('SELECT * FROM partner_clients WHERE client_id = $1', [clientId]);
    return rows[0] ? toPartnerRecord(rows[0]) : undefined;
  }
  async insertPartner(p: PartnerRecord) {
    const result = await this.pool.query(
      `INSERT INTO partner_clients (client_id, name, secret_hash, scopes, status, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [p.clientId, p.name, p.secretHash, p.scopes, p.status, p.createdAt, p.createdBy],
    );
    return result.rowCount === 1;
  }
  async updatePartner(p: PartnerRecord) {
    await this.pool.query(
      `UPDATE partner_clients SET name = $2, secret_hash = $3, scopes = $4, status = $5, updated_at = $6, updated_by = $7,
              secret_rotated_at = $8, last_token_at = $9 WHERE client_id = $1`,
      [p.clientId, p.name, p.secretHash, p.scopes, p.status, p.updatedAt ?? null, p.updatedBy ?? null, p.secretRotatedAt ?? null, p.lastTokenAt ?? null],
    );
  }
  async touchPartnerToken(clientId: string, at: string) {
    await this.pool.query('UPDATE partner_clients SET last_token_at = $2 WHERE client_id = $1', [clientId, at]);
  }
  async patchPartner(clientId: string, patch: PartnerPatch) {
    const columns: Record<keyof PartnerPatch, string> = {
      status: 'status',
      secretHash: 'secret_hash',
      secretRotatedAt: 'secret_rotated_at',
      updatedAt: 'updated_at',
      updatedBy: 'updated_by',
    };
    const keys = (Object.keys(patch) as (keyof PartnerPatch)[]).filter((key) => key in columns);
    const { rows } = await this.pool.query(
      `UPDATE partner_clients SET ${keys.map((key, i) => `${columns[key]} = $${i + 2}`).join(', ')} WHERE client_id = $1 RETURNING *`,
      [clientId, ...keys.map((key) => patch[key] ?? null)],
    );
    return rows[0] ? toPartnerRecord(rows[0]) : undefined;
  }
  async listPartners(status: AccountStatus | undefined, limit: number, offset: number) {
    const { rows } = await this.pool.query(
      `SELECT * FROM partner_clients ${status ? 'WHERE status = $3' : ''} ORDER BY client_id LIMIT $1 OFFSET $2`,
      status ? [limit + 1, offset, status] : [limit + 1, offset],
    );
    const items = rows.slice(0, limit).map(toPartnerRecord);
    return rows.length > limit ? { items, nextCursor: encodeCursor(offset + limit) } : { items };
  }
}
