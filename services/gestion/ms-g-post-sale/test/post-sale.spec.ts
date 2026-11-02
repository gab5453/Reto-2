import 'reflect-metadata';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as soap from 'soap';
import { signJwt, type TokenUse, verifyJwt } from '@ecoairlines/shared';
import { PostSaleModule, setupApp } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { PostSaleService } from '../src/services/post-sale.service.js';

/** Pruebas de MS.G.PostSale (V2.7) con un CLIENTE SOAP real que se construye desde el `?wsdl` publicado. */
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const NS = 'http://ecoairlines.com/soap/post-sale/v1/types';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TOKEN_OPTIONS = { issuer: 'ecoairlines-identity', audience: 'ecoairlines' };
const token = (use: TokenUse, scope: string) => signJwt({ sub: 'ECOAIRLINES_ESB', token_use: use, scope }, privateKey, { ...TOKEN_OPTIONS, ttlSeconds: 600 }).token;
const ESB = token('service', 'ecoairlines:internal');

let app: NestExpressApplication;
let url: string;
let client: soap.Client;
let service: PostSaleService;

const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
const fare = (overrides: Any = {}) => ({
  itineraryId: 'EA100-20261028', cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', price: { currency: 'USD', baseFare: '100.00', taxes: '19.50', total: '119.50' },
  isRefundable: false, isChangeable: false, changeFeeUsd: '0.00', departureAt: soon, departed: false, ...overrides,
});
const booking = (fares: Any[] = [fare()], overrides: Any = {}) => ({ bookingId: randomUUID(), status: 'CONFIRMED', channel: 'BOOKING', partnerId: 'BOOKING_PROTOTIPO', currency: 'USD', seatedPassengers: 2, fare: fares, ...overrides });

/** Llamada SOAP con su CorrelationId; devuelve el resultado y las cabeceras SOAP de la respuesta. */
async function call(operation: string, args: Any, correlationId = `corr-postventa-${randomUUID().slice(0, 8)}`) {
  client.clearSoapHeaders();
  client.addSoapHeader(`<types:CorrelationId xmlns:types="${NS}">${correlationId}</types:CorrelationId>`);
  client.addSoapHeader(`<types:RequestId xmlns:types="${NS}">req-esb-1</types:RequestId>`);
  const [result, , header] = await (client as Any)[`${operation}Async`](args);
  return { result, header, correlationId };
}
/** El PostSaleFault de un soap:Fault. */
async function fault(promise: Promise<unknown>): Promise<Any> {
  try {
    await promise;
  } catch (error) {
    const body = (error as Any).root?.Envelope?.Body?.Fault;
    return { ...body?.detail?.PostSaleFault, faultcode: body?.faultcode, httpStatus: (error as Any).response?.status };
  }
  throw new Error('se esperaba un soap:Fault');
}

