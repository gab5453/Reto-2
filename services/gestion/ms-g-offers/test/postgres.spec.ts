import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ProblemDetailsException } from '@ecoairlines/shared';
import { addDays, localDate } from '../src/domain/catalog.js';
import { PostgresOffersStore } from '../src/repositories/postgres.store.js';
import { CatalogService } from '../src/services/catalog.service.js';
import { HoldsService } from '../src/services/holds.service.js';
import { InventoryService } from '../src/services/inventory.service.js';

/**
 * Concurrencia contra PostgreSQL real (opcional): `OFFERS_TEST_DATABASE_URL=postgres://offers_svc:dev-offers@localhost:5432/offers`
 * con `npm run infra:up`. En memoria las transacciones van en fila; aquí corren de verdad en paralelo, así que esta es la
 * prueba de D34 (sin sobreventa ni asientos duplicados). Usa un esquema propio que borra al terminar.
 */
const url = process.env['OFFERS_TEST_DATABASE_URL'];
const DAY = addDays(localDate(Date.now()), 2);
const SEGMENT = `EA102-${DAY.replaceAll('-', '')}`;
const codeOf = (result: PromiseSettledResult<unknown>) => (result.status === 'rejected' ? (result.reason as ProblemDetailsException).problem?.code : 'OK');

describe.skipIf(!url)('PostgresOffersStore (concurrencia real)', () => {
  const schema = `prueba_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: url });
  let store: PostgresOffersStore;
  let holds: HoldsService;
  let inventory: InventoryService;
  let catalog: CatalogService;

  const hold = (adults: number, cabinClass: 'ECONOMY' | 'BUSINESS' = 'BUSINESS', ttlMinutes?: number) =>
    holds.create({ offerId: SEGMENT, selections: [{ itineraryId: SEGMENT, cabinClass, fareBrand: cabinClass === 'BUSINESS' ? 'DOSEL' : 'SEMILLA' }], passengers: { adults }, ownerId: 'u', ttlMinutes });
  const businessCounts = async () => (await store.transaction((tx) => tx.inventory(SEGMENT))).find((row) => row.cabinClass === 'BUSINESS')!;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = new PostgresOffersStore(`${url}?options=${encodeURIComponent(`-c search_path=${schema}`)}`);
    await store.init();
    holds = new HoldsService(store);
    inventory = new InventoryService(store, holds);
    catalog = new CatalogService(store);
    await inventory.publishTimetable({
      publishId: 'p1',
      from: DAY,
      to: DAY,
      flights: [{ flightNumber: 'EA102', date: DAY, routeId: 'EA102-EA103', origin: 'UIO', destination: 'BOG', departureAt: `${DAY}T13:00:00-05:00`, arrivalAt: `${DAY}T14:25:00-05:00`, aircraftType: 'Airbus A320neo', registration: 'HC-N01' }],
    });
  }, 60_000);

  afterAll(async () => {
    await store?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('10 holds simultáneos de 2 por 12 cupos de Business: exactamente 6 ganan y nunca hay sobreventa', async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => hold(2)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    expect(new Set(results.filter((r) => r.status === 'rejected').map(codeOf))).toEqual(new Set(['OFFER_NO_LONGER_AVAILABLE']));
    const counts = await businessCounts();
    expect(counts.counts.HELD).toBe(12);
    const search = await catalog.search([{ origin: 'UIO', destination: 'BOG', departureDate: DAY }], { adults: 1 });
    expect(search.offers[0]!.itineraries[0]!.pricingOptions.find((p) => p.cabinClass === 'BUSINESS')!.availableSeats).toBe(0);
  });

  it('liberar el mismo hold dos veces a la vez devuelve sus cupos una sola vez', async () => {
    const all = await store.transaction((tx) => tx.activeHoldsOn(SEGMENT));
    const target = all[0]!;
    await Promise.all([holds.release(target.holdId), holds.release(target.holdId), holds.release(target.holdId)]);
    expect((await businessCounts()).counts.HELD).toBe(10);
  });

  it('dos reservas por el mismo asiento en paralelo: una gana y la otra recibe SEAT_TAKEN', async () => {
    const [a, b] = await Promise.all([hold(1, 'ECONOMY'), hold(1, 'ECONOMY')]);
    const take = (holdId: string, bookingId: string) =>
      holds.consume({ holdId, bookingId, ownerId: 'u', passengers: [{ passengerId: 'x', passengerType: 'ADULT', requestedSeats: [{ segmentId: SEGMENT, seatNumber: '15C' }] }] });
    const results = await Promise.allSettled([take(a.holdId, 'b-a'), take(b.holdId, 'b-b')]);
    expect(results.map(codeOf).sort()).toEqual(['OK', 'SEAT_TAKEN']);
    // El perdedor no quedó a medias: su hold sigue HELD y sus cupos siguen retenidos (ROLLBACK).
    const loser = results[0]!.status === 'rejected' ? a : b;
    expect((await holds.get(loser.holdId)).status).toBe('HELD');
  });

  it('asientos automáticos simultáneos: cada pasajero recibe uno distinto', async () => {
    const created = await Promise.all(Array.from({ length: 6 }, () => hold(1, 'ECONOMY')));
    const seats = await Promise.all(
      created.map((h, index) => holds.consume({ holdId: h.holdId, bookingId: `auto-${index}`, ownerId: 'u', passengers: [{ passengerId: 'x', passengerType: 'ADULT', requestedSeats: [] }] })),
    );
    const numbers = seats.flatMap((result) => result.seats.map((seat) => seat.seatNumber));
    expect(new Set(numbers).size).toBe(6);
  });

  it('el stock pendiente guarda el último valor y solo se marca enviado si no cambió mientras viajaba', async () => {
    const [row] = (await store.pendingStock(new Date().toISOString(), 100)).filter((r) => r.segmentId === SEGMENT && r.cabinClass === 'BUSINESS');
    expect(row!.units).toBe(2);
    await hold(1);
    await store.markStockPushed(SEGMENT, 'BUSINESS', row!.version, new Date().toISOString());
    const [after] = (await store.pendingStock(new Date().toISOString(), 100)).filter((r) => r.segmentId === SEGMENT && r.cabinClass === 'BUSINESS');
    expect(after).toMatchObject({ pending: true, units: 1 });
  });

  // Con la suite completa en paralelo y Docker encendido puede pasar de 5 s (sola tarda < 1 s).
  it('V2.11 — outbox: dos réplicas del relé toman los eventos a la vez y cada uno sale una sola vez, en orden', async () => {
    const other = new PostgresOffersStore(`${url}?options=${encodeURIComponent(`-c search_path=${schema}`)}`);
    for (let i = 0; i < 6; i++) await hold(1, 'ECONOMY');
    const [a, b] = await Promise.all([store.claimOutbox(4, 30_000), other.claimOutbox(4, 30_000)]);
    const ids = [...a, ...b].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const all = (await store.outbox()).filter((e) => !e.publishedAt);
    expect(ids.length).toBe(Math.min(8, all.length));
    const first = a.length ? a : b;
    const order = all.map((e) => e.id);
    const positions = first.map((e) => order.indexOf(e.id));
    expect(positions).toEqual(positions.toSorted((x, y) => x - y));
    for (const e of [...a, ...b]) await store.markOutboxPublished(e.id, new Date().toISOString());
    expect((await other.claimOutbox(100, 30_000)).some((e) => ids.includes(e.id))).toBe(false);
    await other.close();
  }, 30_000);
});
