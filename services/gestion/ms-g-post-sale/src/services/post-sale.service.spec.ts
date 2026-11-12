import type { ProblemDetailsException } from '@ecoairlines/shared';
import type { BookingContext, CancellationQuote, DateChangeOffer } from '../domain/rules.js';
import type { PostSaleStore, PostSaleTx, Stored } from '../repositories/post-sale.store.js';
import { PostSaleService } from './post-sale.service.js';

/** PU-2 (Informacion_General/Pruebas.md §5.1.2): PostSaleService — cotizaciones y ofertas que vencen a los 15 min y se usan una vez. */

const AHORA = Date.parse('2026-12-01T12:00:00Z');
const problemOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem;
  }
};

let tx: { [K in keyof PostSaleTx]: ReturnType<typeof vi.fn> };
let service: PostSaleService;
beforeEach(() => {
  tx = { quote: vi.fn(), saveQuote: vi.fn(), offer: vi.fn(), saveOffer: vi.fn(), sagaResult: vi.fn().mockResolvedValue(undefined), saveSagaResult: vi.fn() };
  service = new PostSaleService({ transaction: vi.fn((work: (t: PostSaleTx) => unknown) => work(tx as unknown as PostSaleTx)) } as unknown as PostSaleStore);
  service.now = () => AHORA;
});

const reserva = (over: Partial<BookingContext> = {}): BookingContext => ({
  bookingId: 'b-1',
  status: 'CONFIRMED',
  channel: 'WEB',
  currency: 'USD',
  seatedPassengers: 1,
  fares: [
    {
      itineraryId: 'IDA',
      cabinClass: 'ECONOMY',
      fareBrand: 'BROTE',
      price: { currency: 'USD', baseFare: '100.00', taxes: '27.00', total: '127.00' },
      isRefundable: false,
      isChangeable: true,
      changeFeeUsd: '25.00',
      departureAt: '2026-12-10T08:00:00-05:00',
      departed: false,
    },
  ],
  ...over,
});
const cotizacion = (over: Partial<Stored<CancellationQuote>> = {}): Stored<CancellationQuote> => ({
  data: { quoteId: 'q-1', bookingId: 'b-1', isRefundable: false, refundAmount: '27.00', penaltyAmount: '100.00', penaltyWaived: false, percentage: '21.26', currency: 'USD', unflownItineraryIds: ['IDA'], expiresAt: new Date(AHORA + 60_000).toISOString() },
  status: 'AVAILABLE',
  sagaId: null,
  ...over,
});

describe('cotización de cancelación', () => {
  it('se guarda disponible y vence en 15 minutos', async () => {
    const quote = await service.createCancellationQuote(reserva());
    expect(quote).toMatchObject({ refundAmount: '27.00', penaltyAmount: '100.00', expiresAt: new Date(AHORA + 15 * 60_000).toISOString() });
    expect(tx.saveQuote).toHaveBeenCalledWith({ data: quote, status: 'AVAILABLE', sagaId: null });
  });
  it('una reserva no confirmada no se cotiza (y no se guarda nada)', async () => {
    expect((await problemOf(service.createCancellationQuote(reserva({ status: 'TICKET_ISSUING' }))))?.code).toBe('BOOKING_NOT_CONFIRMED');
    expect(tx.saveQuote).not.toHaveBeenCalled();
  });
  it('usarla la marca CONSUMED con la saga que la usó', async () => {
    tx.quote.mockResolvedValue(cotizacion());
    await service.consumeCancellationQuote('s-1', 'B-1', 'q-1');
    expect(tx.saveQuote).toHaveBeenCalledWith(expect.objectContaining({ status: 'CONSUMED', sagaId: 's-1' }));
  });
  it('la misma saga puede repetir el paso (idempotente) sin volver a guardar', async () => {
    tx.quote.mockResolvedValue(cotizacion({ status: 'CONSUMED', sagaId: 's-1' }));
    expect((await service.consumeCancellationQuote('s-1', 'b-1', 'q-1')).quoteId).toBe('q-1');
    expect(tx.saveQuote).not.toHaveBeenCalled();
  });
  it('otra saga no puede usar una cotización ya usada → NOT_FOUND (409)', async () => {
    tx.quote.mockResolvedValue(cotizacion({ status: 'CONSUMED', sagaId: 's-1' }));
    expect(await problemOf(service.consumeCancellationQuote('s-2', 'b-1', 'q-1'))).toMatchObject({ status: 409, code: 'NOT_FOUND' });
  });
  it('una cotización de otra reserva → NOT_FOUND', async () => {
    tx.quote.mockResolvedValue(cotizacion());
    expect((await problemOf(service.consumeCancellationQuote('s-1', 'otra', 'q-1')))?.code).toBe('NOT_FOUND');
  });
  it('una cotización vencida → QUOTE_EXPIRED (410)', async () => {
    tx.quote.mockResolvedValue(cotizacion({ data: { ...cotizacion().data, expiresAt: new Date(AHORA).toISOString() } }));
    expect(await problemOf(service.consumeCancellationQuote('s-1', 'b-1', 'q-1'))).toMatchObject({ status: 410, code: 'QUOTE_EXPIRED' });
  });
});

