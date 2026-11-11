import { AIRPORTS, ProblemDetailsException } from '@ecoairlines/shared';
import { applyAirportWrite, replaceCatalog, toCatalog } from './clients/airport-catalog.js';
import { problemFrom } from './clients/rest.client.js';
import type { Upstreams } from './clients/upstreams.js';
import { traceWindow } from './composition/composition.service.js';
import { DATE, FLIGHT_NUMBER, IATA, localDate } from './composition/dates.js';
import { layerOf, maskIds } from './composition/journey.js';
import type { EsbConfig } from './config/config.js';
import type { EsbStore, StoredResponse } from './repositories/esb.store.js';
import { ROUTE_EVENT_OPERATIONS, routeEvent } from './router/route-events.js';
import { problemResponse } from './router/router.service.js';
import { matchRoute, pathExists } from './router/routes.js';
import type { SagaContext } from './sagas/engine.js';
import { bookingEventData, collectPayment, fromProto, international, isPartner, partnerIdOf, publicOwner, settleRefund } from './sagas/support.js';
import { assertAmountMatches, assertBookingPaymentReference } from './transversal/booking-reference.js';
import { stableUuid } from './transversal/ids.js';
import { IdempotencyService } from './transversal/idempotency.service.js';

/**
 * PU-3 (Informacion_General/Pruebas.md §5.1.3): piezas del ESB, solas — enrutador, eventos internos, idempotencia, composición,
 * catálogo de aeropuertos y los pasos de cobro y reembolso de las sagas. Los MS.G, la Payment API y el repositorio son dobles.
 */

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
};
const MIN = 60_000;

// ================================================================================================ enrutador
describe('matchRoute y pathExists: la tabla cerrada de rutas (D43)', () => {
  it('una ruta con parámetros los devuelve por nombre', () =>
    expect(matchRoute('bookings', 'GET', '/bookings/b-1/tickets/TKT-1')).toMatchObject({ route: { operationId: expect.any(String) }, params: { bookingId: 'b-1', ticketId: 'TKT-1' } }));
  it('un método que la ruta no tiene no coincide, pero el path existe (→ 405, no 404)', () => {
    expect(matchRoute('bookings', 'PATCH', '/bookings/b-1')).toBeUndefined();
    expect(pathExists('bookings', '/bookings/b-1')).toBe(true);
  });
  it('un servicio que no tiene esa ruta no coincide (no se salta de un MS.G a otro)', () => expect(matchRoute('identity', 'GET', '/bookings/b-1')).toBeUndefined());
  it.each(['/bookings/../users', '/bookings/./b-1', '/bookings/%2e%2e/x'])('%s: los segmentos con puntos se rechazan', (path) => {
    expect(matchRoute('bookings', 'GET', path)).toBeUndefined();
    expect(pathExists('bookings', path)).toBe(false);
  });
});

