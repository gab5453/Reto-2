import { createCloudEvent, eventName, isPublicEvent, signWebhook, verifyWebhookSignature } from './cloudevents/cloudevents.js';
import { correlationAmqpProperties, correlationMetadata, correlationSoapHeaders, runWithCorrelation } from './correlation/correlation.js';
import { applyDiscount, sameAmount, sumMoney } from './domain/money.js';
import { resolvePassengerCounts, seatsRequired } from './domain/passenger-counts.js';
import { createRequestLogMiddleware, redact } from './logging/logging.js';
import { genericCode } from './problem-details/problem-details.js';

const context = { correlationId: 'corr-proceso-1', requestId: 'req-1' };

describe('correlation ID por protocolo (contrato v2 §6)', () => {
  it('gRPC: metadata x-correlation-id con el mismo valor', () => {
    const metadata = runWithCorrelation(context, () => Object.fromEntries(correlationMetadata()));
    expect(metadata['x-correlation-id']).toBe('corr-proceso-1');
    expect(metadata['x-request-id']).toMatch(/^req-/);
  });

  it('RabbitMQ: propiedad correlation_id', () => {
    expect(runWithCorrelation(context, () => correlationAmqpProperties()).correlationId).toBe('corr-proceso-1');
  });

  it('SOAP: <corr:CorrelationId> escapado en el namespace de PostSale', () => {
    const xml = runWithCorrelation({ ...context, correlationId: 'corr-<x>' }, () => correlationSoapHeaders('http://ecoairlines.com/soap/post-sale/v1/types'));
    expect(xml).toContain('<corr:CorrelationId xmlns:corr="http://ecoairlines.com/soap/post-sale/v1/types">corr-&#60;x&#62;</corr:CorrelationId>');
  });
});

describe('CloudEvents y firma de webhooks (contrato v2 §8)', () => {
  it('crea el evento con el correlationid del proceso y el type público o interno', () => {
    const event = runWithCorrelation(context, () => createCloudEvent({ name: 'booking.confirmed', visibility: 'public', data: { pnr: 'XK7P2Q' } }));
    expect(event).toMatchObject({
      specversion: '1.0',
      type: 'ec.edu.epn.booking.vuelos.booking.confirmed',
      source: '/aerolineas/ecoairlines/vuelos',
      correlationid: 'corr-proceso-1',
      datacontenttype: 'application/json',
    });
    expect(isPublicEvent(event)).toBe(true);
    expect(eventName(event.type)).toBe('booking.confirmed');
    const internal = createCloudEvent({ name: 'pricing.changed', visibility: 'internal', data: {}, correlationId: 'corr-x' });
    expect(internal.type).toBe('ec.ecoairlines.internal.pricing.changed');
    expect(isPublicEvent(internal)).toBe(false);
  });

  it('firma con HMAC-SHA256 y rechaza un cuerpo alterado o una firma ausente', () => {
    const body = JSON.stringify({ id: 'evt-1' });
    const signature = signWebhook('secreto-de-al-menos-16', body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature('secreto-de-al-menos-16', body, signature)).toBe(true);
    expect(verifyWebhookSignature('secreto-de-al-menos-16', `${body} `, signature)).toBe(false);
    expect(verifyWebhookSignature('otro-secreto-diferente', body, signature)).toBe(false);
    expect(verifyWebhookSignature('secreto-de-al-menos-16', body, undefined)).toBe(false);
  });
});

describe('logs (sin datos sensibles)', () => {
  it('redacta tokens, tarjetas, documentos, contacto y asistencia médica', () => {
    expect(
      redact({ authorization: 'Bearer x', cardNumber: '4242', cvv: '123', passenger: { documentNumber: '17', email: 'a@b', firstName: 'Ana' }, assistance: { type: 'WCHR' }, flightNumber: 'EA300' }),
    ).toEqual({
      authorization: '[REDACTADO]',
      cardNumber: '[REDACTADO]',
      cvv: '[REDACTADO]',
      passenger: { documentNumber: '[REDACTADO]', email: '[REDACTADO]', firstName: 'Ana' },
      assistance: '[REDACTADO]',
      flightNumber: 'EA300',
    });
  });

  it('escribe una línea api_request_logs con los campos del contrato y sin query string', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const listeners: Record<string, () => void> = {};
    const req = { method: 'GET', baseUrl: '/vuelos', route: { path: '/bookings/:bookingId' }, originalUrl: '/vuelos/bookings/1?pnr=X' };
    const res = { statusCode: 200, on: (event: string, fn: () => void) => (listeners[event] = fn) };
    runWithCorrelation(context, () => {
      createRequestLogMiddleware('ms-reservas')(req as never, res as never, () => undefined);
      listeners['finish']!();
    });
    spy.mockRestore();
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      level: 'info',
      service: 'ms-reservas',
      correlation_id: 'corr-proceso-1',
      request_id: 'req-1',
      type: 'api_request',
      operation: 'GET /vuelos/bookings/:bookingId',
      status: 200,
      latency_ms: expect.any(Number),
      timestamp: expect.any(String),
    });
    expect(lines[0]).not.toContain('pnr');
  });

  it('conserva el correlation id aunque la respuesta termine fuera del contexto (p. ej. la librería soap)', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const listeners: Record<string, () => void> = {};
    const res = { statusCode: 200, on: (event: string, fn: () => void) => (listeners[event] = fn) };
    runWithCorrelation(context, () => createRequestLogMiddleware('ms-g-post-sale')({ method: 'POST', baseUrl: '', originalUrl: '/soap/post-sale' } as never, res as never, () => undefined));
    listeners['finish']!(); // fuera de runWithCorrelation
    spy.mockRestore();
    expect(JSON.parse(lines[0]!)).toMatchObject({ correlation_id: 'corr-proceso-1', request_id: 'req-1', operation: 'POST /soap/post-sale' });
  });
});

describe('dominio compartido', () => {
  it('dinero: descuento sobre el precio congelado y comparación al centavo (BKG-08, AMOUNT_MISMATCH)', () => {
    const locked = { currency: 'USD', baseFare: '200.00', taxes: '39.00', total: '239.00' };
    expect(applyDiscount(locked, 10)).toEqual({ currency: 'USD', baseFare: '180.00', taxes: '35.10', total: '215.10' });
    expect(sameAmount(locked, { currency: 'USD', total: '239.0' })).toBe(true);
    expect(sameAmount(locked, { currency: 'USD', total: '239.01' })).toBe(false);
    expect(sumMoney([locked, locked]).total).toBe('478.00');
    expect(() => applyDiscount(locked, 120)).toThrow(RangeError);
  });

  it('pasajeros: los infantes no ocupan asiento', () => {
    expect(seatsRequired(resolvePassengerCounts({ adults: 2, infants: 1 }))).toBe(2);
  });

  it('códigos genéricos del contrato por status', () => {
    expect([401, 403, 404, 429, 503, 500, 400].map(genericCode)).toEqual([
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'RATE_LIMIT_EXCEEDED',
      'PROVIDER_UNAVAILABLE',
      'INTERNAL_ERROR',
      'VALIDATION_FAILED',
    ]);
  });
});
