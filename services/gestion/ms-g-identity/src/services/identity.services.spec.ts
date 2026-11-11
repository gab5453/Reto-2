import type { ProblemDetailsException } from '@ecoairlines/shared';
import type { IdentityConfig } from '../config/config.js';
import { PARTNER_SCOPES, type PartnerRecord, type UserRecord } from '../domain/model.js';
import type { IdentityRepository } from '../repositories/identity.repository.js';
import { AccountsService } from './accounts.service.js';
import { OAuthError, PartnersService } from './partners.service.js';
import { AttemptLimiter, hashSecret, seedSub, verifySecret } from './security.js';
import type { TokensService } from './tokens.service.js';

/**
 * PU-2 (Informacion_General/Pruebas.md §5.1.2): servicios de MS.G.Identity con el repositorio y la emisión de tokens como dobles.
 * Las contraseñas sí se derivan con scrypt de verdad: es justamente lo que se quiere probar.
 */

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem?.code ?? (error as OAuthError).error;
  }
};

const CONFIG = {
  attemptsPerMinute: 3,
  esbClientSecret: 'secreto-esb-de-prueba-0001',
  responseClientSecrets: { ECOAIRLINES_MS_VUELOS: 'secreto-vuelos-de-prueba', ECOAIRLINES_MS_RESERVAS: 'r', ECOAIRLINES_MS_POSTVENTA: 'p', ECOAIRLINES_MS_CLIENTES: 'c', ECOAIRLINES_MS_ADMIN: 'a' },
} as IdentityConfig;

function dobles() {
  const repo = {
    findUserByEmail: vi.fn().mockResolvedValue(undefined),
    findUser: vi.fn().mockResolvedValue(undefined),
    insertUser: vi.fn().mockResolvedValue(true),
    updateUser: vi.fn().mockResolvedValue(undefined),
    touchLastLogin: vi.fn().mockResolvedValue(undefined),
    changeUser: vi.fn(),
    listUsers: vi.fn().mockResolvedValue({ items: [] }),
    countUsers: vi.fn(),
    listRoles: vi.fn().mockResolvedValue([{ name: 'CUSTOMER', scopes: ['flights:read', 'flights:book'] }]),
    findPartner: vi.fn().mockResolvedValue(undefined),
    insertPartner: vi.fn().mockResolvedValue(true),
    updatePartner: vi.fn().mockResolvedValue(undefined),
    touchPartnerToken: vi.fn().mockResolvedValue(undefined),
    patchPartner: vi.fn(async (clientId: string, patch: Partial<PartnerRecord>) => ({ ...socio(), clientId, ...patch })),
    listPartners: vi.fn().mockResolvedValue({ items: [] }),
  };
  const tokens = {
    issueUserToken: vi.fn((user: UserRecord, scopes: string[]) => ({ access_token: 'token-usuario', scope: scopes.join(' '), user: { sub: user.sub } })),
    issuePartnerToken: vi.fn((_p: unknown, scopes: string[]) => ({ access_token: 'token-partner', scope: scopes.join(' ') })),
    issueServiceToken: vi.fn((clientId = 'ECOAIRLINES_ESB', scope = 'ecoairlines:internal') => ({ access_token: 'token-servicio', clientId, scope })),
  };
  return {
    repo,
    tokens,
    accounts: new AccountsService(repo as unknown as IdentityRepository, tokens as unknown as TokensService, CONFIG),
    partners: new PartnersService(repo as unknown as IdentityRepository, tokens as unknown as TokensService, CONFIG),
  };
}
let d: ReturnType<typeof dobles>;
beforeEach(() => (d = dobles()));

const usuario = async (over: Partial<UserRecord> = {}): Promise<UserRecord> => ({
  sub: 'u-1',
  email: 'ana@x.com',
  fullName: 'Ana',
  passwordHash: await hashSecret('Clave-Segura-1'),
  role: 'CUSTOMER',
  status: 'ACTIVE',
  createdAt: 'x',
  createdBy: null,
  lastLoginAt: null,
  ...over,
});
function socio(over: Partial<PartnerRecord> = {}): PartnerRecord {
  return { clientId: 'BOOKING_PROTOTIPO', name: 'Booking', secretHash: '', scopes: ['flights:read', 'flights:book'], status: 'ACTIVE', createdAt: 'x', createdBy: null, secretRotatedAt: null, lastTokenAt: null, ...over };
}

