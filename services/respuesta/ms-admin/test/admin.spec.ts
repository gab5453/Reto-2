import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { ADMIN_SUB, createResponseApp, FakeEsb, PARTNER_ID, tokens } from '../../../../tests/support/response-service.js';
import { definition } from '../src/service.js';

/** MS.Admin (V2.12) contra un ESB falso: solo ADMIN, `X-Actor-Id` en cada llamada, y cada grupo del panel. */
const expectOwn = contractValidator('ms-admin.openapi.yaml');
const esb = new FakeEsb();
let app: NestExpressApplication;
const http = () => request(app.getHttpServer());
const admin = (call: request.Test) => call.set('Authorization', tokens.admin());
const USER = { sub: '1f0a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b', email: 'ana@ecoairlines.test', fullName: 'Ana Paz', role: 'CUSTOMER', status: 'ACTIVE', createdAt: '2026-10-25T00:00:00Z' };

beforeAll(async () => {
  await esb.start();
  app = await createResponseApp(definition(), esb);
});
afterAll(async () => {
  await app.close();
  await esb.stop();
});
beforeEach(() => esb.reset());

describe('seguridad del panel', () => {
  it('★ solo un usuario ADMIN: un cliente o un partner reciben 403, sin token 401', async () => {
    await http().get('/api/v2/ecoairlines/admin/users').expect(401);
    expectOwn('get', '/ecoairlines/admin/users', await http().get('/api/v2/ecoairlines/admin/users').set('Authorization', tokens.customer()).expect(403));
    expectOwn('get', '/ecoairlines/admin/users', await http().get('/api/v2/ecoairlines/admin/users').set('Authorization', tokens.partner()).expect(403));
    expect(esb.calls).toHaveLength(0);
  });

  it('cada llamada lleva X-Actor-Id = sub del administrador y los filtros del contrato', async () => {
    esb.on('GET', '/router/identity/users', { body: { items: [USER] } });
    const response = await admin(http().get('/api/v2/ecoairlines/admin/users').query({ q: 'ana', role: 'CUSTOMER', limit: 10, desconocido: 'x' })).expect(200);
    expectOwn('get', '/ecoairlines/admin/users', response);
    const call = esb.last()!;
    expect(call.headers['x-actor-id']).toBe(ADMIN_SUB);
    expect(call.headers['x-owner-id']).toBeUndefined();
    // Solo los parámetros del contrato llegan al ESB.
    expect(call.path).toBe('/router/identity/users?q=ana&role=CUSTOMER&limit=10');
  });
});

