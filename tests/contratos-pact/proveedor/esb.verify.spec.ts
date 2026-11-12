import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Verifier } from '@pact-foundation/pact';
import { EsbModule, setupApp } from '../../../services/esb/src/app.module.js';
import { Upstreams } from '../../../services/esb/src/clients/upstreams.js';
import { InMemoryEventsPublisher } from '../../../services/esb/src/inbound/events-publisher.js';
import { InMemoryEsbStore, type SagaRecord } from '../../../services/esb/src/repositories/esb.store.js';
import { FakeMsg, FakeOffers, FixedToken, testConfig, testVerifier } from '../../../services/esb/test/fakes.js';
import { DUENO_RESERVA, pactFile, PARTICIPANTES, RESERVA_ID, SAGA_COMPENSADA, SAGA_COMPLETADA } from '../comun.js';

/**
 * Verificación del PROVEEDOR (CT-1): el ESB real (con su almacén en memoria y los MS.G falsos de sus propias pruebas, que aquí no
 * se usan) responde `GET /sagas/{sagaId}` a lo que esperan los MS de respuesta. Cada estado guarda la saga que necesita.
 */
let app: NestExpressApplication;
let baseUrl: string;
const store = new InMemoryEsbStore();
const msg = new FakeMsg();
const offers = new FakeOffers();

const saga = (sagaId: string, over: Partial<SagaRecord>): SagaRecord => {
  const now = new Date().toISOString();
  return {
    sagaId,
    type: 'CREATE_BOOKING',
    status: 'RUNNING',
    input: { bookingId: RESERVA_ID },
    steps: [],
    result: null,
    error: null,
    ownerId: DUENO_RESERVA,
    actorId: null,
    correlationId: 'corr-pact',
    parentSagaId: null,
    attempts: 1,
    leaseUntil: now,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
};

beforeAll(async () => {
  const config = testConfig(await msg.start(), await offers.start());
  const moduleRef = await Test.createTestingModule({
    imports: [EsbModule.register(config, { store, verifier: testVerifier, upstreams: new Upstreams(config, new FixedToken()), publisher: new InMemoryEventsPublisher() })],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, rawBody: true, bodyParser: false });
  setupApp(app);
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  await msg.stop();
  await offers.stop();
});

it('el ESB cumple el contrato de los MS de respuesta', () =>
  new Verifier({
    provider: PARTICIPANTES.esb,
    providerBaseUrl: baseUrl,
    pactUrls: [pactFile(PARTICIPANTES.msRespuesta, PARTICIPANTES.esb)],
    stateHandlers: {
      'la saga de crear reserva del usuario de Booking terminó bien': async () => {
        await store.insertSaga(saga(SAGA_COMPLETADA, { status: 'COMPLETED', result: { bookingId: RESERVA_ID, pnr: 'ABC234', status: 'CONFIRMED' } }));
      },
      'la saga de crear reserva del usuario de Booking se compensó por asiento tomado': async () => {
        await store.insertSaga(saga(SAGA_COMPENSADA, { status: 'COMPENSATED', error: { type: 'about:blank', status: 409, code: 'SEAT_TAKEN', title: 'Asiento no disponible' } }));
      },
    },
    // Token de servicio de un MS de respuesta (`ecoairlines:esb`, D44) que acepta el verificador de prueba del ESB.
    requestFilter: (req, _res, next) => {
      req.headers['authorization'] = 'Bearer svc-ms';
      next();
    },
    logLevel: 'warn',
  }).verifyProvider());
