import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { createResponseApp, CUSTOMER_SUB, FakeEsb, FIXED_SERVICE_TOKEN, newKey, PARTNER_ID, tokens } from '../../../../tests/support/response-service.js';
import { definition } from '../src/service.js';

/** MS.Clientes (V2.12) contra un ESB falso: webhooks, token de partner, registro, login y perfil. */
const expectContract = contractValidator('vuelos-openapi-v2.yaml');
const expectIdentity = contractValidator('ms-g-identity.openapi.yaml');
const expectOwn = contractValidator('ms-clientes.openapi.yaml');
const esb = new FakeEsb();
let app: NestExpressApplication;
const http = () => request(app.getHttpServer());
const SUB_ID = '8506a4bf-bab3-4318-9d39-f94035f1e9d7';
const SUBSCRIPTION = { id: SUB_ID, url: 'https://booking.example.com/hooks', events: ['booking.confirmed'], active: true, createdAt: '2026-10-25T19:21:46.555Z', ownerId: `partner:${PARTNER_ID}`, secret: 'whsec_no_se_devuelve_nunca' };
const TOKEN = { access_token: 'eyJ.x.y', token_type: 'Bearer', expires_in: 3600, scope: 'flights:read' };

beforeAll(async () => {
  await esb.start();
  app = await createResponseApp(definition(), esb);
});
afterAll(async () => {
  await app.close();
  await esb.stop();
});
beforeEach(() => esb.reset());

describe('webhooks (del partner completo)', () => {
  it('listWebhooks: dueño partner:<clientId> aunque llegue X-User-Id; la respuesta no expone ownerId ni secret', async () => {
    esb.on('GET', '/router/webhooks/subscriptions', { body: [SUBSCRIPTION] });
    const response = await http().get('/api/v2/vuelos/webhooks').set('Authorization', tokens.partner()).set('X-User-Id', 'usr-1').expect(200);
    expectContract('get', '/vuelos/webhooks', response);
    expect(esb.last()!.headers['x-owner-id']).toBe(`partner:${PARTNER_ID}`);
    expect(response.body[0]).not.toHaveProperty('ownerId');
    expect(response.body[0]).not.toHaveProperty('secret');
  });

  it('★ V2.14: listWebhooks (contrato v2, Booking) quita secretHint; listOwnWebhooks (web) lo conserva y es solo de usuario', async () => {
    esb.on('GET', '/router/webhooks/subscriptions', { body: [{ ...SUBSCRIPTION, secretHint: 'cdef' }] });
    const v2 = await http().get('/api/v2/vuelos/webhooks').set('Authorization', tokens.partner()).expect(200);
    expect(v2.body[0]).not.toHaveProperty('secretHint');
    const own = await http().get('/api/v2/ecoairlines/webhooks').set('Authorization', tokens.admin()).expect(200);
    expectOwn('get', '/ecoairlines/webhooks', own);
    expect(own.body[0]).toMatchObject({ secretHint: 'cdef' });
    expect(own.body[0]).not.toHaveProperty('secret');
    await http().get('/api/v2/ecoairlines/webhooks').set('Authorization', tokens.partner()).expect(403);
    await http().get('/api/v2/ecoairlines/webhooks').set('Authorization', tokens.customer()).expect(403);
  });

  it('createWebhook: 201 con el secreto recortado hacia Webhooks pero nunca de vuelta (writeOnly)', async () => {
    esb.on('POST', '/router/webhooks/subscriptions', { status: 201, body: SUBSCRIPTION });
    const response = await http().post('/api/v2/vuelos/webhooks').set('Authorization', tokens.partner()).set('Idempotency-Key', newKey()).send({ url: 'https://booking.example.com/hooks', events: ['booking.confirmed'], secret: '  whsec_1234567890abcdef  ' }).expect(201);
    expectContract('post', '/vuelos/webhooks', response);
    expect(response.body).not.toHaveProperty('secret');
    expect(esb.last()!.json.secret).toBe('whsec_1234567890abcdef');
  });

  it('400 con un evento que no existe o un secreto corto; 403 sin flights:webhooks', async () => {
    const bad = await http().post('/api/v2/vuelos/webhooks').set('Authorization', tokens.partner()).send({ url: 'https://booking.example.com/hooks', events: ['no.existe'], secret: 'corto' }).expect(400);
    expect(bad.body.invalidParams.map((p: { name: string }) => p.name).sort()).toEqual(['events[0]', 'secret']);
    await http().get('/api/v2/vuelos/webhooks').set('Authorization', tokens.partner('flights:read')).expect(403);
  });

  it('deleteWebhook: 204; de otro partner, el 404 de Webhooks', async () => {
    esb.on('DELETE', `/router/webhooks/subscriptions/${SUB_ID}`, (call) => (call.headers['x-owner-id'] === `partner:${PARTNER_ID}` ? { status: 204 } : { status: 404, body: { type: 'about:blank', title: 'No existe.', status: 404, code: 'NOT_FOUND' } }));
    await http().delete(`/api/v2/vuelos/webhooks/${SUB_ID}`).set('Authorization', tokens.partner()).expect(204);
    expectContract('delete', '/vuelos/webhooks/{id}', await http().delete(`/api/v2/vuelos/webhooks/${SUB_ID}`).set('Authorization', tokens.partner(undefined, 'OTRO_PARTNER')).expect(404));
  });
});

