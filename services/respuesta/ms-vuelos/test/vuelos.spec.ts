import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { ADMIN_SUB, createResponseApp, CUSTOMER_SUB, FakeEsb, FIXED_SERVICE_TOKEN, newKey, PARTNER_ID, tokens } from '../../../../tests/support/response-service.js';
import { definition } from '../src/service.js';

/** MS.Vuelos (V2.12) contra un ESB falso: cada respuesta se valida con el contrato del grupo (las rutas son idénticas). */
const expectContract = contractValidator('vuelos-openapi-v2.yaml');
const esb = new FakeEsb();
let app: NestExpressApplication;
const http = () => request(app.getHttpServer());
const CORR = 'corr-prueba-ms-vuelos';

const money = (total: string) => ({ currency: 'USD', baseFare: '59.00', taxes: '20.85', total });
const SEGMENT = {
  segmentId: 'EA100-20261106',
  flightNumber: 'EA100',
  departure: { iataCode: 'UIO', at: '2026-11-06T07:00:00-05:00' },
  arrival: { iataCode: 'GYE', at: '2026-11-06T07:50:00-05:00' },
  marketingCarrier: 'EA',
  operatingCarrier: 'EA',
  status: 'FLIGHT_OPERATIONAL_STATUS_SCHEDULED',
  aircraft: 'Airbus A320neo',
  _aircraft: 'aircraft',
  durationMinutes: 50,
  _durationMinutes: 'durationMinutes',
};
/** Respuesta real de `POST /router/offers/Search` (mapeo JSON de proto3). */
const PROTO_SEARCH = {
  totalOffers: 1,
  offers: [
    {
      offerId: 'EA100-20261106',
      airline: { code: 'EA', name: 'EcoAirlines' },
      grandTotal: money('79.85'),
      itineraries: [
        {
          itineraryId: 'EA100-20261106',
          totalDurationMinutes: 50,
          stopsCount: 0,
          segments: [SEGMENT],
          pricingOptions: [
            {
              cabinClass: 'CABIN_CLASS_ECONOMY',
              fareBrand: 'SEMILLA',
              availableSeats: 162,
              fareRules: { isRefundable: false, isChangeable: false },
              baggageAllowance: { personalItemIncluded: true, carryOnIncluded: 0, checkedBaggageIncluded: 0 },
              extraCheckedBaggagePrice: money('35.00'),
              pricePerPassengerType: [{ passengerType: 'PASSENGER_TYPE_ADULT', price: money('79.85') }],
            },
          ],
        },
      ],
    },
  ],
};
const SEARCH = { itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: '2026-11-06' }], passengers: { adults: 1 } };
const HEALTH = { status: 'HEALTHY', nodo_id: 'NODE_VUE_ECOAIRLINES', nombre_proveedor: 'EcoAirlines', vertical: 'VUELOS', version: '2.0.0', dependencias: [{ nombre: 'esb-postgres', status: 'UP', latencia_ms: 3 }], timestamp: '2026-10-26T01:27:18.381Z' };
const FLIGHT = {
  flightNumber: 'EA100',
  date: '2026-11-04',
  marketingCarrier: 'EA',
  operatingCarrier: 'EA',
  departure: { iataCode: 'UIO', terminal: null, gate: 'A1', scheduledAt: '2026-11-04T07:00:00-05:00', estimatedAt: null, actualAt: null },
  arrival: { iataCode: 'GYE', terminal: null, gate: null, scheduledAt: '2026-11-04T07:50:00-05:00', estimatedAt: null, actualAt: null },
  aircraft: 'Airbus A320neo',
  status: 'SCHEDULED',
  updatedAt: '2026-10-26T01:13:35.884Z',
};
const AGREEMENT = { proveedor_codigo: 'NODE_VUE_ECOAIRLINES', nombre_socio: 'EcoAirlines', vertical: 'VUELOS', actualizado_en: '2026-10-25T17:41:38.120Z', permite_promociones: true, porcentaje_descuento_maximo: 10 };

beforeAll(async () => {
  await esb.start();
  app = await createResponseApp(definition({}), esb, { RATE_LIMIT_SEARCH_LIMIT: '5' });
});
afterAll(async () => {
  await app.close();
  await esb.stop();
});
beforeEach(() => esb.reset());

