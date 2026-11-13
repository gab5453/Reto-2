import { ProblemDetailsException } from '@ecoairlines/shared';
import { EsbProblem, type EsbCall, type EsbResponse, type Handler, type OperationContext, type ResponseServiceDefinition, sagaOutcome, stillRunning, withQuery } from '@ecoairlines/shared/respuesta/index.js';

/**
 * MS.Admin (contract/ms-admin.openapi.yaml): el panel de administración. Solo token de usuario con `ecoairlines:admin`
 * (rol ADMIN); cada llamada lleva `X-Actor-Id` = `sub` del administrador (auditoría y acceso a datos de cualquier dueño).
 */
export const SERVICE = { name: 'ms-admin', version: '1.0.0' };
export const CLIENT_ID = 'ECOAIRLINES_MS_ADMIN';
export const DEFAULT_PORT = 5005;

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Method = EsbCall['method'];

function actorOf(context: OperationContext): string {
  const actorId = context.actor();
  if (!actorId) throw new ProblemDetailsException({ status: 403, code: 'FORBIDDEN', title: 'Solo un administrador de EcoAirlines.' });
  return actorId;
}

const cacheHeaders = (response: EsbResponse): Record<string, string> => {
  const value = response.headers.get('cache-control');
  return value ? { 'Cache-Control': value } : {};
};

/** Una operación = una llamada al ESB con `X-Actor-Id`; responde el status y el cuerpo del MS.G (proyectados al contrato). */
const esb =
  (method: Method, path: (context: OperationContext) => string, options: { status?: number; body?: boolean } = {}): Handler =>
  async (context) => {
    const response = await context.esb({ method, path: path(context), ...(options.body ? { json: context.body } : {}), actorId: actorOf(context) });
    return { status: options.status ?? response.status, ...(response.status === 204 ? {} : { body: response.body }), headers: cacheHeaders(response) };
  };

const p = (context: OperationContext, name: string) => encodeURIComponent(String(context.params[name]));

/** Saga "Publicar horario": responde la ruta guardada (`ScheduledRoute`); si sigue en curso, `503` con `Retry-After`. */
const routeSaga =
  (method: Method, path: (context: OperationContext) => string, status: number): Handler =>
  async (context) => {
    const actorId = actorOf(context);
    const response = await context.esb({ method, path: path(context), ...(method === 'DELETE' ? {} : { json: context.body }), actorId });
    const outcome = await sagaOutcome(context, response, { actorId });
    if (!outcome.done) throw stillRunning(outcome.sagaId);
    return status === 204 ? { status } : { status, body: (outcome.body as Any)['route'] };
  };

/** Precios por clase, tarifa base y precios por ruta (P-1) + el acuerdo de promociones de cada partner que tenga uno. */
async function pricesView(context: OperationContext, actorId: string) {
  const [prices, pricing, partners] = await Promise.all([
    context.esb({ method: 'GET', path: '/router/schedule/fare-prices', actorId }),
    context.esb({ method: 'GET', path: '/router/schedule/pricing', actorId }),
    context.esb<{ items: { clientId: string }[] }>({ method: 'GET', path: '/router/identity/partners?limit=100', actorId }),
  ]);
  const agreements = await Promise.all(
    partners.body.items.map((partner) =>
      context.esb({ method: 'GET', path: `/router/schedule/promotion-agreements/${encodeURIComponent(partner.clientId)}`, actorId }).then(
        // `proveedor_codigo` es la aerolínea: el partner del acuerdo solo se sabe aquí.
        (response) => ({ ...(response.body as object), partnerId: partner.clientId }),
        (error: unknown) => {
          if (error instanceof EsbProblem && error.problem.status === 404) return undefined;
          throw error;
        },
      ),
    ),
  );
  return { prices: prices.body, pricing: pricing.body, promotions: agreements.filter((agreement) => agreement !== undefined) };
}

/** Un saga del panel que no documenta `202`: su resultado, o `503` para reintentar. */
async function saga(context: OperationContext, call: EsbCall, actorId: string): Promise<unknown> {
  const response = await context.esb(call);
  const outcome = await sagaOutcome(context, response, { actorId });
  if (!outcome.done) throw stillRunning(outcome.sagaId);
  return outcome.body;
}

