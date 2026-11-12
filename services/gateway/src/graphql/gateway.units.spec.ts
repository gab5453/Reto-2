import { runWithCorrelation } from '@ecoairlines/shared';
import { buildSchema, parse, validate } from 'graphql';
import { formatError, graphqlCode, problemError, setProblemCodes } from './errors.js';
import { depthLimit, MAX_COMPLEXITY, MAX_DEPTH } from './limits.js';
import {
  adminBooking,
  agreement,
  agreementRequest,
  booking,
  bookingEvent,
  cancellation,
  enumToEvent,
  enumToScope,
  eventNameOf,
  eventToEnum,
  flightOperation,
  indicators,
  maskSecret,
  partner,
  scopesFrom,
  scopeToEnum,
  trace,
  webhook,
  webPayment,
} from './mappers.js';

/**
 * PU-4 (Informacion_General/Pruebas.md §5.1.4): el gateway, solo — conversiones entre REST y `gateway.graphql`, errores con
 * forma de ProblemDetails y el límite de profundidad de las consultas. Sin Apollo ni red.
 */

describe('nombres de enums: scopes y eventos', () => {
  it('scopes: flights:read ↔ FLIGHTS_READ', () => {
    expect(scopeToEnum('flights:read')).toBe('FLIGHTS_READ');
    expect(enumToScope('FLIGHTS_READ')).toBe('flights:read');
  });
  it('eventos: booking.ticket_issued ↔ BOOKING_TICKET_ISSUED (ida y vuelta sin perder el guion bajo)', () => {
    expect(eventToEnum('booking.ticket_issued')).toBe('BOOKING_TICKET_ISSUED');
    expect(enumToEvent('BOOKING_TICKET_ISSUED')).toBe('booking.ticket_issued');
    expect(enumToEvent(eventToEnum('flight.status_changed'))).toBe('flight.status_changed');
  });
  it('eventNameOf quita el prefijo del tipo del CloudEvent', () => expect(eventNameOf('ec.edu.epn.booking.vuelos.booking.confirmed')).toBe('booking.confirmed'));
  it('scopesFrom deja solo los scopes que el esquema conoce', () => expect(scopesFrom('flights:read ecoairlines:esb  flights:book', new Set(['FLIGHTS_READ', 'FLIGHTS_BOOK']))).toEqual(['FLIGHTS_READ', 'FLIGHTS_BOOK']));
});