describe('searchFlights y getSeatMap (Offers por el ESB, mapeo de proto3 al contrato)', () => {
  it('busca sin token y traduce los enums de proto3; no publica las marcas `_campo` de proto3', async () => {
    esb.on('POST', '/router/offers/Search', { body: PROTO_SEARCH });
    const response = await http().post('/api/v2/vuelos/search').set('X-Device-Fingerprint', 'fp-1').set('X-Correlation-Id', CORR).send(SEARCH).expect(200);
    expectContract('post', '/vuelos/search', response);
    const segment = response.body.offers[0].itineraries[0].segments[0];
    expect(segment.status).toBe('SCHEDULED');
    expect(segment).not.toHaveProperty('_aircraft');
    expect(response.body.offers[0].itineraries[0].pricingOptions[0]).toMatchObject({ cabinClass: 'ECONOMY', pricePerPassengerType: [{ passengerType: 'ADULT' }] });
    // El ESB recibe el mismo correlation id, un X-Request-Id nuevo, el token de servicio del MS y los valores por defecto.
    const call = esb.last('POST', '/router/offers/Search')!;
    expect(call.headers['x-correlation-id']).toBe(CORR);
    expect(call.headers['authorization']).toBe(`Bearer ${FIXED_SERVICE_TOKEN}`);
    expect(call.json).toEqual({ itineraries: SEARCH.itineraries, passengers: { adults: 1, youths: 0, children: 0, infants: 0 } });
    expect(response.headers['x-correlation-id']).toBe(CORR);
  });

  it('400 VALIDATION_FAILED con un IATA inválido, sin X-Device-Fingerprint o con una propiedad extra (sin llamar al ESB)', async () => {
    const bad = await http().post('/api/v2/vuelos/search').set('X-Device-Fingerprint', 'fp-1').send({ ...SEARCH, itineraries: [{ origin: 'quito', destination: 'GYE', departureDate: '2026-11-06' }] }).expect(400);
    expectContract('post', '/vuelos/search', bad);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED', invalidParams: [{ name: 'itineraries[0].origin' }] });
    const noFingerprint = await http().post('/api/v2/vuelos/search').send(SEARCH).expect(400);
    expect(noFingerprint.body.invalidParams).toEqual([{ name: 'X-Device-Fingerprint', reason: 'obligatorio' }]);
    const extra = await http().post('/api/v2/vuelos/search').set('X-Device-Fingerprint', 'fp-1').send({ ...SEARCH, ownerId: 'partner:OTRO' }).expect(400);
    expect(extra.body.invalidParams).toEqual([{ name: 'ownerId', reason: 'propiedad no permitida' }]);
    expect(esb.calls).toHaveLength(0);
  });

  it('429 RATE_LIMIT_EXCEEDED con Retry-After al pasar el límite de búsqueda por huella; otra huella sigue', async () => {
    esb.on('POST', '/router/offers/Search', { body: PROTO_SEARCH });
    for (let i = 0; i < 5; i++) await http().post('/api/v2/vuelos/search').set('X-Device-Fingerprint', 'fp-limite').send(SEARCH).expect(200);
    const limited = await http().post('/api/v2/vuelos/search').set('X-Device-Fingerprint', 'fp-limite').send(SEARCH).expect(429);
    expectContract('post', '/vuelos/search', limited);
    expect(limited.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await http().post('/api/v2/vuelos/search').set('X-Device-Fingerprint', 'fp-otra').send(SEARCH).expect(200);
  });

  it('mapa de asientos con el estado de cada asiento; 404 de Offers como ProblemDetails público', async () => {
    esb.on('POST', '/router/offers/GetSeatMap', {
      body: { seatMap: { segmentId: 'EA100-20261106', cabins: [{ cabinClass: 'CABIN_CLASS_ECONOMY', rows: [{ rowNumber: 4, seats: [{ seatNumber: '4A', isAvailable: false, status: 'SEAT_STATUS_HELD', characteristics: ['SEAT_CHARACTERISTIC_WINDOW'] }] }] }] } },
    });
    const ok = await http().get('/api/v2/vuelos/offers/EA100-20261106/seatmap').query({ segmentId: 'EA100-20261106' }).expect(200);
    expectContract('get', '/vuelos/offers/{offerId}/seatmap', ok);
    expect(ok.body.cabins[0].rows[0].seats[0]).toEqual({ seatNumber: '4A', isAvailable: false, status: 'HELD', characteristics: ['WINDOW'] });
    expect(esb.last('POST', '/router/offers/GetSeatMap')!.json).toEqual({ offerId: 'EA100-20261106', segmentId: 'EA100-20261106' });

    esb.on('POST', '/router/offers/GetSeatMap', { status: 404, body: { type: 'about:blank', title: 'Oferta no encontrada.', status: 404, code: 'NOT_FOUND', instance: '/router/offers/GetSeatMap' } });
    const missing = await http().get('/api/v2/vuelos/offers/NO-EXISTE/seatmap').query({ segmentId: 'X' }).set('X-Correlation-Id', CORR).expect(404);
    expectContract('get', '/vuelos/offers/{offerId}/seatmap', missing);
    // `instance` es la ruta pública, no la del ESB.
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', instance: '/api/v2/vuelos/offers/NO-EXISTE/seatmap', correlation_id: CORR });
  });
});

describe('health (< 1 s, desde la caché del ESB)', () => {
  it('200 HEALTHY o 503 DOWN tal como lo calcula el ESB', async () => {
    esb.on('GET', '/composition/health', { body: HEALTH });
    expectContract('get', '/vuelos/health', await http().get('/api/v2/vuelos/health').expect(200));
    esb.on('GET', '/composition/health', { status: 503, body: { ...HEALTH, status: 'DOWN' } });
    const down = await http().get('/api/v2/vuelos/health').expect(503);
    expectContract('get', '/vuelos/health', down);
    expect(down.body.status).toBe('DOWN');
  });

  it('si el ESB no responde a tiempo, 503 DOWN en menos de 1 s (no espera el plazo normal)', async () => {
    esb.on('GET', '/composition/health', { body: HEALTH, delayMs: 3_000 });
    const started = Date.now();
    const response = await http().get('/api/v2/vuelos/health').expect(503);
    expect(Date.now() - started).toBeLessThan(1_000);
    expectContract('get', '/vuelos/health', response);
    expect(response.body).toMatchObject({ status: 'DOWN', vertical: 'VUELOS' });
  });
});

describe('estado de vuelo y operaciones', () => {
  it('getFlightStatus es público y pasa la fecha', async () => {
    esb.on('GET', '/router/flight-status/flights/EA100/status', { body: FLIGHT });
    const response = await http().get('/api/v2/vuelos/flights/EA100/status').query({ date: '2026-11-04' }).expect(200);
    expectContract('get', '/vuelos/flights/{flightNumber}/status', response);
    expect(esb.last()!.path).toBe('/router/flight-status/flights/EA100/status?date=2026-11-04');
  });

  it('updateFlightStatus: 401 sin token; el ADMIN ejecuta la saga con X-Actor-Id; el resultado interno de la saga no se publica', async () => {
    expectContract('patch', '/vuelos/flights/{flightNumber}/status', await http().patch('/api/v2/vuelos/flights/EA100/status').send({ date: '2026-11-04', status: 'DELAYED' }).expect(401));
    esb.on('PATCH', '/sagas/flights/EA100/status', { body: { previousStatus: 'SCHEDULED', flight: { ...FLIGHT, status: 'DELAYED' }, affectedBookings: 2, eventId: 'evt-1', changeId: 'c1', cancellations: [] } });
    const response = await http().patch('/api/v2/vuelos/flights/EA100/status').set('Authorization', tokens.admin()).set('Idempotency-Key', newKey()).send({ date: '2026-11-04', status: 'DELAYED', reason: 'Clima' }).expect(200);
    expectContract('patch', '/vuelos/flights/{flightNumber}/status', response);
    expect(response.body).not.toHaveProperty('changeId');
    expect(esb.last()!.headers['x-actor-id']).toBe(ADMIN_SUB);
  });

  it('updateFlightStatus: un partner con flights:ops recibe 403 (D45 pendiente) y no se llama al ESB', async () => {
    const response = await http().patch('/api/v2/vuelos/flights/EA100/status').set('Authorization', tokens.partner()).set('X-User-Id', 'usr-ops').send({ date: '2026-11-04', status: 'DELAYED' }).expect(403);
    expectContract('patch', '/vuelos/flights/{flightNumber}/status', response);
    expect(esb.calls).toHaveLength(0);
  });

  it('updateFlightStatus: si la saga sigue en curso, 503 con Retry-After; con la misma clave, el resultado cuando termina', async () => {
    esb.on('PATCH', '/sagas/flights/EA100/status', { status: 202, body: { sagaId: 'a3f1c2b4-1111-4222-8333-944455556666', status: 'RUNNING', type: 'UPDATE_FLIGHT_STATUS' } });
    esb.on('GET', '/sagas/a3f1c2b4-1111-4222-8333-944455556666', { body: { sagaId: 'a3f1c2b4-1111-4222-8333-944455556666', status: 'RUNNING', result: null, error: null } });
    const key = newKey();
    const pending = await http().patch('/api/v2/vuelos/flights/EA100/status').set('Authorization', tokens.admin()).set('Idempotency-Key', key).send({ date: '2026-11-04', status: 'CANCELLED' }).expect(503);
    expect(pending.headers['retry-after']).toBe('5');
    esb.on('PATCH', '/sagas/flights/EA100/status', { status: 202, headers: { 'idempotent-replayed': 'true' }, body: { sagaId: 'a3f1c2b4-1111-4222-8333-944455556666', status: 'RUNNING' } });
    esb.on('GET', '/sagas/a3f1c2b4-1111-4222-8333-944455556666', { body: { sagaId: 'x', status: 'COMPLETED', result: { previousStatus: 'SCHEDULED', flight: { ...FLIGHT, status: 'CANCELLED' }, affectedBookings: 3, eventId: 'evt-2' }, error: null } });
    const done = await http().patch('/api/v2/vuelos/flights/EA100/status').set('Authorization', tokens.admin()).set('Idempotency-Key', key).send({ date: '2026-11-04', status: 'CANCELLED' }).expect(200);
    expectContract('patch', '/vuelos/flights/{flightNumber}/status', done);
    expect(done.headers['idempotent-replayed']).toBe('true');
    expect(done.body.affectedBookings).toBe(3);
  });

  it('listFlightOperations: flights:ops; un cliente sin ese scope recibe 403', async () => {
    esb.on('GET', '/composition/flight-operations', { body: { date: '2026-11-04', totalFlights: 0, nextCursor: null, items: [] } });
    const response = await http().get('/api/v2/vuelos/operaciones/vuelos').query({ date: '2026-11-04', limit: 5 }).set('Authorization', tokens.partner()).expect(200);
    expectContract('get', '/vuelos/operaciones/vuelos', response);
    expect(esb.last()!.path).toBe('/composition/flight-operations?date=2026-11-04&limit=5');
    const customer = await http().get('/api/v2/vuelos/operaciones/vuelos').query({ date: '2026-11-04' }).set('Authorization', tokens.customer()).expect(403);
    expectContract('get', '/vuelos/operaciones/vuelos', customer);
    expect(customer.body.title).toContain('flights:ops');
  });
});

describe('eventos y promociones', () => {
  it('listOutboxEvents: el feed del partner completo (partner:<clientId>), aunque llegue X-User-Id', async () => {
    esb.on('GET', '/router/webhooks/events', { body: { events: [], metadata: { total: 0, next_after: null, timestamp: '2026-10-26T01:27:21.444Z' } } });
    const response = await http().get('/api/v2/vuelos/eventos').query({ limit: 5 }).set('Authorization', tokens.partner()).set('X-User-Id', 'usr-1').expect(200);
    expectContract('get', '/vuelos/eventos', response);
    expect(esb.last()!.headers['x-owner-id']).toBe(`partner:${PARTNER_ID}`);
  });

  it('★ listOutboxEvents (V2.13): un CLIENTE pide solo lo suyo (sin X-Actor-Id); el ADMIN lo pide con su sub como actor', async () => {
    esb.on('GET', '/router/webhooks/events', { body: { events: [], metadata: { total: 0, next_after: null, timestamp: '2026-10-26T01:27:21.444Z' } } });
    await http().get('/api/v2/vuelos/eventos').set('Authorization', tokens.customer()).expect(200);
    expect(esb.last()!.headers['x-owner-id']).toBe(CUSTOMER_SUB);
    expect(esb.last()!.headers['x-actor-id']).toBeUndefined();
    await http().get('/api/v2/vuelos/eventos').set('Authorization', tokens.admin()).expect(200);
    expect(esb.last()!.headers).toMatchObject({ 'x-owner-id': ADMIN_SUB, 'x-actor-id': ADMIN_SUB });
  });

  it('getPromotionAgreement: el partner lee el suyo; el ADMIN, el del partner configurado', async () => {
    esb.on('GET', `/router/schedule/promotion-agreements/${PARTNER_ID}`, { body: AGREEMENT });
    expectContract('get', '/vuelos/promociones/contrato', await http().get('/api/v2/vuelos/promociones/contrato').set('Authorization', tokens.partner()).expect(200));
    await http().get('/api/v2/vuelos/promociones/contrato').set('Authorization', tokens.admin()).expect(200);
    const customer = await http().get('/api/v2/vuelos/promociones/contrato').set('Authorization', tokens.customer()).expect(404);
    expectContract('get', '/vuelos/promociones/contrato', customer);
  });

  it('★ PUT /promociones/contrato: el partner recibe 403 (no tiene flights:admin); el ADMIN guarda con la saga', async () => {
    const body = { permite_promociones: true, porcentaje_descuento_maximo: 10 };
    const partner = await http().put('/api/v2/vuelos/promociones/contrato').set('Authorization', tokens.partner()).set('Idempotency-Key', newKey()).send(body).expect(403);
    expectContract('put', '/vuelos/promociones/contrato', partner);
    expect(partner.body.code).toBe('FORBIDDEN');
    // Aunque el partner tuviera el scope (Identity nunca se lo da), no es un administrador.
    await http().put('/api/v2/vuelos/promociones/contrato').set('Authorization', tokens.partner('flights:admin')).set('Idempotency-Key', newKey()).send(body).expect(403);
    expect(esb.calls).toHaveLength(0);

    esb.on('PUT', `/sagas/promotion-agreements/${PARTNER_ID}`, { body: AGREEMENT });
    const admin = await http().put('/api/v2/vuelos/promociones/contrato').set('Authorization', tokens.admin()).set('Idempotency-Key', newKey()).send(body).expect(200);
    expectContract('put', '/vuelos/promociones/contrato', admin);
    expect(esb.last()!.headers['x-actor-id']).toBe(ADMIN_SUB);
  });

  it('PUT sin Idempotency-Key → 400 (el contrato la exige)', async () => {
    const response = await http().put('/api/v2/vuelos/promociones/contrato').set('Authorization', tokens.admin()).send({ permite_promociones: false, porcentaje_descuento_maximo: 0 }).expect(400);
    expect(response.body.invalidParams).toEqual([{ name: 'Idempotency-Key', reason: 'obligatorio' }]);
  });

  it('422 del ESB (descuento > 50 %) se publica con su código del contrato', async () => {
    esb.on('PUT', `/sagas/promotion-agreements/${PARTNER_ID}`, { status: 422, body: { type: 'about:blank', title: 'Máximo 50 %.', status: 422, code: 'PROMOTION_DISCOUNT_OUT_OF_RANGE' } });
    const response = await http().put('/api/v2/vuelos/promociones/contrato').set('Authorization', tokens.admin()).set('Idempotency-Key', newKey()).send({ permite_promociones: true, porcentaje_descuento_maximo: 60 }).expect(422);
    expectContract('put', '/vuelos/promociones/contrato', response);
    expect(response.body.code).toBe('PROMOTION_DISCOUNT_OUT_OF_RANGE');
  });
});

describe('rutas fuera del contrato', () => {
  it('404 para una ruta que no existe y 405 para otro método', async () => {
    expect((await http().get('/api/v2/vuelos/no-existe').expect(404)).body.code).toBe('NOT_FOUND');
    await http().delete('/api/v2/vuelos/search').expect(405);
    await http().get('/api/v2/vuelos/../vuelos/health').expect(404);
  });
});
