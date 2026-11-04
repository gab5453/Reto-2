import 'reflect-metadata';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createCloudEvent, runWithCorrelation, signWebhook, verifyWebhookSignature } from '@ecoairlines/shared';
import { AppModule, setupApp } from '../src/app.module.js';
import { findContractFile, InventoryGrpcServer } from '../src/grpc/inventory.server.js';
import { webhookSecret } from '../src/webhooks/webhooks.controller.js';

type StockClient = grpc.Client & {
  PushStockUpdate(message: object, metadata: grpc.Metadata, callback: (error: grpc.ServiceError | null, ack: { success: boolean; message: string }) => void): void;
  StreamInventoryChanges(callback: (error: grpc.ServiceError | null, summary: { total_events_processed: number }) => void): grpc.ClientWritableStream<object>;
};

let app: NestExpressApplication;
let client: StockClient;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
  setupApp(app);
  await app.init();
  const port = await app.get(InventoryGrpcServer).start(0);
  const definition = protoLoader.loadSync(findContractFile('booking-inventory.proto'), { keepCase: true, longs: String, defaults: true });
  const { inventory } = grpc.loadPackageDefinition(definition) as unknown as { inventory: { InventoryStockService: new (address: string, credentials: grpc.ChannelCredentials) => StockClient } };
  client = new inventory.InventoryStockService(`localhost:${port}`, grpc.credentials.createInsecure());
});

afterAll(async () => {
  client.close();
  await app.close();
});

const sendWebhook = (event: object, signature?: string) => {
  const body = JSON.stringify(event);
  return request(app.getHttpServer())
    .post('/webhooks/vuelos')
    .set('content-type', 'application/cloudevents+json')
    .set('X-Correlation-Id', (event as { correlationid?: string }).correlationid ?? 'corr-x')
    .set('X-Webhook-Signature', signature ?? signWebhook(webhookSecret(), body))
    .send(body);
};

describe('booking-simulado — webhooks (contrato v2 §8)', () => {
  const event = runWithCorrelation({ correlationId: 'corr-compra-1', requestId: 'r' }, () =>
    createCloudEvent({ name: 'booking.confirmed', visibility: 'public', subject: 'b-1', data: { bookingId: 'b-1', pnr: 'XK7P2Q', status: 'CONFIRMED' } }),
  );

  it('acepta un CloudEvent firmado (204) y lo registra con su correlationid', async () => {
    await request(app.getHttpServer()).delete('/simulador');
    const response = await sendWebhook(event);
    expect(response.status).toBe(204);
    const received = await request(app.getHttpServer()).get('/simulador/webhooks?type=booking.confirmed');
    expect(received.body).toHaveLength(1);
    expect(received.body[0]).toMatchObject({ id: event.id, correlationId: 'corr-compra-1', headerCorrelationId: 'corr-compra-1', deliveries: 1 });
  });

  it('un reintento con el mismo id no se duplica (solo cuenta la entrega)', async () => {
    expect((await sendWebhook(event)).status).toBe(204);
    const received = await request(app.getHttpServer()).get('/simulador/webhooks');
    expect(received.body).toHaveLength(1);
    expect(received.body[0].deliveries).toBe(2);
  });

  it('rechaza una firma alterada o de otro secreto con 401 ProblemDetails', async () => {
    const response = await sendWebhook(event, signWebhook('otro-secreto-cualquiera', JSON.stringify(event)));
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'UNAUTHORIZED', correlation_id: 'corr-compra-1' });
  });

  it('rechaza con 400 un evento que no es un CloudEvent público', async () => {
    const internal = { ...event, type: 'ec.ecoairlines.internal.pricing.changed' };
    expect((await sendWebhook(internal)).status).toBe(400);
    const { correlationid: _omit, ...withoutCorrelation } = event;
    const response = await sendWebhook(withoutCorrelation);
    expect(response.status).toBe(400);
    expect(response.body.invalidParams).toEqual([{ name: 'correlationid', reason: 'obligatorio en CloudEvents 1.0' }]);
  });
});