describe('mappers REST → GraphQL', () => {
  it('el pago de la web es siempre de la pasarela propia; nunca lleva datos de tarjeta', () => {
    expect(webPayment({ paymentReference: 'pay_1', cardNumber: '4111' } as never)).toEqual({ paymentReference: 'pay_1', provider: 'AIRLINE_DIRECT' });
    expect(webPayment(null)).toBeUndefined();
  });
  it('el secreto de un webhook nunca se devuelve: solo sus últimos 4', () => {
    expect(maskSecret('1234')).toBe('••••1234');
    expect(webhook({ id: 'w', events: ['booking.confirmed'], secretHint: '9876' })).toMatchObject({ events: ['BOOKING_CONFIRMED'], secret: '••••9876' });
  });
  it('booking: las listas que GraphQL exige siempre existen', () =>
    expect(booking({ bookingId: 'b', passengers: [{ passengerId: 'P1' }] })).toMatchObject({ itineraries: [], changes: [], passengers: [{ passengerId: 'P1', assignedSeats: [], extraBaggage: [] }] }));
  it('adminBooking: la asistencia médica no llega al navegador, solo qué pasajeros la tienen', () => {
    const view = adminBooking({ bookingId: 'b', ownerId: 'partner:BOOKING_PROTOTIPO:u-7', assistance: [{ passengerId: 'P1', type: 'MEDA', notes: 'insulina' }, { passengerId: 'P1', type: 'WCHR' }] });
    expect(view.passengersWithAssistance).toEqual(['P1']);
    expect(view).not.toHaveProperty('assistance');
    expect(JSON.stringify(view)).not.toMatch(/MEDA|insulina/);
    expect(view.partnerUserId).toBe('u-7');
  });
  it('adminBooking: una reserva de la web no tiene usuario de partner', () => expect(adminBooking({ bookingId: 'b', ownerId: 'cliente-1' }).partnerUserId).toBeNull());
  it('partner: los scopes como enum y nunca el secreto', () => {
    const view = partner({ clientId: 'X', name: 'X', scopes: ['flights:read'], status: 'ACTIVE', createdAt: 'x', clientSecret: 'NO' });
    expect(view.scopes).toEqual(['FLIGHTS_READ']);
    expect(view).not.toHaveProperty('clientSecret');
  });
  it('acuerdo de promociones: ida (contrato v2 en español) y vuelta', () => {
    const contrato = { partnerId: 'X', permite_promociones: true, porcentaje_descuento_maximo: 15, rutas_habilitadas: ['UIO-GYE'] };
    const view = agreement(contrato);
    expect(view).toMatchObject({ allowsPromotions: true, maxDiscountPercentage: 15, enabledRoutes: ['UIO-GYE'], enabledCabins: [], validUntil: null });
    expect(agreementRequest(view)).toMatchObject({ permite_promociones: true, porcentaje_descuento_maximo: 15, rutas_habilitadas: ['UIO-GYE'] });
  });
  it('cancelación: un 202 o CANCELLATION_PENDING es ACCEPTED; si no, COMPLETED', () => {
    expect(cancellation(202, { bookingId: 'b' }).outcome).toBe('ACCEPTED');
    expect(cancellation(200, { bookingId: 'b', status: 'CANCELLED', inventoryRestoration: { seatsReleased: 2 } })).toMatchObject({ outcome: 'COMPLETED', seatsReleased: 2, refund: null });
  });
  it('operaciones: los estados de los asientos con los nombres del esquema', () =>
    expect(flightOperation({ cabins: [{ seatsByStatus: { AVAILABLE: 5, CHECKED_IN: 2 } }] }).cabins[0].seatsByStatus).toEqual({ available: 5, held: 0, booked: 0, ticketed: 0, checkedIn: 2, boarded: 0 }));
  it('indicadores con valores por defecto si un servicio no respondió', () => expect(indicators({ generatedAt: 'x' })).toMatchObject({ totalBookings: 0, usersTotal: 0, bookingsByChannel: { web: 0, booking: 0 } }));
  it('traza por correlation ID: los campos de log pasan a camelCase', () =>
    expect(trace({ correlationId: 'c', steps: [{ timestamp: 't', service: 's', operation: 'o', status: 200, latency_ms: 12, request_id: 'r' }] }).steps[0]).toEqual({
      timestamp: 't',
      service: 's',
      operation: 'o',
      status: 200,
      latencyMs: 12,
      requestId: 'r',
      traceId: null,
    }));
  it('bookingEvent: un evento que el esquema no conoce no se envía; uno conocido lleva solo lo público', () => {
    const conocido = new Set(['BOOKING_CONFIRMED']);
    expect(bookingEvent({ type: 'ec.edu.epn.booking.vuelos.booking.secret_event', data: {} }, conocido)).toBeUndefined();
    expect(bookingEvent({ id: 'e', type: 'ec.edu.epn.booking.vuelos.booking.confirmed', time: 't', correlationid: 'c', data: { bookingId: 'b', pnr: 'P', documento: '171' } }, conocido)).toEqual({
      eventId: 'e',
      eventType: 'BOOKING_CONFIRMED',
      occurredAt: 't',
      apiVersion: '2.0',
      data: { bookingId: 'b', pnr: 'P', status: null, refundAmount: null },
      correlationId: 'c',
    });
  });
});

