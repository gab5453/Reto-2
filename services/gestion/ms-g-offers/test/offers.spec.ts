import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import protobuf from 'protobufjs';
import request from 'supertest';
import { signJwt, type TokenUse, verifyJwt } from '@ecoairlines/shared';
import { OffersModule, setupApp } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { addDays, localDate } from '../src/domain/catalog.js';
import { OFFERS_STORE, type OffersStore } from '../src/repositories/offers.store.js';
import { HoldsService } from '../src/services/holds.service.js';
import { findContractFile, StockSyncService } from '../src/services/stock-sync.service.js';

/**
 * Pruebas de MS.G.Offers (V2.5) con un CLIENTE gRPC real contra el servidor (contract/ms-g-offers.proto) y un Booking falso
 * (`inventory.InventoryStockService` de booking-inventory.proto) que registra el stock recibido y se puede apagar.
 */
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Client = grpc.Client & Record<string, (req: unknown, md: grpc.Metadata, cb: (e: grpc.ServiceError | null, r: Any) => void) => grpc.ClientUnaryCall>;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TOKEN_OPTIONS = { issuer: 'ecoairlines-identity', audience: 'ecoairlines' };
const token = (token_use: TokenUse, scope: string) =>
  signJwt({ sub: token_use === 'service' ? 'ECOAIRLINES_ESB' : 'BOOKING_PROTOTIPO', token_use, scope }, privateKey, { ...TOKEN_OPTIONS, ttlSeconds: 600 }).token;
const ESB = token('service', 'ecoairlines:internal');
const problemType = protobuf.loadSync(findContractFile('ms-g-offers.proto')).lookupType('ecoairlines.offers.v1.ProblemDetails');

// Vuelos de la red de prueba (un avión) dentro de 2 días, como los publicaría el ESB desde Schedule.
const DAY = addDays(localDate(Date.now()), 2);
const NEXT = addDays(DAY, 1);
const flight = (flightNumber: string, date: string, origin: string, destination: string, dep: string, arr: string, routeId: string) => ({
  flightNumber, date, routeId, origin, destination, departureAt: `${date}T${dep}:00-05:00`, arrivalAt: `${date}T${arr}:00-05:00`, aircraftType: 'Airbus A320neo', registration: 'HC-N01',
});
const network = (date: string) => [
  flight('EA100', date, 'UIO', 'GYE', '07:00', '07:50', 'EA100-EA101'),
  flight('EA101', date, 'GYE', 'UIO', '09:00', '09:50', 'EA100-EA101'),
  flight('EA102', date, 'UIO', 'BOG', '13:00', '14:25', 'EA102-EA103'),
  flight('EA103', date, 'BOG', 'UIO', '16:30', '17:55', 'EA102-EA103'),
];
const segment = (flightNumber: string, date = DAY) => `${flightNumber}-${date.replaceAll('-', '')}`;

