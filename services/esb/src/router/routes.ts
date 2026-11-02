import type { RestService } from '../config/config.js';

/**
 * Tabla del **Enrutador** (PLAN.md §4.2): una petición, un MS.G, sin coordinación. Solo lo que está aquí se reenvía; lo que
 * coordina varios MS.G es del orquestador (sagas, V2.10) o de la composición. Cada ruta es idéntica a la del contrato del
 * MS.G (`contract/ms-g-*.openapi.yaml`): una prueba lo comprueba, y `contract/esb.openapi.yaml` (`x-esb-routes`) la publica.
 *
 * El ESB la expone como `/router/<servicio><ruta>`, p. ej. `GET /router/bookings/bookings/{bookingId}`.
 */
export interface RestRoute {
  service: RestService;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** operationId en el contrato del MS.G. */
  operationId: string;
  /**
   * Sin el token del ESB: `POST /oauth2/token`, donde el partner se autentica con sus credenciales en el cuerpo
   * (`client_secret_post`; el MS de respuesta convierte el Basic del partner, porque su propio `Authorization` es el token
   * de servicio con el que llama al ESB).
   */
  withoutServiceToken?: true;
}

const r = (service: RestService, method: RestRoute['method'], path: string, operationId: string, extra: Partial<RestRoute> = {}): RestRoute => ({ service, method, path, operationId, ...extra });

export const REST_ROUTES: readonly RestRoute[] = [
  // Identity: registro, login, token de partner; admin: usuarios, rol, bloqueo y partners.
  r('identity', 'POST', '/auth/register', 'register'),
  r('identity', 'POST', '/auth/login', 'login'),
  r('identity', 'POST', '/oauth2/token', 'issuePartnerToken', { withoutServiceToken: true }),
  r('identity', 'GET', '/users', 'listUsers'),
  r('identity', 'POST', '/users', 'createUser'),
  r('identity', 'GET', '/users/summary', 'getUserSummary'),
  r('identity', 'GET', '/users/{sub}', 'getUser'),
  r('identity', 'PUT', '/users/{sub}/role', 'changeUserRole'),
  r('identity', 'PUT', '/users/{sub}/status', 'changeUserStatus'),
  r('identity', 'GET', '/partners', 'listPartners'),
  r('identity', 'POST', '/partners', 'createPartner'),
  r('identity', 'GET', '/partners/{clientId}', 'getPartner'),
  r('identity', 'PUT', '/partners/{clientId}/status', 'changePartnerStatus'),
  r('identity', 'POST', '/partners/{clientId}/secret', 'rotatePartnerSecret'),
  r('identity', 'GET', '/roles', 'listRoles'),
  // Schedule: precios (lectura, «Rellenar», historial), acuerdo de promociones (lectura), rutas y horario (lectura), flota.
  r('schedule', 'GET', '/fare-prices', 'getFarePrices'),
  r('schedule', 'GET', '/fare-prices/reference', 'getReferenceFarePrices'),
  r('schedule', 'GET', '/fare-prices/history', 'getFarePriceHistory'),
  r('schedule', 'GET', '/promotion-agreements/{partnerId}', 'getPromotionAgreement'),
  r('schedule', 'GET', '/routes', 'listRoutes'),
  r('schedule', 'GET', '/routes/{routeId}', 'getRoute'),
  r('schedule', 'GET', '/timetable', 'getTimetable'),
  r('schedule', 'GET', '/fleet-schedule', 'getFleetSchedule'),
  r('schedule', 'GET', '/aircraft-types', 'listAircraftTypes'),
  r('schedule', 'GET', '/aircraft', 'listAircraft'),
  r('schedule', 'POST', '/aircraft', 'createAircraft'),
  r('schedule', 'GET', '/aircraft/{registration}', 'getAircraft'),
  r('schedule', 'PUT', '/aircraft/{registration}', 'updateAircraft'),
  r('schedule', 'DELETE', '/aircraft/{registration}', 'deleteAircraft'),
  // FlightStatus: estado de vuelo (lectura) e historial.
  r('flight-status', 'GET', '/flights', 'listFlights'),
  r('flight-status', 'GET', '/flights/{flightNumber}/status', 'getFlightStatus'),
  r('flight-status', 'GET', '/flights/{flightNumber}/status/history', 'getFlightStatusHistory'),
  // Customers: perfil con la asistencia predeterminada.
  r('customers', 'GET', '/profile', 'getProfile'),
  r('customers', 'PUT', '/profile', 'saveProfile'),
  // Webhooks: suscripciones, feed `GET /vuelos/eventos`, historial y estadísticas.
  r('webhooks', 'GET', '/subscriptions', 'listSubscriptions'),
  r('webhooks', 'POST', '/subscriptions', 'createSubscription'),
  r('webhooks', 'DELETE', '/subscriptions/{id}', 'deleteSubscription'),
  r('webhooks', 'GET', '/events', 'listOutboxEvents'),
  r('webhooks', 'GET', '/history', 'listEventHistory'),
  r('webhooks', 'GET', '/stats', 'getDeliveryStats'),
  // Bookings: consultar reservas y boletos; pedir o cambiar la asistencia médica.
  r('bookings', 'GET', '/bookings', 'listBookings'),
  r('bookings', 'GET', '/bookings/{bookingId}', 'getBooking'),
  r('bookings', 'GET', '/bookings/{bookingId}/tickets', 'listTickets'),
  r('bookings', 'GET', '/bookings/{bookingId}/tickets/{ticketId}', 'getTicket'),
  r('bookings', 'PUT', '/bookings/{bookingId}/passengers/{passengerId}/assistance', 'saveAssistance'),
  r('bookings', 'DELETE', '/bookings/{bookingId}/passengers/{passengerId}/assistance', 'deleteAssistance'),
  // CheckIn: el check-in registrado. Los pases de abordar van por la composición (dueño en Bookings + puerta vigente, V2.12).
  r('check-in', 'GET', '/check-ins/{bookingId}', 'getCheckIn'),
];