describe('booking-simulado — stock por gRPC (contrato v2 §9, booking-inventory.proto)', () => {
  const push = (message: object, correlationId = 'corr-stock-1') =>
    new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      const metadata = new grpc.Metadata();
      metadata.set('x-correlation-id', correlationId);
      client.PushStockUpdate(message, metadata, (error, ack) => (error ? reject(error) : resolve(ack)));
    });
  const valid = { service_id: 'NODE_VUE_ECOAIRLINES', item_id: 'EA300-ECONOMY', date: '2026-11-20', time_slot: '07:00', available_units: 42, timestamp: Date.now() };

  it('PushStockUpdate guarda el valor absoluto por vuelo y cabina, con el x-correlation-id', async () => {
    expect(await push(valid)).toMatchObject({ success: true });
    expect(await push({ ...valid, available_units: 41 }, 'corr-stock-2')).toMatchObject({ success: true });
    const stock = await request(app.getHttpServer()).get('/simulador/stock');
    expect(stock.body.items).toEqual([expect.objectContaining({ itemId: 'EA300-ECONOMY', availableUnits: 41, correlationId: 'corr-stock-2' })]);
  });

  it('responde success = false con el motivo si un campo no cumple el contrato', async () => {
    expect(await push({ ...valid, item_id: 'EA300' })).toMatchObject({ success: false, message: expect.stringContaining('item_id') });
    expect(await push({ ...valid, time_slot: '7am' })).toMatchObject({ success: false, message: expect.stringContaining('time_slot') });
  });

  it('StreamInventoryChanges cuenta los cambios recibidos', async () => {
    const summary = await new Promise<{ total_events_processed: number }>((resolve, reject) => {
      const stream = client.StreamInventoryChanges((error, result) => (error ? reject(error) : resolve(result)));
      stream.write({ event_id: 'e1', item_id: 'EA300-ECONOMY', delta: -2 });
      stream.write({ event_id: 'e2', item_id: 'EA300-ECONOMY', delta: 1 });
      stream.end();
    });
    expect(summary.total_events_processed).toBe(2);
  });

  it('también por REST, como Booking en Azure (V2.20): success: true o 400 con el motivo', async () => {
    const rest = (body: object) => request(app.getHttpServer()).post('/api/v2/inventory/stock').set('x-correlation-id', 'corr-stock-rest').send(body);
    const { timestamp: _timestamp, ...message } = valid;
    const ok = await rest({ ...message, item_id: 'EA301-BUSINESS', available_units: 7 });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, message: 'Stock actualizado' });
    const stock = await request(app.getHttpServer()).get('/simulador/stock');
    expect(stock.body.items).toContainEqual(expect.objectContaining({ itemId: 'EA301-BUSINESS', availableUnits: 7, correlationId: 'corr-stock-rest' }));
    const bad = await rest({ ...message, item_id: 'EA301' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('item_id');
  });

  it('/health informa el gRPC arriba', async () => {
    const health = await request(app.getHttpServer()).get('/health');
    expect(health.status).toBe(200);
    expect(health.body.dependencies.grpc.status).toBe('up');
  });
});

describe('booking-simulado — eventos hacia la aerolínea (BKG-01)', () => {
  let receiver: Server;
  const received: { headers: IncomingMessage['headers']; body: string }[] = [];

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(202).end();
      });
    });
    receiver.listen(0);
    await once(receiver, 'listening');
  });

  afterAll(() => {
    receiver.close();
    delete process.env['AIRLINE_EVENTS_URL'];
  });

  it('sin AIRLINE_EVENTS_URL devuelve el evento sin enviarlo', async () => {
    const response = await request(app.getHttpServer())
      .post('/simulador/eventos')
      .send({ event: 'payment.confirmed', bookingId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ delivered: false, event: { type: 'ec.edu.epn.booking.pagos.payment.confirmed' } });
  });

  it('envía payment.confirmed firmado, con el X-Correlation-Id del proceso', async () => {
    process.env['AIRLINE_EVENTS_URL'] = `http://localhost:${(receiver.address() as AddressInfo).port}/api/integraciones/booking/eventos`;
    const response = await request(app.getHttpServer())
      .post('/simulador/eventos')
      .set('X-Correlation-Id', 'corr-combo-77')
      .send({ event: 'payment.confirmed', bookingId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', amount: '239.00' });
    expect(response.body).toMatchObject({ delivered: true, event: { correlationid: 'corr-combo-77' } });
    const delivery = received.at(-1)!;
    expect(delivery.headers['x-correlation-id']).toBe('corr-combo-77');
    expect(verifyWebhookSignature('secreto-de-prueba-eventos-booking', delivery.body, delivery.headers['x-webhook-signature'] as string)).toBe(true);
    expect(JSON.parse(delivery.body).data).toMatchObject({ amount: { currency: 'USD', total: '239.00' }, failureReason: null });
  });

  it('valida la petición: un evento desconocido responde 400', async () => {
    const response = await request(app.getHttpServer()).post('/simulador/eventos').send({ event: 'payment.refunded', bookingId: 'x' });
    expect(response.status).toBe(400);
    expect(response.body.invalidParams.map((p: { name: string }) => p.name).sort()).toEqual(['bookingId', 'event']);
  });
});
