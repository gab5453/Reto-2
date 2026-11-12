import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Verifier } from '@pact-foundation/pact';
import { IdentityModule, setupApp } from '../../../services/gestion/ms-g-identity/src/app.module.js';
import { loadConfig } from '../../../services/gestion/ms-g-identity/src/config/config.js';
import { pactFile, PARTICIPANTES } from '../comun.js';

/**
 * Verificación del PROVEEDOR (CT-1): MS.G.Identity real (en memoria, con su configuración de desarrollo) recibe cada petición de
 * los contratos que publicaron sus consumidores y Pact compara la respuesta. Si alguien cambia `/oauth2/token` de forma que rompe
 * a un consumidor (un campo renombrado, otro status), esta prueba falla ANTES de desplegar.
 */
let app: NestExpressApplication;
let baseUrl: string;

beforeAll(async () => {
  // Configuración de desarrollo: los secretos de los clientes internos son los mismos que usan los contratos.
  const moduleRef = await Test.createTestingModule({ imports: [IdentityModule.register(loadConfig({ NODE_ENV: 'test', AUTH_ATTEMPTS_PER_MINUTE: '1000' }))] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  setupApp(app);
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(() => app.close());

it('MS.G.Identity cumple los contratos del ESB y de los MS de respuesta', () =>
  new Verifier({
    provider: PARTICIPANTES.identity,
    providerBaseUrl: baseUrl,
    pactUrls: [pactFile(PARTICIPANTES.esb, PARTICIPANTES.identity), pactFile(PARTICIPANTES.msRespuesta, PARTICIPANTES.identity)],
    // Los clientes internos existen siempre (son de semilla, D41 y D44): no hay nada que preparar.
    stateHandlers: {
      'existe el cliente interno ECOAIRLINES_ESB': async () => undefined,
      'existe el cliente interno ECOAIRLINES_MS_RESERVAS': async () => undefined,
    },
    // Limitación del verificador de Pact 17: su proxy convierte un formulario en objeto y lo reenvía como JSON (con otro largo
    // que el Content-Length original), y el proveedor responde 400. Aquí se vuelve a armar el formulario tal como llegó.
    requestFilter: (req, _res, next) => {
      const body = (req as unknown as { body?: unknown }).body;
      if (String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded') && body && typeof body === 'object' && !Buffer.isBuffer(body)) {
        (req as unknown as { body: Buffer }).body = Buffer.from(new URLSearchParams(body as Record<string, string>).toString());
      }
      next();
    },
    logLevel: 'warn',
  }).verifyProvider());
