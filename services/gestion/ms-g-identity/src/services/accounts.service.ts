import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemDetailsException } from '@ecoairlines/shared';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config/config.js';
import { type AccountStatus, type RoleName, ROLES, toUser, type UserRecord } from '../domain/model.js';
import { assertAdminChangeAllowed, assertCanLogin, normalizeEmail } from '../domain/rules.js';
import { decodeCursor, IDENTITY_REPOSITORY, type IdentityRepository, type UserFilter } from '../repositories/identity.repository.js';
import { AttemptLimiter, hashSecret, verifySecret } from './security.js';
import { TokensService } from './tokens.service.js';

/** Registro, login y gestión de usuarios por el administrador (contrato: Autenticación y Usuarios). */
@Injectable()
export class AccountsService {
  private readonly limiter: AttemptLimiter;

  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly repository: IdentityRepository,
    @Inject(TokensService) private readonly tokens: TokensService,
    @Inject(IDENTITY_CONFIG) config: IdentityConfig,
  ) {
    this.limiter = new AttemptLimiter(config.attemptsPerMinute);
  }

  /** 429 si la IP pasó el límite de intentos por minuto. */
  checkAttempts(key: string): void {
    const wait = this.limiter.hit(key);
    if (wait !== undefined) {
      throw new ProblemDetailsException({ status: 429, code: 'RATE_LIMIT_EXCEEDED', title: 'Demasiados intentos. Espere un minuto.', retryAfterSeconds: wait });
    }
  }

  async scopesOf(role: RoleName): Promise<string[]> {
    const roles = await this.repository.listRoles();
    return (roles.find((r) => r.name === role) ?? ROLES.find((r) => r.name === role)!).scopes;
  }

  /** Registro público: siempre CUSTOMER y activo. */
  async register(input: { fullName: string; email: string; password: string }) {
    const user = await this.newUser({ ...input, role: 'CUSTOMER' }, null);
    return this.tokens.issueUserToken(user, await this.scopesOf(user.role));
  }

  async login(input: { email: string; password: string }) {
    const user = await this.repository.findUserByEmail(normalizeEmail(input.email));
    // Un correo inexistente y una contraseña incorrecta responden igual y tardan lo mismo.
    if (!(await verifySecret(input.password, user?.passwordHash)) || !user) {
      throw new ProblemDetailsException({ status: 401, code: 'INVALID_CREDENTIALS', title: 'Correo o contraseña incorrectos.' });
    }
    assertCanLogin(user);
    await this.repository.touchLastLogin(user.sub, new Date().toISOString());
    return this.tokens.issueUserToken(user, await this.scopesOf(user.role));
  }

  async createUser(input: { fullName: string; email: string; password: string; role: RoleName }, actorSub: string) {
    return toUser(await this.newUser(input, actorSub));
  }

  private async newUser(input: { fullName: string; email: string; password: string; role: RoleName }, createdBy: string | null, sub: string = randomUUID()) {
    const user: UserRecord = {
      sub,
      email: normalizeEmail(input.email),
      fullName: input.fullName.trim(),
      passwordHash: await hashSecret(input.password),
      role: input.role,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      createdBy,
      lastLoginAt: null,
    };
    if (!(await this.repository.insertUser(user))) {
      throw new ProblemDetailsException({ status: 409, code: 'EMAIL_ALREADY_REGISTERED', title: 'Ya existe una cuenta con ese correo.' });
    }
    return user;
  }

  /** Usuario de prueba con `sub` fijo; si existe, se actualiza su clave y rol (así ADMIN_PASSWORD se aplica en cada arranque). */
  async upsertSeedUser(input: { sub: string; fullName: string; email: string; password: string; role: RoleName }) {
    const existing = await this.repository.findUser(input.sub);
    if (!existing) {
      await this.newUser(input, null, input.sub);
      return;
    }
    await this.repository.updateUser({ ...existing, fullName: input.fullName, role: input.role, passwordHash: await hashSecret(input.password) });
  }

  async listUsers(filter: UserFilter, limit: number, cursor?: string) {
    const page = await this.repository.listUsers(filter, limit, decodeCursor(cursor));
    return { items: page.items.map(toUser), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async summary() {
    return this.repository.countUsers();
  }

  async getUser(sub: string) {
    return toUser(await this.requireUser(sub));
  }

  changeRole(sub: string, role: RoleName, actorSub: string) {
    return this.change(sub, { role }, actorSub);
  }

  changeStatus(sub: string, status: AccountStatus, actorSub: string) {
    return this.change(sub, { status }, actorSub);
  }

  /** Mismo valor que el actual → 200 sin cambios. La regla se evalúa dentro de la operación atómica del repositorio. */
  private async change(sub: string, change: { role?: RoleName; status?: AccountStatus }, actorSub: string) {
    const updated = await this.repository.changeUser(sub, (target, activeAdmins) => {
      if ((change.role ?? target.role) === target.role && (change.status ?? target.status) === target.status) return null;
      assertAdminChangeAllowed({ actorSub, target, change, activeAdmins });
      return { ...target, ...change, updatedAt: new Date().toISOString(), updatedBy: actorSub };
    });
    if (!updated) throw ProblemDetailsException.notFound('Usuario no encontrado.', 'USER_NOT_FOUND');
    return toUser(updated);
  }

  /** El actor de una operación de administración debe ser un ADMIN activo (defensa en profundidad, D41). */
  async isActiveAdmin(sub: string): Promise<boolean> {
    const user = await this.repository.findUser(sub);
    return user?.role === 'ADMIN' && user.status === 'ACTIVE';
  }

  async roles() {
    return this.repository.listRoles();
  }

  private async requireUser(sub: string): Promise<UserRecord> {
    const user = await this.repository.findUser(sub);
    if (!user) throw ProblemDetailsException.notFound('Usuario no encontrado.', 'USER_NOT_FOUND');
    return user;
  }
}
