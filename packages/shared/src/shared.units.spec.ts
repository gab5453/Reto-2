import type { Request } from 'express';
import type { TokenVerifier } from './auth/service-token.guard.js';
import { CircuitBreaker, isUnavailable } from './clients/circuit-breaker.js';
import { ServiceTokenProvider } from './clients/service-token.js';
import { isValidId, runWithCorrelation } from './correlation/correlation.js';
import {
  AIRCRAFT_LAYOUTS,
  AIRCRAFT_TYPES,
  aircraftTypeSpec,
  buildCabinLayouts,
  configurationOf,
  nextRegistration,
  reaches,
  registerAircraftTypes,
  removeAircraftType,
  seatsByCabin,
  seatsPerRow,
  totalSeats,
} from './domain/aircraft.js';
import { AIRPORTS, distanceKm } from './domain/airports.js';
import { applyDiscount, formatCents, moneyFromCents, sameAmount, scaleMoney, sumMoney, toCents } from './domain/money.js';
import { countPassengers, countsByType, resolvePassengerCounts, seatsRequired } from './domain/passenger-counts.js';
import { redact } from './logging/logging.js';
import { completeProblem, genericCode, ProblemDetailsException } from './problem-details/problem-details.js';
import type { Operation } from './respuesta/contract.js';
import { sanitize } from './respuesta/http-security.js';
import { bookingLinks, holdLinks, publicPath } from './respuesta/links.js';
import { actorOf, authenticate, isPublic, ownerOf, partnerOwnerOf, type Principal } from './respuesta/principal.js';

/**
 * PU-4 (Informacion_General/Pruebas.md §5.1.4): la librería compartida — dinero, aviones, aeropuertos, pasajeros, circuit
 * breaker, token de servicio (con `fetch` simulado), errores, logs sin datos sensibles y la autenticación de los MS de respuesta.
 */

const problemOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem;
  }
};

// ================================================================================================ dinero
describe('dinero en centavos (nunca decimales de punto flotante)', () => {
  it('toCents redondea al centavo y trata vacío como 0', () => {
    expect(toCents('10.005')).toBe(1001);
    expect(toCents('0.1')).toBe(10);
    expect(toCents(undefined)).toBe(0);
  });
  it('0,10 + 0,20 da exactamente 0,30', () =>
    expect(sumMoney([moneyFromCents(10, 0), moneyFromCents(20, 0)])).toEqual({ currency: 'USD', baseFare: '0.30', taxes: '0.00', total: '0.30' }));
  it('moneyFromCents: total = base + impuestos, con 2 decimales', () => expect(moneyFromCents(5900, 2085)).toEqual({ currency: 'USD', baseFare: '59.00', taxes: '20.85', total: '79.85' }));
  it('scaleMoney multiplica base e impuestos por separado', () => expect(scaleMoney(moneyFromCents(5900, 2085), 3)).toEqual({ currency: 'USD', baseFare: '177.00', taxes: '62.55', total: '239.55' }));
  it('applyDiscount: 20 % sobre el precio congelado', () => expect(applyDiscount(moneyFromCents(10000, 0), 20).total).toBe('80.00'));
  it('applyDiscount fuera de 0–100 % lanza', () => {
    expect(() => applyDiscount(moneyFromCents(100, 0), -1)).toThrow(RangeError);
    expect(() => applyDiscount(moneyFromCents(100, 0), 101)).toThrow(RangeError);
  });
  it('sameAmount compara moneda y total al centavo ("10.0" = "10.00")', () => {
    expect(sameAmount({ currency: 'USD', total: '10.0' }, { currency: 'USD', total: '10.00' })).toBe(true);
    expect(sameAmount({ currency: 'EUR', total: '10.00' }, { currency: 'USD', total: '10.00' })).toBe(false);
    expect(sameAmount({ currency: 'USD', total: '10.01' }, { currency: 'USD', total: '10.00' })).toBe(false);
  });
  it('formatCents con negativos (diferencias de precio)', () => expect(formatCents(-3000)).toBe('-30.00'));
});