describe('usuarios y partners (Identity por el enrutador)', () => {
  it('createUser 201; un código propio de Identity sale en `type`', async () => {
    esb.on('POST', '/router/identity/users', { status: 201, body: USER });
    expectOwn('post', '/ecoairlines/admin/users', await admin(http().post('/api/v2/ecoairlines/admin/users')).send({ email: 'ana@ecoairlines.test', fullName: 'Ana Paz', password: 'Clave-segura-1', role: 'CUSTOMER' }).expect(201));
    esb.on('POST', '/router/identity/users', { status: 409, body: { type: 'about:blank', title: 'El correo ya está registrado.', status: 409, code: 'EMAIL_ALREADY_REGISTERED' } });
    const taken = await admin(http().post('/api/v2/ecoairlines/admin/users')).send({ email: 'ana@ecoairlines.test', fullName: 'Ana Paz', password: 'Clave-segura-1', role: 'CUSTOMER' }).expect(409);
    expectOwn('post', '/ecoairlines/admin/users', taken);
    expect(taken.body.type).toBe('urn:ecoairlines:problema:EMAIL_ALREADY_REGISTERED');
  });

  it('rotatePartnerSecret: el secreto nuevo se muestra una vez, con Cache-Control: no-store', async () => {
    esb.on('POST', `/router/identity/partners/${PARTNER_ID}/secret`, { body: { clientId: PARTNER_ID, name: 'Booking Prototipo', scopes: ['flights:read'], status: 'ACTIVE', createdAt: '2026-10-25T00:00:00Z', clientSecret: 'nuevo-secreto-0123456789' }, headers: { 'cache-control': 'no-store' } });
    const response = await admin(http().post(`/api/v2/ecoairlines/admin/partners/${PARTNER_ID}/secret`)).expect(200);
    expectOwn('post', '/ecoairlines/admin/partners/{clientId}/secret', response);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('precios, rutas y asistencia', () => {
  const TABLE = { items: [], updatedAt: '2026-10-25T00:00:00Z', updatedBy: ADMIN_SUB };
  const AGREEMENT = { proveedor_codigo: 'NODE_VUE_ECOAIRLINES', nombre_socio: 'EcoAirlines', vertical: 'VUELOS', actualizado_en: '2026-10-25T17:41:38.120Z', permite_promociones: false, porcentaje_descuento_maximo: 0 };

  it('savePrices: un solo «Guardar» ejecuta las dos sagas y responde la vista nueva', async () => {
    esb.on('PUT', '/sagas/fare-prices', { body: TABLE });
    esb.on('PUT', `/sagas/promotion-agreements/${PARTNER_ID}`, { body: AGREEMENT });
    esb.on('GET', '/router/schedule/fare-prices', { body: TABLE });
    const PRICING = { fixedCharge: 35, perKm: 0.09, routePrices: [{ routeId: 'EA324-EA325', prices: [{ fareBrand: 'SEMILLA', amount: 70 }, { fareBrand: 'BROTE', amount: 95 }, { fareBrand: 'BOSQUE', amount: 125 }, { fareBrand: 'DOSEL', amount: 220 }] }], updatedAt: '2026-11-09T00:00:00Z', updatedBy: ADMIN_SUB, history: [] };
    esb.on('GET', '/router/schedule/pricing', { body: PRICING });
    esb.on('PUT', '/sagas/pricing', { body: PRICING });
    esb.on('GET', '/router/identity/partners', { body: { items: [{ clientId: PARTNER_ID }, { clientId: 'SIN_ACUERDO' }], nextCursor: null } });
    esb.on('GET', `/router/schedule/promotion-agreements/${PARTNER_ID}`, { body: AGREEMENT });
    esb.on('GET', '/router/schedule/promotion-agreements/SIN_ACUERDO', { status: 404, body: { type: 'about:blank', title: 'Sin acuerdo.', status: 404, code: 'NOT_FOUND' } });
    const response = await admin(http().put('/api/v2/ecoairlines/admin/prices'))
      .send({ prices: { items: [{ cabinClass: 'ECONOMY', fareBrand: 'BROTE', multiplier: 1.2 }] }, pricing: { perKm: 0.09, route: PRICING.routePrices[0] }, promotion: { partnerId: PARTNER_ID, agreement: { permite_promociones: false, porcentaje_descuento_maximo: 0 } } })
      .expect(200);
    expect(response.body.promotions).toHaveLength(1);
    expect(response.body.promotions[0].partnerId).toBe(PARTNER_ID); // no `proveedor_codigo`: ese es la aerolínea
    expect(esb.calls.filter((c) => c.path.startsWith('/sagas/')).map((c) => c.path)).toEqual(['/sagas/fare-prices', '/sagas/pricing', `/sagas/promotion-agreements/${PARTNER_ID}`]);
    // P-1: la tarifa base y los precios por ruta vienen en la vista, y la saga recibe lo que cambia.
    expect(response.body.pricing).toMatchObject({ perKm: 0.09, routePrices: [{ routeId: 'EA324-EA325' }] });
    expect(JSON.parse(esb.calls.find((c) => c.path === '/sagas/pricing')!.body)).toEqual({ perKm: 0.09, route: PRICING.routePrices[0] });
  });

  it('createRoute: la saga "Publicar horario" responde solo la ruta (201 ScheduledRoute), sin el resultado de Offers', async () => {
    const leg = (flightNumber: string, origin: string, destination: string) => ({ flightNumber, origin, destination, departureLocal: '07:00', arrivalLocal: '07:50', arrivalDayOffset: 0 });
    const route = { routeId: 'EA300-EA301', origin: 'UIO', destination: 'CUE', outbound: leg('EA300', 'UIO', 'CUE'), inbound: leg('EA301', 'CUE', 'UIO'), weekdays: ['MON'], aircraftType: 'Airbus A320neo', aircraft: ['HC-EAA'], distanceKm: 300, durationMinutes: 50, source: 'ADMIN', createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z', updatedBy: ADMIN_SUB };
    esb.on('POST', '/sagas/routes', { status: 201, body: { route, flights: 120, published: { flights: 120 } } });
    const response = await admin(http().post('/api/v2/ecoairlines/admin/routes')).send({ origin: 'UIO', destination: 'CUE', outboundDepartureLocal: '07:00', inboundDepartureLocal: '09:00', weekdays: ['MON'] }).expect(201);
    expectOwn('post', '/ecoairlines/admin/routes', response);
    expect(response.body).not.toHaveProperty('flights');
    expect(response.body.routeId).toBe('EA300-EA301');
  });

  it('deleteRoute → 204; listFlightAssistance (dato de salud) por la composición con X-Actor-Id', async () => {
    esb.on('DELETE', '/sagas/routes/EA100-EA101', { body: { deletedRouteId: 'EA100-EA101', flights: 0 } });
    await admin(http().delete('/api/v2/ecoairlines/admin/routes/EA100-EA101')).expect(204);
    esb.on('GET', '/composition/flights/EA100/assistance', { body: [] });
    expectOwn('get', '/ecoairlines/admin/flights/{flightNumber}/assistance', await admin(http().get('/api/v2/ecoairlines/admin/flights/EA100/assistance').query({ date: '2026-11-04' })).expect(200));
    expect(esb.last()!.headers['x-actor-id']).toBe(ADMIN_SUB);
  });
});

describe('reservas de todos los canales (panel O-1, solo lectura)', () => {
  const BOOKING_ID = 'e8bead02-1587-4dcd-86c3-a54653fb0986';
  const MONEY = { currency: 'USD', baseFare: '59.00', taxes: '20.85', total: '79.85' };

  it('listAdminBookings: busca por referencia con X-Actor-Id y conserva canal, orden de Booking y reembolso', async () => {
    const item = { bookingId: BOOKING_ID, pnr: 'DHV47T', status: 'CANCELLED', origin: 'UIO', destination: 'GYE', departureDate: '2026-11-08', grandTotal: MONEY,
      channel: 'BOOKING', partnerId: 'BOOKING_PROTOTIPO', partnerOrderId: 'ORD-BKP-7B5BADB7C0', departureAt: '2026-11-08T07:00:00-05:00', passengerCount: 1, refundTotal: '20.85', createdAt: '2026-11-08T04:09:43.317Z' };
    esb.on('GET', '/router/bookings/bookings', { body: { items: [item], nextCursor: null } });
    const response = await admin(http().get('/api/v2/ecoairlines/admin/bookings').query({ reference: 'ORD-BKP-7B5BADB7C0', channel: 'BOOKING', limit: 20 })).expect(200);
    expectOwn('get', '/ecoairlines/admin/bookings', response);
    expect(response.body.items[0]).toEqual(item);
    expect(esb.last()!.path).toBe('/router/bookings/bookings?reference=ORD-BKP-7B5BADB7C0&channel=BOOKING&limit=20');
    expect(esb.last()!.headers['x-actor-id']).toBe(ADMIN_SUB);
  });

  it('getAdminBooking: el detalle con dueño, canal, tarifas, reembolsos y pagos registrados', async () => {
    const detail = {
      bookingId: BOOKING_ID, pnr: 'DHV47T', status: 'CANCELLED', grandTotal: MONEY, createdAt: '2026-11-08T04:09:43.317Z', updatedAt: '2026-11-08T04:09:59.775Z',
      holdId: '0f6b1a2c-3d4e-4f50-8a6b-7c8d9e0f1a2b', paymentReference: 'PAY-BKP-20261107-030453',
      salesChannel: { partnerId: 'BOOKING_PROTOTIPO', partnerOrderId: 'ORD-BKP-7B5BADB7C0', promotionApplied: false },
      itineraries: [], passengers: [], tickets: [], changes: [{ changedAt: '2026-11-08T04:09:59.775Z', description: 'Reserva cancelada (CUSTOMER_REQUEST).' }],
      ownerId: 'partner:BOOKING_PROTOTIPO:7a1c2e9f-4b3d-4c8a-9e21-5f6d7c8b9a01', channel: 'BOOKING',
      refunds: [{ refundId: 'REF-1545C35F', amount: '20.85', penaltyAmount: '59.00', currency: 'USD', percentage: 26.11, status: 'CALCULATED' }],
      payments: [{ paymentReference: 'PAY-BKP-20261107-030453', provider: 'BOOKING_PROTOTIPO', operation: 'BOOKING', amount: { currency: 'USD', total: '79.85' }, bookingId: BOOKING_ID, sagaId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', claimedAt: '2026-11-08T04:09:43.258Z' }],
    };
    esb.on('GET', `/router/bookings/bookings/${BOOKING_ID}`, { body: detail });
    const response = await admin(http().get(`/api/v2/ecoairlines/admin/bookings/${BOOKING_ID}`)).expect(200);
    expectOwn('get', '/ecoairlines/admin/bookings/{bookingId}', response);
    expect(response.body).toMatchObject({ channel: 'BOOKING', ownerId: detail.ownerId, salesChannel: { partnerOrderId: 'ORD-BKP-7B5BADB7C0' }, refunds: [{ amount: '20.85' }], payments: [{ paymentReference: 'PAY-BKP-20261107-030453' }] });
    expect(esb.last()!.headers['x-actor-id']).toBe(ADMIN_SUB);
    expectOwn('get', '/ecoairlines/admin/bookings/{bookingId}', await http().get(`/api/v2/ecoairlines/admin/bookings/${BOOKING_ID}`).set('Authorization', tokens.customer()).expect(403));
  });

  it('getAdminBookingTimeline (O-2): sagas con sus pasos y eventos con sus entregas, por la composición', async () => {
    const timeline = {
      bookingId: BOOKING_ID,
      sagas: [{ sagaId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', type: 'CANCEL_BOOKING', status: 'COMPLETED', correlationId: 'corr-cancel', parentSagaId: null, createdAt: '2026-11-08T04:09:59Z', updatedAt: '2026-11-08T04:09:59Z', errorCode: null, steps: [{ name: 'bookings.get', status: 'DONE', at: '2026-11-08T04:09:59Z' }] }],
      events: [{ seq: 9, id: 'evt-1', type: 'ec.edu.epn.booking.vuelos.booking.cancelled', subject: BOOKING_ID, time: '2026-11-08T04:10:00Z', correlationId: 'corr-cancel', public: true, data: { bookingId: BOOKING_ID }, deliveries: [] }],
    };
    esb.on('GET', `/composition/bookings/${BOOKING_ID}/timeline`, { body: timeline });
    const response = await admin(http().get(`/api/v2/ecoairlines/admin/bookings/${BOOKING_ID}/timeline`)).expect(200);
    expectOwn('get', '/ecoairlines/admin/bookings/{bookingId}/timeline', response);
    expect(response.body).toEqual(timeline);
    expect(esb.last()!.headers['x-actor-id']).toBe(ADMIN_SUB);
  });
});

describe('reportes (panel O-3)', () => {
  it('getSalesReport: el reporte de Bookings por el enrutador, con el rango y X-Actor-Id', async () => {
    const report = { from: '2026-11-01', to: '2026-11-08', currency: 'USD', generatedAt: '2026-11-08T18:00:00Z',
      totals: { bookings: 1, cancelled: 1, passengers: 1, charged: '79.85', refunded: '20.85', net: '59.00' },
      byChannel: [{ channel: 'WEB', bookings: 0, charged: '0.00', refunded: '0.00', net: '0.00' }, { channel: 'BOOKING', bookings: 1, charged: '79.85', refunded: '20.85', net: '59.00' }],
      byDay: [{ date: '2026-11-07', channel: 'BOOKING', bookings: 1, charged: '79.85' }],
      byRoute: [{ origin: 'UIO', destination: 'GYE', bookings: 1, passengers: 1, charged: '79.85' }],
      bookingSettlement: { partnerId: 'BOOKING_PROTOTIPO', bookings: 1, charged: '79.85', refunded: '20.85', penalties: '59.00', net: '59.00', pendingRefunds: { count: 1, amount: '20.85' },
        items: [{ bookingId: 'e8bead02-1587-4dcd-86c3-a54653fb0986', pnr: 'DHV47T', partnerOrderId: 'ORD-BKP-7B5BADB7C0', paymentReference: 'PAY-BKP-20261107-030453', status: 'CANCELLED', createdAt: '2026-11-08T04:09:43Z', charged: '79.85', refunded: '20.85', penalty: '59.00', net: '59.00' }] } };
    esb.on('GET', /^\/router\/bookings\/reports\/sales\?/, { body: report });
    const response = await admin(http().get('/api/v2/ecoairlines/admin/reports/sales').query({ from: '2026-11-01', to: '2026-11-08' })).expect(200);
    expectOwn('get', '/ecoairlines/admin/reports/sales', response);
    expect(response.body).toEqual(report);
    expect(esb.last()!.path).toBe('/router/bookings/reports/sales?from=2026-11-01&to=2026-11-08');
    expect(esb.last()!.headers['x-actor-id']).toBe(ADMIN_SUB);
    expectOwn('get', '/ecoairlines/admin/reports/sales', await admin(http().get('/api/v2/ecoairlines/admin/reports/sales').query({ from: '2026-11-01' })).expect(400));
  });
});

describe('retrasos (R-1)', () => {
  it('getFlightDelayImpact: la composición del ESB con la fecha, los minutos y X-Actor-Id', async () => {
    const impact = { flightNumber: 'EA100', date: '2026-11-10', delayMinutes: 60, scheduledDepartureAt: '2026-11-10T07:00:00-05:00', scheduledArrivalAt: '2026-11-10T07:50:00-05:00',
      estimatedDepartureAt: '2026-11-10T13:00:00.000Z', estimatedArrivalAt: '2026-11-10T13:50:00.000Z', aircraft: { registration: 'HC-N01', aircraftType: 'Airbus A320neo', turnaroundMinutes: 45 },
      nextFlight: { flightNumber: 'EA101', date: '2026-11-10', origin: 'GYE', destination: 'UIO', scheduledDepartureAt: '2026-11-10T09:00:00-05:00', departureAt: '2026-11-10T09:00:00-05:00', status: 'SCHEDULED', readyAt: '2026-11-10T14:35:00.000Z', conflict: true, suggestedDelayMinutes: 35 },
      bookings: 1, passengers: 2,
      tightConnections: [{ bookingId: 'e8bead02-1587-4dcd-86c3-a54653fb0986', pnr: 'DHV47T', channel: 'BOOKING', kind: 'CONNECTION', nextFlightNumber: 'EA102', nextDepartureAt: '2026-11-10T09:30:00-05:00', availableMinutes: 40, requiredMinutes: 60 }] };
    esb.on('GET', /^\/composition\/flights\/EA100\/delay-impact\?/, { body: impact });
    const response = await admin(http().get('/api/v2/ecoairlines/admin/flights/EA100/delay-impact').query({ date: '2026-11-10', delayMinutes: 60 })).expect(200);
    expectOwn('get', '/ecoairlines/admin/flights/{flightNumber}/delay-impact', response);
    expect(response.body).toEqual(impact);
    expect(esb.last()!.path).toBe('/composition/flights/EA100/delay-impact?date=2026-11-10&delayMinutes=60');
    expect(esb.last()!.headers['x-actor-id']).toBe(ADMIN_SUB);
  });
});

describe('eventos y telemetría', () => {
  it('listEventHistory busca por correlation id (parámetro nuevo de ms-admin 1.1.0)', async () => {
    esb.on('GET', '/router/webhooks/history', { body: { items: [], nextCursor: null } });
    await admin(http().get('/api/v2/ecoairlines/admin/events').query({ correlationId: 'corr-x', limit: 5 })).expect(200);
    expect(esb.last()!.path).toBe('/router/webhooks/history?correlationId=corr-x&limit=5');
  });

  it('★ V2.16: latencia, traza por correlation id, colas y alertas por la composición del ESB (con el actor)', async () => {
    esb.on('GET', '/composition/services-health', { body: [{ service: 'ms-g-offers', status: 'UP', latency_ms: 3, checkedAt: '2026-10-26T00:00:00Z' }] });
    expectOwn('get', '/ecoairlines/admin/telemetry/services', await admin(http().get('/api/v2/ecoairlines/admin/telemetry/services')).expect(200));
    esb.on('GET', '/composition/telemetry/latency', { body: [{ service: 'gateway', p50_ms: 12, p95_ms: 80, p99_ms: 140, requests: 52, errorRate: 0.02 }] });
    const latency = await admin(http().get('/api/v2/ecoairlines/admin/telemetry/latency').query({ from: '2026-10-26T00:00:00Z' })).expect(200);
    expectOwn('get', '/ecoairlines/admin/telemetry/latency', latency);
    expect(esb.last()!.path).toBe('/composition/telemetry/latency?from=2026-10-26T00%3A00%3A00Z');
    expect(esb.last()!.headers['x-actor-id']).toBeDefined();
    esb.on('GET', '/composition/telemetry/traces/corr-x', { body: { correlationId: 'corr-x', window: { from: '2026-10-25T23:50:00Z', to: '2026-10-26T00:10:00Z', source: 'RECORDS' }, stepsError: 'La búsqueda tardó demasiado: prueba con un rango más corto.', steps: [{ timestamp: '2026-10-26T00:00:00Z', service: 'gateway', operation: 'POST /api/v2/*path', status: '201', latency_ms: 90, request_id: 'req-1', trace_id: 'abc' }], sagas: [{ sagaId: 's1', type: 'CREATE_BOOKING', status: 'COMPLETED' }], events: { items: [] } } });
    const traced = await admin(http().get('/api/v2/ecoairlines/admin/telemetry/traces/corr-x')).expect(200);
    expectOwn('get', '/ecoairlines/admin/telemetry/traces/{correlationId}', traced);
    // T-2: la ventana de Loki y el aviso de Loki lento pasan tal cual.
    expect([traced.body.window.source, traced.body.stepsError]).toEqual(['RECORDS', 'La búsqueda tardó demasiado: prueba con un rango más corto.']);
    // O-2: el rango (from/to) llega al ESB para acotar la búsqueda en Loki.
    esb.on('GET', /^\/composition\/telemetry\/traces\/corr-x\?/, { body: { correlationId: 'corr-x', steps: [], sagas: [], events: { items: [] } } });
    await admin(http().get('/api/v2/ecoairlines/admin/telemetry/traces/corr-x').query({ from: '2026-11-08T03:50:00Z', to: '2026-11-08T04:30:00Z' })).expect(200);
    expect(esb.last()!.path).toBe('/composition/telemetry/traces/corr-x?from=2026-11-08T03%3A50%3A00Z&to=2026-11-08T04%3A30%3A00Z');
    esb.on('GET', '/composition/telemetry/queues', { body: [{ queue: 'webhooks.events', messages: 0, consumers: 1, deadLetters: 0 }] });
    expectOwn('get', '/ecoairlines/admin/telemetry/queues', await admin(http().get('/api/v2/ecoairlines/admin/telemetry/queues')).expect(200));
    esb.on('GET', '/composition/telemetry/alerts', { body: [{ id: 'f1', rule: 'StockSinEnviar', severity: 'WARNING', message: 'Stock pendiente', startedAt: '2026-10-26T00:00:00Z' }] });
    expectOwn('get', '/ecoairlines/admin/telemetry/alerts', await admin(http().get('/api/v2/ecoairlines/admin/telemetry/alerts')).expect(200));
    // Si la plataforma no responde, el 503 del ESB llega como PROVIDER_UNAVAILABLE.
    esb.on('GET', '/composition/telemetry/queues', { status: 503, body: { type: 'about:blank', title: 'RabbitMQ no está disponible.', status: 503, code: 'PROVIDER_UNAVAILABLE' } });
    const down = await admin(http().get('/api/v2/ecoairlines/admin/telemetry/queues')).expect(503);
    expectOwn('get', '/ecoairlines/admin/telemetry/queues', down);
    expect(down.body.code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('catálogo de aeropuertos (PLAN_Telemetria_Asientos M-1)', () => {
  const airport = { code: 'JPJ', city: 'Jipijapa', name: 'Aeródromo de Jipijapa', country: 'EC', province: 'Manabí', lat: -1.3486, lon: -80.5786, utcOffsetMinutes: -300, active: true, updatedAt: '2026-11-10T00:00:00Z' };
  it('★ alta, cambio y baja van al enrutador del ESB con el administrador; un cliente no puede', async () => {
    esb.on('POST', '/router/schedule/airports', { status: 201, body: airport });
    const created = await admin(http().post('/api/v2/ecoairlines/admin/airports')).send({ code: 'JPJ', city: 'Jipijapa', name: 'Aeródromo de Jipijapa', country: 'EC', lat: -1.3486, lon: -80.5786, utcOffsetMinutes: -300 }).expect(201);
    expectOwn('post', '/ecoairlines/admin/airports', created);
    expect(esb.last()!.headers['x-actor-id']).toBeDefined();
    esb.on('PUT', '/router/schedule/airports/JPJ', { status: 409, body: { type: 'about:blank', title: 'JPJ está en uso.', status: 409, code: 'AIRPORT_IN_USE' } });
    const inUse = await admin(http().put('/api/v2/ecoairlines/admin/airports/JPJ')).send({ city: 'Jipijapa', name: 'X', country: 'EC', lat: -1.2, lon: -80.5786, utcOffsetMinutes: -300 }).expect(409);
    expect(inUse.body.type).toBe('urn:ecoairlines:problema:AIRPORT_IN_USE'); // código propio: va en `type` (el `code` del contrato es cerrado)
    esb.on('DELETE', '/router/schedule/airports/JPJ', { status: 204 });
    await admin(http().delete('/api/v2/ecoairlines/admin/airports/JPJ')).expect(204);
    await http().post('/api/v2/ecoairlines/admin/airports').set('Authorization', tokens.customer()).send({ code: 'JPJ', city: 'J', name: 'J', country: 'EC', lat: 0, lon: 0, utcOffsetMinutes: -300 }).expect(403);
  });
});


describe('catálogo de tipos de avión (PLAN_Telemetria_Asientos M-2)', () => {
  const input = { registrationPrefix: 'HC-E', maxRouteKm: 1000, turnaroundMinutes: 30, business: { seats: 12, configuration: '2-2' }, economy: { seats: 112, configuration: '2-4-2' } };
  const info = { aircraftType: 'Embraer E195-E2', registrationPrefix: 'HC-E', seats: [{ cabinClass: 'BUSINESS', seats: 12 }, { cabinClass: 'ECONOMY', seats: 112 }], totalSeats: 124, maxRouteKm: 1000, turnaroundMinutes: 30, inFleet: 0, cabins: [{ cabinClass: 'BUSINESS', seats: 12, configuration: '2-2', layout: 'AC-DF', firstRow: 1, lastRow: 3, exitRows: [], extraLegroomRows: [] }, { cabinClass: 'ECONOMY', seats: 112, configuration: '2-4-2', layout: 'AC-DEFG-HK', firstRow: 4, lastRow: 17, exitRows: [11], extraLegroomRows: [4, 11] }], source: 'ADMIN', updatedAt: '2026-11-10T00:00:00Z' };
  it('★ alta, cambio y baja al enrutador del ESB, con el nombre codificado', async () => {
    esb.on('POST', '/router/schedule/aircraft-types', { status: 201, body: info });
    const created = await admin(http().post('/api/v2/ecoairlines/admin/aircraft-types')).send({ aircraftType: 'Embraer E195-E2', ...input }).expect(201);
    expectOwn('post', '/ecoairlines/admin/aircraft-types', created);
    esb.on('PUT', '/router/schedule/aircraft-types/Embraer%20E195-E2', { body: { ...info, turnaroundMinutes: 40 } });
    expect((await admin(http().put('/api/v2/ecoairlines/admin/aircraft-types/Embraer%20E195-E2')).send({ ...input, turnaroundMinutes: 40 }).expect(200)).body.turnaroundMinutes).toBe(40);
    esb.on('DELETE', '/router/schedule/aircraft-types/Embraer%20E195-E2', { status: 204 });
    await admin(http().delete('/api/v2/ecoairlines/admin/aircraft-types/Embraer%20E195-E2')).expect(204);
  });
});

describe('vista «Recorrido» y mapa en vivo (PLAN_Telemetria_Asientos T-4)', () => {
  it('★ recorrido y mapa por la composición del ESB, con el rango', async () => {
    esb.on('GET', /^\/composition\/telemetry\/journeys\/corr-x/, { body: { correlationId: 'corr-x', startedAt: '2026-11-10T07:55:55Z', durationMs: 900, traces: 1, nodes: [{ id: 'cliente', layer: 'CLIENT' }, { id: 'gateway', layer: 'GATEWAY' }], hops: [{ sequence: 1, from: 'cliente', to: 'gateway', operation: 'POST /api/graphql', startMs: 0, durationMs: 900, status: 'OK', httpStatus: 200, traceId: 'abc' }], truncated: false } });
    expectOwn('get', '/ecoairlines/admin/telemetry/journeys/{correlationId}', await admin(http().get('/api/v2/ecoairlines/admin/telemetry/journeys/corr-x').query({ from: '2026-11-10T07:00:00Z' })).expect(200));
    expect(esb.last()!.path).toBe('/composition/telemetry/journeys/corr-x?from=2026-11-10T07%3A00%3A00Z');
    esb.on('GET', '/composition/telemetry/system-map', { body: { generatedAt: '2026-11-10T08:00:00Z', windowMinutes: 5, edges: [{ from: 'gateway', to: 'ms-reservas', requestsPerMinute: 12, errorsPerMinute: 0.5, p95Ms: 120 }] } });
    expectOwn('get', '/ecoairlines/admin/telemetry/system-map', await admin(http().get('/api/v2/ecoairlines/admin/telemetry/system-map')).expect(200));
  });
});


describe('check-in en mostrador (1.14.0, D57)', () => {
  const BOOKING = '4c1f3d2a-6b5e-4f70-8a9b-0c1d2e3f4a5b';
  const resultado = { bookingId: BOOKING, status: 'COMPLETED', checkedInPassengers: [{ passengerId: 'PAX-1', status: 'CHECKED_IN', segments: [{ segmentId: 'EA100-20261210', seat: '12A', status: 'CHECKED_IN' }] }] };
  const pases = { bookingId: BOOKING, boardingPasses: [{ passengerId: 'PAX-1', segmentId: 'EA100-20261210', seat: '12A', boardingGroup: 'B', boardingPosition: '001', barcode: 'M1TORRES/MARIA', barcodeType: 'PDF417', gate: 'A4' }] };

  it('★ hace el check-in con la saga del pasajero, como administrador (X-Actor-Id) y sin dueño; un cliente no puede', async () => {
    esb.on('POST', `/sagas/bookings/${BOOKING}/check-in`, { body: resultado });
    const response = await admin(http().post(`/api/v2/ecoairlines/admin/bookings/${BOOKING}/check-in`)).expect(200);
    expectOwn('post', '/ecoairlines/admin/bookings/{bookingId}/check-in', response);
    expect(response.body).toMatchObject({ bookingId: BOOKING, status: 'COMPLETED' });
    const call = esb.last()!;
    expect(call.headers['x-actor-id']).toBeDefined();
    expect(call.headers['x-owner-id']).toBeUndefined(); // el administrador no se hace pasar por el dueño
    await http().post(`/api/v2/ecoairlines/admin/bookings/${BOOKING}/check-in`).set('Authorization', tokens.customer()).expect(403);
  });

  it('lee los pases de cualquier reserva por la composición del ESB (para reimprimir); un cliente no puede', async () => {
    esb.on('GET', `/composition/bookings/${BOOKING}/boarding-passes`, { body: pases });
    const response = await admin(http().get(`/api/v2/ecoairlines/admin/bookings/${BOOKING}/boarding-passes`)).expect(200);
    expectOwn('get', '/ecoairlines/admin/bookings/{bookingId}/boarding-passes', response);
    expect(response.body.boardingPasses[0]).toMatchObject({ passengerId: 'PAX-1', seat: '12A', gate: 'A4' });
    expect(esb.last()!.headers['x-actor-id']).toBeDefined();
    await http().get(`/api/v2/ecoairlines/admin/bookings/${BOOKING}/boarding-passes`).set('Authorization', tokens.customer()).expect(403);
  });

  it('un error de la saga (ventana cerrada) llega con su code y su detail', async () => {
    esb.on('POST', `/sagas/bookings/${BOOKING}/check-in`, { status: 409, body: { type: 'about:blank', status: 409, code: 'CHECK_IN_NOT_AVAILABLE', title: 'El check-in abre 48 horas antes.', detail: 'Vuelo EA100 del 10/12.' } });
    const response = await admin(http().post(`/api/v2/ecoairlines/admin/bookings/${BOOKING}/check-in`)).expect(409);
    expect(response.body).toMatchObject({ code: 'CHECK_IN_NOT_AVAILABLE', detail: 'Vuelo EA100 del 10/12.' });
  });
});

describe('cancelación de administrador (excepción a D2)', () => {
  const BOOKING = 'dc4d0bf7-e126-4533-bcb5-f328f7461d51';
  it('★ cancela con SAGA_COMPENSATION (sin cotización ni regla del check-in), con el motivo y el administrador; un cliente no puede', async () => {
    esb.on('POST', `/sagas/bookings/${BOOKING}/cancel`, { body: { bookingId: BOOKING, status: 'CANCELLED' } });
    const response = await admin(http().post(`/api/v2/ecoairlines/admin/bookings/${BOOKING}/cancel`)).send({ reason: 'Reserva de prueba de Booking que quedó activa' }).expect(200);
    expectOwn('post', '/ecoairlines/admin/bookings/{bookingId}/cancel', response);
    expect(response.body).toEqual({ bookingId: BOOKING, status: 'CANCELLED' });
    const call = esb.last()!;
    expect(JSON.parse(call.body)).toEqual({ reasonCode: 'SAGA_COMPENSATION', reason: 'Cancelación de administrador: Reserva de prueba de Booking que quedó activa' });
    expect(call.headers['x-actor-id']).toBeDefined();
    await admin(http().post(`/api/v2/ecoairlines/admin/bookings/${BOOKING}/cancel`)).send({ reason: 'x' }).expect(400);
    await http().post(`/api/v2/ecoairlines/admin/bookings/${BOOKING}/cancel`).set('Authorization', tokens.customer()).send({ reason: 'Quiero cancelar' }).expect(403);
  });
});
