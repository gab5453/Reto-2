import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ProblemDetailsException } from '@ecoairlines/shared';
import { isValidEcuadorianId } from '../src/domain/rules.js';
import { PostgresBookingsStore } from '../src/repositories/postgres.store.js';
import { BookingsService, type CreateBookingCommand } from '../src/services/bookings.service.js';

/**
 * Concurrencia contra PostgreSQL real (opcional): `BOOKINGS_TEST_DATABASE_URL=postgres://bookings_svc:dev-bookings@localhost:5432/bookings`.
 * Esquema propio que se borra al terminar.
 */
const url = process.env['BOOKINGS_TEST_DATABASE_URL'];
const DAY = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
const cedula = (prefix: string) => `${prefix}${[...Array(10).keys()].find((d) => isValidEcuadorianId(`${prefix}${d}`))}`;
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? (r.reason as ProblemDetailsException).problem?.code ?? String(r.reason) : 'OK');
const itinerary = { itineraryId: `EA100-${DAY.replaceAll('-', '')}`, segments: [{ segmentId: `EA100-${DAY.replaceAll('-', '')}`, flightNumber: 'EA100', departure: { iataCode: 'UIO', at: `${DAY}T07:00:00-05:00` }, arrival: { iataCode: 'GYE', at: `${DAY}T07:50:00-05:00` } }] };
const money = { currency: 'USD', baseFare: '100.00', taxes: '19.50', total: '119.50' };

describe.skipIf(!url)('PostgresBookingsStore (concurrencia real)', () => {
  const schema = `prueba_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: url });
  let store: PostgresBookingsStore;
  let service: BookingsService;

  /** Claim + comando de creación (cada uno con su referencia y su hold). */
  async function command(documentNumber: string, overrides: Partial<CreateBookingCommand> = {}): Promise<CreateBookingCommand> {
    const sagaId = randomUUID();
    const reference = `pi_${randomUUID().slice(0, 12)}`;
    await service.claimPayment({ sagaId, paymentReference: reference, provider: 'AIRLINE_DIRECT', operation: 'BOOKING', expectedAmount: money });
    return {
      bookingId: randomUUID(), sagaId, holdId: randomUUID(), offerId: itinerary.itineraryId, passengersBreakdown: { adults: 1 },
      passengers: [{ passengerId: 'PAX-1', passengerType: 'ADULT', firstName: 'Ana', lastName: 'Ruiz', documentType: 'NATIONAL_ID', documentNumber, nationality: 'EC', birthDate: '1990-01-01', gender: 'F', contact: { email: 'a@x.com', phone: '+593990000000' } }],
      itineraries: [itinerary], fares: [{ itineraryId: itinerary.itineraryId, cabinClass: 'ECONOMY', fareBrand: 'BROTE', segmentIds: [itinerary.segments[0]!.segmentId], price: money, isRefundable: false, isChangeable: true }],
      grandTotal: money, payment: { paymentReference: reference, provider: 'AIRLINE_DIRECT' }, ...overrides,
    };
  }

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = new PostgresBookingsStore(`${url}?options=${encodeURIComponent(`-c search_path=${schema}`)}`);
    await store.init();
    service = new BookingsService(store);
  }, 60_000);

  afterAll(async () => {
    await store?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('la misma referencia de pago desde 5 sagas a la vez: se registra una sola vez', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.claimPayment({ sagaId: randomUUID(), paymentReference: 'PAY-BKP-CARRERA-01', provider: 'BOOKING_PROTOTIPO', operation: 'BOOKING', expectedAmount: money })),
    );
    expect(results.map(codeOf).sort()).toEqual(['OK', 'PAYMENT_REFERENCE_INVALID', 'PAYMENT_REFERENCE_INVALID', 'PAYMENT_REFERENCE_INVALID', 'PAYMENT_REFERENCE_INVALID']);
  });

  it('dos reservas a la vez con el mismo documento en el mismo vuelo: una gana; la otra no deja nada a medias', async () => {
    const doc = cedula('171003420');
    const [a, b] = await Promise.all([command(doc), command(doc)]);
    const results = await Promise.allSettled([service.create(a, 'owner-a'), service.create(b, 'owner-b')]);
    expect(results.map(codeOf).sort()).toEqual(['OK', 'PASSENGER_ALREADY_ON_FLIGHT']);
    const loser = results[0]!.status === 'rejected' ? a : b;
    const { rows } = await admin.query(`SELECT booking_id FROM ${schema}.payment_records WHERE payment_reference = $1`, [loser.payment.paymentReference]);
    expect(rows[0].booking_id).toBeNull(); // ROLLBACK: su referencia no quedó unida a nada
    const { rows: bookings } = await admin.query(`SELECT count(*)::int AS n FROM ${schema}.bookings WHERE booking_id = $1`, [loser.bookingId]);
    expect(bookings[0].n).toBe(0);
  });

  it('el mismo bookingId dos veces a la vez (reintento de la saga): una reserva, el segundo recibe la existente', async () => {
    const cmd = await command(cedula('171003421'));
    const [first, second] = await Promise.all([service.create(cmd, 'owner-c'), service.create(cmd, 'owner-c')]);
    expect(first.booking.pnr).toBe(second.booking.pnr);
    expect([first.created, second.created].sort()).toEqual([false, true]);
  });

  it('la reserva y el pago persisten como JSON y se vuelven a leer igual', async () => {
    const cmd = await command(cedula('171003422'));
    const { booking } = await service.create(cmd, 'partner:BOOKING_PROTOTIPO:u1');
    const issued = await service.issueTickets(booking.bookingId, {});
    expect(issued).toMatchObject({ status: 'CONFIRMED', issued: 1 });
    const read = await service.get(booking.bookingId, { ownerId: 'partner:BOOKING_PROTOTIPO:u1' });
    expect(read).toMatchObject({ status: 'CONFIRMED', channel: 'BOOKING', assistance: [] });
    expect((await service.flightBookings('EA100', DAY)).items.map((item) => item.bookingId)).toContain(booking.bookingId);
  });
});