describe('errores GraphQL con forma de ProblemDetails', () => {
  beforeAll(() => setProblemCodes(['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED', 'INTERNAL_ERROR', 'PROVIDER_UNAVAILABLE', 'RATE_LIMIT_EXCEEDED', 'SEAT_TAKEN', 'EMAIL_ALREADY_REGISTERED']));

  it('UNAUTHORIZED del REST se llama UNAUTHENTICATED en GraphQL', () => expect(graphqlCode({ status: 401, code: 'UNAUTHORIZED' })).toBe('UNAUTHENTICATED'));
  it('un código del contrato se conserva', () => expect(graphqlCode({ status: 409, code: 'SEAT_TAKEN' })).toBe('SEAT_TAKEN'));
  it('un código propio publicado en `type` recupera su nombre', () => expect(graphqlCode({ status: 409, code: 'X', type: 'urn:ecoairlines:problema:EMAIL_ALREADY_REGISTERED' })).toBe('EMAIL_ALREADY_REGISTERED'));
  it('un código desconocido cae al genérico de su status', () => {
    expect(graphqlCode({ status: 409, code: 'INVENTADO' })).toBe('VALIDATION_FAILED');
    expect(graphqlCode({ status: 503, code: 'INVENTADO' })).toBe('PROVIDER_UNAVAILABLE');
    expect(graphqlCode({ status: 502 })).toBe('INTERNAL_ERROR');
  });
  it('problemError replica el ProblemDetails en extensions, con el correlation ID', () => {
    const error = runWithCorrelation({ correlationId: 'corr-9', requestId: 'r' }, () =>
      problemError({ status: 429, code: 'RATE_LIMIT_EXCEEDED', title: 'Espere', retryAfter: 3, invalidParams: [{ name: 'x', reason: 'y' }] }),
    );
    expect(error.message).toBe('Espere');
    expect(error.extensions).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', status: 429, instance: '/api/graphql', correlation_id: 'corr-9', retryAfter: 3, invalidParams: [{ name: 'x', reason: 'y' }] });
  });
  it('formatError: un error nuestro sale tal cual (sin stacktrace)', () => {
    const ours = formatError({ message: 'Asiento', extensions: { code: 'SEAT_TAKEN', status: 409, stacktrace: ['...'] } }, vi.fn());
    expect(ours.extensions).toEqual({ code: 'SEAT_TAKEN', status: 409 });
  });
  it('formatError: un documento inválido → VALIDATION_FAILED (400) sin registrarlo como error', () => {
    const log = vi.fn();
    expect(formatError({ message: 'Cannot query field "x"', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }, log).extensions).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    expect(log).not.toHaveBeenCalled();
  });
  it('formatError: un error inesperado → INTERNAL_ERROR sin filtrar el mensaje interno, y se registra', () => {
    const log = vi.fn();
    const formatted = formatError({ message: 'TypeError: cannot read x of undefined at /app/src/resolvers.ts:42' }, log);
    expect(formatted).toMatchObject({ message: 'Error interno.', extensions: { code: 'INTERNAL_ERROR', status: 500 } });
    expect(JSON.stringify(formatted)).not.toContain('resolvers.ts');
    expect(log).toHaveBeenCalled();
  });
});

describe('límite de profundidad de las consultas', () => {
  const schema = buildSchema('type Nodo { id: ID, hijo: Nodo } type Query { raiz: Nodo }');
  const consulta = (niveles: number) => `{ raiz ${'{ hijo '.repeat(niveles - 2)}{ id }${' }'.repeat(niveles - 2)} }`;
  const errores = (texto: string, max = 4) => validate(schema, parse(texto), [depthLimit(max)]).map((e) => e.message);

  it('el contrato fija profundidad 10 y complejidad 1000', () => expect([MAX_DEPTH, MAX_COMPLEXITY]).toEqual([10, 1000]));
  it('justo en el máximo pasa; un nivel más se rechaza', () => {
    expect(errores(consulta(4))).toEqual([]);
    expect(errores(consulta(5))[0]).toBe('La consulta tiene profundidad 5; el máximo es 4.');
  });
  it('los fragmentos se expanden: no sirven para esquivar el límite', () =>
    expect(errores('{ raiz { hijo { ...F } } } fragment F on Nodo { hijo { hijo { id } } }')).toHaveLength(1));
  it('__typename no cuenta como nivel', () => expect(errores('{ raiz { hijo { hijo { id __typename } } } }')).toEqual([]));
});
