import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import * as soap from 'soap';
import {
  INTERNAL_SCOPE,
  isValidId,
  newCorrelationId,
  newRequestId,
  ProblemDetailsException,
  runWithCorrelation,
  scopesOf,
  type TokenVerifier,
} from '@ecoairlines/shared';
import type { Alternative, BaggageLine, BookingContext, CancellationQuote, DateChangeOffer, Money, PurchasedFare } from '../domain/rules.js';
import type { PostSaleService } from '../services/post-sale.service.js';

/**
 * Servidor SOAP 1.1 document/literal de MS.G.PostSale (contract/ms-g-post-sale.wsdl + .xsd, sin cambios), en
 * `/soap/post-sale` y con el WSDL en `?wsdl` (el XSD importado se sirve al lado, en `/soap/ms-g-post-sale.xsd`).
 * - Autenticación: `Authorization: Bearer` con el token de servicio del ESB (D41), en la cabecera HTTP.
 * - Cabeceras SOAP (contrato v2 §6): `CorrelationId` (sin cambios) y `RequestId` en la petición y en la respuesta.
 * - Errores: `soap:Fault` (soap:Client de negocio o datos, soap:Server en INTERNAL_ERROR) con `detail/types:PostSaleFault`.
 */
export const SOAP_PATH = '/soap/post-sale';
const TYPES_NS = 'http://ecoairlines.com/soap/post-sale/v1/types';

