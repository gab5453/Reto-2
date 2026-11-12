import * as soap from 'soap';
import { CORRELATION_HEADER, currentCorrelation, newCorrelationId, newRequestId, ProblemDetailsException, REQUEST_ID_HEADER } from '@ecoairlines/shared';
import { CircuitBreaker } from './circuit-breaker.js';
import { findContractFile } from './contract-files.js';
import type { TokenSource } from './service-token.js';

const TYPES_NS = 'http://ecoairlines.com/soap/post-sale/v1/types';
const xmlEscape = (value: string) => value.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
export const SOAP_PATH = '/soap/post-sale';
export const POST_SALE_OPERATIONS = [
  'CreateCancellationQuote',
  'ConsumeCancellationQuote',
  'CalculateCompensationRefund',
  'CreateDateChangeOffers',
  'ConsumeDateChangeOffer',
  'ReleaseDateChangeOffer',
  'GetBaggageOptions',
  'ValidateBaggagePurchase',
] as const;
export type PostSaleOperation = (typeof POST_SALE_OPERATIONS)[number];

type Args = Record<string, unknown>;
type SoapError = Error & { root?: { Envelope?: { Body?: { Fault?: { faultstring?: string; detail?: { PostSaleFault?: Args } } } } }; response?: { status?: number } };

/**
 * Cliente SOAP de MS.G.PostSale. El WSDL se lee UNA vez del contrato (`contract/ms-g-post-sale.wsdl`, con su XSD al lado) y por
 * cada llamada se crea un cliente liviano sobre ese WSDL ya interpretado: las cabeceras SOAP `CorrelationId` (sin cambios) y
 * `RequestId` (nuevo por salto) son de esa llamada y no se mezclan entre llamadas simultáneas. El token de servicio va en la
 * cabecera HTTP `Authorization`. Un `soap:Fault` vuelve a ser el ProblemDetails de su `PostSaleFault` (`code` y `status`).
 */
export class PostSaleClient {
  readonly breaker = new CircuitBreaker('MS.G.PostSale');
  private wsdl?: Promise<soap.WSDL>;
  private readonly endpoint: string;

  constructor(
    baseUrl: string,
    private readonly tokens: TokenSource,
    private readonly timeoutMs: number,
  ) {
    this.endpoint = `${baseUrl}${SOAP_PATH}`;
  }

  private parsedWsdl(): Promise<soap.WSDL> {
    this.wsdl ??= soap.createClientAsync(findContractFile('ms-g-post-sale.wsdl'), {}, this.endpoint).then((client) => client.wsdl);
    return this.wsdl;
  }

  async call<T = Args>(operation: PostSaleOperation, args: Args): Promise<T> {
    try {
      return await this.send<T>(operation, args);
    } catch (error) {
      if (error instanceof ProblemDetailsException && error.problem.status === 401 && this.tokens.invalidate) {
        this.tokens.invalidate();
        return this.send<T>(operation, args);
      }
      throw error;
    }
  }

  private send<T>(operation: PostSaleOperation, args: Args): Promise<T> {
    return this.breaker.run(async () => {
      const client = new soap.Client(await this.parsedWsdl(), this.endpoint, { forceSoap12Headers: false });
      // El mismo CorrelationId y RequestId en la cabecera SOAP (contrato) y en la HTTP (logs y trazas del servidor).
      const correlationId = currentCorrelation()?.correlationId ?? newCorrelationId();
      const requestId = newRequestId();
      client.addSoapHeader(
        `<corr:CorrelationId xmlns:corr="${TYPES_NS}">${xmlEscape(correlationId)}</corr:CorrelationId><corr:RequestId xmlns:corr="${TYPES_NS}">${xmlEscape(requestId)}</corr:RequestId>`,
      );
      const method = (client as unknown as Record<string, (args: Args, options: object, headers: object) => Promise<[T]>>)[`${operation}Async`];
      try {
        const [result] = await method.call(client, args, { timeout: this.timeoutMs }, { Authorization: `Bearer ${await this.tokens.token()}`, [CORRELATION_HEADER]: correlationId, [REQUEST_ID_HEADER]: requestId });
        return result;
      } catch (error) {
        throw translate(error as SoapError);
      }
    });
  }
}

function translate(error: SoapError): ProblemDetailsException {
  const fault = error.root?.Envelope?.Body?.Fault;
  const detail = fault?.detail?.PostSaleFault;
  if (detail?.['code']) {
    const invalid = detail['invalidParam'];
    const invalidParams = (Array.isArray(invalid) ? invalid : invalid ? [invalid] : []) as { name: string; reason: string }[];
    return new ProblemDetailsException({
      status: Number(detail['status']) || error.response?.status || 500,
      code: String(detail['code']),
      title: String(detail['title'] ?? fault?.faultstring ?? 'Error de MS.G.PostSale.'),
      ...(detail['detail'] ? { detail: String(detail['detail']) } : {}),
      ...(invalidParams.length ? { invalidParams } : {}),
    });
  }
  if (!error.response) {
    const timeout = /timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(error.message);
    return new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title: timeout ? 'MS.G.PostSale no respondió a tiempo.' : 'MS.G.PostSale no está disponible.', retryAfterSeconds: 5 });
  }
  return new ProblemDetailsException({ status: 502, code: 'INTERNAL_ERROR', title: `MS.G.PostSale respondió ${error.response.status ?? '?'} sin PostSaleFault.` });
}