export const adminHandlers: Record<string, Handler> = {
  getIndicators: esb('GET', (c) => withQuery('/composition/indicators', c.query)),

  // usuarios y roles (Identity)
  listUsers: esb('GET', (c) => withQuery('/router/identity/users', c.query)),
  createUser: esb('POST', () => '/router/identity/users', { body: true, status: 201 }),
  getUser: esb('GET', (c) => `/router/identity/users/${p(c, 'sub')}`),
  changeUserRole: esb('PUT', (c) => `/router/identity/users/${p(c, 'sub')}/role`, { body: true }),
  changeUserStatus: esb('PUT', (c) => `/router/identity/users/${p(c, 'sub')}/status`, { body: true }),
  listRoles: esb('GET', () => '/router/identity/roles'),

  // partners (el secreto nuevo se muestra una sola vez, con Cache-Control: no-store)
  listPartners: esb('GET', (c) => withQuery('/router/identity/partners', c.query)),
  createPartner: esb('POST', () => '/router/identity/partners', { body: true, status: 201 }),
  getPartner: esb('GET', (c) => `/router/identity/partners/${p(c, 'clientId')}`),
  changePartnerStatus: esb('PUT', (c) => `/router/identity/partners/${p(c, 'clientId')}/status`, { body: true }),
  rotatePartnerSecret: esb('POST', (c) => `/router/identity/partners/${p(c, 'clientId')}/secret`, { status: 200 }),

  // precios y promociones
  getPrices: async (context) => ({ status: 200, body: await pricesView(context, actorOf(context)) }),
  /** Un solo «Guardar»: la saga de precios y, si viene, la del acuerdo (cada una valida y publica en Offers). */
  savePrices: async (context) => {
    const actorId = actorOf(context);
    const body = context.body as { prices?: unknown; pricing?: unknown; promotion?: { partnerId: string; agreement: unknown } };
    if (body.prices) await saga(context, { method: 'PUT', path: '/sagas/fare-prices', json: body.prices, actorId }, actorId);
    // P-1: tarifa base y/o el precio exacto de los paquetes de una ruta (misma saga "Guardar precios").
    if (body.pricing) await saga(context, { method: 'PUT', path: '/sagas/pricing', json: body.pricing, actorId }, actorId);
    if (body.promotion) await saga(context, { method: 'PUT', path: `/sagas/promotion-agreements/${encodeURIComponent(body.promotion.partnerId)}`, json: body.promotion.agreement, actorId }, actorId);
    return { status: 200, body: await pricesView(context, actorId) };
  },
  getReferencePrices: esb('GET', () => '/router/schedule/fare-prices/reference'),
  getPriceHistory: esb('GET', (c) => withQuery('/router/schedule/fare-prices/history', c.query)),

  // rutas (saga "Publicar horario"), flota y horario
  listRoutes: esb('GET', () => '/router/schedule/routes'),
  createRoute: routeSaga('POST', () => '/sagas/routes', 201),
  getRoute: esb('GET', (c) => `/router/schedule/routes/${p(c, 'routeId')}`),
  updateRoute: routeSaga('PUT', (c) => `/sagas/routes/${p(c, 'routeId')}`, 200),
  deleteRoute: routeSaga('DELETE', (c) => `/sagas/routes/${p(c, 'routeId')}`, 204),
  // M-1: catálogo de aeropuertos (la lista la da la consulta pública de MS.Vuelos).
  createAirport: esb('POST', () => '/router/schedule/airports', { body: true, status: 201 }),
  updateAirport: esb('PUT', (c) => `/router/schedule/airports/${p(c, 'code')}`, { body: true }),
  deleteAirport: esb('DELETE', (c) => `/router/schedule/airports/${p(c, 'code')}`, { status: 204 }),
  listAircraftTypes: esb('GET', () => '/router/schedule/aircraft-types'),
  // M-2: catálogo de tipos de avión (el nombre va codificado en la ruta).
  createAircraftType: esb('POST', () => '/router/schedule/aircraft-types', { body: true, status: 201 }),
  updateAircraftType: esb('PUT', (c) => `/router/schedule/aircraft-types/${p(c, 'aircraftType')}`, { body: true }),
  deleteAircraftType: esb('DELETE', (c) => `/router/schedule/aircraft-types/${p(c, 'aircraftType')}`, { status: 204 }),
  listAircraft: esb('GET', () => '/router/schedule/aircraft'),
  createAircraft: esb('POST', () => '/router/schedule/aircraft', { body: true, status: 201 }),
  getAircraft: esb('GET', (c) => `/router/schedule/aircraft/${p(c, 'registration')}`),
  updateAircraft: esb('PUT', (c) => `/router/schedule/aircraft/${p(c, 'registration')}`, { body: true }),
  deleteAircraft: esb('DELETE', (c) => `/router/schedule/aircraft/${p(c, 'registration')}`, { status: 204 }),
  getFleetSchedule: esb('GET', (c) => withQuery('/router/schedule/fleet-schedule', c.query)),

  // reservas de todos los canales, solo lectura (panel O-1): el MS.G las da completas porque llega `X-Actor-Id`
  listAdminBookings: esb('GET', (c) => withQuery('/router/bookings/bookings', c.query)),
  getAdminBooking: esb('GET', (c) => `/router/bookings/bookings/${p(c, 'bookingId')}`),
  // historial (O-2): sagas y eventos con sus entregas, por la composición del ESB
  getAdminBookingTimeline: esb('GET', (c) => `/composition/bookings/${p(c, 'bookingId')}/timeline`),
  // reportes (O-3): ventas por día, canal y ruta, y la liquidación con Booking
  getSalesReport: esb('GET', (c) => withQuery('/router/bookings/reports/sales', c.query)),

  // asistencia por vuelo (dato de salud: solo el administrador; nunca en logs)
  listFlightAssistance: esb('GET', (c) => withQuery(`/composition/flights/${p(c, 'flightNumber')}/assistance`, c.query)),
  getFlightDelayImpact: esb('GET', (c) => withQuery(`/composition/flights/${p(c, 'flightNumber')}/delay-impact`, c.query)),
  /**
   * Cancelación de administrador (1.13.0): la saga «Cancelar» con `SAGA_COMPENSATION`, que no exige cotización ni aplica la regla
   * del check-in (la misma vía con que EcoAirlines cancela las reservas de un vuelo cancelado). Solo el administrador y con motivo.
   */
  adminCancelBooking: async (context) => {
    const actorId = actorOf(context);
    const bookingId = p(context, 'bookingId');
    const reason = `Cancelación de administrador: ${String((context.body as { reason: string }).reason).trim()}`.slice(0, 200);
    await saga(context, { method: 'POST', path: `/sagas/bookings/${bookingId}/cancel`, json: { reasonCode: 'SAGA_COMPENSATION', reason }, actorId }, actorId);
    return { status: 200, body: { bookingId: context.params['bookingId'], status: 'CANCELLED' } };
  },
  /**
   * Check-in en mostrador (1.14.0, D57): la saga «Check-in» del pasajero, ejecutada por el administrador (`X-Actor-Id`) para
   * todos los pasajeros pendientes de la reserva, con las mismas reglas. Emite `booking.checked_in` (a Booking, si es su reserva).
   */
  adminCheckIn: async (context) => {
    const actorId = actorOf(context);
    return { status: 200, body: await saga(context, { method: 'POST', path: `/sagas/bookings/${p(context, 'bookingId')}/check-in`, actorId }, actorId) };
  },
  /** Pases de cualquier reserva, para reimprimirlos en mostrador: la composición del ESB (CheckIn + puerta de FlightStatus). */
  listAdminBoardingPasses: esb('GET', (c) => `/composition/bookings/${p(c, 'bookingId')}/boarding-passes`),
  markAssistanceReady: async (context) => {
    const actorId = actorOf(context);
    return { status: 200, body: await saga(context, { method: 'PUT', path: `/sagas/bookings/${p(context, 'bookingId')}/assistance-ready`, json: context.body, actorId }, actorId) };
  },

  // eventos y telemetría
  listEventHistory: esb('GET', (c) => withQuery('/router/webhooks/history', c.query)),
  getServicesHealth: esb('GET', () => '/composition/services-health'),
  // Plataforma de observabilidad (V2.16, D50), por la composición del ESB. Si una pieza no responde: 503 del contrato.
  getLatency: esb('GET', (c) => withQuery('/composition/telemetry/latency', c.query)),
  getCorrelationTrace: esb('GET', (c) => withQuery(`/composition/telemetry/traces/${encodeURIComponent(c.params['correlationId'])}`, c.query)),
  // T-4: vista «Recorrido» y mapa del sistema en vivo.
  // El ESB consulta a Tempo con un plazo mayor (8 s): aquí se le espera hasta 12 s, por debajo de los 15 s del gateway.
  getJourney: async (context) => {
    const response = await context.esb({ method: 'GET', path: withQuery(`/composition/telemetry/journeys/${encodeURIComponent(context.params['correlationId'])}`, context.query), actorId: actorOf(context), timeoutMs: 12_000 });
    return { status: response.status, body: response.body };
  },
  getSystemMap: esb('GET', () => '/composition/telemetry/system-map'),
  getQueues: esb('GET', () => '/composition/telemetry/queues'),
  getAlerts: esb('GET', () => '/composition/telemetry/alerts'),
  getBookingIntegration: esb('GET', () => '/composition/booking-integration'),
};

export function definition(_env: NodeJS.ProcessEnv = process.env): ResponseServiceDefinition {
  return { ...SERVICE, contract: 'ms-admin.openapi.yaml', handlers: adminHandlers };
}