// ================================================================================================ cuentas
describe('AccountsService: registro y login', () => {
  it('el registro público crea siempre un CUSTOMER activo, con el correo normalizado y la clave derivada', async () => {
    await d.accounts.register({ fullName: '  Ana  ', email: ' Ana@X.com ', password: 'Clave-Segura-1' });
    const guardado = d.repo.insertUser.mock.calls[0]![0] as UserRecord;
    expect(guardado).toMatchObject({ email: 'ana@x.com', fullName: 'Ana', role: 'CUSTOMER', status: 'ACTIVE', createdBy: null });
    expect(guardado.passwordHash).toMatch(/^scrypt\$/);
    expect(guardado.passwordHash).not.toContain('Clave-Segura-1');
  });
  it('el token se emite con los scopes del rol', async () => {
    await d.accounts.register({ fullName: 'Ana', email: 'ana@x.com', password: 'Clave-Segura-1' });
    expect(d.tokens.issueUserToken).toHaveBeenCalledWith(expect.objectContaining({ role: 'CUSTOMER' }), ['flights:read', 'flights:book']);
  });
  it('un correo ya registrado → EMAIL_ALREADY_REGISTERED', async () => {
    d.repo.insertUser.mockResolvedValue(false);
    expect(await codeOf(d.accounts.register({ fullName: 'Ana', email: 'ana@x.com', password: 'x' }))).toBe('EMAIL_ALREADY_REGISTERED');
  });
  it('login correcto: registra el último acceso y emite el token', async () => {
    d.repo.findUserByEmail.mockResolvedValue(await usuario());
    expect((await d.accounts.login({ email: 'ANA@x.com', password: 'Clave-Segura-1' })).access_token).toBe('token-usuario');
    expect(d.repo.findUserByEmail).toHaveBeenCalledWith('ana@x.com');
    expect(d.repo.touchLastLogin).toHaveBeenCalledWith('u-1', expect.any(String));
  });
  it('contraseña incorrecta y correo inexistente responden igual → INVALID_CREDENTIALS', async () => {
    d.repo.findUserByEmail.mockResolvedValue(await usuario());
    expect(await codeOf(d.accounts.login({ email: 'ana@x.com', password: 'otra' }))).toBe('INVALID_CREDENTIALS');
    d.repo.findUserByEmail.mockResolvedValue(undefined);
    expect(await codeOf(d.accounts.login({ email: 'nadie@x.com', password: 'otra' }))).toBe('INVALID_CREDENTIALS');
    expect(d.repo.touchLastLogin).not.toHaveBeenCalled();
  });
  it('una cuenta bloqueada con la clave correcta → ACCOUNT_BLOCKED (sin token)', async () => {
    d.repo.findUserByEmail.mockResolvedValue(await usuario({ status: 'BLOCKED' }));
    expect(await codeOf(d.accounts.login({ email: 'ana@x.com', password: 'Clave-Segura-1' }))).toBe('ACCOUNT_BLOCKED');
    expect(d.tokens.issueUserToken).not.toHaveBeenCalled();
  });
  it(`más de ${CONFIG.attemptsPerMinute} intentos por minuto desde la misma IP → RATE_LIMIT_EXCEEDED`, async () => {
    for (let i = 0; i < CONFIG.attemptsPerMinute; i++) d.accounts.checkAttempts('1.2.3.4');
    expect(await codeOf((async () => d.accounts.checkAttempts('1.2.3.4'))())).toBe('RATE_LIMIT_EXCEEDED');
    expect(await codeOf((async () => d.accounts.checkAttempts('5.6.7.8'))())).toBeUndefined();
  });
});

