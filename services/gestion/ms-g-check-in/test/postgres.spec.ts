import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresCheckInStore } from '../src/repositories/check-in.store.js';
import { CheckInService } from '../src/services/check-in.service.js';

/**
 * PostgreSQL real (opcional): `CHECK_IN_TEST_DATABASE_URL=postgres://check_in_svc:dev-check-in@localhost:5432/check_in`.
 * Esquema propio que se borra al terminar.
 */
const url = process.env['CHECK_IN_TEST_DATABASE_URL'];
const DAY = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const SEGMENT = `EA102-${DAY.replaceAll('-', '')}`;

describe.skipIf(!url)('PostgresCheckInStore (concurrencia real)', () => {
  const schema = `prueba_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: url });
  let store: PostgresCheckInStore;
  let service: CheckInService;
  const checkIn = (bookingId: string, sagaId = randomUUID(), seat = '10A') =>
    service.register(bookingId, {
      sagaId,
      pnr: 'ABC234',
      passengers: [{ passengerId: 'PAX-1', passengerType: 'ADULT', firstName: 'Luis', lastName: 'Andrade', segments: [{ segmentId: SEGMENT, flightNumber: 'EA102', origin: 'UIO', destination: 'BOG', departureAt: `${DAY}T13:00:00-05:00`, cabinClass: 'ECONOMY', seat }] }],
    });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = new PostgresCheckInStore(`${url}?options=${encodeURIComponent(`-c search_path=${schema}`)}`);
    await store.init();
    service = new CheckInService(store);
  }, 60_000);

  afterAll(async () => {
    await store?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('8 reservas hacen check-in a la vez en el mismo vuelo: posiciones de abordaje 1–8, sin repetir', async () => {
    const bookings = Array.from({ length: 8 }, () => randomUUID());
    await Promise.all(bookings.map((bookingId, index) => checkIn(bookingId, randomUUID(), `${10 + index}A`)));
    const { rows } = await admin.query(`SELECT boarding_position FROM ${schema}.check_ins WHERE segment_id = $1 ORDER BY 1`, [SEGMENT]);
    expect(rows.map((row) => row.boarding_position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('K-1: anular mueve el check-in a voided_check_ins (historia), los pases dan 409; la compensación lo devuelve; la posición nunca se repite', async () => {
    const bookingId = randomUUID();
    await checkIn(bookingId, randomUUID(), '30A');
    const [{ boarding_position: posicion }] = (await admin.query(`SELECT boarding_position FROM ${schema}.check_ins WHERE booking_id = $1`, [bookingId])).rows;
    const sagaId = randomUUID();
    expect(await service.voidCheckIns(bookingId, { sagaId, reason: 'BOOKING_CANCELLED' })).toEqual({ bookingId, voided: 1 });
    expect((await admin.query(`SELECT count(*)::int AS n FROM ${schema}.check_ins WHERE booking_id = $1`, [bookingId])).rows[0].n).toBe(0);
    const historia = (await admin.query(`SELECT void_reason, void_saga_id, seat FROM ${schema}.voided_check_ins WHERE booking_id = $1`, [bookingId])).rows;
    expect(historia).toEqual([{ void_reason: 'BOOKING_CANCELLED', void_saga_id: sagaId, seat: '30A' }]);
    await expect(service.boardingPasses(bookingId)).rejects.toMatchObject({ problem: { code: 'BOARDING_PASS_NOT_AVAILABLE' } });
    expect(await service.voidCheckIns(bookingId, { sagaId, reason: 'BOOKING_CANCELLED' })).toEqual({ bookingId, voided: 1 }); // idempotente

    // Otra reserva hace check-in en el mismo vuelo: no recibe la posición del anulado.
    const otra = randomUUID();
    await checkIn(otra, randomUUID(), '31A');
    const [{ boarding_position: nueva }] = (await admin.query(`SELECT boarding_position FROM ${schema}.check_ins WHERE booking_id = $1`, [otra])).rows;
    expect(nueva).toBeGreaterThan(posicion);

    await service.restoreVoided(bookingId, sagaId);
    await service.restoreVoided(bookingId, sagaId);
    expect((await service.boardingPasses(bookingId)).boardingPasses).toHaveLength(1);
    expect((await admin.query(`SELECT count(*)::int AS n FROM ${schema}.voided_check_ins WHERE booking_id = $1`, [bookingId])).rows[0].n).toBe(0);
  });

  it('el mismo pasajero dos veces a la vez (sagas distintas): un solo check-in', async () => {
    const bookingId = randomUUID();
    const results = await Promise.allSettled([checkIn(bookingId), checkIn(bookingId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await service.state(bookingId)).items).toHaveLength(1);
  });
});