// ================================================================================================ aviones
describe('tipos de avión (M-2)', () => {
  afterEach(() => removeAircraftType('Prueba 100'));
  it('configuración y asientos por fila', () => {
    expect(configurationOf('ABC-DEF-GHJ')).toBe('3-3-3');
    expect(seatsPerRow('AC-DEFG-HK')).toBe(8);
  });
  it('buildCabinLayouts: Business desde la fila 1, Economy sigue; salida de emergencia en el medio', () =>
    expect(buildCabinLayouts({ seats: 12, configuration: '2-2' }, { seats: 120, configuration: '3-3' })).toEqual([
      { cabinClass: 'BUSINESS', firstRow: 1, lastRow: 3, layout: 'AC-DF' },
      { cabinClass: 'ECONOMY', firstRow: 4, lastRow: 23, layout: 'ABC-DEF', exitRows: [14], extraLegroomRows: [4, 14] },
    ]));
  it('asientos por cabina y total de los 3 tipos de siempre', () => {
    expect(seatsByCabin('Airbus A220-300')).toEqual([
      { cabinClass: 'BUSINESS', seats: 12 },
      { cabinClass: 'ECONOMY', seats: 110 },
    ]);
    expect(totalSeats('Airbus A320neo')).toBe(12 + 27 * 6);
    expect(totalSeats('No existe')).toBe(0);
  });
  it('matrículas: prefijo del tipo + dos dígitos', () => expect(nextRegistration('Boeing 787-9', 7)).toBe('HC-W07'));
  it('alcance: estrictamente menor; sin límite alcanza todo', () => {
    expect(reaches('Airbus A220-300', 1_499)).toBe(true);
    expect(reaches('Airbus A220-300', 1_500)).toBe(false);
    expect(reaches('Boeing 787-9', 20_000)).toBe(true);
    expect(reaches('No existe', 1)).toBe(false);
  });
  it('registrar un tipo lo ordena por alcance; quitarlo lo borra de todo el catálogo', () => {
    registerAircraftTypes([{ name: 'Prueba 100', registrationPrefix: 'HC-P', maxRouteKm: 800, turnaroundMinutes: 30, cabins: buildCabinLayouts({ seats: 4, configuration: '2-2' }, { seats: 30, configuration: '3-3' }) }]);
    expect(AIRCRAFT_TYPES[0]).toBe('Prueba 100');
    expect(aircraftTypeSpec('Prueba 100')).toMatchObject({ registrationPrefix: 'HC-P', maxRouteKm: 800 });
    removeAircraftType('Prueba 100');
    expect(AIRCRAFT_TYPES).not.toContain('Prueba 100');
    expect(AIRCRAFT_LAYOUTS['Prueba 100']).toBeUndefined();
    expect(aircraftTypeSpec('Prueba 100')).toBeUndefined();
  });
  it('registrar de nuevo crea un mapa NUEVO (así el caché de asientos de Offers ve el cambio)', () => {
    const antes = AIRCRAFT_LAYOUTS['Airbus A220-300'];
    registerAircraftTypes([aircraftTypeSpec('Airbus A220-300')!]);
    expect(AIRCRAFT_LAYOUTS['Airbus A220-300']).not.toBe(antes);
    expect(AIRCRAFT_LAYOUTS['Airbus A220-300']).toEqual(antes);
  });
});

describe('aeropuertos y pasajeros', () => {
  it('distanceKm: simétrica, 0 al mismo aeropuerto, UIO–GYE 282 km', () => {
    expect(distanceKm(AIRPORTS['UIO']!, AIRPORTS['GYE']!)).toBe(282);
    expect(distanceKm(AIRPORTS['GYE']!, AIRPORTS['UIO']!)).toBe(282);
    expect(distanceKm(AIRPORTS['UIO']!, AIRPORTS['UIO']!)).toBe(0);
  });
  it('los 24 aeropuertos de provincias del Ecuador están en el catálogo (P-1)', () => expect(Object.values(AIRPORTS).filter((a) => a.country === 'EC').length).toBeGreaterThanOrEqual(24));
  it('resolvePassengerCounts: 1 adulto por defecto', () => expect(resolvePassengerCounts(undefined)).toEqual({ adults: 1, youths: 0, children: 0, infants: 0 }));
  it('seatsRequired no cuenta infantes; countsByType omite los ceros', () => {
    const counts = { adults: 2, youths: 0, children: 1, infants: 1 };
    expect(seatsRequired(counts)).toBe(3);
    expect(countsByType(counts)).toEqual([
      ['ADULT', 2],
      ['CHILD', 1],
      ['INFANT', 1],
    ]);
  });
  it('countPassengers cuenta por tipo', () =>
    expect(countPassengers([{ passengerType: 'ADULT' }, { passengerType: 'INFANT' }, { passengerType: 'ADULT' }])).toEqual({ adults: 2, youths: 0, children: 0, infants: 1 }));
});