describe('POST /oauth2/token (tokenUrl del contrato)', () => {
  const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

  it('convierte el Basic del partner a client_secret_post y llama al ESB con SU token de servicio (el Basic del partner no viaja)', async () => {
    esb.on('POST', '/router/identity/oauth2/token', { body: TOKEN, headers: { 'cache-control': 'no-store' } });
    const response = await http().post('/api/v2/oauth2/token').set('Authorization', basic(PARTNER_ID, 's3creto')).type('form').send('grant_type=client_credentials&scope=flights%3Aread').expect(200);
    expectIdentity('post', '/oauth2/token', response);
    expect(response.headers['cache-control']).toBe('no-store');
    const call = esb.last()!;
    // El router del ESB exige el token del MS en toda ruta; es el ESB el que llama a Identity sin él.
    expect(call.headers['authorization']).toBe(`Bearer ${FIXED_SERVICE_TOKEN}`);
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({ grant_type: 'client_credentials', scope: 'flights:read', client_id: PARTNER_ID, client_secret: 's3creto' });
  });

  it('el error de Identity sale en el formato de OAuth2 (no ProblemDetails), con WWW-Authenticate si usó Basic', async () => {
    esb.on('POST', '/router/identity/oauth2/token', { status: 401, body: { error: 'invalid_client', error_description: 'Credenciales del cliente inválidas.' } });
    const response = await http().post('/api/v2/oauth2/token').set('Authorization', basic(PARTNER_ID, 'mal')).type('form').send('grant_type=client_credentials').expect(401);
    expectIdentity('post', '/oauth2/token', response);
    expect(response.body.error).toBe('invalid_client');
    expect(response.headers['www-authenticate']).toContain('Basic');
  });

  it('credenciales en la cabecera y en el cuerpo, o un parámetro desconocido → 400 invalid_request (sin llamar al ESB)', async () => {
    const both = await http().post('/api/v2/oauth2/token').set('Authorization', basic(PARTNER_ID, 's')).type('form').send(`grant_type=client_credentials&client_id=${PARTNER_ID}`).expect(400);
    expectIdentity('post', '/oauth2/token', both);
    expect(both.body.error).toBe('invalid_request');
    const unknown = await http().post('/api/v2/oauth2/token').type('form').send('grant_type=client_credentials&password=x').expect(400);
    expect(unknown.body.error).toBe('invalid_request');
    expect(esb.calls).toHaveLength(0);
  });
});

describe('propias de la web: registro, login y perfil', () => {
  it('register y login pasan a Identity; el token no se guarda en cachés', async () => {
    const issued = { access_token: 'eyJ.a.b', token_type: 'Bearer', expires_in: 3600, scope: 'flights:read', user: { sub: CUSTOMER_SUB, fullName: 'Ana Paz', email: 'ana@ecoairlines.test', role: 'CUSTOMER' } };
    esb.on('POST', '/router/identity/auth/register', { status: 201, body: issued, headers: { 'cache-control': 'no-store' } });
    esb.on('POST', '/router/identity/auth/login', { body: issued, headers: { 'cache-control': 'no-store' } });
    const registered = await http().post('/api/v2/ecoairlines/auth/register').send({ email: 'ana@ecoairlines.test', fullName: 'Ana Paz', password: 'Clave-segura-1' }).expect(201);
    expectOwn('post', '/ecoairlines/auth/register', registered);
    const login = await http().post('/api/v2/ecoairlines/auth/login').send({ email: 'ana@ecoairlines.test', password: 'Clave-segura-1' }).expect(200);
    expectOwn('post', '/ecoairlines/auth/login', login);
    expect(login.headers['cache-control']).toBe('no-store');
  });

  it('un código propio de Identity (fuera del enum del contrato) va en `type` y `code` queda el genérico', async () => {
    esb.on('POST', '/router/identity/auth/login', { status: 401, body: { type: 'about:blank', title: 'Correo o contraseña incorrectos.', status: 401, code: 'INVALID_CREDENTIALS' } });
    const response = await http().post('/api/v2/ecoairlines/auth/login').send({ email: 'ana@ecoairlines.test', password: 'mal-mal-mal' }).expect(401);
    expectOwn('post', '/ecoairlines/auth/login', response);
    expect(response.body).toMatchObject({ code: 'UNAUTHORIZED', type: 'urn:ecoairlines:problema:INVALID_CREDENTIALS', title: 'Correo o contraseña incorrectos.' });
  });

  it('★ perfil: solo token de usuario (el partner recibe 403); el dueño es el sub', async () => {
    const profile = { sub: CUSTOMER_SUB, documentType: 'NATIONAL_ID', documentNumber: '1710034065', nationality: 'EC', birthDate: '1990-05-02', gender: 'F', phone: '+593991112244', updatedAt: '2026-10-25T19:20:20.813Z' };
    esb.on('GET', '/router/customers/profile', { body: profile });
    await http().get('/api/v2/ecoairlines/customers/me').set('Authorization', tokens.customer()).expect(200);
    expect(esb.last()!.headers['x-owner-id']).toBe(CUSTOMER_SUB);
    const partner = await http().get('/api/v2/ecoairlines/customers/me').set('Authorization', tokens.partner()).expect(403);
    expectOwn('get', '/ecoairlines/customers/me', partner);
  });
});