/**
 * RPC de MS.G.Offers que pasan por el enrutador (`POST /router/offers/<Rpc>`, cuerpo y respuesta con el mapeo JSON de proto3):
 * buscar, mapa de asientos con estado, y crear, consultar y liberar un hold. Los demás son pasos de sagas o de la composición.
 */
export const OFFERS_ROUTES = ['Search', 'GetSeatMap', 'CreateHold', 'GetHold', 'ReleaseHold'] as const;

export interface MatchedRoute {
  route: RestRoute;
  params: Record<string, string>;
}

const compiled = REST_ROUTES.map((route) => ({
  route,
  names: [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!),
  // `/users/summary` va antes que `/users/{sub}` en la tabla: gana la primera que coincide.
  regex: new RegExp(`^${route.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '([^/]+)')}$`),
}));

/** Busca la ruta de `service` que coincide con `method` y `path` (sin query). `undefined` → 404 (la ruta no existe o no es del enrutador). */
/** `..` o `.` (también codificados) harían que la URL se normalice hacia otra ruta del MS.G que no está en la tabla. */
const dotSegment = (path: string) => path.split('/').some((segment) => /^(\.|%2e){1,2}$/i.test(segment));

export function matchRoute(service: string, method: string, path: string): MatchedRoute | undefined {
  if (dotSegment(path)) return undefined;
  for (const candidate of compiled) {
    if (candidate.route.service !== service || candidate.route.method !== method) continue;
    const match = candidate.regex.exec(path);
    if (match) return { route: candidate.route, params: Object.fromEntries(candidate.names.map((name, i) => [name, match[i + 1]!])) };
  }
  return undefined;
}

/** Hay alguna ruta con ese path aunque con otro método (→ 405 en vez de 404). */
export const pathExists = (service: string, path: string) => !dotSegment(path) && compiled.some((c) => c.route.service === service && c.regex.test(path));
