import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as soap from 'soap';
import { ProblemDetailsException, runWithCorrelation } from '@ecoairlines/shared';
import { CircuitBreaker } from '../src/clients/circuit-breaker.js';
import { findContractFile } from '../src/clients/contract-files.js';
import { PaymentApiClient } from '../src/clients/payment-api.client.js';
import { PostSaleClient, SOAP_PATH } from '../src/clients/post-sale.client.js';
import { ServiceTokenProvider } from '../src/clients/service-token.js';
import { FixedToken } from './fakes.js';

/** Clientes del ESB: SOAP (PostSale, contra un servidor hecho con el WSDL del contrato), Payment API, token de servicio y circuit breaker. */
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const problemOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProblemDetailsException) return error.problem;
    throw error;
  }
  throw new Error('se esperaba un error');
};

describe('PostSaleClient (SOAP)', () => {
  let server: Server;
  let base: string;
  const seen: { authorization?: string; correlationId?: string; requestId?: string; httpCorrelationId?: string; httpRequestId?: string }[] = [];

  beforeAll(async () => {
    server = createServer();
    base = await listen(server);
    const wsdl = readFileSync(findContractFile('ms-g-post-sale.wsdl'), 'utf8');
    const quote = { quoteId: '0b6c3a7e-1111-4222-8333-444455556666', bookingId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', refundAmount: '50.00', penaltyAmount: '0.00', penaltyWaived: true, currency: 'USD', expiresAt: '2026-10-25T12:00:00Z' };
    const service = {
      PostSaleService: {
        PostSaleSoapPort: {
          GetBaggageOptions: (args: Any, _cb: unknown, headers: Any, req: IncomingMessage) => {
            seen.push({ authorization: req.headers['authorization'], correlationId: headers?.CorrelationId, requestId: headers?.RequestId, httpCorrelationId: req.headers['x-correlation-id'] as string, httpRequestId: req.headers['x-request-id'] as string });
            if (args.bookingId === '00000000-0000-4000-8000-000000000000') {
              throw { Fault: { faultcode: 'soap:Client', faultstring: 'Límite de equipaje', detail: { $xml: '<types:PostSaleFault xmlns:types="http://ecoairlines.com/soap/post-sale/v1/types"><types:code>BAGGAGE_LIMIT_EXCEEDED</types:code><types:status>422</types:status><types:title>Límite de equipaje</types:title><types:timestamp>2026-10-25T10:00:00Z</types:timestamp></types:PostSaleFault>' } } };
            }
            return { bookingId: args.bookingId, options: [] };
          },
          CreateCancellationQuote: () => ({ quote }),
        },
      },
    };
    // El WSDL importa el XSD con una ruta relativa: `uri` es la ruta del WSDL para resolverlo (como en MS.G.PostSale).
    await new Promise<void>((resolve, reject) => {
      soap.listen(server, { path: SOAP_PATH, services: service, xml: wsdl, uri: findContractFile('ms-g-post-sale.wsdl'), callback: (error: unknown) => (error ? reject(error) : resolve()) });
    });
  });
  afterAll(() => server.close());

  it('llama con el token en Authorization y CorrelationId (sin cambios) + RequestId en el soap:Header', async () => {
    const client = new PostSaleClient(base, new FixedToken(), 2_000);
    const result = await runWithCorrelation({ correlationId: 'corr-soap-v29', requestId: 'req-x' }, () => client.call<Any>('GetBaggageOptions', { bookingId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' }));
    expect(result['bookingId']).toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7');
    expect(seen.at(-1)).toMatchObject({ authorization: 'Bearer token-de-servicio-del-esb', correlationId: 'corr-soap-v29' });
    expect(seen.at(-1)!.requestId).toMatch(/^req-/);
    expect(seen.at(-1)!.requestId).not.toBe('req-x');
    // También en la cabecera HTTP, con los mismos valores (logs y trazas del servidor SOAP).
    expect(seen.at(-1)).toMatchObject({ httpCorrelationId: 'corr-soap-v29', httpRequestId: seen.at(-1)!.requestId });
  });

  it('un soap:Fault vuelve como ProblemDetails con el code y el status del PostSaleFault', async () => {
    const client = new PostSaleClient(base, new FixedToken(), 2_000);
    expect(await problemOf(client.call('GetBaggageOptions', { bookingId: '00000000-0000-4000-8000-000000000000' }))).toMatchObject({ status: 422, code: 'BAGGAGE_LIMIT_EXCEEDED', title: 'Límite de equipaje' });
  });

  it('llamadas simultáneas no mezclan sus cabeceras SOAP (cada una su correlation id)', async () => {
    const client = new PostSaleClient(base, new FixedToken(), 2_000);
    seen.length = 0;
    await Promise.all(['a', 'b', 'c'].map((id) => runWithCorrelation({ correlationId: `corr-${id}`, requestId: 'r' }, () => client.call('GetBaggageOptions', { bookingId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' }))));
    expect(seen.map((s) => s.correlationId).sort()).toEqual(['corr-a', 'corr-b', 'corr-c']);
  });

  it('PostSale caído → 503 PROVIDER_UNAVAILABLE', async () => {
    const client = new PostSaleClient('http://127.0.0.1:1', new FixedToken(), 1_000);
    expect((await problemOf(client.call('GetBaggageOptions', { bookingId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' }))).code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('PaymentApiClient', () => {
  let server: Server;
  let base: string;
  const seen: { url: string; headers: IncomingMessage['headers']; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url!, headers: req.headers, body });
        if (req.url!.includes('pay_mismatch0001')) {
          res.writeHead(422, { 'content-type': 'application/problem+json' }).end(JSON.stringify({ type: 'about:blank', title: 'El monto esperado no es el autorizado.', status: 422, code: 'AMOUNT_MISMATCH' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ paymentReference: 'pay_ok0000000001', status: 'CAPTURED', amount: { currency: 'USD', total: '239.00' }, card: { brand: 'VISA', last4: '4242' }, createdAt: '2026-10-25T10:00:00Z' }));
      });
    });
    base = await listen(server);
  });
  afterAll(() => server.close());

  it('captura con la clave secreta (no con el token del ESB), el correlation id y el monto exacto', async () => {
    const client = new PaymentApiClient(base, 'sk_test_clave_de_prueba', 2_000);
    const payment = await runWithCorrelation({ correlationId: 'corr-pago', requestId: 'r' }, () => client.capture('pay_ok0000000001', { orderId: 'saga-1', operation: 'BOOKING', expectedAmount: { currency: 'USD', total: '239.00' } }));
    expect(payment.status).toBe('CAPTURED');
    expect(seen.at(-1)).toMatchObject({ url: '/payments/pay_ok0000000001/capture', headers: { authorization: 'Bearer sk_test_clave_de_prueba', 'x-correlation-id': 'corr-pago' } });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ orderId: 'saga-1', operation: 'BOOKING', expectedAmount: { currency: 'USD', total: '239.00' } });
  });

  it('★ V2.15: el monto de la reserva (con baseFare y taxes) viaja como el MoneyAmount del contrato de la pasarela: solo currency y total', async () => {
    const client = new PaymentApiClient(base, 'sk_test_clave_de_prueba', 2_000);
    const booking = { currency: 'USD', baseFare: '100.00', taxes: '19.50', total: '119.50' };
    await client.capture('pay_ok0000000001', { orderId: 'saga-2', operation: 'BOOKING', expectedAmount: booking });
    expect(JSON.parse(seen.at(-1)!.body).expectedAmount).toEqual({ currency: 'USD', total: '119.50' });
    await client.refund({ paymentReference: 'pay_ok0000000001', amount: booking, reason: 'SAGA_COMPENSATION', orderId: 'saga-2' });
    expect(JSON.parse(seen.at(-1)!.body).amount).toEqual({ currency: 'USD', total: '119.50' });
  });

  it('el reembolso lleva Idempotency-Key; los errores conservan su code (AMOUNT_MISMATCH)', async () => {
    const client = new PaymentApiClient(base, 'sk_test_clave_de_prueba', 2_000);
    await client.refund({ paymentReference: 'pay_ok0000000001', amount: { currency: 'USD', total: '10.00' }, reason: 'CUSTOMER_REQUEST' }, '5f0d7a43-6b1e-4c63-9b5e-2f1b9b7a1c11');
    expect(seen.at(-1)!.headers['idempotency-key']).toBe('5f0d7a43-6b1e-4c63-9b5e-2f1b9b7a1c11');
    expect(await problemOf(client.capture('pay_mismatch0001', { orderId: 's', operation: 'BOOKING', expectedAmount: { currency: 'USD', total: '1.00' } }))).toMatchObject({ status: 422, code: 'AMOUNT_MISMATCH' });
    expect((await problemOf(new PaymentApiClient('http://127.0.0.1:1', 'sk', 500).get('pay_x'))).code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('ServiceTokenProvider', () => {
  let server: Server;
  let base: string;
  let issued = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const ok = req.headers['authorization'] === `Basic ${Buffer.from('ECOAIRLINES_ESB:secreto').toString('base64')}` && body === 'grant_type=client_credentials';
        if (!ok) return void res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_client' }));
        issued++;
        setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: `t${issued}`, token_type: 'Bearer', expires_in: 600 })), 50);
      });
    });
    base = await listen(server);
  });
  afterAll(() => server.close());

  it('pide el token una vez aunque lo pidan 10 a la vez, lo guarda y lo renueva tras invalidate()', async () => {
    const provider = new ServiceTokenProvider(base, 'ECOAIRLINES_ESB', 'secreto');
    expect(new Set(await Promise.all(Array.from({ length: 10 }, () => provider.token())))).toEqual(new Set(['t1']));
    expect(await provider.token()).toBe('t1');
    provider.invalidate();
    expect(await provider.token()).toBe('t2');
    expect(issued).toBe(2);
  });

  it('credenciales malas → 503 PROVIDER_UNAVAILABLE (el ESB no puede llamar a los MS.G)', async () => {
    expect((await problemOf(new ServiceTokenProvider(base, 'ECOAIRLINES_ESB', 'otro').token())).code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('CircuitBreaker', () => {
  const down = () => Promise.reject(new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title: 'caído' }));

  it('se abre tras N fallas, deja pasar una prueba al vencer y se cierra si responde; un 4xx no cuenta', async () => {
    const breaker = new CircuitBreaker('X', 2, 50);
    await expect(breaker.run(() => Promise.reject(new ProblemDetailsException({ status: 404, code: 'NOT_FOUND', title: 'no' })))).rejects.toThrow();
    expect(breaker.state).toBe('CLOSED');
    await expect(breaker.run(down)).rejects.toThrow();
    await expect(breaker.run(down)).rejects.toThrow();
    expect(breaker.state).toBe('OPEN');
    let called = false;
    await expect(breaker.run(async () => (called = true))).rejects.toMatchObject({ problem: { title: 'X no está disponible (circuito abierto).' } });
    expect(called).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(breaker.state).toBe('HALF_OPEN');
    expect(await breaker.run(async () => 'ok')).toBe('ok');
    expect(breaker.state).toBe('CLOSED');
  });
});