describe('routeEvent: eventos internos de una escritura que salió bien', () => {
  const contexto = (operationId: string, over: Record<string, unknown> = {}) => ({ operationId, params: {}, request: undefined, response: undefined, caller: { actorId: 'admin-1' }, ...over });

  it('crear un usuario → user.created con sub, rol y quién lo hizo', () =>
    expect(routeEvent(contexto('createUser', { response: { sub: 'u-9', role: 'CUSTOMER', status: 'ACTIVE' } }))?.event).toMatchObject({
      subject: 'u-9',
      data: { sub: 'u-9', role: 'CUSTOMER', status: 'ACTIVE', actorId: 'admin-1' },
    }));
  it('el motivo se recorta a 200 caracteres', () =>
    expect((routeEvent(contexto('changeUserStatus', { params: { sub: 'u-9' }, request: { reason: 'x'.repeat(500) }, response: { sub: 'u-9' } }))!.event.data as { reason: string }).reason).toHaveLength(200));
  it('rotar el secreto de un partner NUNCA pone el secreto en el evento', () => {
    const route = routeEvent(contexto('rotatePartnerSecret', { params: { clientId: 'BOOKING_PROTOTIPO' }, response: { clientId: 'BOOKING_PROTOTIPO', status: 'ACTIVE', clientSecret: 'SECRETO-123' } }));
    expect(JSON.stringify(route)).not.toContain('SECRETO-123');
    expect(route!.event.type).toContain('partner.secret_rotated');
  });
  it('la asistencia solo dice QUE cambió, nunca el tipo ni las notas (dato de salud)', () => {
    const route = routeEvent(contexto('saveAssistance', { params: { bookingId: 'b-1', passengerId: 'P%201' }, request: { type: 'MEDA', notes: 'diabetes' }, caller: { ownerId: 'cliente-1' } }));
    expect(route).toMatchObject({ ownerId: 'cliente-1', event: { data: { bookingId: 'b-1', passengerId: 'P 1', action: 'REQUESTED' } } });
    expect(JSON.stringify(route)).not.toMatch(/MEDA|diabetes/);
  });
  it('todos los eventos del enrutador son internos', () => {
    const route = routeEvent(contexto('deleteAssistance', { params: { bookingId: 'b-1', passengerId: 'P1' } }));
    expect(route!.event.type).toContain('internal');
  });
  it('una operación que no produce eventos, o sin asunto, no publica nada', () => {
    expect(routeEvent(contexto('getBooking'))).toBeUndefined();
    expect(routeEvent(contexto('createUser', { response: {} }))).toBeUndefined();
  });
  it('las operaciones con evento son exactamente 8', () => expect(ROUTE_EVENT_OPERATIONS).toHaveLength(8));
});

describe('problemResponse y problemFrom: errores con forma de ProblemDetails', () => {
  it('problemResponse: application/problem+json, con el correlation de la instancia y Retry-After si corresponde', () => {
    const response = problemResponse(new ProblemDetailsException({ status: 429, code: 'RATE_LIMIT_EXCEEDED', title: 'Espere', retryAfterSeconds: 7 }), '/router/x');
    expect(response.status).toBe(429);
    expect(response.headers).toEqual({ 'content-type': 'application/problem+json', 'retry-after': '7' });
    expect(JSON.parse(response.body)).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', instance: '/router/x' });
  });
  it('problemFrom: un ProblemDetails del MS.G se conserva tal cual', () =>
    expect(problemFrom(409, { code: 'SEAT_TAKEN', title: 'Asiento no disponible', detail: 'd' }, 'MS.G.Offers').problem).toMatchObject({ status: 409, code: 'SEAT_TAKEN', detail: 'd' }));
  it('problemFrom: un 5xx sin ProblemDetails se vuelve 502 INTERNAL_ERROR (no se filtra el error del MS.G)', () =>
    expect(problemFrom(500, '<html>Error</html>', 'MS.G.Bookings').problem).toMatchObject({ status: 502, code: 'INTERNAL_ERROR' }));
  it('problemFrom: 404 sin cuerpo → NOT_FOUND; otro 4xx → VALIDATION_FAILED', () => {
    expect(problemFrom(404, undefined, 'x').problem.code).toBe('NOT_FOUND');
    expect(problemFrom(400, {}, 'x').problem.code).toBe('VALIDATION_FAILED');
  });
});

