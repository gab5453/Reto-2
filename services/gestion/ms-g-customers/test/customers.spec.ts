import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JsonLogger, signJwt, verifyJwt } from '@ecoairlines/shared';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { CustomersModule, loadConfig, setupApp } from '../src/app.module.js';

/** Pruebas de MS.G.Customers (V2.8) contra contract/ms-g-customers.openapi.yaml 1.1.0. */
const expectContract = contractValidator('ms-g-customers.openapi.yaml');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TOKEN_OPTIONS = { issuer: 'ecoairlines-identity', audience: 'ecoairlines' };
const ESB = signJwt({ sub: 'ECOAIRLINES_ESB', token_use: 'service', scope: 'ecoairlines:internal' }, privateKey, { ...TOKEN_OPTIONS, ttlSeconds: 600 }).token;
const OWNER = '9d2c6a3e-1111-4222-8333-444455556666';
const profile = {
  firstName: 'María José', lastName: 'Andrade Vera', documentType: 'NATIONAL_ID', documentNumber: '1723456789', nationality: 'EC', birthDate: '1995-03-14', gender: 'F',
  contact: { email: 'maria.andrade@example.com', phone: '+593987654321' }, defaultAssistance: { type: 'WCHR', needsCompanion: false, notes: 'Rodilla operada en octubre' },
};

let app: NestExpressApplication;
const esb = (method: 'get' | 'put', owner = OWNER) => request(app.getHttpServer())[method]('/profile').set('Authorization', `Bearer ${ESB}`).set('X-Owner-Id', owner);

beforeAll(async () => {
  process.env['HTTP_REQUEST_LOG'] = 'true';
  const verifier = { verify: async (jwt: string) => verifyJwt(jwt, () => publicKey, TOKEN_OPTIONS) };
  const moduleRef = await Test.createTestingModule({ imports: [CustomersModule.register(loadConfig({ NODE_ENV: 'test' }), { verifier })] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  setupApp(app);
  app.useLogger(new JsonLogger('ms-g-customers'));
  await app.init();
});
afterAll(async () => {
  delete process.env['HTTP_REQUEST_LOG'];
  await app.close();
});

describe('perfil del cliente', () => {
  it('sin perfil → 404 PROFILE_NOT_FOUND', async () => {
    const response = await esb('get', '11111111-2222-4333-8444-555555555555');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('PROFILE_NOT_FOUND');
    expectContract('get', '/profile', response);
  });

  it('crear (201), reemplazar (200) y leer, con la asistencia predeterminada', async () => {
    const created = await esb('put').send(profile);
    expect(created.status).toBe(201);
    expectContract('put', '/profile', created);
    const replaced = await esb('put').send({ ...profile, lastName: 'Andrade' });
    expect(replaced.status).toBe(200);
    const read = await esb('get');
    expectContract('get', '/profile', read);
    expect(read.body).toMatchObject({ lastName: 'Andrade', defaultAssistance: { type: 'WCHR' }, updatedAt: expect.any(String) });
  });

  it('un dueño de partner → 403; datos inválidos o campos de más → 400; sin token → 401', async () => {
    const partner = await esb('get', 'partner:BOOKING_PROTOTIPO:u1');
    expect(partner.status).toBe(403);
    expectContract('get', '/profile', partner);
    const invalid = await esb('put').send({ ...profile, nationality: 'Ecuador' });
    expect(invalid.status).toBe(400);
    expectContract('put', '/profile', invalid);
    expect((await esb('put').send({ ...profile, ownerId: OWNER })).status).toBe(400); // el dueño nunca viaja en el cuerpo
    expect((await request(app.getHttpServer()).get('/profile').set('X-Owner-Id', OWNER)).status).toBe(401);
  });

  it('la asistencia predeterminada (dato de salud) no aparece en los logs', async () => {
    const lines: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => (lines.push(String(chunk)), true));
    process.stderr.write = ((chunk: unknown) => (lines.push(String(chunk)), true));
    try {
      await esb('put').send(profile);
      await esb('put').send({ ...profile, defaultAssistance: { type: 'MEDA', notes: 'Rodilla operada en octubre', extra: 1 } });
      await esb('get');
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    expect(lines.filter((line) => line.includes('"type":"api_request"')).length).toBeGreaterThanOrEqual(3);
    expect(lines.join('')).not.toMatch(/Rodilla|WCHR|MEDA/);
  });
});
