import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ProblemDetailsException } from '@ecoairlines/shared';
import { PostgresPostSaleStore } from '../src/repositories/post-sale.store.js';
import { PostSaleService } from '../src/services/post-sale.service.js';

/**
 * PostgreSQL real (opcional): `POST_SALE_TEST_DATABASE_URL=postgres://post_sale_svc:dev-post-sale@localhost:5432/post_sale`.
 * Esquema propio que se borra al terminar.
 */
const url = process.env['POST_SALE_TEST_DATABASE_URL'];
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? (r.reason as ProblemDetailsException).problem?.code : 'OK');
const booking = () => ({
  bookingId: randomUUID(), status: 'CONFIRMED', channel: 'WEB' as const, currency: 'USD', seatedPassengers: 1,
  fares: [{ itineraryId: 'EA100-20261028', cabinClass: 'ECONOMY', fareBrand: 'BROTE', price: { currency: 'USD', baseFare: '100.00', taxes: '19.50', total: '119.50' }, isRefundable: false, isChangeable: true, changeFeeUsd: '50.00', departureAt: '2099-01-01T12:00:00.000Z', departed: false }],
});

describe.skipIf(!url)('PostgresPostSaleStore (concurrencia real)', () => {
  const schema = `prueba_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: url });
  let store: PostgresPostSaleStore;
  let service: PostSaleService;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = new PostgresPostSaleStore(`${url}?options=${encodeURIComponent(`-c search_path=${schema}`)}`);
    await store.init();
    service = new PostSaleService(store);
  }, 60_000);

  afterAll(async () => {
    await store?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('5 sagas consumen la misma cotización a la vez: una sola la usa', async () => {
    const context = booking();
    const quote = await service.createCancellationQuote(context);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => service.consumeCancellationQuote(randomUUID(), context.bookingId, quote.quoteId)));
    expect(results.map(codeOf).sort()).toEqual(['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND', 'OK']);
  });

  it('la misma oferta de cambio: consumir, liberar y volver a consumir persiste entre transacciones', async () => {
    const context = booking();
    const [offer] = await service.createDateChangeOffers(context, [{ replacedItineraryId: 'EA100-20261028', newItineraryId: 'EA100-20261029', segmentIds: ['EA100-20261029'], price: { currency: 'USD', baseFare: '110.00', taxes: '20.00', total: '130.00' } }]);
    const saga = randomUUID();
    await service.consumeDateChangeOffer(saga, context.bookingId, offer.changeOfferId);
    expect(await service.releaseDateChangeOffer(saga, offer.changeOfferId)).toBe(true);
    const results = await Promise.allSettled([1, 2].map(() => service.consumeDateChangeOffer(randomUUID(), context.bookingId, offer.changeOfferId)));
    expect(results.map(codeOf).sort()).toEqual(['NOT_FOUND', 'OK']);
  });

  it('CalculateCompensationRefund con el mismo sagaId, 4 veces a la vez: todas devuelven el mismo resultado', async () => {
    const sagaId = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => service.calculateCompensationRefund({ sagaId, reasonCode: 'FLIGHT_CANCELLED', booking: booking() })));
    expect(new Set(results.map((quote) => quote.quoteId)).size).toBe(1);
  });
});
