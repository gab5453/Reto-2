import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config/config.js';
import type { StockSyncRecord } from '../src/domain/model.js';
import type { OffersStore } from '../src/repositories/offers.store.js';
import { StockSyncService } from '../src/services/stock-sync.service.js';

/**
 * Stock a Booking por REST (V2.20, D53): `POST /api/v2/inventory/stock`, como lo publicó Booking en Azure. Un Booking falso por
 * HTTP registra lo recibido y responde `success: true` o un ProblemDetails 400, como el real.
 */
type Any = Record<string, unknown>;
const received: { body: Any; headers: IncomingHttpHeaders }[] = [];
let reply: { status: number; body: Any } = { status: 200, body: { success: true } };
let server: Server;
let url = '';

const row = (overrides: Partial<StockSyncRecord> = {}): StockSyncRecord => ({
  segmentId: 'EA100-20261120',
  cabinClass: 'ECONOMY',
  flightNumber: 'EA100',
  date: '2026-11-20',
  timeSlot: '07:00',
  units: 42,
  version: 3,
  pending: true,
  attempts: 0,
  nextAttemptAt: '2026-11-03T00:00:00.000Z',
  correlationId: 'corr-stock-rest',
  ...overrides,
});

function fakeStore(rows: StockSyncRecord[]) {
  const pushed: Any[] = [];
  const failed: Any[] = [];
  const store = {
    pendingStock: async () => rows.splice(0),
    markStockPushed: async (segmentId: string, cabinClass: string, version: number) => void pushed.push({ segmentId, cabinClass, version }),
    markStockFailed: async (segmentId: string, cabinClass: string, version: number, error: string) => void failed.push({ segmentId, cabinClass, version, error }),
  } as unknown as OffersStore;
  return { store, pushed, failed };
}

const service = (store: OffersStore, overrides: Any = {}) =>
  new StockSyncService(store, { ...loadConfig({ NODE_ENV: 'test' }), bookingStockUrl: url, bookingDeadlineMs: 5_000, ...overrides });

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ body: JSON.parse(body || '{}') as Any, headers: req.headers });
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2/inventory/stock`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  received.length = 0;
  reply = { status: 200, body: { success: true } };
});

describe('stock a Booking por REST (D53)', () => {
  it('★ envía exactamente los 5 campos que pide Booking, con nuestro service_id y el X-Correlation-Id', async () => {
    const { store, pushed } = fakeStore([row()]);
    expect(await service(store).flush()).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].body).toEqual({ service_id: 'NODE_VUE_EQ5', item_id: 'EA100-ECONOMY', date: '2026-11-20', time_slot: '07:00', available_units: 42 });
    expect(received[0].headers['content-type']).toBe('application/json');
    expect(received[0].headers['x-correlation-id']).toBe('corr-stock-rest');
    expect(pushed).toEqual([{ segmentId: 'EA100-20261120', cabinClass: 'ECONOMY', version: 3 }]);
  });

  it('★ un 400 de Booking deja el stock pendiente con su motivo (se reintenta)', async () => {
    reply = { status: 400, body: { type: 'urn:gds:error:validation-failed', status: 400, detail: 'El campo item_id (o vehicle_id) es obligatorio.', code: 'VALIDATION_FAILED' } };
    const { store, pushed, failed } = fakeStore([row()]);
    expect(await service(store).flush()).toBe(0);
    expect(pushed).toEqual([]);
    expect(failed[0]).toMatchObject({ version: 3, error: expect.stringContaining('HTTP 400 El campo item_id') });
  });

  it('200 sin success: true no cuenta como integrado', async () => {
    reply = { status: 200, body: { success: false, message: 'servicio no registrado' } };
    const { store, failed } = fakeStore([row()]);
    expect(await service(store).flush()).toBe(0);
    expect(failed[0]).toMatchObject({ error: expect.stringContaining('servicio no registrado') });
  });

  it('Booking caído o lento: falla por tiempo y queda pendiente, sin bloquear', async () => {
    const { store, failed } = fakeStore([row()]);
    expect(await service(store, { bookingStockUrl: 'http://127.0.0.1:9/api/v2/inventory/stock' }).flush()).toBe(0);
    expect(failed).toHaveLength(1);
  });

  it('el stock de un vuelo que ya salió no se envía y queda cerrado', async () => {
    const { store, pushed } = fakeStore([row({ date: '2020-01-01', segmentId: 'EA100-20200101' })]);
    expect(await service(store).flush()).toBe(0);
    expect(received).toEqual([]);
    expect(pushed).toEqual([{ segmentId: 'EA100-20200101', cabinClass: 'ECONOMY', version: 3 }]);
  });

  it('el service_id sale de BOOKING_SERVICE_ID y en producción basta la URL REST como destino', () => {
    expect(loadConfig({ NODE_ENV: 'test', BOOKING_SERVICE_ID: 'NODE_VUE_EQ9' }).bookingServiceId).toBe('NODE_VUE_EQ9');
    const production = { NODE_ENV: 'production', IDENTITY_JWKS_URL: 'http://identity/jwks', BUS_URL: 'amqp://bus' };
    expect(loadConfig({ ...production, BOOKING_STOCK_URL: 'https://booking/api/v2/inventory/stock' }).bookingStockUrl).toContain('booking');
    expect(() => loadConfig(production)).toThrow(/BOOKING_STOCK_URL o BOOKING_GRPC_ADDRESS/);
  });
});