// ------------------------------------------------------------------ Booking falso
const received: Any[] = [];
let booking: grpc.Server | undefined;
let bookingPort = 0;
async function startBooking(port = 0): Promise<number> {
  const definition = protoLoader.loadSync(findContractFile('booking-inventory.proto'), { keepCase: true, longs: String, defaults: true });
  const { inventory } = grpc.loadPackageDefinition(definition) as unknown as { inventory: { InventoryStockService: { service: grpc.ServiceDefinition } } };
  booking = new grpc.Server();
  booking.addService(inventory.InventoryStockService.service, {
    PushStockUpdate: (call: grpc.ServerUnaryCall<Any, Any>, callback: grpc.sendUnaryData<Any>) => {
      received.push({ ...call.request, correlationId: call.metadata.get('x-correlation-id')[0]?.toString() });
      callback(null, { success: true, message: 'ok', processed_at: String(Date.now()) });
    },
    StreamInventoryChanges: () => undefined,
  });
  return new Promise((resolve, reject) => booking!.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
}
const stopBooking = () => new Promise<void>((resolve) => booking!.tryShutdown(() => resolve()));
const lastStock = (flightNumber: string, cabin = 'ECONOMY', date = DAY) => received.filter((r) => r.item_id === `${flightNumber}-${cabin}` && r.date === date).at(-1);

// ------------------------------------------------------------------ app y cliente
let app: NestExpressApplication;
let clients: Record<string, Client>;
let stock: StockSyncService;
let holds: HoldsService;
let store: OffersStore;

interface CallResult {
  response: Any;
  metadata: grpc.Metadata;
}
function call(service: string, rpc: string, req: unknown, options: { token?: string | null; correlationId?: string } = {}): Promise<CallResult> {
  const metadata = new grpc.Metadata();
  if (options.token !== null) metadata.set('authorization', `Bearer ${options.token ?? ESB}`);
  if (options.correlationId) metadata.set('x-correlation-id', options.correlationId);
  return new Promise((resolve, reject) => {
    let headers = new grpc.Metadata();
    const pending = clients[service]![rpc]!(req, metadata, (error, response) => (error ? reject(error) : resolve({ response, metadata: headers })));
    pending.on('metadata', (received: grpc.Metadata) => (headers = received));
  });
}
const rpc = async (service: string, method: string, req: unknown) => (await call(service, method, req)).response;
/** Error gRPC con el ProblemDetails del trailer `x-problem-details-bin`. */
async function failure(promise: Promise<unknown>): Promise<{ code: grpc.status; problem: Any }> {
  try {
    await promise;
  } catch (error) {
    const e = error as grpc.ServiceError;
    const raw = e.metadata.get('x-problem-details-bin')[0] as Buffer;
    return { code: e.code, problem: problemType.toObject(problemType.decode(raw)) };
  }
  throw new Error('se esperaba un error');
}

beforeAll(async () => {
  bookingPort = await startBooking();
  const config = { ...loadConfig({ NODE_ENV: 'test' }), bookingGrpcAddress: `127.0.0.1:${bookingPort}`, stockIntervalMs: 60_000, sweepIntervalMs: 60_000, bookingDeadlineMs: 500 };
  const verifier = { verify: async (jwt: string) => verifyJwt(jwt, () => publicKey, TOKEN_OPTIONS) };
  const moduleRef = await Test.createTestingModule({ imports: [OffersModule.register(config, { verifier })] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  const server = setupApp(app);
  await app.init();
  const port = await server.start(0);
  stock = app.get(StockSyncService);
  holds = app.get(HoldsService);
  store = app.get(OFFERS_STORE);
  const definition = protoLoader.loadSync(findContractFile('ms-g-offers.proto'), { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(definition) as Any)['ecoairlines']['offers']['v1'];
  clients = Object.fromEntries(
    ['CatalogService', 'HoldService', 'InventoryService', 'PublishingService'].map((name) => [name, new pkg[name](`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as Client]),
  );
  await rpc('PublishingService', 'PublishTimetable', { publishId: 'pub-inicial', from: DAY, to: NEXT, flights: [...network(DAY), ...network(NEXT)] });
  await stock.flush();
}, 30_000);

afterAll(async () => {
  Object.values(clients ?? {}).forEach((client) => client.close());
  await app?.close();
  await stopBooking().catch(() => undefined);
});

const search = (origin: string, destination: string, date = DAY, passengers: Any = { adults: 2 }) =>
  rpc('CatalogService', 'Search', { itineraries: [{ origin, destination, departureDate: date }], passengers });
const createHold = (offerId: string, cabinClass = 'CABIN_CLASS_ECONOMY', fareBrand = 'SEMILLA', passengers: Any = { adults: 2 }, ownerId = 'user-1') =>
  rpc('HoldService', 'CreateHold', { offerId, itinerarySelections: [{ itineraryId: offerId.split('~')[0], cabinClass, fareBrand }], passengersBreakdown: passengers, ownerId }).then((r) => r['hold']);
const directOffer = async (flightNumber: 'EA100' | 'EA101' | 'EA102' | 'EA103', date = DAY) => {
  const route = { EA100: ['UIO', 'GYE'], EA101: ['GYE', 'UIO'], EA102: ['UIO', 'BOG'], EA103: ['BOG', 'UIO'] }[flightNumber]!;
  const result = await search(route[0]!, route[1]!, date, { adults: 1 });
  return result['offers'].find((offer: Any) => offer.offerId === segment(flightNumber, date))!.offerId as string;
};

describe('acceso y trazabilidad (D41, contrato v2 §6)', () => {
  it('sin token → UNAUTHENTICATED; token de partner → PERMISSION_DENIED, con el ProblemDetails en el trailer', async () => {
    const none = await failure(call('CatalogService', 'Search', {}, { token: null }));
    expect(none.code).toBe(grpc.status.UNAUTHENTICATED);
    expect(none.problem).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    const partner = await failure(call('CatalogService', 'Search', {}, { token: token('partner', 'flights:read') }));
    expect(partner.code).toBe(grpc.status.PERMISSION_DENIED);
  });

  it('devuelve el mismo x-correlation-id y su propio x-request-id', async () => {
    const { metadata } = await call('InventoryService', 'GetStats', {}, { correlationId: 'corr-offers-1' });
    expect(metadata.get('x-correlation-id')[0]).toBe('corr-offers-1');
    expect(String(metadata.get('x-request-id')[0])).toMatch(/^req-/);
  });

  it('health gRPC estándar SERVING y /health HTTP con la base y el gRPC', async () => {
    const definition = protoLoader.loadSync(require.resolve('grpc-health-check/proto/health/v1/health.proto'), { enums: String });
    const Health = (grpc.loadPackageDefinition(definition) as Any)['grpc']['health']['v1']['Health'];
    const address = (clients['CatalogService'] as grpc.Client).getChannel().getTarget().replace(/^dns:/, '');
    const health = new Health(address, grpc.credentials.createInsecure());
    const status = await new Promise<Any>((resolve, reject) => health.Check({ service: '' }, (e: unknown, r: Any) => (e ? reject(e) : resolve(r))));
    health.close();
    expect(status['status']).toBe('SERVING');
    const http = await request(app.getHttpServer()).get('/health');
    expect(http.body.dependencies).toMatchObject({ database: { status: 'memory' }, grpc: { status: 'up' } });
  });
});

describe('publicación del horario (saga "Publicar horario")', () => {
  it('crea los vuelos con sus cupos por cabina y envía el stock inicial a Booking', async () => {
    expect(lastStock('EA100')).toMatchObject({ service_id: 'NODE_VUE_EQ5', item_id: 'EA100-ECONOMY', date: DAY, time_slot: '07:00', available_units: 162 });
    expect(lastStock('EA100', 'BUSINESS')).toMatchObject({ available_units: 12 });
  });

  it('es idempotente por publishId y una publicación igual no cambia nada', async () => {
    const again = await rpc('PublishingService', 'PublishTimetable', { publishId: 'pub-inicial', from: DAY, to: NEXT, flights: [] });
    expect(again['result']).toMatchObject({ publishId: 'pub-inicial', added: 8 });
    const same = await rpc('PublishingService', 'PublishTimetable', { publishId: 'pub-2', from: DAY, to: NEXT, flights: [...network(DAY), ...network(NEXT)] });
    expect(same['result']).toMatchObject({ added: 0, updated: 0, removed: 0 });
  });
});

describe('búsqueda y mapa de asientos', () => {
  it('directo con 4 familias, cupos AVAILABLE por cabina y precio por tipo de pasajero', async () => {
    const result = await search('UIO', 'GYE');
    expect(result['totalOffers']).toBe(1);
    const option = result['offers'][0]['itineraries'][0];
    expect(option.segments[0]).toMatchObject({ flightNumber: 'EA100', departure: { iataCode: 'UIO', at: `${DAY}T07:00:00-05:00` }, status: 'FLIGHT_OPERATIONAL_STATUS_SCHEDULED' });
    expect(option.pricingOptions.map((p: Any) => p.fareBrand)).toEqual(['SEMILLA', 'BROTE', 'BOSQUE', 'DOSEL']);
    expect(option.pricingOptions[0]).toMatchObject({ cabinClass: 'CABIN_CLASS_ECONOMY', availableSeats: 162 });
    expect(Number(result['offers'][0]['grandTotal']['total'])).toBeGreaterThan(0);
  });

  it('conexión GYE → UIO → BOG con el mismo avión', async () => {
    const result = await search('GYE', 'BOG');
    const connection = result['offers'].find((offer: Any) => offer.itineraries[0].stopsCount === 1);
    expect(connection.offerId).toBe(`${segment('EA101')}.${segment('EA102')}`);
    expect(connection.itineraries[0].segments[0].layoverMinutes).toBe(190);
  });

  it('infantes que superan a los adultos → INVALID_ARGUMENT INFANT_WITHOUT_ADULT', async () => {
    const error = await failure(search('UIO', 'GYE', DAY, { adults: 1, infants: 2 }));
    expect(error.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(error.problem.code).toBe('INFANT_WITHOUT_ADULT');
  });

  it('mapa con estado y características; un segmento ajeno a la oferta → NOT_FOUND', async () => {
    const offerId = await directOffer('EA100');
    const map = (await rpc('CatalogService', 'GetSeatMap', { offerId, segmentId: segment('EA100') }))['seatMap'];
    const economy = map.cabins.find((cabin: Any) => cabin.cabinClass === 'CABIN_CLASS_ECONOMY');
    const row12 = economy.rows.find((row: Any) => row.rowNumber === 12);
    expect(row12.seats[0]).toMatchObject({ seatNumber: '12A', status: 'SEAT_STATUS_AVAILABLE', isAvailable: true });
    expect(row12.seats[0].characteristics).toEqual(['SEAT_CHARACTERISTIC_WINDOW', 'SEAT_CHARACTERISTIC_EXTRA_LEGROOM', 'SEAT_CHARACTERISTIC_EMERGENCY_EXIT']);
    expect((await failure(rpc('CatalogService', 'GetSeatMap', { offerId, segmentId: segment('EA102') }))).code).toBe(grpc.status.NOT_FOUND);
  });
});

describe('holds y stock a Booking (D33, D34)', () => {
  it('crear: HELD con precio congelado, availableSeats baja, hold.created al outbox y Booking recibe el stock nuevo', async () => {
    const offerId = await directOffer('EA102');
    const { response, metadata } = await call('HoldService', 'CreateHold', { offerId, itinerarySelections: [{ itineraryId: offerId, cabinClass: 'CABIN_CLASS_ECONOMY', fareBrand: 'BROTE' }], passengersBreakdown: { adults: 2, infants: 1 }, ownerId: 'partner:BOOKING_PROTOTIPO:u1' }, { correlationId: 'corr-hold-1' });
    const hold = response['hold'];
    expect(hold).toMatchObject({ status: 'HOLD_STATUS_HELD', ttlMinutes: 15, channel: 'SALES_CHANNEL_BOOKING', passengersBreakdown: { adults: 2, infants: 1 } });
    expect(hold.remainingSeconds).toBeGreaterThan(890);
    expect(metadata.get('x-correlation-id')[0]).toBe('corr-hold-1');
    const after = await search('UIO', 'BOG');
    expect(after['offers'][0]['itineraries'][0]['pricingOptions'][0]['availableSeats']).toBe(160); // el infante no ocupa asiento
    await stock.flush();
    expect(lastStock('EA102')).toMatchObject({ available_units: 160, correlationId: 'corr-hold-1' });
    const events = await store.outbox();
    expect(events.at(-1)).toMatchObject({ type: 'ec.edu.epn.booking.vuelos.hold.created' });
    expect((events.at(-1)!.event as Any)['data']).toMatchObject({ holdId: hold.holdId, seatsHeld: 2 });
    // V2.11: el relé lo toma (con el dueño, para el filtro D40 de Webhooks) y, publicado, no se vuelve a tomar.
    const claimed = (await store.claimOutbox(100, 30_000)).find((e) => e.id === events.at(-1)!.id)!;
    expect(claimed).toMatchObject({ ownerId: 'partner:BOOKING_PROTOTIPO:u1', event: { correlationid: 'corr-hold-1' } });
    expect((await store.claimOutbox(100, 30_000)).some((e) => e.id === claimed.id)).toBe(false); // ya tiene su plazo
    await store.markOutboxPublished(claimed.id, new Date().toISOString());
    expect((await store.outbox()).find((e) => e.id === claimed.id)!.publishedAt).toBeTruthy();
  });

  it('TTL fuera de 5–30 → INVALID_ARGUMENT; oferta inexistente → NOT_FOUND OFFER_NO_LONGER_AVAILABLE', async () => {
    const offerId = await directOffer('EA100');
    const ttl = await failure(rpc('HoldService', 'CreateHold', { offerId, itinerarySelections: [{ itineraryId: offerId, cabinClass: 'CABIN_CLASS_ECONOMY', fareBrand: 'SEMILLA' }], ttlMinutes: 31, ownerId: 'u' }));
    expect(ttl.code).toBe(grpc.status.INVALID_ARGUMENT);
    const gone = await failure(createHold('EA999-20991231'));
    expect(gone).toMatchObject({ code: grpc.status.NOT_FOUND, problem: { code: 'OFFER_NO_LONGER_AVAILABLE', status: 410 } });
  });

  it('dos holds simultáneos por los últimos cupos: uno gana y el otro recibe OFFER_NO_LONGER_AVAILABLE (sin sobreventa)', async () => {
    const offerId = await directOffer('EA103');
    await createHold(offerId, 'CABIN_CLASS_BUSINESS', 'DOSEL', { adults: 9 });
    await createHold(offerId, 'CABIN_CLASS_BUSINESS', 'DOSEL', { adults: 1 }); // quedan 2
    const results = await Promise.allSettled([1, 2].map(() => createHold(offerId, 'CABIN_CLASS_BUSINESS', 'DOSEL', { adults: 2 })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = await failure(Promise.reject((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason));
    expect(loser).toMatchObject({ code: grpc.status.RESOURCE_EXHAUSTED, problem: { code: 'OFFER_NO_LONGER_AVAILABLE', status: 409 } });
    const occupancy = await rpc('InventoryService', 'GetOccupancy', { date: DAY });
    const business = occupancy['flights'].find((f: Any) => f.flightNumber === 'EA103').cabins.find((c: Any) => c.cabinClass === 'CABIN_CLASS_BUSINESS');
    expect(business.seatsByStatus).toMatchObject({ available: 0, held: 12 });
  });

  it('obtener con otro dueño → NOT_FOUND; liberar es idempotente y devuelve los cupos', async () => {
    const offerId = await directOffer('EA101');
    const hold = await createHold(offerId);
    expect((await failure(rpc('HoldService', 'GetHold', { holdId: hold.holdId, ownerId: 'otro' }))).code).toBe(grpc.status.NOT_FOUND);
    const released = (await rpc('HoldService', 'ReleaseHold', { holdId: hold.holdId, ownerId: 'user-1' }))['hold'];
    expect(released.status).toBe('HOLD_STATUS_RELEASED');
    expect((await rpc('HoldService', 'ReleaseHold', { holdId: hold.holdId }))['hold'].status).toBe('HOLD_STATUS_RELEASED');
    const seats = (await search('GYE', 'UIO'))['offers'][0]['itineraries'][0]['pricingOptions'][0]['availableSeats'];
    expect(seats).toBe(162);
  });

  it('vence sola con el barrido: cupos de vuelta y hold.expired', async () => {
    const offerId = await directOffer('EA100', NEXT);
    const hold = (await rpc('HoldService', 'CreateHold', { offerId, itinerarySelections: [{ itineraryId: offerId, cabinClass: 'CABIN_CLASS_ECONOMY', fareBrand: 'SEMILLA' }], passengersBreakdown: { adults: 3 }, ttlMinutes: 5, ownerId: 'user-exp' }))['hold'];
    // 6 minutos después: vence este hold (TTL 5) y no los de las demás pruebas (TTL 15).
    const realNow = holds.now;
    holds.now = () => Date.now() + 6 * 60_000;
    try {
      expect(await holds.sweep()).toBe(1);
    } finally {
      holds.now = realNow;
    }
    expect((await rpc('HoldService', 'GetHold', { holdId: hold.holdId }))['hold'].status).toBe('HOLD_STATUS_EXPIRED');
    const events = await store.outbox();
    expect(events.some((e) => e.type === 'ec.edu.epn.booking.vuelos.hold.expired' && (e.event as Any)['data']['holdId'] === hold.holdId)).toBe(true);
    await stock.flush();
    expect(lastStock('EA100', 'ECONOMY', NEXT)).toMatchObject({ available_units: 162 });
  });

  it('con Booking apagado el hold igual se crea; el stock se envía cuando Booking vuelve', async () => {
    await stopBooking();
    const offerId = await directOffer('EA101', NEXT);
    const hold = await createHold(offerId, 'CABIN_CLASS_ECONOMY', 'SEMILLA', { adults: 4 });
    expect(hold.status).toBe('HOLD_STATUS_HELD');
    await stock.flush();
    expect((await rpc('InventoryService', 'GetStats', {}))['stats']['pendingStockPushes']).toBeGreaterThanOrEqual(1);
    await startBooking(bookingPort);
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // primer reintento: 1 s
    await stock.flush();
    expect(lastStock('EA101', 'ECONOMY', NEXT)).toMatchObject({ available_units: 158 });
    expect((await rpc('InventoryService', 'GetStats', {}))['stats']['pendingStockPushes']).toBe(0);
  }, 15_000);
});

describe('promociones (D35) y reserva desde el hold', () => {
  let offerId: string;
  let holdId: string;

  beforeAll(async () => {
    await rpc('PublishingService', 'PublishFarePrices', {
      publishId: 'precios-1',
      prices: [{ cabinClass: 'CABIN_CLASS_ECONOMY', fareBrand: 'SEMILLA', multiplier: 1 }],
      promotions: [{ partnerId: 'BOOKING_PROTOTIPO', allowsPromotions: true, maxDiscountPercentage: 10, routes: [], cabins: ['CABIN_CLASS_ECONOMY'] }],
    });
    offerId = await directOffer('EA100');
    holdId = (await createHold(offerId, 'CABIN_CLASS_ECONOMY', 'SEMILLA', { adults: 2, infants: 1 }, 'partner:BOOKING_PROTOTIPO:u2')).holdId;
  });

  it('ValidateHold: el descuento dentro del acuerdo da el monto esperado; fuera → PROMOTION_DISCOUNT_OUT_OF_RANGE', async () => {
    const owner = 'partner:BOOKING_PROTOTIPO:u2';
    const ok = await rpc('HoldService', 'ValidateHold', { holdId, ownerId: owner, promotion: { partnerId: 'BOOKING_PROTOTIPO', discountPercentage: 10 } });
    expect(Number(ok['expectedAmount']['total'])).toBeCloseTo(Number(ok['hold']['lockedPrice']['total']) * 0.9, 1);
    const over = await failure(rpc('HoldService', 'ValidateHold', { holdId, ownerId: owner, promotion: { partnerId: 'BOOKING_PROTOTIPO', discountPercentage: 11 } }));
    expect(over).toMatchObject({ code: grpc.status.INVALID_ARGUMENT, problem: { code: 'PROMOTION_DISCOUNT_OUT_OF_RANGE' } });
    const noAgreement = await failure(rpc('HoldService', 'ValidateHold', { holdId, ownerId: owner, promotion: { partnerId: 'OTRO', discountPercentage: 1 } }));
    expect(noAgreement.problem.code).toBe('PROMOTION_DISCOUNT_OUT_OF_RANGE');
  });

  const passengers = (seat?: string) => [
    { passengerId: 'p1', passengerType: 'PASSENGER_TYPE_ADULT', requestedSeats: seat ? [{ passengerId: 'p1', segmentId: segment('EA100'), seatNumber: seat }] : [] },
    { passengerId: 'p2', passengerType: 'PASSENGER_TYPE_ADULT', requestedSeats: [] },
    { passengerId: 'p3', passengerType: 'PASSENGER_TYPE_INFANT', requestedSeats: [] },
  ];

  it.each([
    ['pasajeros que no coinciden con el hold', passengers().slice(0, 2), 'PASSENGER_COUNT_MISMATCH'],
    ['asiento de Business con tarifa Economy', passengers('2A'), 'SEAT_CABIN_MISMATCH'],
    ['infante con asiento', [...passengers().slice(0, 2), { passengerId: 'p3', passengerType: 'PASSENGER_TYPE_INFANT', requestedSeats: [{ segmentId: segment('EA100'), seatNumber: '20A' }] }], 'INFANT_SEAT_NOT_ALLOWED'],
  ])('ConsumeHold con %s → %s (y el hold sigue HELD)', async (_, list, code) => {
    const error = await failure(rpc('HoldService', 'ConsumeHold', { holdId, bookingId: 'b-invalida', sagaId: 's', ownerId: 'partner:BOOKING_PROTOTIPO:u2', passengers: list }));
    expect(error.problem.code).toBe(code);
    expect((await rpc('HoldService', 'GetHold', { holdId }))['hold'].status).toBe('HOLD_STATUS_HELD');
  });

  it('ConsumeHold: HELD → BOOKED con el asiento pedido y uno automático; idempotente por bookingId', async () => {
    const consume = (bookingId: string) => rpc('HoldService', 'ConsumeHold', { holdId, bookingId, sagaId: 'saga-1', ownerId: 'partner:BOOKING_PROTOTIPO:u2', passengers: passengers('10A') });
    const first = await consume('booking-1');
    expect(first['hold']).toMatchObject({ status: 'HOLD_STATUS_CONSUMED', bookingId: 'booking-1' });
    expect(first['seats']).toEqual([
      expect.objectContaining({ passengerId: 'p1', seatNumber: '10A', status: 'SEAT_STATUS_BOOKED' }),
      expect.objectContaining({ passengerId: 'p2', seatNumber: '4A', status: 'SEAT_STATUS_BOOKED' }),
    ]);
    expect((await consume('booking-1'))['seats']).toEqual(first['seats']);
    const other = await failure(consume('booking-2'));
    expect(other).toMatchObject({ code: grpc.status.FAILED_PRECONDITION, problem: { code: 'HOLD_ALREADY_CONSUMED' } });
    const map = (await rpc('CatalogService', 'GetSeatMap', { offerId, segmentId: segment('EA100') }))['seatMap'];
    const seat10A = map.cabins.flatMap((c: Any) => c.rows).flatMap((r: Any) => r.seats).find((s: Any) => s.seatNumber === '10A');
    expect(seat10A).toMatchObject({ status: 'SEAT_STATUS_BOOKED', isAvailable: false });
  });

  it('dos reservas simultáneas por el mismo asiento: una gana y la otra recibe ALREADY_EXISTS SEAT_TAKEN', async () => {
    const [a, b] = await Promise.all([createHold(offerId, 'CABIN_CLASS_ECONOMY', 'SEMILLA', { adults: 1 }, 'u-a'), createHold(offerId, 'CABIN_CLASS_ECONOMY', 'SEMILLA', { adults: 1 }, 'u-b')]);
    const take = (hold: Any, owner: string, bookingId: string) =>
      rpc('HoldService', 'ConsumeHold', { holdId: hold.holdId, bookingId, sagaId: bookingId, ownerId: owner, passengers: [{ passengerId: 'x', passengerType: 'PASSENGER_TYPE_ADULT', requestedSeats: [{ segmentId: segment('EA100'), seatNumber: '15C' }] }] });
    const results = await Promise.allSettled([take(a, 'u-a', 'booking-a'), take(b, 'u-b', 'booking-b')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = await failure(Promise.reject((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason));
    expect(loser).toMatchObject({ code: grpc.status.ALREADY_EXISTS, problem: { code: 'SEAT_TAKEN' } });
  });
});

describe('asientos e inventario de una reserva (sagas)', () => {
  it('emisión, cambio de asiento, check-in automático y transiciones inválidas', async () => {
    const transition = (sagaId: string, from: string, to: string) =>
      rpc('InventoryService', 'TransitionBookingSeats', { bookingId: 'booking-1', sagaId, fromStatus: `SEAT_STATUS_${from}`, toStatus: `SEAT_STATUS_${to}`, segmentIds: [], passengerIds: [] });
    expect((await transition('emitir-1', 'BOOKED', 'TICKETED'))['result']['seatsAffected']).toBe(2);
    expect((await transition('emitir-1', 'BOOKED', 'TICKETED'))['result']['seatsAffected']).toBe(2); // misma saga: sin efecto doble
    const invalid = await failure(transition('x', 'TICKETED', 'BOARDED'));
    expect(invalid.code).toBe(grpc.status.INVALID_ARGUMENT);

    const moved = await rpc('InventoryService', 'ReserveSeats', {
      bookingId: 'booking-1',
      sagaId: 'cambio-asiento-1',
      seats: [{ passengerId: 'p2', segmentId: segment('EA100'), seatNumber: '11F' }],
      purchasedCabins: [{ passengerId: 'p2', segmentId: segment('EA100'), cabinClass: 'CABIN_CLASS_ECONOMY' }],
      targetStatus: 'SEAT_STATUS_TICKETED',
    });
    expect(moved['result']['seats'][0]).toMatchObject({ seatNumber: '11F', previousSeatNumber: '4A', status: 'SEAT_STATUS_TICKETED' });
    const taken = await failure(
      rpc('InventoryService', 'ReserveSeats', {
        bookingId: 'booking-1',
        sagaId: 'cambio-asiento-2',
        seats: [{ passengerId: 'p2', segmentId: segment('EA100'), seatNumber: '10A' }],
        purchasedCabins: [{ passengerId: 'p2', segmentId: segment('EA100'), cabinClass: 'CABIN_CLASS_ECONOMY' }],
        targetStatus: 'SEAT_STATUS_TICKETED',
      }),
    );
    expect(taken.problem.code).toBe('SEAT_TAKEN');

    expect((await transition('checkin-1', 'TICKETED', 'CHECKED_IN'))['result']['seatsAffected']).toBe(2);
    const occupancy = await rpc('InventoryService', 'GetOccupancy', { date: DAY, origin: 'UIO', destination: 'GYE' });
    const economy = occupancy['flights'][0].cabins.find((c: Any) => c.cabinClass === 'CABIN_CLASS_ECONOMY');
    expect(economy.seatsByStatus.checkedIn).toBe(2);
  });

  it('cambio de fecha: reserva cupos sin asiento, los asigna en el check-in y libera los viejos', async () => {
    const reserved = await rpc('InventoryService', 'ReserveInventory', {
      bookingId: 'booking-2b',
      sagaId: 'cambio-fecha-1',
      segments: [{ segmentId: segment('EA102', NEXT), cabinClass: 'CABIN_CLASS_ECONOMY', count: 2 }],
      targetStatus: 'SEAT_STATUS_TICKETED',
    });
    expect(reserved['result']['seatsAffected']).toBe(2);
    const assigned = await rpc('InventoryService', 'AutoAssignSeats', {
      bookingId: 'booking-2b',
      sagaId: 'checkin-2b',
      passengers: [
        { passengerId: 'q1', segmentId: segment('EA102', NEXT), cabinClass: 'CABIN_CLASS_ECONOMY' },
        { passengerId: 'q2', segmentId: segment('EA102', NEXT), cabinClass: 'CABIN_CLASS_ECONOMY' },
      ],
      targetStatus: 'SEAT_STATUS_CHECKED_IN',
    });
    expect(assigned['result']['seats'].map((s: Any) => s.status)).toEqual(['SEAT_STATUS_CHECKED_IN', 'SEAT_STATUS_CHECKED_IN']);
    const occupancy = await rpc('InventoryService', 'GetOccupancy', { date: NEXT, origin: 'UIO', destination: 'BOG' });
    expect(occupancy['flights'][0].cabins.find((c: Any) => c.cabinClass === 'CABIN_CLASS_ECONOMY').seatsByStatus).toMatchObject({ checkedIn: 2, ticketed: 0 });
    const released = await rpc('InventoryService', 'ReleaseBookingInventory', { bookingId: 'booking-2b', sagaId: 'rel-2b', segmentIds: [], reason: 'DATE_CHANGE' });
    expect(released).toMatchObject({ seatsReleased: 2, newSeatStatus: 'SEAT_STATUS_AVAILABLE' });
  });

  it('cuenta los cupos vendidos o retenidos de una ruta (saga "Publicar horario")', async () => {
    const sold = await rpc('InventoryService', 'CountSoldSeats', { flightNumbers: ['EA103'], fromDate: DAY });
    expect(sold['soldSeats']).toBe(12);
  });
});

describe('cierre de venta (D37)', () => {
  it('cierra el vuelo: libera sus holds, desaparece de la búsqueda y Booking recibe stock 0; reabrir lo devuelve', async () => {
    const closed = await rpc('InventoryService', 'CloseFlightSales', { flight: { flightNumber: 'EA103', date: DAY, sagaId: 'cancel-1', reason: 'FLIGHT_CANCELLED' } });
    expect(closed['state']).toMatchObject({ onSale: false, activeHoldsReleased: 3 });
    expect((await search('BOG', 'UIO'))['totalOffers']).toBe(0);
    await stock.flush();
    expect(lastStock('EA103', 'BUSINESS')).toMatchObject({ available_units: 0 });
    const reopened = await rpc('InventoryService', 'ReopenFlightSales', { flight: { flightNumber: 'EA103', date: DAY, sagaId: 'cancel-1-comp', reason: '' } });
    expect(reopened['state'].onSale).toBe(true);
    await stock.flush();
    expect(lastStock('EA103', 'BUSINESS')).toMatchObject({ available_units: 12 });
  });
});