// ================================================================================================ circuit breaker
describe('CircuitBreaker: CERRADO → ABIERTO → MEDIO ABIERTO → CERRADO', () => {
  const caido = () => Promise.reject(new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title: 'caído' }));
  const negocio = () => Promise.reject(new ProblemDetailsException({ status: 409, code: 'SEAT_TAKEN', title: 'x' }));
  let breaker: CircuitBreaker;
  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker('MS.G.Offers', 3, 10_000);
  });
  afterEach(() => vi.useRealTimers());

  it('se abre tras 3 fallas seguidas de disponibilidad y entonces falla al instante sin llamar', async () => {
    for (let i = 0; i < 3; i++) await breaker.run(caido).catch(() => undefined);
    expect(breaker.state).toBe('OPEN');
    const llamada = vi.fn();
    expect(await problemOf(breaker.run(llamada))).toMatchObject({ status: 503, code: 'PROVIDER_UNAVAILABLE' });
    expect(llamada).not.toHaveBeenCalled();
  });
  it('un error de negocio (4xx) no cuenta como falla: el servicio respondió', async () => {
    await breaker.run(caido).catch(() => undefined);
    await breaker.run(caido).catch(() => undefined);
    await breaker.run(negocio).catch(() => undefined);
    await breaker.run(caido).catch(() => undefined);
    expect(breaker.state).toBe('CLOSED');
  });
  it('después del plazo pasa a MEDIO ABIERTO y deja pasar UNA sola llamada de prueba', async () => {
    for (let i = 0; i < 3; i++) await breaker.run(caido).catch(() => undefined);
    vi.advanceTimersByTime(10_000);
    expect(breaker.state).toBe('HALF_OPEN');
    let soltar!: (v: string) => void;
    const prueba = breaker.run(() => new Promise<string>((resolve) => (soltar = resolve)));
    expect(await problemOf(breaker.run(async () => 'otra'))).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    soltar('ok');
    expect(await prueba).toBe('ok');
    expect(breaker.state).toBe('CLOSED');
  });
  it('si la llamada de prueba falla, vuelve a ABRIRSE de inmediato', async () => {
    for (let i = 0; i < 3; i++) await breaker.run(caido).catch(() => undefined);
    vi.advanceTimersByTime(10_000);
    await breaker.run(caido).catch(() => undefined);
    expect(breaker.state).toBe('OPEN');
  });
  it('isUnavailable reconoce solo PROVIDER_UNAVAILABLE', () => {
    expect(isUnavailable(new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title: 'x' }))).toBe(true);
    expect(isUnavailable(new ProblemDetailsException({ status: 500, code: 'INTERNAL_ERROR', title: 'x' }))).toBe(false);
    expect(isUnavailable(new Error('x'))).toBe(false);
  });
});