describe('AccountsService: cambios del administrador', () => {
  /** El repositorio real ejecuta la función de cambio de forma atómica; el stub la ejecuta con el usuario y los ADMIN activos que se le indican. */
  const conCambio = (target: UserRecord, activeAdmins: number) =>
    d.repo.changeUser.mockImplementation(async (_sub: string, change: (t: UserRecord, n: number) => UserRecord | null) => change(target, activeAdmins) ?? target);

  it('cambia el rol y guarda quién lo hizo', async () => {
    conCambio(await usuario(), 1);
    expect(await d.accounts.changeRole('u-1', 'ADMIN', 'admin-1')).toMatchObject({ role: 'ADMIN' });
  });
  it('el mismo valor que ya tiene no es un cambio', async () => {
    const actual = await usuario();
    conCambio(actual, 1);
    expect(await d.accounts.changeStatus('u-1', 'ACTIVE', 'admin-1')).toMatchObject({ status: 'ACTIVE' });
  });
  it('bloquear al último ADMIN activo → LAST_ADMIN', async () => {
    conCambio(await usuario({ sub: 'admin-2', role: 'ADMIN' }), 1);
    expect(await codeOf(d.accounts.changeStatus('admin-2', 'BLOCKED', 'admin-1'))).toBe('LAST_ADMIN');
  });
  it('un usuario que no existe → USER_NOT_FOUND', async () => {
    d.repo.changeUser.mockResolvedValue(undefined);
    expect(await codeOf(d.accounts.changeRole('nadie', 'ADMIN', 'admin-1'))).toBe('USER_NOT_FOUND');
  });
  it('isActiveAdmin: solo un ADMIN activo', async () => {
    d.repo.findUser.mockResolvedValue(await usuario({ role: 'ADMIN' }));
    expect(await d.accounts.isActiveAdmin('u-1')).toBe(true);
    d.repo.findUser.mockResolvedValue(await usuario({ role: 'ADMIN', status: 'BLOCKED' }));
    expect(await d.accounts.isActiveAdmin('u-1')).toBe(false);
    d.repo.findUser.mockResolvedValue(await usuario());
    expect(await d.accounts.isActiveAdmin('u-1')).toBe(false);
  });
  it('el usuario de semilla se crea con su sub fijo o, si existe, solo se le actualiza la clave', async () => {
    await d.accounts.upsertSeedUser({ sub: 'fijo', fullName: 'Admin', email: 'admin@x.com', password: 'p', role: 'ADMIN' });
    expect(d.repo.insertUser).toHaveBeenCalledWith(expect.objectContaining({ sub: 'fijo', role: 'ADMIN' }));
    d.repo.findUser.mockResolvedValue(await usuario({ sub: 'fijo' }));
    await d.accounts.upsertSeedUser({ sub: 'fijo', fullName: 'Admin', email: 'admin@x.com', password: 'nueva', role: 'ADMIN' });
    expect(d.repo.updateUser).toHaveBeenCalledTimes(1);
  });
});

