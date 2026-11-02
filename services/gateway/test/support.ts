import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { FakeEsb, testVerifier } from '../../../tests/support/response-service.js';
import { createRuntime, GatewayModule, setupGateway } from '../src/app.module.js';
import { loadGatewayConfig, RESPONSE_SERVICES, type ResponseService, SERVICE_INFO } from '../src/config.js';
import type { GatewayRuntime } from '../src/runtime.js';

/**
 * Soporte de las pruebas del gateway (V2.13): un MS de respuesta falso por servicio (el `FakeEsb` de V2.12 sirve: registra
 * cada llamada y responde lo programado) y la app real del gateway contra ellos, con las claves de prueba.
 */
export type FakeServices = Record<ResponseService, FakeEsb>;

export async function startFakeServices(): Promise<FakeServices> {
  const fakes = Object.fromEntries(RESPONSE_SERVICES.map((service) => [service, new FakeEsb()])) as FakeServices;
  await Promise.all(Object.values(fakes).map((fake) => fake.start()));
  return fakes;
}

export async function stopFakeServices(fakes: FakeServices): Promise<void> {
  await Promise.all(Object.values(fakes).map((fake) => fake.stop()));
}

export function resetFakeServices(fakes: FakeServices): void {
  for (const fake of Object.values(fakes)) fake.reset();
}

export interface GatewayTestApp {
  app: NestExpressApplication;
  runtime: GatewayRuntime;
}

export async function createGatewayApp(fakes: FakeServices, env: NodeJS.ProcessEnv = {}, listen = false): Promise<GatewayTestApp> {
  const urls = Object.fromEntries(RESPONSE_SERVICES.map((service) => [SERVICE_INFO[service].urlVariable, fakes[service].base]));
  const config = loadGatewayConfig({ NODE_ENV: 'test', UPSTREAM_TIMEOUT_MS: '2000', ...urls, ...env });
  const runtime = createRuntime(config, { verifier: testVerifier });
  const moduleRef = await Test.createTestingModule({ imports: [GatewayModule.register(runtime)] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  setupGateway(app, runtime);
  if (listen) await app.listen(0, '127.0.0.1');
  else await app.init();
  return { app, runtime };
}

/** Un ProblemDetails como el que devuelve un MS de respuesta. */
export const problem = (status: number, code: string, title: string, extra: Record<string, unknown> = {}) => ({
  type: 'about:blank',
  title,
  status,
  code,
  instance: '/api/v2/x',
  correlation_id: 'corr-ms',
  timestamp: '2026-10-26T00:00:00.000Z',
  ...extra,
});