// ================================================================================================ token de servicio
describe('ServiceTokenProvider (D41, D44): token client_credentials', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const responde = (body: unknown, status = 200) => fetchSpy.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-12-01T12:00:00Z'));
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });
  const proveedor = () => new ServiceTokenProvider('http://identity:3001', 'ECOAIRLINES_ESB', 'secreto/con:caracteres');

  it('pide el token con Basic (id y secreto codificados) y grant_type=client_credentials', async () => {
    responde({ access_token: 't-1', expires_in: 300 });
    expect(await proveedor().token()).toBe('t-1');
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://identity:3001/oauth2/token');
    expect(init.body).toBe('grant_type=client_credentials');
    const basic = Buffer.from(String((init.headers as Record<string, string>)['authorization']).slice(6), 'base64').toString('utf8');
    expect(basic).toBe('ECOAIRLINES_ESB:secreto%2Fcon%3Acaracteres');
  });
  it('lo reutiliza hasta 60 s antes de vencer y entonces lo renueva', async () => {
    responde({ access_token: 't-1', expires_in: 300 });
    const tokens = proveedor();
    await tokens.token();
    vi.setSystemTime(Date.parse('2026-12-01T12:03:59Z'));
    await tokens.token();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.parse('2026-12-01T12:04:01Z'));
    await tokens.token();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
  it('si varias llamadas lo piden a la vez, se pide una sola vez', async () => {
    responde({ access_token: 't-1', expires_in: 300 });
    const tokens = proveedor();
    expect(await Promise.all([tokens.token(), tokens.token(), tokens.token()])).toEqual(['t-1', 't-1', 't-1']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('invalidate obliga a pedir uno nuevo (Identity rotó sus claves)', async () => {
    responde({ access_token: 't-1', expires_in: 300 });
    const tokens = proveedor();
    await tokens.token();
    tokens.invalidate();
    await tokens.token();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
  it('credenciales rechazadas o Identity caído → PROVIDER_UNAVAILABLE (no se guarda nada)', async () => {
    responde({ error: 'invalid_client' }, 401);
    expect((await problemOf(proveedor().token()))?.code).toBe('PROVIDER_UNAVAILABLE');
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    expect((await problemOf(proveedor().token()))?.code).toBe('PROVIDER_UNAVAILABLE');
  });
});

// ================================================================================================ errores y logs
describe('ProblemDetails, logs y correlation ID', () => {
  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMIT_EXCEEDED'],
    [503, 'PROVIDER_UNAVAILABLE'],
    [502, 'INTERNAL_ERROR'],
    [422, 'VALIDATION_FAILED'],
  ])('genericCode(%s) = %s', (status, code) => expect(genericCode(status)).toBe(code));
  it('completeProblem agrega instance, correlation_id y timestamp; sin título usa el del status HTTP', () => {
    const problem = runWithCorrelation({ correlationId: 'corr-1', requestId: 'r' }, () => completeProblem({ type: 'about:blank', status: 404, code: 'NOT_FOUND', title: '' }, '/x'));
    expect(problem).toMatchObject({ title: 'Not Found', instance: '/x', correlation_id: 'corr-1', timestamp: expect.any(String) });
  });
  it('redact oculta tokens, contraseñas, tarjetas, documentos, contacto y asistencia, también anidados', () =>
    expect(redact({ authorization: 'Bearer x', user: { email: 'a@x.com', name: 'Ana' }, items: [{ documentNumber: '171', cardNumber: '4111' }], assistance: { type: 'MEDA' } })).toEqual({
      authorization: '[REDACTADO]',
      user: { email: '[REDACTADO]', name: 'Ana' },
      items: [{ documentNumber: '[REDACTADO]', cardNumber: '[REDACTADO]' }],
      assistance: '[REDACTADO]',
    }));
  it('redact no recorre más de 5 niveles (un objeto enorme no bloquea el log)', () => {
    const profundo = { a: { b: { c: { d: { e: { f: { token: 'x' } } } } } } };
    expect(JSON.stringify(redact(profundo))).toContain('"token":"x"');
  });
  it('isValidId: caracteres visibles, sin espacios, hasta 100', () => {
    expect(isValidId('corr-123')).toBe(true);
    expect(isValidId('con espacio')).toBe(false);
    expect(isValidId('x'.repeat(101))).toBe(false);
    expect(isValidId(undefined)).toBe(false);
  });
});

// ================================================================================================ MS de respuesta
describe('sanitize: entrada de los MS de respuesta', () => {
  it('recorta espacios en todos los textos, también anidados', () => expect(sanitize({ nombre: '  Ana ', lista: [' a '] })).toEqual({ nombre: 'Ana', lista: ['a'] }));
  it('un carácter de control → VALIDATION_FAILED con la ruta del campo', () => {
    try {
      sanitize({ pasajeros: [{ nombre: 'A\u0000na' }] });
      expect.unreachable();
    } catch (error) {
      expect((error as ProblemDetailsException).problem.invalidParams?.[0]?.name).toBe('pasajeros[0].nombre');
    }
  });
  it('los saltos de línea y tabulaciones sí se permiten', () => expect(sanitize('línea 1\nlínea 2\t.')).toBe('línea 1\nlínea 2\t.'));
  it('__proto__ y constructor se rechazan (contaminación de prototipos)', () => {
    expect(() => sanitize(JSON.parse('{"__proto__":{"admin":true}}'))).toThrow(ProblemDetailsException);
    expect(() => sanitize({ a: { constructor: 1 } })).toThrow(ProblemDetailsException);
  });
});

describe('enlaces HATEOAS', () => {
  it('una reserva confirmada ofrece sus acciones de postventa', () => {
    const links = bookingLinks({ bookingId: 'b-1', status: 'CONFIRMED' });
    expect(links['cancel']).toEqual({ href: '/api/v2/vuelos/bookings/b-1/cancel', method: 'POST' });
    expect(Object.keys(links)).toHaveLength(10);
  });
  it('una cancelada solo ofrece verla y sus boletos', () => expect(Object.keys(bookingLinks({ bookingId: 'b-1', status: 'CANCELLED' }))).toEqual(['self', 'tickets']));
  it('un hold vigente se puede liberar o reservar; uno vencido, solo ver', () => {
    expect(Object.keys(holdLinks({ holdId: 'h', status: 'HELD' }))).toEqual(['self', 'release', 'book']);
    expect(Object.keys(holdLinks({ holdId: 'h', status: 'EXPIRED' }))).toEqual(['self']);
  });
  it('publicPath agrega /api/v2', () => expect(publicPath('/vuelos/search')).toBe('/api/v2/vuelos/search'));
});

describe('authenticate: quién llama a un MS de respuesta (D22, D29)', () => {
  const operacion = (security: Operation['security']) => ({ security }) as Operation;
  const PROTEGIDA = operacion([{ PartnerOAuth2: ['flights:book'] }]);
  const peticion = (headers: Record<string, string>) => ({ header: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;
  const verificador = (claims: Record<string, unknown> | Error): TokenVerifier => ({ verify: vi.fn(async () => (claims instanceof Error ? Promise.reject(claims) : claims)) }) as unknown as TokenVerifier;
  const conToken = (extra: Record<string, string> = {}) => peticion({ authorization: 'Bearer t', ...extra });

  it('una operación pública no pide token', async () => {
    expect(isPublic(operacion([]))).toBe(true);
    expect(isPublic(operacion([{}]))).toBe(true);
    expect(await authenticate(operacion([]), peticion({}), verificador({}))).toEqual({ kind: 'anonymous' });
  });
  it('sin token → 401; token inválido → 401', async () => {
    expect((await problemOf(authenticate(PROTEGIDA, peticion({}), verificador({}))))?.status).toBe(401);
    expect((await problemOf(authenticate(PROTEGIDA, conToken(), verificador(new Error('firma')))))?.status).toBe(401);
  });
  it('un token de servicio (del ESB) no se acepta aquí → 401', async () =>
    expect((await problemOf(authenticate(PROTEGIDA, conToken(), verificador({ sub: 'ECOAIRLINES_ESB', token_use: 'service', scope: 'flights:book' }))))?.status).toBe(401));
  it('sin el scope → 403', async () =>
    expect((await problemOf(authenticate(PROTEGIDA, conToken(), verificador({ sub: 'BOOKING_PROTOTIPO', token_use: 'partner', scope: 'flights:read' }))))?.code).toBe('FORBIDDEN'));
  it('un partner en una operación solo de la web → 403', async () =>
    expect((await problemOf(authenticate(operacion([{ BearerAuth: [] }]), conToken(), verificador({ sub: 'BOOKING_PROTOTIPO', token_use: 'partner', scope: '' }))))?.code).toBe('FORBIDDEN'));
  it('partner con su usuario final: el dueño es partner:<clientId>:<X-User-Id>', async () => {
    const principal = await authenticate(PROTEGIDA, conToken({ 'x-user-id': 'u-77' }), verificador({ sub: 'BOOKING_PROTOTIPO', token_use: 'partner', scope: 'flights:book' }));
    expect(ownerOf(principal)).toBe('partner:BOOKING_PROTOTIPO:u-77');
    expect(partnerOwnerOf(principal)).toBe('partner:BOOKING_PROTOTIPO');
  });
  it('un X-User-Id con espacios → 400', async () =>
    expect((await problemOf(authenticate(PROTEGIDA, conToken({ 'x-user-id': 'con espacio' }), verificador({ sub: 'BOOKING_PROTOTIPO', token_use: 'partner', scope: 'flights:book' }))))?.code).toBe('VALIDATION_FAILED'));
  it('un usuario de la web: el dueño es su sub y X-User-Id se ignora', async () => {
    const principal = await authenticate(PROTEGIDA, conToken({ 'x-user-id': 'otro' }), verificador({ sub: 'u-1', token_use: 'user', scope: 'flights:book', role: 'CUSTOMER' }));
    expect(ownerOf(principal)).toBe('u-1');
    expect(actorOf(principal)).toBeUndefined();
  });
  it('solo un ADMIN es actor (auditoría)', () => expect(actorOf({ kind: 'user', sub: 'a-1', role: 'ADMIN', scopes: [] })).toBe('a-1'));
  it('ownerOf: un partner sin usuario usa la huella del dispositivo, y sin ninguna → 400', () => {
    expect(ownerOf({ kind: 'partner', clientId: 'BOOKING_PROTOTIPO', scopes: [], fingerprint: 'fp1' })).toBe('partner:BOOKING_PROTOTIPO:fp:fp1');
    expect(() => ownerOf({ kind: 'partner', clientId: 'BOOKING_PROTOTIPO', scopes: [] } as Principal)).toThrow(ProblemDetailsException);
  });
});
