import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { signJwt, type TokenUse, verifyJwt } from '@ecoairlines/shared';
import { contractValidator } from '../../../../tests/support/openapi-contract.js';
import { ScheduleModule, setupApp } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { addDays, localDateOf } from '../src/domain/dates.js';
import { SEED_FLEET as DEFAULT_FLEET, SEED_ROUTES as DEFAULT_ROUTES } from '../src/domain/seed-network.js';

/** Pruebas de MS.G.Schedule (V2.4) contra contract/ms-g-schedule.openapi.yaml, con el repositorio en memoria. */
const expectContract = contractValidator('ms-g-schedule.openapi.yaml');
const ACTOR = '6b0f1c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TOKEN_OPTIONS = { issuer: 'ecoairlines-identity', audience: 'ecoairlines' };
const token = (token_use: TokenUse, scope: string) =>
  signJwt({ sub: token_use === 'service' ? 'ECOAIRLINES_ESB' : 'BOOKING_PROTOTIPO', token_use, scope }, privateKey, { ...TOKEN_OPTIONS, ttlSeconds: 300 }).token;
const ESB = token('service', 'ecoairlines:internal');
const today = localDateOf(Date.now(), -300);

let app: NestExpressApplication;
const http = () => request(app.getHttpServer());
const esb = (method: 'get' | 'post' | 'put' | 'delete', path: string, actor: string | null = ACTOR) => {
  const call = http()[method](path).set('Authorization', `Bearer ${ESB}`);
  return actor ? call.set('X-Actor-Id', actor) : call;
};
const routeBody = (overrides: Record<string, unknown> = {}) => ({
  origin: 'UIO',
  destination: 'GYE',
  outboundDepartureLocal: '05:10',
  inboundDepartureLocal: '06:40',
  weekdays: ['MON', 'WED', 'FRI'],
  ...overrides,
});

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  const verifier = { verify: async (jwt: string) => verifyJwt(jwt, () => publicKey, TOKEN_OPTIONS) };
  const moduleRef = await Test.createTestingModule({ imports: [ScheduleModule.register(config, { verifier })] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  setupApp(app);
  await app.init();
});
afterAll(() => app.close());

describe('acceso: solo el ESB', () => {
  it('sin token → 401; token de partner → 403', async () => {
    const none = await http().get('/routes');
    expect(none.status).toBe(401);
    expectContract('get', '/routes', none);
    const partner = await http().get('/routes').set('Authorization', `Bearer ${token('partner', 'flights:read')}`);
    expect(partner.status).toBe(403);
  });

  it('GET /health sin token, con la base en memoria', async () => {
    const response = await http().get('/health');
    expectContract('get', '/health', response);
    expect(response.body.dependencies.database.status).toBe('memory');
  });

  it('un cambio sin X-Actor-Id → 400', async () => {
    const response = await esb('post', '/aircraft', null).send({ aircraftType: 'Airbus A320neo', base: 'UIO' });
    expect(response.status).toBe(400);
    expectContract('post', '/aircraft', response);
  });
});