// ================================================================================================ OAuth2 client_credentials
describe('PartnersService.issueToken (OAuth2 client_credentials)', () => {
  const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
  beforeEach(async () => d.repo.findPartner.mockResolvedValue(socio({ secretHash: await hashSecret('secreto-booking') })));

  it('credenciales correctas en el cuerpo: token con todos sus scopes y registra el uso', async () => {
    const token = await d.partners.issueToken({ grant_type: 'client_credentials', client_id: 'BOOKING_PROTOTIPO', client_secret: 'secreto-booking' }, undefined);
    expect(token.scope).toBe('flights:read flights:book');
    expect(d.repo.touchPartnerToken).toHaveBeenCalledWith('BOOKING_PROTOTIPO', expect.any(String));
  });
  it('también por Authorization: Basic (codificado como formulario)', async () =>
    expect((await d.partners.issueToken({ grant_type: 'client_credentials' }, basic('BOOKING_PROTOTIPO', 'secreto-booking'))).access_token).toBe('token-partner'));
  it('pidiendo un subconjunto de scopes, recibe solo esos', async () =>
    expect((await d.partners.issueToken({ grant_type: 'client_credentials', scope: 'flights:read', client_id: 'BOOKING_PROTOTIPO', client_secret: 'secreto-booking' }, undefined)).scope).toBe(
      'flights:read',
    ));
  it('un scope que no tiene → invalid_scope', async () =>
    expect(await codeOf(d.partners.issueToken({ grant_type: 'client_credentials', scope: 'flights:admin', client_id: 'BOOKING_PROTOTIPO', client_secret: 'secreto-booking' }, undefined))).toBe(
      'invalid_scope',
    ));
  it('secreto incorrecto, partner bloqueado o inexistente responden igual → invalid_client (401)', async () => {
    expect(await codeOf(d.partners.issueToken({ grant_type: 'client_credentials', client_id: 'BOOKING_PROTOTIPO', client_secret: 'otro' }, undefined))).toBe('invalid_client');
    d.repo.findPartner.mockResolvedValue(socio({ status: 'BLOCKED', secretHash: await hashSecret('secreto-booking') }));
    expect(await codeOf(d.partners.issueToken({ grant_type: 'client_credentials', client_id: 'BOOKING_PROTOTIPO', client_secret: 'secreto-booking' }, undefined))).toBe('invalid_client');
    d.repo.findPartner.mockResolvedValue(undefined);
    expect(await codeOf(d.partners.issueToken({ grant_type: 'client_credentials', client_id: 'NADIE', client_secret: 'x' }, undefined))).toBe('invalid_client');
    expect(d.tokens.issuePartnerToken).not.toHaveBeenCalled();
  });
  it('otro grant_type → unsupported_grant_type; sin grant_type → invalid_request', async () => {
    expect(await codeOf(d.partners.issueToken({ grant_type: 'password' }, undefined))).toBe('unsupported_grant_type');
    expect(await codeOf(d.partners.issueToken({}, undefined))).toBe('invalid_request');
  });
  it('parámetros que no son de OAuth2 → invalid_request', async () =>
    expect(await codeOf(d.partners.issueToken({ grant_type: 'client_credentials', username: 'x' }, undefined))).toBe('invalid_request'));
  it('credenciales en la cabecera Y en el cuerpo → invalid_request', async () =>
    expect(await codeOf(d.partners.issueToken({ grant_type: 'client_credentials', client_id: 'X' }, basic('X', 'y')))).toBe('invalid_request'));
  it('el ESB recibe un token de servicio ecoairlines:internal (D41)', async () => {
    await d.partners.issueToken({ grant_type: 'client_credentials', client_id: 'ECOAIRLINES_ESB', client_secret: CONFIG.esbClientSecret }, undefined);
    expect(d.tokens.issueServiceToken).toHaveBeenCalledWith();
    expect(d.repo.findPartner).not.toHaveBeenCalled();
  });
  it('un MS de respuesta recibe un token ecoairlines:esb (D44)', async () => {
    await d.partners.issueToken({ grant_type: 'client_credentials', client_id: 'ECOAIRLINES_MS_VUELOS', client_secret: 'secreto-vuelos-de-prueba' }, undefined);
    expect(d.tokens.issueServiceToken).toHaveBeenCalledWith('ECOAIRLINES_MS_VUELOS', 'ecoairlines:esb');
  });
  it('el ESB no puede pedir otro scope → invalid_scope', async () =>
    expect(await codeOf(d.partners.issueToken({ grant_type: 'client_credentials', scope: 'flights:admin', client_id: 'ECOAIRLINES_ESB', client_secret: CONFIG.esbClientSecret }, undefined))).toBe(
      'invalid_scope',
    ));
});

