import type { AccountStatus, PartnerRecord, RoleName, UserRecord } from '../domain/model.js';
import { type AdminChange, encodeCursor, type IdentityRepository, type Page, type PartnerPatch, type UserFilter } from './identity.repository.js';

/** Implementación en memoria (pruebas y local sin DATABASE_URL). Los datos se pierden al reiniciar. */
export class InMemoryIdentityRepository implements IdentityRepository {
  readonly kind = 'memory' as const;
  private readonly users = new Map<string, UserRecord>();
  private readonly partners = new Map<string, PartnerRecord>();
  private roles: { name: RoleName; displayName: string; description: string; scopes: string[] }[] = [];

  async init(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}

  async findUserByEmail(email: string) {
    return [...this.users.values()].find((user) => user.email === email);
  }
  async findUser(sub: string) {
    return this.users.get(sub);
  }
  async insertUser(user: UserRecord) {
    if (this.users.has(user.sub) || (await this.findUserByEmail(user.email))) return false;
    this.users.set(user.sub, { ...user });
    return true;
  }
  async updateUser(user: UserRecord) {
    this.users.set(user.sub, { ...user });
  }
  async touchLastLogin(sub: string, at: string) {
    const user = this.users.get(sub);
    if (user) user.lastLoginAt = at;
  }
  // Sin `await` entre leer y escribir: en un solo hilo de JavaScript esto ya es atómico.
  async changeUser(sub: string, change: AdminChange) {
    const target = this.users.get(sub);
    if (!target) return undefined;
    const activeAdmins = [...this.users.values()].filter((u) => u.role === 'ADMIN' && u.status === 'ACTIVE').length;
    const updated = change({ ...target }, activeAdmins);
    if (!updated) return { ...target };
    this.users.set(sub, { ...updated });
    return updated;
  }
  async listUsers(filter: UserFilter, limit: number, offset: number): Promise<Page<UserRecord>> {
    const q = filter.q?.toLowerCase();
    const matching = [...this.users.values()]
      .filter((user) => (!q || user.email.includes(q) || user.fullName.toLowerCase().includes(q)))
      .filter((user) => (!filter.role || user.role === filter.role) && (!filter.status || user.status === filter.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.sub.localeCompare(b.sub));
    return page(matching, limit, offset);
  }
  async countUsers() {
    const users = [...this.users.values()];
    const count = (fn: (u: UserRecord) => boolean) => users.filter(fn).length;
    return {
      total: users.length,
      byRole: { CUSTOMER: count((u) => u.role === 'CUSTOMER'), ADMIN: count((u) => u.role === 'ADMIN') },
      byStatus: { ACTIVE: count((u) => u.status === 'ACTIVE'), BLOCKED: count((u) => u.status === 'BLOCKED') },
    };
  }

  async seedRoles(roles: { name: RoleName; displayName: string; description: string; scopes: string[] }[]) {
    this.roles = roles.map((role) => ({ ...role, scopes: [...role.scopes] }));
  }
  async listRoles() {
    return this.roles;
  }

  async findPartner(clientId: string) {
    return this.partners.get(clientId);
  }
  async insertPartner(partner: PartnerRecord) {
    if (this.partners.has(partner.clientId)) return false;
    this.partners.set(partner.clientId, { ...partner });
    return true;
  }
  async updatePartner(partner: PartnerRecord) {
    this.partners.set(partner.clientId, { ...partner });
  }
  async touchPartnerToken(clientId: string, at: string) {
    const partner = this.partners.get(clientId);
    if (partner) partner.lastTokenAt = at;
  }
  async patchPartner(clientId: string, patch: PartnerPatch) {
    const partner = this.partners.get(clientId);
    if (!partner) return undefined;
    Object.assign(partner, patch);
    return { ...partner };
  }
  async listPartners(status: AccountStatus | undefined, limit: number, offset: number) {
    const matching = [...this.partners.values()].filter((p) => !status || p.status === status).sort((a, b) => a.clientId.localeCompare(b.clientId));
    return page(matching, limit, offset);
  }
}

function page<T>(items: T[], limit: number, offset: number): Page<T> {
  const slice = items.slice(offset, offset + limit);
  return offset + limit < items.length ? { items: slice, nextCursor: encodeCursor(offset + limit) } : { items: slice };
}