describe('reembolso de compensación (sin cotización, D42)', () => {
  it('siempre sin penalidad y se guarda por saga', async () => {
    const quote = await service.calculateCompensationRefund({ sagaId: 's-1', reasonCode: 'FLIGHT_CANCELLED', booking: reserva() });
    expect(quote).toMatchObject({ refundAmount: '127.00', penaltyWaived: true });
    expect(tx.saveSagaResult).toHaveBeenCalledWith('compensation:s-1', quote);
  });
  it('repetida devuelve el resultado guardado', async () => {
    tx.sagaResult.mockResolvedValue({ quoteId: 'guardada' });
    expect((await service.calculateCompensationRefund({ sagaId: 's-1', reasonCode: 'SAGA_COMPENSATION', booking: reserva() })).quoteId).toBe('guardada');
    expect(tx.saveSagaResult).not.toHaveBeenCalled();
  });
  it('si dos llamadas simultáneas guardan, ambas devuelven el que quedó primero', async () => {
    tx.sagaResult.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ quoteId: 'la-primera' });
    expect((await service.calculateCompensationRefund({ sagaId: 's-1', reasonCode: 'FLIGHT_CANCELLED', booking: reserva() })).quoteId).toBe('la-primera');
  });
});

describe('ofertas de cambio de fecha', () => {
  const alternativa = { replacedItineraryId: 'IDA', newItineraryId: 'N', segmentIds: ['N'], price: { currency: 'USD', baseFare: '120.00', taxes: '30.00', total: '150.00' } };
  const oferta = (over: Partial<Stored<DateChangeOffer>> = {}): Stored<DateChangeOffer> => ({
    data: { changeOfferId: 'c-1', bookingId: 'b-1', expiresAt: new Date(AHORA + 60_000).toISOString(), replacements: [alternativa], priceDifference: { fareDifference: '20.00', taxDifference: '3.00', changeFee: '25.00', totalToPay: '48.00', currency: 'USD' } },
    status: 'AVAILABLE',
    sagaId: null,
    ...over,
  });

  it('crea una oferta por alternativa, cada una guardada y con vencimiento', async () => {
    const offers = await service.createDateChangeOffers(reserva(), [alternativa, { ...alternativa, newItineraryId: 'M' }]);
    expect(offers).toHaveLength(2);
    expect(tx.saveOffer).toHaveBeenCalledTimes(2);
    expect(offers[0].priceDifference.totalToPay).toBe('48.00');
  });
  it('una oferta vencida → CHANGE_OFFER_EXPIRED', async () => {
    tx.offer.mockResolvedValue(oferta({ data: { ...oferta().data, expiresAt: new Date(AHORA - 1).toISOString() } }));
    expect((await problemOf(service.consumeDateChangeOffer('s-1', 'b-1', 'c-1')))?.code).toBe('CHANGE_OFFER_EXPIRED');
  });
  it('compensar: la oferta que usó esa saga vuelve a estar disponible', async () => {
    tx.offer.mockResolvedValue(oferta({ status: 'CONSUMED', sagaId: 's-1' }));
    expect(await service.releaseDateChangeOffer('s-1', 'c-1')).toBe(true);
    expect(tx.saveOffer).toHaveBeenCalledWith(expect.objectContaining({ status: 'AVAILABLE', sagaId: null }));
  });
  it('compensar no libera la oferta que usó otra saga', async () => {
    tx.offer.mockResolvedValue(oferta({ status: 'CONSUMED', sagaId: 's-2' }));
    expect(await service.releaseDateChangeOffer('s-1', 'c-1')).toBe(false);
    expect(tx.saveOffer).not.toHaveBeenCalled();
  });
});