beforeAll(async () => {
  const verifier = { verify: async (jwt: string) => verifyJwt(jwt, () => publicKey, TOKEN_OPTIONS) };
  const moduleRef = await Test.createTestingModule({ imports: [PostSaleModule.register(loadConfig({ NODE_ENV: 'test' }), { verifier })] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  await setupApp(app);
  await app.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/soap/post-sale`;
  client = await soap.createClientAsync(`${url}?wsdl`, { endpoint: url });
  client.addHttpHeader('Authorization', `Bearer ${ESB}`);
  service = app.get(PostSaleService);
});
afterAll(() => app.close());

describe('contrato SOAP publicado', () => {
  it('el WSDL está en ?wsdl con sus 8 operaciones y el XSD importado se resuelve', async () => {
    const wsdl = await fetch(`${url}?wsdl`).then((r) => r.text());
    expect(wsdl).toContain('<wsdl:definitions name="PostSaleService"');
    expect((await fetch(url.replace('post-sale', 'ms-g-post-sale.xsd'))).status).toBe(200);
    const operations = Object.keys((client.describe() as Any).PostSaleService.PostSaleSoapPort).sort();
    expect(operations).toEqual(['CalculateCompensationRefund', 'ConsumeCancellationQuote', 'ConsumeDateChangeOffer', 'CreateCancellationQuote', 'CreateDateChangeOffers', 'GetBaggageOptions', 'ReleaseDateChangeOffer', 'ValidateBaggagePurchase']);
  });

  it('sin token → Fault UNAUTHORIZED (HTTP 401); token de partner → FORBIDDEN (403)', async () => {
    const anonymous = await soap.createClientAsync(`${url}?wsdl`, { endpoint: url });
    const none = await fault((anonymous as Any).GetBaggageOptionsAsync({ bookingId: randomUUID(), line: [] }));
    expect(none).toMatchObject({ code: 'UNAUTHORIZED', status: '401', faultcode: 'soap:Client', httpStatus: 401 });
    anonymous.addHttpHeader('Authorization', `Bearer ${token('partner', 'flights:read')}`);
    expect((await fault((anonymous as Any).GetBaggageOptionsAsync({ bookingId: randomUUID(), line: [] }))).code).toBe('FORBIDDEN');
  });

  it('las cabeceras SOAP de la respuesta traen el mismo CorrelationId y el RequestId de este servicio', async () => {
    const { header, correlationId } = await call('GetBaggageOptions', { bookingId: randomUUID(), line: [] }, 'corr-cabeceras-1');
    expect(correlationId).toBe('corr-cabeceras-1');
    expect(header).toMatchObject({ CorrelationId: 'corr-cabeceras-1', RequestId: expect.stringMatching(/^req-/) });
  });

  it('un error de datos → soap:Fault VALIDATION_FAILED con el correlationId', async () => {
    const error = await fault(call('ConsumeCancellationQuote', { sagaId: 'no-es-uuid', bookingId: randomUUID(), quoteId: randomUUID() }, 'corr-error-1'));
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: '400', correlationId: 'corr-error-1', faultcode: 'soap:Client', httpStatus: 500 });
    expect(error.invalidParam).toMatchObject({ name: 'sagaId' });
  });
});

describe('cancelación con cotización', () => {
  it('no reembolsable: devuelve solo los impuestos y la tarifa base es penalidad; vence en 15 minutos', async () => {
    const context = booking([fare(), fare({ itineraryId: 'EA101-20261030', isRefundable: true, price: { currency: 'USD', baseFare: '80.00', taxes: '15.00', total: '95.00' } })]);
    const { result } = await call('CreateCancellationQuote', { booking: context });
    expect(result.quote).toMatchObject({ bookingId: context.bookingId, isRefundable: false, refundAmount: '114.50', penaltyAmount: '100.00', penaltyWaived: false, percentage: 53.38, currency: 'USD' }); // 114,50 / 214,50 = 53,3799… (xs:decimal → número)
    expect(result.quote.unflownItineraryId).toEqual(['EA100-20261028', 'EA101-20261030']);
    const minutes = (Date.parse(result.quote.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
  });

  it('lo ya volado no cuenta; sin nada por volar → BOOKING_NOT_CANCELLABLE; no confirmada o ya cancelada → 409', async () => {
    const partly = await call('CreateCancellationQuote', { booking: booking([fare({ departed: true }), fare({ itineraryId: 'EA101-20261030', isRefundable: true })]) });
    expect(partly.result.quote).toMatchObject({ refundAmount: '119.50', percentage: 100, unflownItineraryId: ['EA101-20261030'] });
    expect((await fault(call('CreateCancellationQuote', { booking: booking([fare({ departed: true })]) }))).code).toBe('BOOKING_NOT_CANCELLABLE');
    expect(await fault(call('CreateCancellationQuote', { booking: booking(undefined, { status: 'TICKET_ISSUING' }) }))).toMatchObject({ code: 'BOOKING_NOT_CONFIRMED', status: '409' });
    expect((await fault(call('CreateCancellationQuote', { booking: booking(undefined, { status: 'CANCELLED' }) }))).code).toBe('ALREADY_CANCELLED');
  });

  it('consumir: una sola vez; el mismo sagaId lo repite; otra saga u otra reserva → NOT_FOUND (409); vencida → QUOTE_EXPIRED (410)', async () => {
    const context = booking();
    const { quoteId } = (await call('CreateCancellationQuote', { booking: context })).result.quote;
    const sagaId = randomUUID();
    const consumed = await call('ConsumeCancellationQuote', { sagaId, bookingId: context.bookingId, quoteId });
    expect(consumed.result.quote.quoteId).toBe(quoteId);
    expect((await call('ConsumeCancellationQuote', { sagaId, bookingId: context.bookingId, quoteId })).result.quote.quoteId).toBe(quoteId);
    expect(await fault(call('ConsumeCancellationQuote', { sagaId: randomUUID(), bookingId: context.bookingId, quoteId }))).toMatchObject({ code: 'NOT_FOUND', status: '409' });
    expect((await fault(call('ConsumeCancellationQuote', { sagaId: randomUUID(), bookingId: randomUUID(), quoteId }))).code).toBe('NOT_FOUND');

    const fresh = (await call('CreateCancellationQuote', { booking: context })).result.quote.quoteId;
    const realNow = service.now;
    service.now = () => Date.now() + 16 * 60_000;
    try {
      expect(await fault(call('ConsumeCancellationQuote', { sagaId: randomUUID(), bookingId: context.bookingId, quoteId: fresh }))).toMatchObject({ code: 'QUOTE_EXPIRED', status: '410' });
    } finally {
      service.now = realNow;
    }
  });
});

describe('cancelación sin cotización (CalculateCompensationRefund)', () => {
  const nonRefundable = () => booking([fare()]);
  const compensate = (reasonCode: string, context: Any, partnerAgreement?: Any, sagaId = randomUUID()) =>
    call('CalculateCompensationRefund', { sagaId, reasonCode, booking: context, ...(partnerAgreement ? { partnerAgreement } : {}) });

  it('FLIGHT_CANCELLED (D37): 100 % sin penalidad aunque la tarifa no sea reembolsable', async () => {
    const { result } = await compensate('FLIGHT_CANCELLED', nonRefundable());
    expect(result.quote).toMatchObject({ refundAmount: '119.50', penaltyAmount: '0.00', penaltyWaived: true, percentage: 100 });
    expect(result.quote).not.toHaveProperty('expiresAt');
  });

  it('SAGA_COMPENSATION (combo que falló) siempre sin penalidad, con o sin acuerdo de promociones (D42)', async () => {
    for (const agreement of [undefined, { partnerId: 'BOOKING_PROTOTIPO', allowsPromotions: false }, { partnerId: 'BOOKING_PROTOTIPO', allowsPromotions: true, validUntil: '2020-01-01' }]) {
      const { result } = await compensate('SAGA_COMPENSATION', nonRefundable(), agreement);
      expect(result.quote).toMatchObject({ refundAmount: '119.50', penaltyAmount: '0.00', penaltyWaived: true, percentage: 100 });
    }
  });

  it('las fechas del XML llegan como Date y se leen como fecha ISO (departureAt)', async () => {
    const { result } = await call('CreateCancellationQuote', { booking: booking([fare({ departureAt: '2026-10-28T12:00:00Z', departed: false })]) });
    expect(result.quote.unflownItineraryId).toEqual(['EA100-20261028']);
  });

  it('idempotente por sagaId; otro motivo → VALIDATION_FAILED; reserva no confirmada → BOOKING_NOT_CONFIRMED', async () => {
    const sagaId = randomUUID();
    const first = await compensate('FLIGHT_CANCELLED', nonRefundable(), undefined, sagaId);
    const again = await compensate('FLIGHT_CANCELLED', nonRefundable(), undefined, sagaId);
    expect(again.result.quote.quoteId).toBe(first.result.quote.quoteId);
    expect((await fault(compensate('CUSTOMER_REQUEST', nonRefundable()))).code).toBe('VALIDATION_FAILED');
    expect((await fault(compensate('FLIGHT_CANCELLED', booking(undefined, { status: 'FAILED' })))).code).toBe('BOOKING_NOT_CONFIRMED');
  });

  it('V2.10: un combo que falla ANTES de emitir los boletos (TICKET_ISSUING) también se compensa; la cotización del cliente no', async () => {
    const { result } = await compensate('SAGA_COMPENSATION', booking([fare()], { status: 'TICKET_ISSUING' }));
    expect(result.quote).toMatchObject({ refundAmount: '119.50', penaltyWaived: true });
    expect((await fault(call('CreateCancellationQuote', { booking: booking([fare()], { status: 'TICKET_ISSUING' }) }))).code).toBe('BOOKING_NOT_CONFIRMED');
    expect((await fault(compensate('SAGA_COMPENSATION', booking(undefined, { status: 'CANCELLED' })))).code).toBe('ALREADY_CANCELLED');
  });
});

describe('cambio de fecha', () => {
  const changeable = (overrides: Any = {}) => fare({ fareBrand: 'BROTE', isChangeable: true, changeFeeUsd: '50.00', ...overrides });
  const alternative = (id: string, base: string, taxes: string, replaced = 'EA100-20261028') => ({
    replacedItineraryId: replaced, newItineraryId: id, segmentId: [id], price: { currency: 'USD', baseFare: base, taxes, total: (Number(base) + Number(taxes)).toFixed(2) },
  });

  it('ofertas con priceDifference: diferencia con signo, cargo × pasajeros con asiento y saldo a favor no reembolsado', async () => {
    const context = booking([changeable()]);
    const { result } = await call('CreateDateChangeOffers', { booking: context, alternative: [alternative('EA100-20261029', '130.00', '22.00'), alternative('EA102-20261029', '90.00', '17.00')] });
    const [pricier, cheaper] = result.offer;
    expect(pricier.priceDifference).toMatchObject({ fareDifference: '30.00', taxDifference: '2.50', changeFee: '100.00', totalToPay: '132.50', currency: 'USD' });
    expect(cheaper.priceDifference).toMatchObject({ fareDifference: '-10.00', taxDifference: '-2.50', totalToPay: '100.00' });
    expect(pricier.replacement).toEqual([expect.objectContaining({ replacedItineraryId: 'EA100-20261028', newItineraryId: 'EA100-20261029', segmentId: ['EA100-20261029'] })]);
  });

  it('tarifa no cambiable → FARE_NOT_CHANGEABLE; itinerario que ya salió → FLIGHT_ALREADY_DEPARTED; sin alternativas → lista vacía', async () => {
    expect((await fault(call('CreateDateChangeOffers', { booking: booking([fare()]), alternative: [alternative('EA100-20261029', '100.00', '19.50')] }))).code).toBe('FARE_NOT_CHANGEABLE');
    expect((await fault(call('CreateDateChangeOffers', { booking: booking([changeable({ departed: true })]), alternative: [alternative('EA100-20261029', '100.00', '19.50')] }))).code).toBe('FLIGHT_ALREADY_DEPARTED');
    const empty = await call('CreateDateChangeOffers', { booking: booking([changeable()]) });
    expect(empty.result?.offer ?? []).toHaveLength(0);
  });

  it('ida y vuelta: combina las alternativas de cada itinerario (máximo 10)', async () => {
    const context = booking([changeable(), changeable({ itineraryId: 'EA101-20261030' })]);
    const outbound = Array.from({ length: 4 }, (_, i) => alternative(`EA10${i}-20261029`, '100.00', '19.50'));
    const inbound = Array.from({ length: 4 }, (_, i) => alternative(`EA11${i}-20261031`, '100.00', '19.50', 'EA101-20261030'));
    const { result } = await call('CreateDateChangeOffers', { booking: context, alternative: [...outbound, ...inbound] });
    expect(result.offer).toHaveLength(10);
    expect(result.offer[0].replacement).toHaveLength(2);
    expect(result.offer[0].priceDifference.changeFee).toBe('200.00');
  });

  it('consumir una vez (idempotente por saga), liberar como compensación y vencer a los 15 minutos', async () => {
    const context = booking([changeable()]);
    const offerId = (await call('CreateDateChangeOffers', { booking: context, alternative: [alternative('EA100-20261029', '100.00', '19.50')] })).result.offer[0].changeOfferId;
    const saga = randomUUID();
    await call('ConsumeDateChangeOffer', { sagaId: saga, bookingId: context.bookingId, changeOfferId: offerId });
    expect((await fault(call('ConsumeDateChangeOffer', { sagaId: randomUUID(), bookingId: context.bookingId, changeOfferId: offerId }))).code).toBe('NOT_FOUND');
    expect((await call('ReleaseDateChangeOffer', { sagaId: randomUUID(), changeOfferId: offerId })).result.released).toBe(false);
    expect((await call('ReleaseDateChangeOffer', { sagaId: saga, changeOfferId: offerId })).result.released).toBe(true);
    expect((await call('ReleaseDateChangeOffer', { sagaId: saga, changeOfferId: offerId })).result.released).toBe(false);
    await call('ConsumeDateChangeOffer', { sagaId: randomUUID(), bookingId: context.bookingId, changeOfferId: offerId });
    const later = (await call('CreateDateChangeOffers', { booking: context, alternative: [alternative('EA100-20261029', '100.00', '19.50')] })).result.offer[0].changeOfferId;
    const realNow = service.now;
    service.now = () => Date.now() + 16 * 60_000;
    try {
      expect(await fault(call('ConsumeDateChangeOffer', { sagaId: randomUUID(), bookingId: context.bookingId, changeOfferId: later }))).toMatchObject({ code: 'CHANGE_OFFER_EXPIRED', status: '410' });
    } finally {
      service.now = realNow;
    }
  });
});

describe('maletas extra', () => {
  const unitPrice = { currency: 'USD', baseFare: '35.00', taxes: '0.00', total: '35.00' };

  it('opciones solo de lo no volado, con lo que queda del máximo de 3', async () => {
    const { result } = await call('GetBaggageOptions', {
      bookingId: randomUUID(),
      line: [
        { passengerId: 'PAX-1', itineraryId: 'EA100-20261028', alreadyPurchased: 1, unitPrice, departed: false },
        { passengerId: 'PAX-1', itineraryId: 'EA101-20261020', alreadyPurchased: 0, unitPrice, departed: true },
      ],
    });
    const options = [result.option].flat();
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ passengerId: 'PAX-1', itineraryId: 'EA100-20261028', maxAllowed: '2', alreadyPurchased: '1' });
  });

  it('validar la compra: monto = precio × cantidad; pasarse de 3 → BAGGAGE_LIMIT_EXCEEDED (422); ya salió → 409', async () => {
    const line = { passengerId: 'PAX-1', itineraryId: 'EA100-20261028', alreadyPurchased: 1, unitPrice, departed: false };
    const { result } = await call('ValidateBaggagePurchase', { bookingId: randomUUID(), line, quantity: 2 });
    expect(result).toMatchObject({ amountToCharge: { currency: 'USD', total: '70.00' }, totalAfterPurchase: '3' });
    expect(await fault(call('ValidateBaggagePurchase', { bookingId: randomUUID(), line, quantity: 3 }))).toMatchObject({ code: 'BAGGAGE_LIMIT_EXCEEDED', status: '422' });
    expect((await fault(call('ValidateBaggagePurchase', { bookingId: randomUUID(), line: { ...line, departed: true }, quantity: 1 }))).code).toBe('FLIGHT_ALREADY_DEPARTED');
  });
});