export function findContractFile(file: string, from = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'contract', file);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No se encontró contract/${file}`);
}

type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type SoapRequest = Request & { postSale?: { correlationId: string; requestId: string } };

const escape = (value: string) => value.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);
const bool = (value: unknown) => value === true || value === 'true' || value === '1';
const text = (value: unknown) => (value === undefined || value === null ? undefined : typeof value === 'object' && '$value' in (value) ? String((value).$value) : String(value));
/** `xs:date` / `xs:dateTime`: la librería los entrega como `Date`; aquí siempre texto ISO (sin depender de la zona del proceso). */
const isoDate = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const invalid = (name: string, reason: string) => new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La petición SOAP no es válida.', invalidParams: [{ name, reason }] });
function uuid(value: unknown, name: string): string {
  const id = text(value)?.toLowerCase();
  if (!id || !UUID.test(id)) throw invalid(name, 'debe ser un UUID');
  return id;
}

const money = (value: Args): Money => ({
  currency: String(value['currency']),
  ...(value['baseFare'] !== undefined ? { baseFare: Number(value['baseFare']).toFixed(2) } : {}),
  ...(value['taxes'] !== undefined ? { taxes: Number(value['taxes']).toFixed(2) } : {}),
  total: Number(value['total']).toFixed(2),
});

function bookingContext(value: Args | undefined): BookingContext {
  if (!value) throw invalid('booking', 'obligatorio');
  const fares = list<Args>(value['fare']).map(
    (fare): PurchasedFare => ({
      itineraryId: String(fare['itineraryId']),
      cabinClass: String(fare['cabinClass']),
      fareBrand: String(fare['fareBrand']),
      price: money(fare['price']),
      isRefundable: bool(fare['isRefundable']),
      isChangeable: bool(fare['isChangeable']),
      changeFeeUsd: Number(fare['changeFeeUsd'] ?? 0).toFixed(2),
      departureAt: isoDate(fare['departureAt']),
      departed: bool(fare['departed']),
    }),
  );
  if (!fares.length) throw invalid('booking.fare', 'al menos una tarifa');
  const seated = Number(value['seatedPassengers']);
  if (!Number.isInteger(seated) || seated < 1) throw invalid('booking.seatedPassengers', 'entero positivo');
  return {
    bookingId: uuid(value['bookingId'], 'booking.bookingId'),
    status: String(value['status']),
    channel: value['channel'] === 'BOOKING' ? 'BOOKING' : 'WEB',
    ...(value['partnerId'] ? { partnerId: String(value['partnerId']) } : {}),
    currency: String(value['currency']),
    seatedPassengers: seated,
    fares,
  };
}

const line = (value: Args): BaggageLine => ({
  passengerId: String(value['passengerId']),
  itineraryId: String(value['itineraryId']),
  alreadyPurchased: Number(value['alreadyPurchased'] ?? 0),
  unitPrice: money(value['unitPrice']),
  departed: bool(value['departed']),
});

const quoteXml = (quote: CancellationQuote) => ({
  quoteId: quote.quoteId,
  bookingId: quote.bookingId,
  isRefundable: quote.isRefundable,
  refundAmount: quote.refundAmount,
  penaltyAmount: quote.penaltyAmount,
  penaltyWaived: quote.penaltyWaived,
  percentage: quote.percentage,
  currency: quote.currency,
  unflownItineraryId: quote.unflownItineraryIds,
  ...(quote.expiresAt ? { expiresAt: quote.expiresAt } : {}),
});

const offerXml = (offer: DateChangeOffer) => ({
  changeOfferId: offer.changeOfferId,
  bookingId: offer.bookingId,
  expiresAt: offer.expiresAt,
  replacement: offer.replacements.map((r) => ({ replacedItineraryId: r.replacedItineraryId, newItineraryId: r.newItineraryId, segmentId: r.segmentIds, price: r.price })),
  priceDifference: offer.priceDifference,
});

/** `soap:Fault` con el PostSaleFault del XSD en `detail` (XML crudo, con el espacio de nombres de los tipos). */
function soapFault(error: unknown, correlationId: string) {
  const problem = error instanceof ProblemDetailsException ? error.problem : { status: 500, code: 'INTERNAL_ERROR', title: 'Error interno.' };
  const detail = 'detail' in problem && problem.detail ? `<types:detail>${escape(String(problem.detail))}</types:detail>` : '';
  const params = ('invalidParams' in problem ? (problem.invalidParams ?? []) : [])
    .map((p: { name: string; reason: string }) => `<types:invalidParam><types:name>${escape(p.name)}</types:name><types:reason>${escape(p.reason)}</types:reason></types:invalidParam>`)
    .join('');
  return {
    Fault: {
      faultcode: problem.status >= 500 ? 'soap:Server' : 'soap:Client',
      faultstring: problem.title,
      detail: {
        $xml:
          `<types:PostSaleFault xmlns:types="${TYPES_NS}"><types:code>${problem.code}</types:code><types:status>${problem.status}</types:status>` +
          `<types:title>${escape(problem.title)}</types:title>${detail}<types:correlationId>${escape(correlationId)}</types:correlationId>` +
          `<types:timestamp>${new Date().toISOString()}</types:timestamp>${params}</types:PostSaleFault>`,
      },
      statusCode: problem.status === 401 || problem.status === 403 ? problem.status : 500,
    },
  };
}

/** Monta el servicio SOAP en la app de NestJS; resuelve cuando la librería terminó de leer el WSDL (antes de `app.init()`). */
export async function mountSoap(app: NestExpressApplication, service: PostSaleService, verifier: TokenVerifier): Promise<soap.Server> {
  const wsdlPath = findContractFile('ms-g-post-sale.wsdl');
  const xsd = readFileSync(findContractFile('ms-g-post-sale.xsd'), 'utf8');
  const express = app.getHttpAdapter().getInstance();

  // El XSD que importa el WSDL (schemaLocation relativo a `/soap/post-sale?wsdl`).
  express.get('/soap/ms-g-post-sale.xsd', (_req: Request, res: Response) => {
    res.type('application/xml').send(xsd);
  });

  // Token de servicio del ESB en los POST; el WSDL y el XSD son públicos (los necesita el cliente para construirse).
  express.use(SOAP_PATH, (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') return next();
    const header = req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const correlationId = req.header('x-correlation-id') ?? newCorrelationId();
    const reject = (status: 401 | 403, title: string) => {
      const fault = soapFault(new ProblemDetailsException({ status, code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', title }), correlationId).Fault;
      res
        .status(status)
        .type('text/xml')
        .send(
          `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault>` +
            `<faultcode>${fault.faultcode}</faultcode><faultstring>${escape(fault.faultstring)}</faultstring><detail>${fault.detail.$xml}</detail></soap:Fault></soap:Body></soap:Envelope>`,
        );
    };
    if (!token) return reject(401, 'Se requiere el token de servicio del ESB.');
    verifier
      .verify(token)
      .then((claims) => (claims.token_use === 'service' && scopesOf(claims).includes(INTERNAL_SCOPE) ? next() : reject(403, 'Solo el ESB puede llamar a este servicio.')))
      .catch(() => reject(401, 'El token no es válido o venció.'));
  });

  /** Cada operación corre con el CorrelationId de la cabecera SOAP (o el HTTP, o uno nuevo). */
  const operation =
    (handler: (args: Args) => unknown) =>
    async (args: Args, _callback: unknown, _headers: unknown, req: SoapRequest) => {
      const context = req.postSale ?? { correlationId: newCorrelationId(), requestId: newRequestId() };
      try {
        return await runWithCorrelation(context, () => Promise.resolve(handler(args)));
      } catch (error) {
        // node-soap exige lanzar el objeto `{ Fault }` tal cual (no un Error) para responder un SOAP Fault.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw soapFault(error, context.correlationId);
      }
    };

  const services = {
    PostSaleService: {
      PostSaleSoapPort: {
        CreateCancellationQuote: operation(async (args) => ({ quote: quoteXml(await service.createCancellationQuote(bookingContext(args['booking']))) })),
        ConsumeCancellationQuote: operation(async (args) => ({
          quote: quoteXml(await service.consumeCancellationQuote(uuid(args['sagaId'], 'sagaId'), uuid(args['bookingId'], 'bookingId'), uuid(args['quoteId'], 'quoteId'))),
        })),
        CalculateCompensationRefund: operation(async (args) => {
          const reasonCode = text(args['reasonCode']);
          if (reasonCode !== 'FLIGHT_CANCELLED' && reasonCode !== 'SAGA_COMPENSATION') throw invalid('reasonCode', 'FLIGHT_CANCELLED o SAGA_COMPENSATION');
          const agreement = args['partnerAgreement'] as Args | undefined;
          const quote = await service.calculateCompensationRefund({
            sagaId: uuid(args['sagaId'], 'sagaId'),
            reasonCode,
            booking: bookingContext(args['booking']),
            ...(agreement ? { partnerAgreement: { partnerId: String(agreement['partnerId']), allowsPromotions: bool(agreement['allowsPromotions']), ...(agreement['validUntil'] ? { validUntil: isoDate(agreement['validUntil']).slice(0, 10) } : {}) } } : {}),
          });
          return { quote: quoteXml(quote) };
        }),
        CreateDateChangeOffers: operation(async (args) => {
          const alternatives = list<Args>(args['alternative']).map(
            (a): Alternative => ({ replacedItineraryId: String(a['replacedItineraryId']), newItineraryId: String(a['newItineraryId']), segmentIds: list<unknown>(a['segmentId']).map(String), price: money(a['price']) }),
          );
          const offers = await service.createDateChangeOffers(bookingContext(args['booking']), alternatives);
          return offers.length ? { offer: offers.map(offerXml) } : {};
        }),
        ConsumeDateChangeOffer: operation(async (args) => ({
          offer: offerXml(await service.consumeDateChangeOffer(uuid(args['sagaId'], 'sagaId'), uuid(args['bookingId'], 'bookingId'), uuid(args['changeOfferId'], 'changeOfferId'))),
        })),
        ReleaseDateChangeOffer: operation(async (args) => ({ released: await service.releaseDateChangeOffer(uuid(args['sagaId'], 'sagaId'), uuid(args['changeOfferId'], 'changeOfferId')) })),
        GetBaggageOptions: operation((args) => {
          uuid(args['bookingId'], 'bookingId');
          const options = service.getBaggageOptions(list<Args>(args['line']).map(line));
          return options.length ? { option: options } : {};
        }),
        ValidateBaggagePurchase: operation((args) => {
          uuid(args['bookingId'], 'bookingId');
          const quantity = Number(args['quantity']);
          if (!Number.isInteger(quantity) || quantity < 1) throw invalid('quantity', 'entero positivo');
          return service.validateBaggagePurchase(line(args['line']), quantity);
        }),
      },
    },
  };

  const server = await new Promise<soap.Server>((resolve, reject) => {
    const created = soap.listen(express, {
      path: SOAP_PATH,
      services,
      xml: readFileSync(wsdlPath, 'utf8'),
      uri: wsdlPath,
      callback: (error: unknown) => (error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve(created)),
    });
  });

  // Cabeceras SOAP de la respuesta: el mismo CorrelationId y el RequestId de este servicio. La librería las arma ANTES de
  // ejecutar la operación, así que aquí se decide el contexto y se deja en la petición para la operación.
  server.addSoapHeader((_method: string, _args: unknown, headers: Args | undefined, req: SoapRequest, res: Response) => {
    const incoming = text(headers?.['CorrelationId']) ?? req.header('x-correlation-id');
    req.postSale = { correlationId: isValidId(incoming) ? incoming : newCorrelationId(), requestId: newRequestId() };
    res.setHeader('X-Correlation-Id', req.postSale.correlationId);
    return (
      `<types:CorrelationId xmlns:types="${TYPES_NS}">${escape(req.postSale.correlationId)}</types:CorrelationId>` +
      `<types:RequestId xmlns:types="${TYPES_NS}">${escape(req.postSale.requestId)}</types:RequestId>`
    );
  });
  return server;
}