describe('red de prueba sembrada', () => {
  it('un avión (HC-N01) con sus 2 rutas diarias, en servicio', async () => {
    const routes = await esb('get', '/routes');
    expectContract('get', '/routes', routes);
    expect(routes.body).toHaveLength(DEFAULT_ROUTES.length);
    expect(routes.body[0]).toMatchObject({ source: 'NETWORK', updatedBy: null });
    const aircraft = await esb('get', '/aircraft');
    expectContract('get', '/aircraft', aircraft);
    expect(aircraft.body).toHaveLength(DEFAULT_FLEET.length);
    expect(aircraft.body.every((plane: { status: string }) => plane.status === 'IN_SERVICE')).toBe(true);
  });

  it('detalle de una ruta con sus tramos y llegada local; 404 si no existe', async () => {
    const first = DEFAULT_ROUTES[0]!;
    const route = await esb('get', `/routes/${first.routeId}`);
    expectContract('get', '/routes/{routeId}', route);
    expect(route.body.outbound).toMatchObject({ flightNumber: first.outbound.flightNumber, departureLocal: first.outbound.departureLocal });
    expect(route.body.weekdays).toEqual(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
    const missing = await esb('get', '/routes/EA1-EA2');
    expect(missing.status).toBe(404);
    expectContract('get', '/routes/{routeId}', missing);
  });

  it('tipos de avión con sus asientos por cabina', async () => {
    const response = await esb('get', '/aircraft-types');
    expectContract('get', '/aircraft-types', response);
    const a320 = response.body.find((type: { aircraftType: string }) => type.aircraftType === 'Airbus A320neo');
    expect(a320).toMatchObject({ registrationPrefix: 'HC-N', totalSeats: 174, maxRouteKm: 4500, turnaroundMinutes: 45 });
  });
});

describe('rutas (saga "Publicar horario")', () => {
  it('crear: números desde EA300, avión nuevo con base en el origen, Location y auditoría', async () => {
    const response = await esb('post', '/routes').send(routeBody());
    expect(response.status).toBe(201);
    expectContract('post', '/routes', response);
    expect(response.headers['location']).toBe('/routes/EA300-EA301');
    expect(response.body).toMatchObject({ routeId: 'EA300-EA301', aircraftType: 'Airbus A220-300', source: 'ADMIN', updatedBy: ACTOR, weekdays: ['MON', 'WED', 'FRI'] });
    expect(response.body.aircraft).toHaveLength(1);
    const plane = await esb('get', `/aircraft/${response.body.aircraft[0]}`);
    expect(plane.body).toMatchObject({ base: 'UIO', status: 'IN_SERVICE', routes: ['EA300-EA301'] });
  });

  it('el mismo vuelo (origen, destino y hora) de otra ruta → 409 ROUTE_ALREADY_EXISTS', async () => {
    const seed = DEFAULT_ROUTES.find((route) => route.origin === 'UIO' && route.destination === 'GYE')!;
    const response = await esb('post', '/routes').send(routeBody({ outboundDepartureLocal: seed.outbound.departureLocal }));
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('ROUTE_ALREADY_EXISTS');
    expectContract('post', '/routes', response);
  });

  it.each([
    ['aeropuerto fuera de la red', routeBody({ destination: 'XXX' }), 'UNKNOWN_AIRPORT'],
    ['origen igual al destino', routeBody({ destination: 'UIO' }), 'VALIDATION_FAILED'],
    ['avión sin alcance (A220 a Madrid)', routeBody({ destination: 'MAD', aircraftType: 'Airbus A220-300' }), 'AIRCRAFT_RANGE_EXCEEDED'],
    ['avión inexistente', routeBody({ aircraft: ['HC-ZZ99'] }), 'AIRCRAFT_NOT_IN_FLEET'],
  ])('%s → 422 %s', async (_, body, code) => {
    const response = await esb('post', '/routes').send(body);
    expect(response.status).toBe(422);
    expect(response.body.code).toBe(code);
    expectContract('post', '/routes', response);
  });

  it('aviones elegidos que no alcanzan → 422 NOT_ENOUGH_AIRCRAFT con cuántos faltan', async () => {
    const plane = await esb('post', '/aircraft').send({ aircraftType: 'Boeing 787-9', base: 'UIO' });
    const response = await esb('post', '/routes').send(
      routeBody({ destination: 'MAD', outboundDepartureLocal: '23:10', inboundDepartureLocal: '23:40', weekdays: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], aircraft: [plane.body.registration] }),
    );
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('NOT_ENOUGH_AIRCRAFT');
    expect(response.body.detail).toMatch(/^Faltan \d+ avión/);
    expectContract('post', '/routes', response);
    await esb('delete', `/aircraft/${plane.body.registration}`);
  });

  it('avión de otra base → 422 AIRCRAFT_MISMATCH', async () => {
    const plane = await esb('post', '/aircraft').send({ aircraftType: 'Airbus A220-300', base: 'GYE' });
    const response = await esb('post', '/routes').send(routeBody({ origin: 'UIO', outboundDepartureLocal: '05:20', inboundDepartureLocal: '06:55', aircraft: [plane.body.registration] }));
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('AIRCRAFT_MISMATCH');
    await esb('delete', `/aircraft/${plane.body.registration}`);
  });

  it('cambiar con cupos vendidos → 409 ROUTE_HAS_SOLD_SEATS; sin cupos cambia y conserva su avión', async () => {
    const before = (await esb('get', '/routes/EA300-EA301')).body;
    const sold = await esb('put', '/routes/EA300-EA301').send({ route: routeBody({ outboundDepartureLocal: '05:15' }), soldSeats: 37 });
    expect(sold.status).toBe(409);
    expect(sold.body).toMatchObject({ code: 'ROUTE_HAS_SOLD_SEATS', detail: expect.stringContaining('37 cupos') });
    expectContract('put', '/routes/{routeId}', sold);
    const changed = await esb('put', '/routes/EA300-EA301').send({ route: routeBody({ outboundDepartureLocal: '05:15', weekdays: ['MON'] }), soldSeats: 0 });
    expect(changed.status).toBe(200);
    expectContract('put', '/routes/{routeId}', changed);
    expect(changed.body).toMatchObject({ weekdays: ['MON'], aircraft: before.aircraft });
    expect(changed.body.outbound.departureLocal).toBe('05:15');
  });

  it('dar de baja: con cupos → 409, sin soldSeats → 400; la compensación la restaura con el mismo routeId', async () => {
    const route = (await esb('get', '/routes/EA300-EA301')).body;
    expect((await esb('delete', '/routes/EA300-EA301?soldSeats=2')).status).toBe(409);
    const missing = await esb('delete', '/routes/EA300-EA301');
    expect(missing.status).toBe(400);
    expectContract('delete', '/routes/{routeId}', missing);
    expect((await esb('delete', '/routes/EA300-EA301?soldSeats=0')).status).toBe(204);
    expect((await esb('get', `/aircraft/${route.aircraft[0]}`)).body.status).toBe('AVAILABLE');

    const body = routeBody({ outboundDepartureLocal: '05:15', weekdays: ['MON'], aircraft: route.aircraft });
    const restored = await esb('post', '/routes?restoreRouteId=EA300-EA301').send(body);
    expect(restored.status).toBe(201);
    expect(restored.body).toMatchObject({ routeId: 'EA300-EA301', aircraft: route.aircraft });
    const again = await esb('post', '/routes?restoreRouteId=EA300-EA301').send(routeBody({ outboundDepartureLocal: '04:00' }));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ROUTE_ALREADY_EXISTS');
  });

  it('dos rutas creadas a la vez reciben números y aviones distintos', async () => {
    const [a, b] = await Promise.all([
      esb('post', '/routes').send(routeBody({ destination: 'CUE', outboundDepartureLocal: '05:00' })),
      esb('post', '/routes').send(routeBody({ destination: 'CUE', outboundDepartureLocal: '05:30', inboundDepartureLocal: '07:10' })),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.routeId).not.toBe(b.body.routeId);
    expect(a.body.aircraft[0]).not.toBe(b.body.aircraft[0]);
  });
});

describe('flota', () => {
  it('alta con la siguiente matrícula libre; base fuera de la red → 422 UNKNOWN_AIRPORT', async () => {
    const created = await esb('post', '/aircraft').send({ aircraftType: 'Airbus A320neo', base: 'CUE' });
    expect(created.status).toBe(201);
    expectContract('post', '/aircraft', created);
    expect(created.body).toMatchObject({ registration: expect.stringMatching(/^HC-N\d{2}$/), status: 'AVAILABLE', routes: [], totalSeats: 174, source: 'ADMIN' });
    const unknown = await esb('post', '/aircraft').send({ aircraftType: 'Airbus A320neo', base: 'XXX' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.code).toBe('UNKNOWN_AIRPORT');
    expectContract('post', '/aircraft', unknown);
    const moved = await esb('put', `/aircraft/${created.body.registration}`).send({ base: 'GYE' });
    expectContract('put', '/aircraft/{registration}', moved);
    expect(moved.body.base).toBe('GYE');
    expect((await esb('delete', `/aircraft/${created.body.registration}`)).status).toBe(204);
    expect((await esb('get', `/aircraft/${created.body.registration}`)).status).toBe(404);
  });

  it('un avión en servicio no cambia de base ni se retira (409 AIRCRAFT_IN_SERVICE)', async () => {
    const plane = DEFAULT_FLEET[0]!.registration;
    const move = await esb('put', `/aircraft/${plane}`).send({ base: 'MIA' });
    expect(move.status).toBe(409);
    expect(move.body.code).toBe('AIRCRAFT_IN_SERVICE');
    expectContract('put', '/aircraft/{registration}', move);
    const remove = await esb('delete', `/aircraft/${plane}`);
    expect(remove.status).toBe(409);
    expectContract('delete', '/aircraft/{registration}', remove);
  });
});

describe('horario', () => {
  it('un día: los vuelos de la red con fecha, avión y horas con el desfase del aeropuerto', async () => {
    const response = await esb('get', `/timetable?from=${today}&to=${today}`);
    expectContract('get', '/timetable', response);
    // Los 4 vuelos del avión de prueba (y los de las rutas que crearon las pruebas anteriores).
    const seed = response.body.flights.filter((flight: { registration: string }) => flight.registration === 'HC-N01');
    expect(seed.map((flight: { flightNumber: string }) => flight.flightNumber)).toEqual(['EA100', 'EA101', 'EA102', 'EA103']);
    expect(seed[0]).toMatchObject({ origin: 'UIO', destination: 'GYE', departureAt: `${today}T07:00:00-05:00`, routeId: 'EA100-EA101' });
  });

  it('los 92 días de la ventana, y filtro por ruta (2 vuelos por día)', async () => {
    const started = Date.now();
    const full = await esb('get', `/timetable?from=${today}&to=${addDays(today, 91)}`);
    expect(full.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);
    const route = DEFAULT_ROUTES[0]!.routeId;
    const one = await esb('get', `/timetable?from=${today}&to=${addDays(today, 6)}&routeId=${route}`);
    expectContract('get', '/timetable', one);
    expect(one.body.flights).toHaveLength(14);
    expect(new Set(one.body.flights.map((flight: { routeId: string }) => flight.routeId))).toEqual(new Set([route]));
  });

  it.each([
    ['más de 92 días', `from=${today}&to=${addDays(today, 92)}`],
    ['to antes de from', `from=${today}&to=${addDays(today, -1)}`],
    ['fecha inexistente', 'from=2026-02-30&to=2026-03-01'],
    ['sin to', `from=${today}`],
  ])('%s → 400', async (_, query) => {
    const response = await esb('get', `/timetable?${query}`);
    expect(response.status).toBe(400);
    expectContract('get', '/timetable', response);
  });

  it('rotación de la flota en una fecha: cada avión con sus vuelos, sin superponerse', async () => {
    const response = await esb('get', `/fleet-schedule?date=${today}`);
    expectContract('get', '/fleet-schedule', response);
    expect(response.body.aircraft.length).toBeGreaterThanOrEqual(DEFAULT_FLEET.length);
    for (const plane of response.body.aircraft as { registration: string; flights: { registration: string; departureAt: string; arrivalAt: string }[] }[]) {
      for (const [index, flight] of plane.flights.entries()) {
        expect(flight.registration).toBe(plane.registration);
        const next = plane.flights[index + 1];
        if (next) expect(Date.parse(next.departureAt)).toBeGreaterThan(Date.parse(flight.arrivalAt));
      }
    }
  });
});

describe('precios por clase (saga "Guardar precios y descuento máximo")', () => {
  it('tabla con referencia, «Rellenar» sin guardar', async () => {
    const table = await esb('get', '/fare-prices');
    expectContract('get', '/fare-prices', table);
    expect(table.body.items).toHaveLength(4);
    const reference = await esb('get', '/fare-prices/reference');
    expectContract('get', '/fare-prices/reference', reference);
    expect(reference.body).toContainEqual({ cabinClass: 'ECONOMY', fareBrand: 'BROTE', multiplier: 1.35 });
  });

  it('guardar deja historial; el mismo valor no repite historial', async () => {
    const saved = await esb('put', '/fare-prices').send({ items: [{ cabinClass: 'ECONOMY', fareBrand: 'BROTE', multiplier: 1.4 }] });
    expect(saved.status).toBe(200);
    expectContract('put', '/fare-prices', saved);
    expect(saved.body.items.find((p: { fareBrand: string }) => p.fareBrand === 'BROTE')).toMatchObject({ multiplier: 1.4, referenceMultiplier: 1.35, updatedBy: ACTOR });
    await esb('put', '/fare-prices').send({ items: [{ cabinClass: 'ECONOMY', fareBrand: 'BROTE', multiplier: 1.4 }] });
    const history = await esb('get', '/fare-prices/history');
    expectContract('get', '/fare-prices/history', history);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0]).toMatchObject({ fareBrand: 'BROTE', oldMultiplier: 1.35, newMultiplier: 1.4, changedBy: ACTOR });
  });

  it('todo o nada: un multiplicador fuera de 0,5–10 → 422 y no se guarda ninguna fila', async () => {
    const response = await esb('put', '/fare-prices').send({
      items: [
        { cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 1.1 },
        { cabinClass: 'BUSINESS', fareBrand: 'DOSEL', multiplier: 11 },
      ],
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('MULTIPLIER_OUT_OF_RANGE');
    expectContract('put', '/fare-prices', response);
    const semilla = (await esb('get', '/fare-prices')).body.items.find((p: { fareBrand: string }) => p.fareBrand === 'SEMILLA');
    expect(semilla.multiplier).toBe(1);
  });

  it('combinación inexistente → 404; repetida → 400', async () => {
    const missing = await esb('put', '/fare-prices').send({ items: [{ cabinClass: 'BUSINESS', fareBrand: 'SEMILLA', multiplier: 2 }] });
    expect(missing.status).toBe(404);
    expectContract('put', '/fare-prices', missing);
    const item = { cabinClass: 'ECONOMY', fareBrand: 'BOSQUE', multiplier: 2 };
    expect((await esb('put', '/fare-prices').send({ items: [item, item] })).status).toBe(400);
  });
});

describe('acuerdo de promociones (D35)', () => {
  const terms = {
    permite_promociones: true,
    porcentaje_descuento_maximo: 12,
    rutas_habilitadas: ['UIO-GYE', 'GYE-UIO'],
    cabinas_habilitadas: ['ECONOMY'],
    vigencia_hasta: addDays(today, 60),
    condiciones_combo: 'Hasta 12 % en combos vuelo + hotel.',
  };

  it('el acuerdo inicial con Booking es "sin promociones" (0 %); otro partner sin acuerdo → 404', async () => {
    const seeded = await esb('get', '/promotion-agreements/BOOKING_PROTOTIPO');
    expect(seeded.status).toBe(200);
    expectContract('get', '/promotion-agreements/{partnerId}', seeded);
    expect(seeded.body).toMatchObject({ permite_promociones: false, porcentaje_descuento_maximo: 0 });
    const missing = await esb('get', '/promotion-agreements/OTRO_PARTNER');
    expect(missing.status).toBe(404);
    expectContract('get', '/promotion-agreements/{partnerId}', missing);
  });

  it('guardar y leer con la forma ContratoPromocionesResponse del contrato v2', async () => {
    const saved = await esb('put', '/promotion-agreements/BOOKING_PROTOTIPO').send(terms);
    expect(saved.status).toBe(200);
    expectContract('put', '/promotion-agreements/{partnerId}', saved);
    expect(saved.body).toMatchObject({ proveedor_codigo: 'NODE_VUE_ECOAIRLINES', nombre_socio: 'EcoAirlines', vertical: 'VUELOS', ...terms });
    expect(saved.body).not.toHaveProperty('destinos_habilitados');
    const read = await esb('get', '/promotion-agreements/BOOKING_PROTOTIPO');
    expectContract('get', '/promotion-agreements/{partnerId}', read);
    expect(read.body).toEqual(saved.body);
  });

  it('50 % es el máximo; 51 % o negativo → 422 PROMOTION_DISCOUNT_OUT_OF_RANGE (aunque el contrato v2 admite 100)', async () => {
    expect((await esb('put', '/promotion-agreements/BOOKING_PROTOTIPO').send({ ...terms, porcentaje_descuento_maximo: 50 })).status).toBe(200);
    for (const value of [51, 100, -1]) {
      const response = await esb('put', '/promotion-agreements/BOOKING_PROTOTIPO').send({ ...terms, porcentaje_descuento_maximo: value });
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('PROMOTION_DISCOUNT_OUT_OF_RANGE');
      expectContract('put', '/promotion-agreements/{partnerId}', response);
    }
    expect((await esb('get', '/promotion-agreements/BOOKING_PROTOTIPO')).body.porcentaje_descuento_maximo).toBe(50);
  });

  it.each([
    ['ruta que no se opera', { rutas_habilitadas: ['UIO-XXX'] }],
    ['cabina que la flota no tiene', { cabinas_habilitadas: ['FIRST'] }],
    ['vigencia ya vencida', { vigencia_hasta: addDays(today, -1) }],
  ])('%s → 422 VALIDATION_FAILED', async (_, change) => {
    const response = await esb('put', '/promotion-agreements/BOOKING_PROTOTIPO').send({ ...terms, ...change });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expectContract('put', '/promotion-agreements/{partnerId}', response);
  });

  it('falta permite_promociones → 400', async () => {
    const response = await esb('put', '/promotion-agreements/BOOKING_PROTOTIPO').send({ porcentaje_descuento_maximo: 5 });
    expect(response.status).toBe(400);
    expectContract('put', '/promotion-agreements/{partnerId}', response);
  });
});

describe('regreso de cada ruta (PLAN_Correccion C-3)', () => {
  it('★ C-3: la ruta dice qué días sale la vuelta y cuánto tiempo pasa el avión en tierra (UIO ⇄ MAD, 787-9)', async () => {
    // Llega el jueves 12:25 a Madrid; a las 13:00 del jueves el 787-9 no cumple sus 90 min en tierra → la vuelta sale el viernes.
    const madrid = await esb('post', '/routes').send(routeBody({ destination: 'MAD', outboundDepartureLocal: '19:00', inboundDepartureLocal: '13:00', weekdays: ['WED'], aircraftType: 'Boeing 787-9' }));
    expect(madrid.status).toBe(201);
    expectContract('post', '/routes', madrid);
    expect(madrid.body.outbound).toMatchObject({ arrivalLocal: '12:25', arrivalDayOffset: 1, weekdays: ['WED'] });
    expect(madrid.body.inbound.weekdays).toEqual(['FRI']);
    expect(madrid.body).toMatchObject({ returnDelayDays: 2, groundMinutes: 1475, turnaroundMinutes: 90 });
    // Con tiempo de sobra, la vuelta sale el mismo día (UIO → GYE, A220: 35 min en tierra como mínimo).
    const sameDay = await esb('post', '/routes').send(routeBody({ outboundDepartureLocal: '04:20', inboundDepartureLocal: '06:20' }));
    expect(sameDay.status).toBe(201);
    expect(sameDay.body).toMatchObject({ returnDelayDays: 0, turnaroundMinutes: 35 });
    expect(sameDay.body.inbound.weekdays).toEqual(['MON', 'WED', 'FRI']);
    expect(sameDay.body.groundMinutes).toBeGreaterThanOrEqual(35);
    const listed = (await esb('get', '/routes')).body.find((route: { routeId: string }) => route.routeId === madrid.body.routeId);
    expect(listed).toMatchObject({ returnDelayDays: 2, groundMinutes: 1475 });
    await esb('delete', `/routes/${madrid.body.routeId}?soldSeats=0`);
    await esb('delete', `/routes/${sameDay.body.routeId}?soldSeats=0`);
  });
});

describe('red nacional: capitales de provincia (PLAN_Provincias)', () => {
  it('★ Quito → Guaranda (capital sin aeropuerto, código propio) y Quito → Galápagos (UTC−6): rutas válidas con su hora local', async () => {
    const guaranda = await esb('post', '/routes').send(routeBody({ destination: 'GDA', outboundDepartureLocal: '04:05', inboundDepartureLocal: '06:05', weekdays: ['TUE'] }));
    expect(guaranda.status).toBe(201);
    expectContract('post', '/routes', guaranda);
    expect(guaranda.body).toMatchObject({ destination: 'GDA', aircraftType: 'Airbus A220-300', returnDelayDays: 0 });

    const galapagos = await esb('post', '/routes').send(routeBody({ destination: 'SCY', outboundDepartureLocal: '04:10', inboundDepartureLocal: '08:10', weekdays: ['TUE'] }));
    expect(galapagos.status).toBe(201);
    // Llega a la hora local de San Cristóbal: una hora menos que en Quito.
    const minutes = 4 * 60 + 10 + galapagos.body.durationMinutes - 60;
    const local = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    expect(galapagos.body.outbound.arrivalLocal).toBe(local);
    expect(galapagos.body.returnDelayDays).toBe(0);

    await esb('delete', `/routes/${guaranda.body.routeId}?soldSeats=0`);
    await esb('delete', `/routes/${galapagos.body.routeId}?soldSeats=0`);
  });
});