// ================================================================================================ idempotencia
describe('IdempotencyService (D6): Idempotency-Key', () => {
  const KEY = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
  const ok: StoredResponse = { status: 201, headers: {}, body: '{"bookingId":"b-1"}' };
  let store: { claim: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let service: IdempotencyService;
  beforeEach(() => {
    store = { claim: vi.fn().mockResolvedValue({ kind: 'new' }), complete: vi.fn(), release: vi.fn() };
    service = new IdempotencyService(store as unknown as EsbStore);
  });

  it('sin clave se ejecuta siempre y no se guarda nada', async () => {
    const execute = vi.fn().mockResolvedValue(ok);
    expect(await service.run(undefined, 'owner:x', 'h', execute)).toEqual({ ...ok, replayed: false });
    expect(store.claim).not.toHaveBeenCalled();
  });
  it('una clave que no es UUID → VALIDATION_FAILED, sin ejecutar', async () => {
    const execute = vi.fn();
    expect(await codeOf(service.run('mi-clave', 'owner:x', 'h', execute))).toBe('VALIDATION_FAILED');
    expect(execute).not.toHaveBeenCalled();
  });
  it('primera vez: ejecuta y guarda la respuesta con la clave en minúsculas y el alcance del dueño', async () => {
    await service.run(KEY, 'owner:x', 'h', vi.fn().mockResolvedValue(ok));
    expect(store.claim).toHaveBeenCalledWith('owner:x', KEY.toLowerCase(), 'h', expect.any(Number));
    expect(store.complete).toHaveBeenCalledWith('owner:x', KEY.toLowerCase(), ok);
  });
  it('repetida con el mismo cuerpo: devuelve la guardada (Idempotent-Replayed) SIN ejecutar', async () => {
    store.claim.mockResolvedValue({ kind: 'replay', response: ok });
    const execute = vi.fn();
    expect(await service.run(KEY, 'owner:x', 'h', execute)).toEqual({ ...ok, replayed: true });
    expect(execute).not.toHaveBeenCalled();
  });
  it('la misma clave con otro cuerpo → IDEMPOTENCY_KEY_REUSED', async () => {
    store.claim.mockResolvedValue({ kind: 'mismatch' });
    expect(await codeOf(service.run(KEY, 'owner:x', 'otro-hash', vi.fn()))).toBe('IDEMPOTENCY_KEY_REUSED');
  });
  it('si la primera sigue en curso, espera y devuelve su respuesta (nunca ejecuta dos veces a la vez)', async () => {
    store.claim.mockResolvedValueOnce({ kind: 'in-progress' }).mockResolvedValueOnce({ kind: 'replay', response: ok });
    const execute = vi.fn();
    expect((await service.run(KEY, 'owner:x', 'h', execute)).replayed).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it('un 5xx no se guarda: la clave se libera para que el reintento vuelva a intentarlo', async () => {
    await service.run(KEY, 'owner:x', 'h', vi.fn().mockResolvedValue({ status: 503, headers: {}, body: '' }));
    expect(store.release).toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });
  it('el límite exacto: un 500 tampoco se guarda; un 499 sí (lo encontró la mutación manual)', async () => {
    await service.run(KEY, 'owner:x', 'h', vi.fn().mockResolvedValue({ status: 500, headers: {}, body: '' }));
    expect(store.release).toHaveBeenCalledTimes(1);
    expect(store.complete).not.toHaveBeenCalled();
    await service.run(KEY, 'owner:x', 'h', vi.fn().mockResolvedValue({ status: 499, headers: {}, body: '' }));
    expect(store.complete).toHaveBeenCalledTimes(1);
  });
  it('si la ejecución lanza, la clave también se libera y el error sigue', async () => {
    expect(await codeOf(service.run(KEY, 'owner:x', 'h', vi.fn().mockRejectedValue(new ProblemDetailsException({ status: 409, code: 'SEAT_TAKEN', title: 'x' }))))).toBe('SEAT_TAKEN');
    expect(store.release).toHaveBeenCalled();
  });
  it('hash: el orden de las partes importa y no se confunden los límites ("ab"+"c" ≠ "a"+"bc")', () => {
    expect(IdempotencyService.hash('ab', 'c')).not.toBe(IdempotencyService.hash('a', 'bc'));
    expect(IdempotencyService.hash('POST', '/x', '{}')).toBe(IdempotencyService.hash('POST', '/x', '{}'));
  });
});

// ================================================================================================ composición
describe('traceWindow: dónde buscar las trazas de un correlation ID (T-2)', () => {
  const ahora = Date.parse('2026-12-01T12:00:00Z');
  it('con rango pedido, se usa; sin "from", 3 h antes de "to"', () => {
    expect(traceWindow({ from: '2026-12-01T08:00:00Z', to: '2026-12-01T09:00:00Z' }, [], ahora)).toMatchObject({ source: 'RANGE', from: new Date('2026-12-01T08:00:00Z') });
    expect(traceWindow({ to: '2026-12-01T09:00:00Z' }, [], ahora).from).toEqual(new Date('2026-12-01T06:00:00Z'));
  });
  it('sin rango, alrededor de sus sagas y eventos (±10 min)', () =>
    expect(traceWindow({}, ['2026-12-01T10:00:00Z', undefined, '2026-12-01T10:30:00Z'], ahora)).toEqual({
      from: new Date('2026-12-01T09:50:00Z'),
      to: new Date('2026-12-01T10:40:00Z'),
      source: 'RECORDS',
    }));
  it('nunca más de 24 h aunque los registros estén más separados', () => {
    const window = traceWindow({}, ['2026-11-25T00:00:00Z', '2026-11-30T00:00:00Z'], ahora);
    expect(window.to.getTime() - window.from.getTime()).toBe(24 * 60 * MIN);
  });
  it('nunca hacia el futuro', () => expect(traceWindow({}, ['2026-12-01T11:58:00Z'], ahora).to.getTime()).toBe(ahora));
  it('sin registros: las últimas 3 horas', () => expect(traceWindow({}, [], ahora)).toEqual({ from: new Date(ahora - 180 * MIN), to: new Date(ahora), source: 'DEFAULT' }));
  it('fechas inválidas se ignoran', () => expect(traceWindow({}, ['no-es-fecha'], ahora).source).toBe('DEFAULT'));
});

describe('recorrido: capas y rutas sin identificadores (T-4)', () => {
  it.each([
    ['cliente', 'CLIENT'],
    ['gateway', 'GATEWAY'],
    ['ms-reservas', 'RESPONSE'],
    ['esb', 'ESB'],
    ['ms-g-offers', 'MANAGEMENT'],
    ['payment-api', 'EXTERNAL'],
  ] as const)('%s está en la capa %s', (service, layer) => expect(layerOf(service)).toBe(layer));
  it('enmascara UUID, referencias de pago y códigos con dígitos; deja la versión de la API', () => {
    expect(maskIds('/bookings/562db2df-a55e-4b32-8272-11ebfcab1289/seats')).toBe('/bookings/{id}/seats');
    expect(maskIds('/payments/pm_abc/void')).toBe('/payments/{id}/void');
    expect(maskIds('/api/v2/vuelos/bookings/ABC234')).toBe('/api/v2/vuelos/bookings/{id}');
    expect(maskIds('/api/v2/vuelos/search')).toBe('/api/v2/vuelos/search');
  });
});

describe('fechas y formatos del ESB', () => {
  it('localDate: "hoy" es la fecha de Ecuador (a las 02:00 UTC todavía es ayer)', () => expect(localDate(new Date('2026-12-02T02:00:00Z'))).toBe('2026-12-01'));
  it('formatos de fecha, aeropuerto y número de vuelo', () => {
    expect(['2026-12-01', '26-12-01'].map((v) => DATE.test(v))).toEqual([true, false]);
    expect(['UIO', 'uio', 'UIOX'].map((v) => IATA.test(v))).toEqual([true, false, false]);
    // El código de aerolínea puede llevar dígitos (IATA: «4M»): «E100» es E1 + 00 y es válido.
    expect(['EA100', 'EA1', 'E100', 'ea100', 'EA12345'].map((v) => FLIGHT_NUMBER.test(v))).toEqual([true, true, true, false, false]);
  });
});

describe('catálogo de aeropuertos del ESB (M-1)', () => {
  // Copia del catálogo ANTES de modificarlo: restaurar desde AIRPORTS ya modificado dejaría la prueba siguiente sin GYE.
  const original = Object.values(AIRPORTS).map((airport) => ({ ...airport }));
  afterEach(() => replaceCatalog(original));
  const tena = { code: 'TNW', city: 'Tena', name: 'Jumandy', country: 'EC', province: null, lat: '-1.0' as unknown as number, lon: -77.8, utcOffsetMinutes: -300 };

  it('toCatalog normaliza números y quita lo que no necesitan las reglas', () =>
    expect(toCatalog({ ...tena, updatedAt: 'x' } as never)).toEqual({ code: 'TNW', city: 'Tena', name: 'Jumandy', country: 'EC', lat: -1, lon: -77.8, utcOffsetMinutes: -300, active: true }));
  it('una escritura del enrutador que salió bien actualiza el catálogo del proceso', () => {
    applyAirportWrite('createAirport', {}, tena as never);
    expect(AIRPORTS['TNW']?.city).toBe('Tena');
    applyAirportWrite('deleteAirport', { code: 'TNW' }, undefined);
    expect(AIRPORTS['TNW']).toBeUndefined();
  });
  it('replaceCatalog quita los aeropuertos que Schedule ya no tiene', () => {
    replaceCatalog([toCatalog(tena as never), AIRPORTS['UIO']!]);
    expect(Object.keys(AIRPORTS).sort()).toEqual(['TNW', 'UIO']);
  });
});

// ================================================================================================ pasos de las sagas
describe('ayudas de las sagas', () => {
  it('partner: dueño partner:<id>:<usuario>', () => {
    expect(isPartner('partner:BOOKING_PROTOTIPO:u-1')).toBe(true);
    expect(partnerIdOf('partner:BOOKING_PROTOTIPO:u-1')).toBe('BOOKING_PROTOTIPO');
    expect(partnerIdOf('cliente-1')).toBeNull();
  });
  it('el dueño público de un evento no lleva nuestro prefijo interno', () => {
    expect(publicOwner('partner:BOOKING_PROTOTIPO:u:1')).toBe('u:1');
    expect(bookingEventData({ bookingId: 'b', pnr: 'P', status: 'CONFIRMED', ownerId: 'partner:B:u-1', grandTotal: { currency: 'USD', total: '1.00' } })).toMatchObject({ ownerId: 'u-1', partnerOrderId: null });
  });
  it('international: países distintos', () => {
    expect(international({ departure: { iataCode: 'UIO', at: '' }, arrival: { iataCode: 'GYE', at: '' } })).toBe(false);
    expect(international({ departure: { iataCode: 'UIO', at: '' }, arrival: { iataCode: 'BOG', at: '' } })).toBe(true);
  });
  it('fromProto quita los prefijos de los enums y los campos virtuales de proto3', () =>
    expect(fromProto({ cabinClass: 'CABIN_CLASS_ECONOMY', _terminal: 'terminal', items: [{ status: 'SEAT_STATUS_HELD' }], texto: 'CABINA' })).toEqual({ cabinClass: 'ECONOMY', items: [{ status: 'HELD' }], texto: 'CABINA' }));
  it('stableUuid: el mismo texto da el mismo UUID versión 5', () => {
    expect(stableUuid('saga:1')).toBe(stableUuid('saga:1'));
    expect(stableUuid('saga:1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('referencia de pago de Booking (D28, BKG-02)', () => {
  const PATRON = /^PAY-BKP-(\d{8})-\d{6}$/;
  const ahora = new Date('2026-12-01T12:00:00Z');
  it('una referencia con fecha real de hoy o de mañana (zona horaria) pasa', () => {
    expect(assertBookingPaymentReference(' PAY-BKP-20261201-000123 ', PATRON, ahora)).toBe('PAY-BKP-20261201-000123');
    expect(() => assertBookingPaymentReference('PAY-BKP-20261202-000123', PATRON, ahora)).not.toThrow();
  });
  it.each([
    ['PAY-BKP-20260230-000123', 'no existe'],
    ['PAY-BKP-20261205-000123', 'en el futuro'],
    ['PAY-20261201-1', 'formato'],
  ])('%s se rechaza (%s)', (reference, motivo) => expect(() => assertBookingPaymentReference(reference, PATRON, ahora)).toThrow(expect.objectContaining({ problem: expect.objectContaining({ detail: expect.stringContaining(motivo === 'formato' ? 'formato' : motivo) }) })));
  it('el monto, si llega, debe ser exacto y en la misma moneda', () => {
    expect(() => assertAmountMatches(undefined, { currency: 'USD', total: '10.00' })).not.toThrow();
    expect(() => assertAmountMatches({ currency: 'USD', total: '10.0' }, { currency: 'USD', total: '10.00' })).not.toThrow();
    expect(() => assertAmountMatches({ currency: 'EUR', total: '10.00' }, { currency: 'USD', total: '10.00' })).toThrow();
    expect(() => assertAmountMatches({ currency: 'USD', total: '9.99' }, { currency: 'USD', total: '10.00' })).toThrow();
  });
});

describe('collectPayment y settleRefund: el paso de cobro y el de reembolso', () => {
  /** Contexto de saga mínimo: cada paso se ejecuta y se anota (su compensación queda guardada para probarla aparte). */
  const sagaFalsa = (ownerId: string) => {
    const pasos: string[] = [];
    const compensaciones = new Map<string, () => Promise<unknown>>();
    const saga = {
      sagaId: 'saga-123456789',
      ownerId,
      step: vi.fn(async (name: string, run: () => Promise<unknown>, compensate?: (r: unknown) => Promise<unknown>) => {
        pasos.push(name);
        if (compensate) compensaciones.set(name, () => compensate(undefined));
        return run();
      }),
    };
    return { saga: saga as unknown as SagaContext, pasos, compensaciones };
  };
  const dobles = () => {
    const bookings = { json: vi.fn().mockResolvedValue({ created: true }), request: vi.fn().mockResolvedValue({ status: 204 }) };
    const payments = {
      capture: vi.fn().mockResolvedValue({ paymentReference: 'pay_1', status: 'CAPTURED' }),
      void: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ status: 'CAPTURED', orderId: 'saga-123456789' }),
      refund: vi.fn().mockResolvedValue({ refundId: 're_1', createdAt: 'ahora' }),
    };
    const upstreams = { rest: { bookings }, payments } as unknown as Upstreams;
    const config = { bookingPaymentReferencePattern: /^PAY-BKP-(\d{8})-\d{6}$/, paymentPendingWaitMs: 100 } as EsbConfig;
    return { bookings, payments, deps: { upstreams, config } };
  };
  const esperado = { currency: 'USD', total: '127.00' };

  it('un monto de 0 no cobra ni exige referencia', async () => {
    const { saga, pasos } = sagaFalsa('cliente-1');
    expect(await collectPayment(saga, dobles().deps, { operation: 'SEATS', expected: { currency: 'USD', total: '0.00' } })).toBeUndefined();
    expect(pasos).toEqual([]);
  });
  it('sin referencia (y con monto) → PAYMENT_REFERENCE_INVALID', async () =>
    expect(await codeOf(collectPayment(sagaFalsa('cliente-1').saga, dobles().deps, { operation: 'BOOKING', expected: esperado }))).toBe('PAYMENT_REFERENCE_INVALID'));

  it('canal Booking: la aerolínea NO cobra; valida y registra la referencia', async () => {
    const { saga, pasos } = sagaFalsa('partner:BOOKING_PROTOTIPO:u-1');
    const d = dobles();
    const result = await collectPayment(saga, d.deps, { operation: 'BOOKING', payment: { paymentReference: 'PAY-BKP-20261101-000001', amount: esperado }, expected: esperado });
    expect(result).toEqual({ paymentReference: 'PAY-BKP-20261101-000001', provider: 'BOOKING_PROTOTIPO', amount: esperado });
    expect(d.payments.capture).not.toHaveBeenCalled();
    expect(pasos).toEqual(['payment.claim:BOOKING']);
    expect(d.bookings.json).toHaveBeenCalledWith('POST', '/payment-references/claim', { json: expect.objectContaining({ provider: 'BOOKING_PROTOTIPO', sagaId: 'saga-123456789' }) });
  });
  it('canal Booking: no puede pagar con la pasarela de la aerolínea', async () =>
    expect(
      await codeOf(collectPayment(sagaFalsa('partner:BOOKING_PROTOTIPO:u-1').saga, dobles().deps, { operation: 'BOOKING', payment: { paymentReference: 'PAY-BKP-20261101-000001', provider: 'AIRLINE_DIRECT' }, expected: esperado })),
    ).toBe('PAYMENT_REFERENCE_INVALID'));
  it('canal Booking: un monto distinto → AMOUNT_MISMATCH y no se registra', async () => {
    const d = dobles();
    expect(
      await codeOf(collectPayment(sagaFalsa('partner:BOOKING_PROTOTIPO:u-1').saga, d.deps, { operation: 'BOOKING', payment: { paymentReference: 'PAY-BKP-20261101-000001', amount: { currency: 'USD', total: '1.00' } }, expected: esperado })),
    ).toBe('AMOUNT_MISMATCH');
    expect(d.bookings.json).not.toHaveBeenCalled();
  });

  it('canal web: autoriza (compensable con anular), captura con la orden = sagaId y registra', async () => {
    const { saga, pasos } = sagaFalsa('cliente-1');
    const d = dobles();
    await collectPayment(saga, d.deps, { operation: 'BOOKING', payment: { paymentReference: 'pay_1' }, expected: esperado });
    expect(pasos).toEqual(['payment.authorization:BOOKING', 'payment.capture:BOOKING', 'payment.claim:BOOKING']);
    expect(d.payments.capture).toHaveBeenCalledWith('pay_1', { orderId: 'saga-123456789', operation: 'BOOKING', expectedAmount: esperado });
  });
  it('canal web: una tarjeta rechazada → PAYMENT_NOT_AUTHORIZED', async () => {
    const d = dobles();
    d.payments.capture.mockRejectedValue(new ProblemDetailsException({ status: 409, code: 'PAYMENT_NOT_CAPTURABLE', title: 'x', detail: 'DECLINED' }));
    expect(await codeOf(collectPayment(sagaFalsa('cliente-1').saga, d.deps, { operation: 'BOOKING', payment: { paymentReference: 'pay_1' }, expected: esperado }))).toBe('PAYMENT_NOT_AUTHORIZED');
  });
  it('compensación del cobro: reembolsa solo si lo capturó ESTA saga (nunca el dinero de otra compra)', async () => {
    const { saga, compensaciones } = sagaFalsa('cliente-1');
    const d = dobles();
    await collectPayment(saga, d.deps, { operation: 'BOOKING', payment: { paymentReference: 'pay_1' }, expected: esperado });
    d.payments.get.mockResolvedValue({ status: 'CAPTURED', orderId: 'otra-saga' });
    await compensaciones.get('payment.capture:BOOKING')!();
    expect(d.payments.refund).not.toHaveBeenCalled();
    d.payments.get.mockResolvedValue({ status: 'CAPTURED', orderId: 'saga-123456789' });
    await compensaciones.get('payment.capture:BOOKING')!();
    expect(d.payments.refund).toHaveBeenCalledWith(expect.objectContaining({ paymentReference: 'pay_1', reason: 'SAGA_COMPENSATION', orderId: 'saga-123456789' }), stableUuid('refund:saga-123456789:BOOKING'));
  });

  const reserva = (channel: 'WEB' | 'BOOKING') => ({ channel, paymentReference: 'pay_1', grandTotal: { currency: 'USD', total: '127.00' } });
  const reembolso = { amount: '27.00', penaltyAmount: '100.00', penaltyWaived: false, percentage: 21.26, reason: 'CUSTOMER_REQUEST' as const };
  it('reembolso en Booking: solo se CALCULA (lo ejecuta Booking)', async () => {
    const d = dobles();
    expect(await settleRefund(sagaFalsa('p').saga, d.deps, { booking: reserva('BOOKING'), ...reembolso })).toMatchObject({ status: 'CALCULATED', refundId: 'REF-SAGA-123' });
    expect(d.payments.refund).not.toHaveBeenCalled();
  });
  it('reembolso web: se EJECUTA en la Payment API (SETTLED)', async () =>
    expect(await settleRefund(sagaFalsa('c').saga, dobles().deps, { booking: reserva('WEB'), ...reembolso })).toMatchObject({ status: 'SETTLED', refundId: 're_1', settledAt: 'ahora' }));
  it('un reembolso de 0 → NOT_REFUNDABLE', async () =>
    expect((await settleRefund(sagaFalsa('c').saga, dobles().deps, { booking: reserva('WEB'), ...reembolso, amount: '0.00' })).status).toBe('NOT_REFUNDABLE'));
});
