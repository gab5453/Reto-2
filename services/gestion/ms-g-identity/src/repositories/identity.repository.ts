import type { AccountStatus, PartnerRecord, RoleName, UserRecord } from '../domain/model.js';

/**
 * Acceso a los datos de Identity (base `identity`). Dos implementaciones con el mismo comportamiento: en memoria (pruebas y
 * local sin DATABASE_URL) y PostgreSQL. Los servicios dependen solo de esta interfaz.
 */
export const IDENTITY_REPOSITORY = Symbol('IDENTITY_REPOSITORY');

export interface UserFilter {
  q?: string;
  role?: RoleName;
  status?: AccountStatus;
}

export type AdminChange = (target: UserRecord, activeAdmins: number) => UserRecord | null;
export type PartnerPatch = Partial<Pick<PartnerRecord, 'status' | 'secretHash' | 'secretRotatedAt' | 'updatedAt' | 'updatedBy'>>;

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface IdentityRepository {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;

  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  findUser(sub: string): Promise<UserRecord | undefined>;
  /** Crea el usuario; devuelve `false` si el correo ya existe (índice único). */
  insertUser(user: UserRecord): Promise<boolean>;
  /** Reescribe el registro completo: solo para la semilla (al arrancar no hay peticiones concurrentes). */
  updateUser(user: UserRecord): Promise<void>;
  /** Solo `last_login_at`: el login no puede pisar un bloqueo hecho mientras verificaba la contraseña. */
  touchLastLogin(sub: string, at: string): Promise<void>;
  /**
   * Cambio de rol o estado de forma atómica: `change` recibe el usuario y la cantidad de ADMIN activos, y devuelve el
   * registro nuevo (o `null` si no hay cambios) o lanza si rompe una regla. Dos cambios simultáneos se ejecutan uno tras
   * otro, así dos administradores que se bloquean a la vez no dejan la aerolínea sin administradores (LAST_ADMIN).
   * Devuelve `undefined` si el usuario no existe.
   */
  changeUser(sub: string, change: AdminChange): Promise<UserRecord | undefined>;
  /** Del más reciente al más antiguo. */
  listUsers(filter: UserFilter, limit: number, offset: number): Promise<Page<UserRecord>>;
  countUsers(): Promise<{ total: number; byRole: Record<RoleName, number>; byStatus: Record<AccountStatus, number> }>;

  /** Semilla de los roles y sus scopes (idempotente). */
  seedRoles(roles: { name: RoleName; displayName: string; description: string; scopes: string[] }[]): Promise<void>;
  listRoles(): Promise<{ name: RoleName; displayName: string; description: string; scopes: string[] }[]>;

  findPartner(clientId: string): Promise<PartnerRecord | undefined>;
  insertPartner(partner: PartnerRecord): Promise<boolean>;
  /** Reescribe el registro completo: solo para la semilla. */
  updatePartner(partner: PartnerRecord): Promise<void>;
  /** Solo `last_token_at`: emitir un token no puede pisar un bloqueo ni una rotación de secreto simultáneos. */
  touchPartnerToken(clientId: string, at: string): Promise<void>;
  /** Cambia solo los campos indicados y devuelve el registro actualizado (`undefined` si no existe). */
  patchPartner(clientId: string, patch: PartnerPatch): Promise<PartnerRecord | undefined>;
  listPartners(status: AccountStatus | undefined, limit: number, offset: number): Promise<Page<PartnerRecord>>;
}

export const encodeCursor = (offset: number): string => Buffer.from(`o:${offset}`).toString('base64url');
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^o:(\d{1,7})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return match ? Number(match[1]) : 0;
}
