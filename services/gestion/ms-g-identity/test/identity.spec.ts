import 'reflect-metadata';
import { createPublicKey } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type Jwk, verifyJwt } from '@ecoairlines/shared';
import { IdentityModule, setupApp } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { seedSub } from '../src/services/security.js';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';

const expectContract = contractValidator('ms-g-identity.openapi.yaml');

/** Pruebas de MS.G.Identity (V2.3) contra contract/ms-g-identity.openapi.yaml, con el repositorio en memoria. */
const ESB_SECRET = 'secreto-esb-de-prueba-0001';
const BOOKING_SECRET = 'secreto-booking-de-prueba-0001';
const ADMIN = seedSub('admin@ecoairlines.test');
const DEMO = seedSub('demo@ecoairlines.test');

async function createApp(env: Record<string, string> = {}): Promise<NestExpressApplication> {
  const config = loadConfig({
    NODE_ENV: 'test',
    ESB_CLIENT_SECRET: ESB_SECRET,
    BOOKING_CLIENT_SECRET: BOOKING_SECRET,
    AUTH_ATTEMPTS_PER_MINUTE: '1000',
    ...env,
  });
  const moduleRef = await Test.createTestingModule({ imports: [IdentityModule.register(config)] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  setupApp(app);
  await app.init();
  return app;
}

let app: NestExpressApplication;
let esbToken: string;
const http = () => request(app.getHttpServer());
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const tokenRequest = (form: Record<string, string>, authorization?: string) => {
  const call = http().post('/oauth2/token').type('form').send(form);
  return authorization ? call.set('Authorization', authorization) : call;
};
/** Llamada de administración tal como la hace el ESB: token de servicio + X-Actor-Id. */
const admin = (method: 'get' | 'post' | 'put', path: string, actor = ADMIN) =>
  http()[method](path).set('Authorization', `Bearer ${esbToken}`).set('X-Actor-Id', actor);

beforeAll(async () => {
  app = await createApp();
  const response = await tokenRequest({ grant_type: 'client_credentials' }, basic('ECOAIRLINES_ESB', ESB_SECRET));
  esbToken = response.body.access_token;
});
afterAll(() => app.close());

describe('JWKS y firma RS256', () => {
  it('publica la clave pública con caché de 1 h y sin parte privada', async () => {
    const response = await http().get('/.well-known/jwks.json');
    expectContract('get', '/.well-known/jwks.json', response);
    expect(response.headers['cache-control']).toBe('public, max-age=3600');
    expect(response.body.keys[0]).not.toHaveProperty('d');
  });

  it('un token emitido se verifica con la JWKS publicada', async () => {
    const jwks = (await http().get('/.well-known/jwks.json')).body as { keys: Jwk[] };
    const login = await http().post('/auth/login').send({ email: 'demo@ecoairlines.test', password: 'EcoDemo2026' });
    const key = createPublicKey({ key: { ...jwks.keys[0] }, format: 'jwk' });
    const claims = verifyJwt(login.body.access_token, (kid) => (kid === jwks.keys[0].kid ? key : undefined), {
      issuer: 'ecoairlines-identity',
      audience: 'ecoairlines',
    });
    expect(claims).toMatchObject({ sub: DEMO, token_use: 'user', role: 'CUSTOMER', name: 'Usuario Demo', email: 'demo@ecoairlines.test' });
  });
});

describe('registro', () => {
  it('crea siempre un CUSTOMER activo, guarda el correo en minúsculas y devuelve su token', async () => {
    const response = await http().post('/auth/register').send({ fullName: 'Ana Pérez', email: '  Ana.Perez@Ejemplo.COM ', password: 'ClaveSegura2026' });
    expect(response.status).toBe(201);
    expectContract('post', '/auth/register', response);
    expect(response.headers['x-correlation-id']).toBeTruthy();
    expect(response.body.user).toMatchObject({ email: 'ana.perez@ejemplo.com', role: 'CUSTOMER' });
    expect(claimsOf(response.body.access_token)).toMatchObject({ token_use: 'user', role: 'CUSTOMER', scope: 'flights:read flights:hold flights:book flights:cancel ecoairlines:profile' });
  });

  it('nadie se registra como ADMIN: un campo `role` se rechaza (400)', async () => {
    const response = await http().post('/auth/register').send({ fullName: 'Intruso', email: 'intruso@x.com', password: 'ClaveSegura2026', role: 'ADMIN' });
    expect(response.status).toBe(400);
    expectContract('post', '/auth/register', response);
  });

  it('el mismo correo con otras mayúsculas es la misma cuenta (409 EMAIL_ALREADY_REGISTERED)', async () => {
    const response = await http().post('/auth/register').send({ fullName: 'Otra', email: 'DEMO@ecoairlines.test', password: 'ClaveSegura2026' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EMAIL_ALREADY_REGISTERED');
    expectContract('post', '/auth/register', response);
  });

  it('contraseña corta → 400 VALIDATION_FAILED con invalidParams', async () => {
    const response = await http().post('/auth/register').send({ fullName: 'Corta', email: 'corta@x.com', password: '1234' });
    expect(response.status).toBe(400);
    expect(response.body.invalidParams[0].name).toBe('password');
  });
});

describe('login', () => {
  it('credenciales correctas → 200 con el token de usuario', async () => {
    const response = await http().post('/auth/login').send({ email: 'admin@ecoairlines.test', password: 'EcoAdmin2026' });
    expect(response.status).toBe(200);
    expectContract('post', '/auth/login', response);
    expect(response.body.user).toMatchObject({ sub: ADMIN, role: 'ADMIN' });
    expect(response.body.scope.split(' ')).toContain('flights:admin');
  });

  it('correo inexistente y contraseña incorrecta responden igual (401 INVALID_CREDENTIALS)', async () => {
    const unknown = await http().post('/auth/login').send({ email: 'nadie@ecoairlines.test', password: 'EcoDemo2026' });
    const wrong = await http().post('/auth/login').send({ email: 'demo@ecoairlines.test', password: 'otra-clave' });
    for (const response of [unknown, wrong]) {
      expect(response.status).toBe(401);
      expectContract('post', '/auth/login', response);
    }
    const strip = ({ correlation_id: _c, timestamp: _t, ...rest }: Record<string, unknown>) => rest;
    expect(strip(unknown.body)).toEqual(strip(wrong.body));
  });

  it('cuenta bloqueada: 403 solo con la contraseña correcta; con una incorrecta sigue siendo 401', async () => {
    const created = await admin('post', '/users').send({ fullName: 'Para Bloquear', email: 'bloqueo@x.com', password: 'ClaveSegura2026', role: 'CUSTOMER' });
    await admin('put', `/users/${created.body.sub}/status`).send({ status: 'BLOCKED', reason: 'prueba' });
    const correct = await http().post('/auth/login').send({ email: 'bloqueo@x.com', password: 'ClaveSegura2026' });
    expect(correct.status).toBe(403);
    expect(correct.body.code).toBe('ACCOUNT_BLOCKED');
    expectContract('post', '/auth/login', correct);
    const incorrect = await http().post('/auth/login').send({ email: 'bloqueo@x.com', password: 'otra-clave-123' });
    expect(incorrect.status).toBe(401);
  });

  it('registra lastLoginAt', async () => {
    await http().post('/auth/login').send({ email: 'demo@ecoairlines.test', password: 'EcoDemo2026' });
    const user = await admin('get', `/users/${DEMO}`);
    expect(user.body.lastLoginAt).toEqual(expect.any(String));
  });
});

describe('límite de intentos (10 por minuto)', () => {
  it('pasado el límite responde 429 con Retry-After, por IP en login y por client_id en /oauth2/token', async () => {
    const limited = await createApp({ AUTH_ATTEMPTS_PER_MINUTE: '3' });
    try {
      const server = limited.getHttpServer();
      for (let i = 0; i < 3; i++) await request(server).post('/auth/login').send({ email: 'demo@ecoairlines.test', password: 'mala-1234' });
      const blocked = await request(server).post('/auth/login').send({ email: 'demo@ecoairlines.test', password: 'EcoDemo2026' });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expectContract('post', '/auth/login', blocked);

      const token = () => request(server).post('/oauth2/token').type('form').set('Authorization', basic('BOOKING_PROTOTIPO', 'mala')).send({ grant_type: 'client_credentials' });
      for (let i = 0; i < 3; i++) expect((await token()).status).toBe(401);
      const tooMany = await token();
      expect(tooMany.status).toBe(429);
      expect(tooMany.body.code).toBe('RATE_LIMIT_EXCEEDED');
    } finally {
      await limited.close();
    }
    // Arma su propia app (el seed calcula los hash scrypt de los usuarios demo) y hace 8 logins: con la suite en paralelo
    // pasaba a veces los 5 s por defecto.
  }, 20_000);
});

describe('OAuth2 client_credentials (partner Booking)', () => {
  it('client_secret_basic → token de partner con TODOS sus scopes y nunca flights:admin', async () => {
    const response = await tokenRequest({ grant_type: 'client_credentials' }, basic('BOOKING_PROTOTIPO', BOOKING_SECRET));
    expect(response.status).toBe(200);
    expectContract('post', '/oauth2/token', response);
    expect(response.headers['cache-control']).toBe('no-store');
    const claims = claimsOf(response.body.access_token);
    expect(claims).toMatchObject({ sub: 'BOOKING_PROTOTIPO', token_use: 'partner', iss: 'ecoairlines-identity', aud: 'ecoairlines' });
    expect(claims.scope.split(' ').sort()).toEqual(['flights:book', 'flights:cancel', 'flights:hold', 'flights:ops', 'flights:read', 'flights:webhooks']);
    expect(claims.scope).not.toMatch(/flights:admin|ecoairlines:/);
    expect(claims).not.toHaveProperty('role');
  });

  it('client_secret_post con un subconjunto de scopes → solo esos', async () => {
    const response = await tokenRequest({ grant_type: 'client_credentials', client_id: 'BOOKING_PROTOTIPO', client_secret: BOOKING_SECRET, scope: 'flights:read flights:hold' });
    expect(response.status).toBe(200);
    expect(response.body.scope).toBe('flights:read flights:hold');
  });

  it('pedir flights:admin → 400 invalid_scope (formato OAuth2, no ProblemDetails)', async () => {
    const response = await tokenRequest({ grant_type: 'client_credentials', scope: 'flights:read flights:admin' }, basic('BOOKING_PROTOTIPO', BOOKING_SECRET));
    expect(response.status).toBe(400);
    expectContract('post', '/oauth2/token', response);
    expect(response.body).toMatchObject({ error: 'invalid_scope', correlation_id: expect.any(String), timestamp: expect.any(String) });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('secreto incorrecto por Basic → 401 invalid_client con WWW-Authenticate', async () => {
    const response = await tokenRequest({ grant_type: 'client_credentials' }, basic('BOOKING_PROTOTIPO', 'incorrecto'));
    expect(response.status).toBe(401);
    expectContract('post', '/oauth2/token', response);
    expect(response.body.error).toBe('invalid_client');
    expect(response.headers['www-authenticate']).toBe('Basic realm="ecoairlines"');
  });

  it('partner inexistente responde igual que un secreto incorrecto (sin WWW-Authenticate si fue por el cuerpo)', async () => {
    const response = await tokenRequest({ grant_type: 'client_credentials', client_id: 'NO_EXISTE', client_secret: 'x' });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: 'invalid_client', error_description: 'Credenciales del cliente inválidas.' });
    expect(response.headers['www-authenticate']).toBeUndefined();
  });

  it.each([
    ['credenciales en la cabecera y en el cuerpo', { grant_type: 'client_credentials', client_id: 'BOOKING_PROTOTIPO' }, true, 'invalid_request'],
    ['falta grant_type', {}, true, 'invalid_request'],
    ['parámetro no permitido', { grant_type: 'client_credentials', username: 'x' }, true, 'invalid_request'],
    ['grant_type password', { grant_type: 'password' }, true, 'unsupported_grant_type'],
  ])('%s → 400 %s', async (_, form, withBasic, error) => {
    const response = await tokenRequest(form, withBasic ? basic('BOOKING_PROTOTIPO', BOOKING_SECRET) : undefined);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe(error);
    expectContract('post', '/oauth2/token', response);
  });

  it('un cuerpo JSON en lugar de formulario → 400 invalid_request', async () => {
    const response = await http().post('/oauth2/token').set('Authorization', basic('BOOKING_PROTOTIPO', BOOKING_SECRET)).send({ grant_type: 'client_credentials' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it('cabecera Basic con codificación inválida → 401 invalid_client (no 500)', async () => {
    const response = await tokenRequest({ grant_type: 'client_credentials' }, `Basic ${Buffer.from('BOOKING_PROTOTIPO:%E0%A4%A').toString('base64')}`);
    expect(response.status).toBe(401);
  });

  it('ESB (D41) → token de servicio con ecoairlines:internal; ECOAIRLINES_ESB no aparece en /partners', async () => {
    expect(claimsOf(esbToken)).toMatchObject({ sub: 'ECOAIRLINES_ESB', token_use: 'service', scope: 'ecoairlines:internal' });
    const asked = await tokenRequest({ grant_type: 'client_credentials', scope: 'flights:admin' }, basic('ECOAIRLINES_ESB', ESB_SECRET));
    expect(asked.body.error).toBe('invalid_scope');
    const list = await admin('get', '/partners');
    expect(list.body.items.map((p: { clientId: string }) => p.clientId)).toEqual(['BOOKING_PROTOTIPO']);
  });
});

describe('clientes internos de los MS de respuesta (D44)', () => {
  const MS_VUELOS_SECRET = 'secreto-ms-vuelos-dev-solo-local-0001';

  it('token de servicio con ecoairlines:esb (lo acepta solo el ESB); otro scope → invalid_scope; secreto incorrecto → 401', async () => {
    const response = await tokenRequest({ grant_type: 'client_credentials' }, basic('ECOAIRLINES_MS_VUELOS', MS_VUELOS_SECRET));
    expect(response.status).toBe(200);
    expectContract('post', '/oauth2/token', response);
    expect(claimsOf(response.body.access_token)).toMatchObject({ sub: 'ECOAIRLINES_MS_VUELOS', token_use: 'service', scope: 'ecoairlines:esb' });
    const internal = await tokenRequest({ grant_type: 'client_credentials', scope: 'ecoairlines:internal' }, basic('ECOAIRLINES_MS_VUELOS', MS_VUELOS_SECRET));
    expect(internal.body.error).toBe('invalid_scope');
    const wrong = await tokenRequest({ grant_type: 'client_credentials' }, basic('ECOAIRLINES_MS_VUELOS', 'otro-secreto-de-16-car'));
    expect(wrong.status).toBe(401);
    // El secreto de un MS no sirve para otro.
    expect((await tokenRequest({ grant_type: 'client_credentials' }, basic('ECOAIRLINES_MS_ADMIN', MS_VUELOS_SECRET))).status).toBe(401);
  });

  it('sus identificadores están reservados: no se pueden dar de alta como partner y no aparecen en /partners', async () => {
    expect((await admin('post', '/partners').send({ clientId: 'ECOAIRLINES_MS_RESERVAS', name: 'Suplantación' })).status).toBe(409);
    const list = await admin('get', '/partners');
    expect(list.body.items.map((p: { clientId: string }) => p.clientId)).not.toContain('ECOAIRLINES_MS_RESERVAS');
  });
});

describe('operaciones de administración: solo el ESB, en nombre de un ADMIN activo', () => {
  it('sin token → 401', async () => {
    const response = await http().get('/users').set('X-Actor-Id', ADMIN);
    expect(response.status).toBe(401);
    expectContract('get', '/users', response);
  });

  it('token de partner o de usuario (aunque sea ADMIN) → 403: solo vale el token de servicio', async () => {
    const partner = await tokenRequest({ grant_type: 'client_credentials' }, basic('BOOKING_PROTOTIPO', BOOKING_SECRET));
    const user = await http().post('/auth/login').send({ email: 'admin@ecoairlines.test', password: 'EcoAdmin2026' });
    for (const token of [partner.body.access_token, user.body.access_token]) {
      const response = await http().get('/users').set('Authorization', `Bearer ${token}`).set('X-Actor-Id', ADMIN);
      expect(response.status).toBe(403);
      expectContract('get', '/users', response);
    }
  });

  it('X-Actor-Id ausente o de un CUSTOMER → 403', async () => {
    const missing = await http().get('/roles').set('Authorization', `Bearer ${esbToken}`);
    const customer = await admin('get', '/roles', DEMO);
    for (const response of [missing, customer]) {
      expect(response.status).toBe(403);
      expectContract('get', '/roles', response);
    }
  });

  it('token firmado con otra clave → 401', async () => {
    const other = await createApp();
    try {
      const foreign = await request(other.getHttpServer()).post('/oauth2/token').type('form').set('Authorization', basic('ECOAIRLINES_ESB', ESB_SECRET)).send({ grant_type: 'client_credentials' });
      const response = await http().get('/roles').set('Authorization', `Bearer ${foreign.body.access_token}`).set('X-Actor-Id', ADMIN);
      expect(response.status).toBe(401);
    } finally {
      await other.close();
    }
  });
});

describe('usuarios', () => {
  it('lista, busca, resume y lee usuarios (contrato)', async () => {
    const list = await admin('get', '/users?limit=2');
    expectContract('get', '/users', list);
    expect(list.body.items).toHaveLength(2);
    const next = await admin('get', `/users?limit=2&cursor=${list.body.nextCursor}`);
    expect(next.body.items[0].sub).not.toBe(list.body.items[0].sub);
    const search = await admin('get', '/users?q=MARÍA');
    expect(search.body.items.map((u: { email: string }) => u.email)).toEqual(['maria@ecoairlines.test']);
    const summary = await admin('get', '/users/summary');
    expectContract('get', '/users/summary', summary);
    expect(summary.body.byRole.ADMIN).toBeGreaterThanOrEqual(1);
    const one = await admin('get', `/users/${DEMO}`);
    expectContract('get', '/users/{sub}', one);
    expect(one.body).not.toHaveProperty('passwordHash');
    const missing = await admin('get', '/users/00000000-0000-4000-a000-000000000000');
    expect(missing.status).toBe(404);
    expectContract('get', '/users/{sub}', missing);
  });

  it('limit fuera de rango → 400', async () => {
    const response = await admin('get', '/users?limit=500');
    expect(response.status).toBe(400);
    expectContract('get', '/users', response);
  });

  it('crea un ADMIN con Location y createdBy = X-Actor-Id; el nuevo ADMIN puede operar', async () => {
    const response = await admin('post', '/users').send({ fullName: 'Ana Supervisora', email: 'ana@ecoairlines.test', password: 'ClaveSegura2026', role: 'ADMIN' });
    expect(response.status).toBe(201);
    expectContract('post', '/users', response);
    expect(response.headers['location']).toBe(`/users/${response.body.sub}`);
    expect(response.body).toMatchObject({ role: 'ADMIN', status: 'ACTIVE', createdBy: ADMIN });
    expect((await admin('get', '/roles', response.body.sub)).status).toBe(200);
  });

  it('cambia el rol (mismo rol → 200 sin cambios)', async () => {
    const created = await admin('post', '/users').send({ fullName: 'Rol Cambiante', email: 'rol@x.com', password: 'ClaveSegura2026', role: 'CUSTOMER' });
    const same = await admin('put', `/users/${created.body.sub}/role`).send({ role: 'CUSTOMER' });
    expect(same.status).toBe(200);
    expect(same.body).not.toHaveProperty('updatedAt');
    const changed = await admin('put', `/users/${created.body.sub}/role`).send({ role: 'ADMIN' });
    expectContract('put', '/users/{sub}/role', changed);
    expect(changed.body).toMatchObject({ role: 'ADMIN', updatedBy: ADMIN });
  });

  it('un ADMIN no cambia su propio rol ni se bloquea (409 CANNOT_MODIFY_SELF)', async () => {
    const role = await admin('put', `/users/${ADMIN}/role`).send({ role: 'CUSTOMER' });
    const status = await admin('put', `/users/${ADMIN}/status`).send({ status: 'BLOCKED' });
    for (const [path, response] of [['/users/{sub}/role', role], ['/users/{sub}/status', status]] as const) {
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CANNOT_MODIFY_SELF');
      expectContract('put', path, response);
    }
  });

  it('un ADMIN bloqueado deja de poder operar aunque el ESB lo mande como actor', async () => {
    const other = await admin('post', '/users').send({ fullName: 'Admin Temporal', email: 'temporal@x.com', password: 'ClaveSegura2026', role: 'ADMIN' });
    await admin('put', `/users/${other.body.sub}/status`).send({ status: 'BLOCKED' });
    expect((await admin('get', '/roles', other.body.sub)).status).toBe(403);
  });

  it('valor de rol desconocido → 400', async () => {
    const response = await admin('put', `/users/${DEMO}/role`).send({ role: 'OPS' });
    expect(response.status).toBe(400);
  });
});

describe('partners', () => {
  it('alta: el secreto se muestra una sola vez y sirve para pedir un token', async () => {
    const created = await admin('post', '/partners').send({ clientId: 'AGENCIA_NORTE', name: 'Agencia Norte', scopes: ['flights:read'] });
    expect(created.status).toBe(201);
    expectContract('post', '/partners', created);
    expect(created.headers['location']).toBe('/partners/AGENCIA_NORTE');
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body.clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const detail = await admin('get', '/partners/AGENCIA_NORTE');
    expectContract('get', '/partners/{clientId}', detail);
    expect(detail.body).not.toHaveProperty('clientSecret');

    const token = await tokenRequest({ grant_type: 'client_credentials' }, basic('AGENCIA_NORTE', created.body.clientSecret));
    expect(token.body.scope).toBe('flights:read');
    expect((await admin('get', '/partners/AGENCIA_NORTE')).body.lastTokenAt).toEqual(expect.any(String));
  });

  it('sin scopes recibe todos los PartnerScope; duplicado → 409 PARTNER_ALREADY_EXISTS', async () => {
    const created = await admin('post', '/partners').send({ clientId: 'AGENCIA_SUR', name: 'Agencia Sur' });
    expect(created.body.scopes).toHaveLength(6);
    const duplicate = await admin('post', '/partners').send({ clientId: 'AGENCIA_SUR', name: 'Otra' });
    expect(duplicate.status).toBe(409);
    expectContract('post', '/partners', duplicate);
    const esb = await admin('post', '/partners').send({ clientId: 'ECOAIRLINES_ESB', name: 'Suplantación' });
    expect(esb.status).toBe(409);
  });

  it('un partner nunca recibe flights:admin ni ecoairlines:* (400)', async () => {
    const response = await admin('post', '/partners').send({ clientId: 'AGENCIA_MALA', name: 'Mala', scopes: ['flights:read', 'flights:admin'] });
    expect(response.status).toBe(400);
    expectContract('post', '/partners', response);
    expect(response.body.invalidParams[0].reason).toContain('flights:admin');
  });

  it('clientId inválido → 400', async () => {
    const response = await admin('post', '/partners').send({ clientId: 'minusculas', name: 'X' });
    expect(response.status).toBe(400);
  });

  it('rotar el secreto: el anterior deja de servir de inmediato', async () => {
    const created = await admin('post', '/partners').send({ clientId: 'AGENCIA_ESTE', name: 'Agencia Este' });
    const rotated = await admin('post', '/partners/AGENCIA_ESTE/secret');
    expect(rotated.status).toBe(200);
    expectContract('post', '/partners/{clientId}/secret', rotated);
    expect(rotated.body.secretRotatedAt).toEqual(expect.any(String));
    expect((await tokenRequest({ grant_type: 'client_credentials' }, basic('AGENCIA_ESTE', created.body.clientSecret))).status).toBe(401);
    expect((await tokenRequest({ grant_type: 'client_credentials' }, basic('AGENCIA_ESTE', rotated.body.clientSecret))).status).toBe(200);
  });

  it('bloqueado → invalid_client; al reactivarlo vuelve a obtener tokens', async () => {
    const created = await admin('post', '/partners').send({ clientId: 'AGENCIA_OESTE', name: 'Agencia Oeste' });
    const blocked = await admin('put', '/partners/AGENCIA_OESTE/status').send({ status: 'BLOCKED', reason: 'prueba' });
    expectContract('put', '/partners/{clientId}/status', blocked);
    const denied = await tokenRequest({ grant_type: 'client_credentials' }, basic('AGENCIA_OESTE', created.body.clientSecret));
    expect(denied.status).toBe(401);
    expect(denied.body.error).toBe('invalid_client');
    await admin('put', '/partners/AGENCIA_OESTE/status').send({ status: 'ACTIVE' });
    expect((await tokenRequest({ grant_type: 'client_credentials' }, basic('AGENCIA_OESTE', created.body.clientSecret))).status).toBe(200);
  });

  it('lista con filtro y 404 de un partner inexistente', async () => {
    const list = await admin('get', '/partners?status=ACTIVE');
    expectContract('get', '/partners', list);
    const missing = await admin('get', '/partners/NO_EXISTE');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('PARTNER_NOT_FOUND');
    expectContract('get', '/partners/{clientId}', missing);
  });
});

describe('roles y salud', () => {
  it('roles CUSTOMER y ADMIN con sus scopes (sin OPS, D30)', async () => {
    const response = await admin('get', '/roles');
    expectContract('get', '/roles', response);
    expect(response.body.map((r: { name: string }) => r.name).sort()).toEqual(['ADMIN', 'CUSTOMER']);
    const adminRole = response.body.find((r: { name: string }) => r.name === 'ADMIN');
    expect(adminRole.scopes).toEqual(expect.arrayContaining(['flights:ops', 'flights:admin']));
  });

  it('GET /health informa la base (en memoria en las pruebas)', async () => {
    const response = await http().get('/health');
    expect(response.status).toBe(200);
    expectContract('get', '/health', response);
    expect(response.body.dependencies.database.status).toBe('memory');
  });
});