describe('PartnersService: alta, bloqueo y rotación del secreto', () => {
  it('crear: devuelve el secreto UNA vez y guarda solo su hash', async () => {
    const creado = await d.partners.create({ clientId: 'NUEVO', name: ' Nuevo ' }, 'admin-1');
    const guardado = d.repo.insertPartner.mock.calls[0]![0] as PartnerRecord;
    expect(creado.clientSecret).toHaveLength(43);
    expect(guardado.secretHash).not.toContain(creado.clientSecret);
    expect(await verifySecret(creado.clientSecret, guardado.secretHash)).toBe(true);
    expect(guardado).toMatchObject({ name: 'Nuevo', scopes: [...PARTNER_SCOPES], status: 'ACTIVE', createdBy: 'admin-1' });
  });
  it('un identificador reservado (el ESB o un MS de respuesta) no se da de alta', async () => {
    expect(await codeOf(d.partners.create({ clientId: 'ECOAIRLINES_ESB', name: 'x' }, 'a'))).toBe('PARTNER_ALREADY_EXISTS');
    expect(await codeOf(d.partners.create({ clientId: 'ECOAIRLINES_MS_ADMIN', name: 'x' }, 'a'))).toBe('PARTNER_ALREADY_EXISTS');
    expect(d.repo.insertPartner).not.toHaveBeenCalled();
  });
  it('un partner nunca recibe flights:admin', async () => expect(await codeOf(d.partners.create({ clientId: 'X', name: 'x', scopes: ['flights:admin'] }, 'a'))).toBe('VALIDATION_FAILED'));
  it('bloquear guarda quién lo hizo; bloquear uno bloqueado no escribe', async () => {
    d.repo.findPartner.mockResolvedValue(socio());
    expect((await d.partners.changeStatus('BOOKING_PROTOTIPO', 'BLOCKED', 'admin-1')).status).toBe('BLOCKED');
    expect(d.repo.patchPartner).toHaveBeenCalledWith('BOOKING_PROTOTIPO', expect.objectContaining({ status: 'BLOCKED', updatedBy: 'admin-1' }));
    d.repo.patchPartner.mockClear();
    d.repo.findPartner.mockResolvedValue(socio({ status: 'BLOCKED' }));
    await d.partners.changeStatus('BOOKING_PROTOTIPO', 'BLOCKED', 'admin-1');
    expect(d.repo.patchPartner).not.toHaveBeenCalled();
  });
  it('rotar el secreto: el nuevo verifica y queda la fecha de rotación', async () => {
    d.repo.findPartner.mockResolvedValue(socio());
    const rotado = await d.partners.rotateSecret('BOOKING_PROTOTIPO', 'admin-1');
    const patch = d.repo.patchPartner.mock.calls[0]![1] as Partial<PartnerRecord>;
    expect(await verifySecret(rotado.clientSecret, patch.secretHash)).toBe(true);
    expect(patch.secretRotatedAt).toBeTruthy();
  });
  it('un partner que no existe → PARTNER_NOT_FOUND', async () => expect(await codeOf(d.partners.get('NADIE'))).toBe('PARTNER_NOT_FOUND'));
});

describe('security: contraseñas, límite de intentos y sub de semilla', () => {
  it('verifySecret sin hash guardado es falso (y no lanza)', async () => expect(await verifySecret('x', undefined)).toBe(false));
  it('verifySecret con un hash mal formado es falso', async () => expect(await verifySecret('x', 'scrypt$abc$123')).toBe(false));
  it('AttemptLimiter: los intentos de hace más de un minuto ya no cuentan', () => {
    const limiter = new AttemptLimiter(2);
    expect(limiter.hit('ip', 0)).toBeUndefined();
    expect(limiter.hit('ip', 1_000)).toBeUndefined();
    expect(limiter.hit('ip', 2_000)).toBe(58);
    expect(limiter.hit('ip', 61_500)).toBeUndefined();
  });
  it('seedSub: el mismo correo da siempre el mismo sub, con forma de UUID v4', () => {
    expect(seedSub('admin@ecoairlines.ec')).toBe(seedSub('admin@ecoairlines.ec'));
    expect(seedSub('admin@ecoairlines.ec')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(seedSub('otro@ecoairlines.ec')).not.toBe(seedSub('admin@ecoairlines.ec'));
  });
});
