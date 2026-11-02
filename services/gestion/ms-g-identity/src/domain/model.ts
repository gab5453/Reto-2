/**
 * Modelo de MS.G.Identity (contract/ms-g-identity.openapi.yaml v1.2.0 y modelo conceptual v4: users, roles, role_scopes,
 * partner_clients). Un usuario tiene UN solo rol (D17); no hay rol OPS (D30).
 */
export type RoleName = 'CUSTOMER' | 'ADMIN';
export type AccountStatus = 'ACTIVE' | 'BLOCKED';

export const PARTNER_SCOPES = ['flights:read', 'flights:hold', 'flights:book', 'flights:cancel', 'flights:webhooks', 'flights:ops'] as const;
export type PartnerScope = (typeof PARTNER_SCOPES)[number];

/**
 * Clientes internos de los 5 MS de respuesta (D44): solo de semilla, como el del ESB. Su token de servicio lleva el scope
 * `ecoairlines:esb`, que acepta el ESB y rechazan los MS.G: un MS de respuesta no puede saltarse el ESB.
 */
export const RESPONSE_CLIENT_IDS = ['ECOAIRLINES_MS_VUELOS', 'ECOAIRLINES_MS_RESERVAS', 'ECOAIRLINES_MS_POSTVENTA', 'ECOAIRLINES_MS_CLIENTES', 'ECOAIRLINES_MS_ADMIN'] as const;
export type ResponseClientId = (typeof RESPONSE_CLIENT_IDS)[number];
export const RESPONSE_SCOPE = 'ecoairlines:esb';

/** Datos semilla de solo lectura (se cambian con una migración, no desde el panel). */
export const ROLES: readonly { name: RoleName; displayName: string; description: string; scopes: string[] }[] = [
  {
    name: 'CUSTOMER',
    displayName: 'Cliente',
    description: 'Compra y gestiona sus propias reservas.',
    scopes: ['flights:read', 'flights:hold', 'flights:book', 'flights:cancel', 'ecoairlines:profile'],
  },
  {
    name: 'ADMIN',
    displayName: 'Administrador',
    description: 'Opera el panel de administración, los vuelos y el acuerdo de promociones.',
    scopes: ['flights:read', 'flights:webhooks', 'flights:ops', 'flights:admin', 'ecoairlines:admin'],
  },
];

export interface UserRecord {
  sub: string;
  email: string;
  fullName: string;
  passwordHash: string;
  role: RoleName;
  status: AccountStatus;
  createdAt: string;
  createdBy: string | null;
  updatedAt?: string;
  updatedBy?: string | null;
  lastLoginAt?: string | null;
}

export interface PartnerRecord {
  clientId: string;
  name: string;
  secretHash: string;
  scopes: PartnerScope[];
  status: AccountStatus;
  createdAt: string;
  createdBy: string | null;
  updatedAt?: string;
  updatedBy?: string | null;
  secretRotatedAt?: string | null;
  lastTokenAt?: string | null;
}

/** Vista pública de un usuario: nunca incluye la contraseña ni su hash. */
export function toUser(record: UserRecord) {
  return {
    sub: record.sub,
    email: record.email,
    fullName: record.fullName,
    role: record.role,
    status: record.status,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    ...(record.updatedAt ? { updatedAt: record.updatedAt, updatedBy: record.updatedBy ?? null } : {}),
    lastLoginAt: record.lastLoginAt ?? null,
  };
}

/** Vista pública de un partner: nunca incluye el secreto ni su hash. */
export function toPartner(record: PartnerRecord) {
  return {
    clientId: record.clientId,
    name: record.name,
    scopes: record.scopes,
    status: record.status,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    ...(record.updatedAt ? { updatedAt: record.updatedAt, updatedBy: record.updatedBy ?? null } : {}),
    secretRotatedAt: record.secretRotatedAt ?? null,
    lastTokenAt: record.lastTokenAt ?? null,
  };
}
