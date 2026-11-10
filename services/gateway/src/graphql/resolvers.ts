import type { GraphQLFieldResolver } from 'graphql';
import type { GqlContext } from './context.js';
import { requireUser } from './context.js';
import { GraphQLError } from 'graphql';
import * as map from './mappers.js';

/**
 * Resolvers de `gateway.graphql`. Cada campo llama a UNA operación REST de un MS de respuesta (la flecha
 * "→ MS.<servicio> <operationId>" del contrato), con el token del usuario: la web pasa por la misma validación, seguridad y
 * sagas que Booking. Nada aquí llama al ESB ni a un MS.G.
 */
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Resolver = GraphQLFieldResolver<Any, GqlContext, Any>;

export interface ResolverOptions {
  /** Valores de los enums `Scope` y `WebhookEventType` (del esquema). */
  scopes: Set<string>;
  events: Set<string>;
  /** La suscripción `bookingEvents` (ver `subscriptions.ts`). */
  bookingEvents: Resolver;
  /** T-5: `traceProgress` y `liveSystemMap` (ver `live-topics.ts`). */
  traceProgress: Resolver;
  liveSystemMap: Resolver;
  /** Límite de búsquedas por `X-Device-Fingerprint` (lanza `RATE_LIMIT_EXCEEDED`). */
  checkSearchLimit: (fingerprint: string | undefined) => void;
}

const id = (value: unknown) => encodeURIComponent(String(value));
const isNotFound = (error: unknown) => error instanceof GraphQLError && error.extensions['code'] === 'NOT_FOUND';

/** `COMPLETED` (200/201) o `ACCEPTED` (202 o un estado "en curso" de la reserva). */
const outcome = (status: number, bookingStatus?: string) =>
  status === 202 || bookingStatus === 'TICKET_ISSUING' || bookingStatus === 'CHANGE_PENDING' ? 'ACCEPTED' : 'COMPLETED';

export function createResolvers(options: ResolverOptions) {
  const Query: Record<string, Resolver> = {
    // --------------------------------------------------------------------------------------------- búsqueda y catálogo
    /** Requiere `X-Device-Fingerprint` (la valida MS.Vuelos); el gateway aplica su límite por huella antes de llamar. */
    searchFlights: async (_, { input }, { ms, fingerprint }) => {
      options.checkSearchLimit(fingerprint);
      return (await ms.call('MS.Vuelos', 'POST', '/vuelos/search', { body: input })).body;
    },
    seatMap: async (_, { offerId, segmentId }, { ms }) => (await ms.call('MS.Vuelos', 'GET', `/vuelos/offers/${id(offerId)}/seatmap`, { query: { segmentId } })).body,
    flightStatus: async (_, { flightNumber, date }, { ms }) => (await ms.call('MS.Vuelos', 'GET', `/vuelos/flights/${id(flightNumber)}/status`, { query: { date } })).body,

    // ---------------------------------------------------------------------------------------------------- hold y reservas
    hold: async (_, { holdId }, { ms }) => ({ ttlMinutes: null, ...(await ms.call('MS.Reservas', 'GET', `/vuelos/offers/hold/${id(holdId)}`)).body }),
    bookings: async (_, { filter, limit, cursor }, { ms }) => {
      const page = (await ms.call<Any>('MS.Reservas', 'GET', '/vuelos/bookings', { query: { ...filter, limit, cursor } })).body;
      return { items: page['items'] ?? [], nextCursor: page['nextCursor'] ?? null };
    },
    booking: async (_, { bookingId }, { ms }) => map.booking((await ms.call('MS.Reservas', 'GET', `/vuelos/bookings/${id(bookingId)}`)).body),
    dateChangeOptions: async (_, { bookingId, input }, { ms }) => (await ms.call('MS.Postventa', 'POST', `/vuelos/bookings/${id(bookingId)}/date-change/search`, { body: input })).body,
    webhookSubscriptions: async (_, __, { ms }) => ((await ms.call<Any[]>('MS.Clientes', 'GET', '/ecoairlines/webhooks')).body ?? []).map((s) => map.webhook(s)),

    // ------------------------------------------------------------------------------------------------------------ cliente
    me: (_, __, context) => {
      const claims = requireUser(context, []);
      return { sub: claims.sub, fullName: claims.name ?? '', email: claims.email ?? '', role: claims.role, scopes: map.scopesFrom(claims.scope, options.scopes) };
    },
    myProfile: async (_, __, { ms }) => {
      try {
        return (await ms.call('MS.Clientes', 'GET', '/ecoairlines/customers/me')).body;
      } catch (error) {
        if (isNotFound(error)) return null; // aún no guardó su perfil
        throw error;
      }
    },

    // ---------------------------------------------------------------------------------------------------- administración
    adminIndicators: async (_, __, { ms }) => map.indicators((await ms.call('MS.Admin', 'GET', '/ecoairlines/admin/indicators')).body),
    users: async (_, { filter, limit, cursor }, { ms }) => {
      const page = (await ms.call<Any>('MS.Admin', 'GET', '/ecoairlines/admin/users', { query: { ...filter, limit, cursor } })).body;
      return { items: page['items'] ?? [], nextCursor: page['nextCursor'] ?? null };
    },
    user: async (_, { sub }, { ms }) => (await ms.call('MS.Admin', 'GET', `/ecoairlines/admin/users/${id(sub)}`)).body,
    roles: async (_, __, { ms }) => (await ms.call('MS.Admin', 'GET', '/ecoairlines/admin/roles')).body,
    /** La pantalla muestra todos los partners: se recorren las páginas (son pocos). */
    partners: async (_, __, { ms }) => {
      const all: Any[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const body = (await ms.call<Any>('MS.Admin', 'GET', '/ecoairlines/admin/partners', { query: { limit: 100, cursor } })).body;
        all.push(...((body['items'] as Any[] | undefined) ?? []));
        cursor = body['nextCursor'] ?? undefined;
        if (!cursor) break;
      }
      return all.map(map.partner);
    },
    partner: async (_, { clientId }, { ms }) => map.partner((await ms.call('MS.Admin', 'GET', `/ecoairlines/admin/partners/${id(clientId)}`)).body),
    prices: async (_, __, { ms }) => map.pricesView((await ms.call('MS.Admin', 'GET', '/ecoairlines/admin/prices')).body),
    referencePrices: async (_, __, { ms }) => (await ms.call('MS.Admin', 'GET', '/ecoairlines/admin/prices/reference')).body,
    priceHistory: async (_, { limit, cursor }, { ms }) => {
      const page = (await ms.call<Any>('MS.Admin', 'GET', '/ecoairlines/admin/prices/history', { query: { limit, cursor } })).body;
      return { items: page['items'] ?? [], nextCursor: page['nextCursor'] ?? null };
    },
    routes: async (_, __, { ms }) => (await ms.call('MS.Admin', 'GET', '/ecoairlines/admin/routes')).body,
    route: async (_, { routeId }, { ms }) => (await ms.call('MS.Admin', 'GET', `/ecoairlines/admin/routes/${id(routeId)}`)).body,
    airports: async (_, __, { ms }) => (await ms.call('MS.Vuelos', 'GET', '/ecoairlines/airports')).body,
    aircraftTypes: async (_, __, { ms }) => (await ms.call('MS.Admin', 'GET', '/ecoairlines/admin/aircraft-types')).body,
    fleet: async (_, __, { ms }) => (await ms.call('MS.Admin', 'GET', '/ecoairlines/admin/aircraft')).body,
    aircraft: async (_, { registration }, { ms }) => (await ms.call('MS.Admin', 'GET', `/ecoairlines/admin/aircraft/${id(registration)}`)).body,
    fleetSchedule: async (_, { date }, { ms }) => (await ms.call('MS.Admin', 'GET', '/ecoairlines/admin/fleet-schedule', { query: { date } })).body,
    flightOperations: async (_, args, { ms }) => {
      const page = (await ms.call<Any>('MS.Vuelos', 'GET', '/vuelos/operaciones/vuelos', { query: args })).body;
      return { date: page['date'] ?? args['date'], totalFlights: page['totalFlights'] ?? 0, nextCursor: page['nextCursor'] ?? null, items: ((page['items'] as Any[] | undefined) ?? []).map(map.flightOperation) };
    },
    promotionAgreement: async (_, { partnerId }, { ms }) => {
      const view = map.pricesView((await ms.call('MS.Admin', 'GET', '/ecoairlines/admin/prices')).body);
      return (view['promotions'] as Any[]).find((agreement) => agreement['partnerId'] === partnerId) ?? null;
    },
    flightDelayImpact: async (_, { flightNumber, date, delayMinutes }, { ms }) =>
      (await ms.call('MS.Admin', 'GET', `/ecoairlines/admin/flights/${id(flightNumber)}/delay-impact`, { query: { date, delayMinutes } })).body,
    flightAssistance: async (_, { flightNumber, date }, { ms }) => (await ms.call('MS.Admin', 'GET', `/ecoairlines/admin/flights/${id(flightNumber)}/assistance`, { query: { date } })).body,
    eventHistory: async (_, args, { ms }) => {
      const page = (await ms.call<Any>('MS.Admin', 'GET', '/ecoairlines/admin/events', { query: args })).body;
      return { items: ((page['items'] as Any[] | undefined) ?? []).map(map.eventHistoryItem), nextCursor: page['nextCursor'] ?? null };
    },
    /** Reservas de todos los canales para el panel (O-1, solo lectura): el filtro `reference` busca PNR, orden o pago. */
    adminBookings: async (_, { filter, limit, cursor }, { ms }) => {
      const page = (await ms.call<Any>('MS.Admin', 'GET', '/ecoairlines/admin/bookings', { query: { ...filter, limit, cursor } })).body;
      return { items: ((page['items'] as Any[] | undefined) ?? []).map(map.adminBookingSummary), nextCursor: page['nextCursor'] ?? null };
    },
    adminBooking: async (_, { bookingId }, { ms }) => map.adminBooking((await ms.call('MS.Admin', 'GET', `/ecoairlines/admin/bookings/${id(bookingId)}`)).body),
    adminSalesReport: async (_, { from, to }, { ms }) => (await ms.call('MS.Admin', 'GET', '/ecoairlines/admin/reports/sales', { query: { from, to } })).body,
    /** Cada campo de `Telemetry` llama a su propia operación (algunas responden 503 hasta V2.16). */
    telemetry: () => ({}),
  };

  const Mutation: Record<string, Resolver> = {
    // ------------------------------------------------------------------------------------------------ autenticación y perfil
    register: async (_, { input }, { ms }) => authPayload((await ms.call('MS.Clientes', 'POST', '/ecoairlines/auth/register', { body: input })).body, options.scopes),
    login: async (_, { input }, { ms }) => authPayload((await ms.call('MS.Clientes', 'POST', '/ecoairlines/auth/login', { body: input })).body, options.scopes),
    saveMyProfile: async (_, { input }, { ms }) => (await ms.call('MS.Clientes', 'PUT', '/ecoairlines/customers/me', { body: input })).body,

    // ------------------------------------------------------------------------------------------------------------- hold
    holdInventory: async (_, { idempotencyKey, input }, { ms }) => {
      const hold = (await ms.call<Any>('MS.Reservas', 'POST', '/vuelos/offers/hold', { body: input, idempotencyKey })).body;
      return { ...hold, remainingSeconds: Math.max(0, Math.round((Date.parse(hold['expiresAt']) - Date.now()) / 1000)) };
    },
    releaseHold: async (_, { holdId }, { ms }) => {
      await ms.call('MS.Reservas', 'DELETE', `/vuelos/offers/hold/${id(holdId)}`);
      return { holdId, status: 'RELEASED' };
    },

    // ---------------------------------------------------------------------------------------------- reservas y emisión
    createBooking: async (_, { idempotencyKey, input }, { ms }) => {
      const body = { booking: { holdId: input['holdId'], passengers: input['passengers'], payment: map.webPayment(input['payment']) }, assistance: input['assistance'] };
      const response = await ms.call<Any>('MS.Reservas', 'POST', '/ecoairlines/bookings', { body, idempotencyKey });
      return { outcome: outcome(response.status, response.body['status']), booking: map.booking(response.body) };
    },
    issueTickets: async (_, { bookingId }, { ms }) => (await ms.call('MS.Reservas', 'POST', `/vuelos/bookings/${id(bookingId)}/tickets`)).body,
    changeSeats: async (_, { idempotencyKey, bookingId, input }, { ms }) =>
      (await ms.call('MS.Reservas', 'PUT', `/vuelos/bookings/${id(bookingId)}/seats`, { body: { seats: input['seats'], payment: map.webPayment(input['payment']) }, idempotencyKey })).body,
    savePassengerAssistance: async (_, { bookingId, passengerId, input }, { ms }) =>
      (await ms.call('MS.Reservas', 'PUT', `/ecoairlines/bookings/${id(bookingId)}/passengers/${id(passengerId)}/assistance`, { body: input })).body,
    deletePassengerAssistance: async (_, { bookingId, passengerId }, { ms }) => {
      await ms.call('MS.Reservas', 'DELETE', `/ecoairlines/bookings/${id(bookingId)}/passengers/${id(passengerId)}/assistance`);
      return true;
    },

    // ---------------------------------------------------------------------------------------------------------- postventa
    addBaggage: async (_, { idempotencyKey, bookingId, input }, { ms }) => {
      const body = { passengerId: input['passengerId'], itineraryId: input['itineraryId'], quantity: input['quantity'], payment: map.webPayment(input['payment']) };
      const response = await ms.call('MS.Postventa', 'POST', `/vuelos/bookings/${id(bookingId)}/baggage`, { body, idempotencyKey });
      return response.status === 202 ? { outcome: 'ACCEPTED', baggage: null } : { outcome: 'COMPLETED', baggage: response.body };
    },
    confirmDateChange: async (_, { idempotencyKey, bookingId, input }, { ms }) => {
      const body = { changeOfferId: input['changeOfferId'], payment: map.webPayment(input['payment']), assignedSeats: input['assignedSeats'] };
      const response = await ms.call<Any>('MS.Postventa', 'POST', `/vuelos/bookings/${id(bookingId)}/date-change`, { body, idempotencyKey });
      return { outcome: outcome(response.status, response.body['status']), booking: map.booking(response.body) };
    },
    /** La web solo cancela por pedido del cliente (`CUSTOMER_REQUEST`); los otros motivos son del canal Booking y de las sagas. */
    cancelBooking: async (_, { idempotencyKey, bookingId, input }, { ms }) => {
      const response = await ms.call<Any>('MS.Postventa', 'POST', `/vuelos/bookings/${id(bookingId)}/cancel`, { body: { quoteId: input['quoteId'], reason: input['reason'], reasonCode: 'CUSTOMER_REQUEST' }, idempotencyKey });
      return map.cancellation(response.status, response.body);
    },
    checkIn: async (_, { bookingId }, { ms }) => (await ms.call('MS.Reservas', 'POST', `/vuelos/bookings/${id(bookingId)}/check-in`)).body,

    // ----------------------------------------------------------------------------------------------------------- webhooks
    registerWebhook: async (_, { input }, { ms }) =>
      // La respuesta v2 no trae la pista: sale del secreto que se acaba de registrar.
      map.webhook((await ms.call('MS.Clientes', 'POST', '/vuelos/webhooks', { body: { url: input['url'], events: (input['events'] as string[]).map(map.enumToEvent), secret: input['secret'] } })).body, String(input['secret']).slice(-4)),
    deleteWebhook: async (_, { id: subscriptionId }, { ms }) => {
      await ms.call('MS.Clientes', 'DELETE', `/vuelos/webhooks/${id(subscriptionId)}`);
      return { id: subscriptionId, deleted: true };
    },

    // ---------------------------------------------------------------------------------------------------- administración
    createUser: async (_, { input }, { ms }) => (await ms.call('MS.Admin', 'POST', '/ecoairlines/admin/users', { body: input })).body,
    changeUserRole: async (_, { sub, role }, { ms }) => (await ms.call('MS.Admin', 'PUT', `/ecoairlines/admin/users/${id(sub)}/role`, { body: { role } })).body,
    changeUserStatus: async (_, { sub, input }, { ms }) => (await ms.call('MS.Admin', 'PUT', `/ecoairlines/admin/users/${id(sub)}/status`, { body: input })).body,
    createPartner: async (_, { input }, { ms }) => {
      const body = { clientId: input['clientId'], name: input['name'], scopes: (input['scopes'] as string[] | null | undefined)?.map(map.enumToScope) };
      const created = (await ms.call<Any>('MS.Admin', 'POST', '/ecoairlines/admin/partners', { body })).body;
      return { partner: map.partner(created), clientSecret: created['clientSecret'] };
    },
    changePartnerStatus: async (_, { clientId, input }, { ms }) => map.partner((await ms.call('MS.Admin', 'PUT', `/ecoairlines/admin/partners/${id(clientId)}/status`, { body: input })).body),
    rotatePartnerSecret: async (_, { clientId }, { ms }) => {
      const rotated = (await ms.call<Any>('MS.Admin', 'POST', `/ecoairlines/admin/partners/${id(clientId)}/secret`)).body;
      return { partner: map.partner(rotated), clientSecret: rotated['clientSecret'] };
    },
    savePrices: async (_, { input }, { ms }) => {
      const prices = input['prices'] as Any[] | null | undefined;
      const promotion = input['promotion'] as Any | null | undefined;
      const pricing = input['pricing'] as Any | null | undefined;
      const body = {
        ...(prices?.length ? { prices: { items: prices } } : {}),
        ...(pricing ? { pricing: Object.fromEntries(Object.entries(pricing).filter(([, value]) => value !== null && value !== undefined)) } : {}),
        ...(promotion ? { promotion: { partnerId: promotion['partnerId'], agreement: map.agreementRequest(promotion) } } : {}),
      };
      return map.pricesView((await ms.call('MS.Admin', 'PUT', '/ecoairlines/admin/prices', { body })).body);
    },
    createRoute: async (_, { input }, { ms }) => (await ms.call('MS.Admin', 'POST', '/ecoairlines/admin/routes', { body: input })).body,
    updateRoute: async (_, { routeId, input }, { ms }) => (await ms.call('MS.Admin', 'PUT', `/ecoairlines/admin/routes/${id(routeId)}`, { body: input })).body,
    deleteRoute: async (_, { routeId }, { ms }) => {
      await ms.call('MS.Admin', 'DELETE', `/ecoairlines/admin/routes/${id(routeId)}`);
      return true;
    },
    createAirport: async (_, { input }, { ms }) => (await ms.call('MS.Admin', 'POST', '/ecoairlines/admin/airports', { body: input })).body,
    updateAirport: async (_, { code, input }, { ms }) => (await ms.call('MS.Admin', 'PUT', `/ecoairlines/admin/airports/${id(code)}`, { body: input })).body,
    deleteAirport: async (_, { code }, { ms }) => {
      await ms.call('MS.Admin', 'DELETE', `/ecoairlines/admin/airports/${id(code)}`);
      return true;
    },
    createAircraftType: async (_, { input }, { ms }) => (await ms.call('MS.Admin', 'POST', '/ecoairlines/admin/aircraft-types', { body: input })).body,
    updateAircraftType: async (_, { aircraftType, input }, { ms }) => (await ms.call('MS.Admin', 'PUT', `/ecoairlines/admin/aircraft-types/${id(aircraftType)}`, { body: input })).body,
    deleteAircraftType: async (_, { aircraftType }, { ms }) => {
      await ms.call('MS.Admin', 'DELETE', `/ecoairlines/admin/aircraft-types/${id(aircraftType)}`);
      return true;
    },
    createAircraft: async (_, { input }, { ms }) => (await ms.call('MS.Admin', 'POST', '/ecoairlines/admin/aircraft', { body: input })).body,
    updateAircraftBase: async (_, { registration, base }, { ms }) => (await ms.call('MS.Admin', 'PUT', `/ecoairlines/admin/aircraft/${id(registration)}`, { body: { base } })).body,
    deleteAircraft: async (_, { registration }, { ms }) => {
      await ms.call('MS.Admin', 'DELETE', `/ecoairlines/admin/aircraft/${id(registration)}`);
      return true;
    },
    updateFlightStatus: async (_, { flightNumber, input }, { ms }) => {
      const body = (await ms.call<Any>('MS.Vuelos', 'PATCH', `/vuelos/flights/${id(flightNumber)}/status`, { body: input })).body;
      return { ...body, affectedBookings: body['affectedBookings'] ?? 0 };
    },
    markAssistanceReady: async (_, { bookingId, input }, { ms }) => {
      await ms.call('MS.Admin', 'PUT', `/ecoairlines/admin/bookings/${id(bookingId)}/assistance-ready`, { body: input });
      return true;
    },
  };

  /** Campos de la reserva resueltos por sus sub-recursos REST (con la misma validación de propiedad en el MS). */
  const Booking: Record<string, Resolver> = {
    tickets: async (booking, _, { ms }) => booking['tickets'] ?? ((await ms.call<Any>('MS.Reservas', 'GET', `/vuelos/bookings/${id(booking['bookingId'])}/tickets`)).body['tickets'] ?? []),
    ticket: async (booking, { ticketId }, { ms }) => (await ms.call('MS.Reservas', 'GET', `/vuelos/bookings/${id(booking['bookingId'])}/tickets/${id(ticketId)}`)).body,
    baggageOptions: async (booking, _, { ms }) => (await ms.call('MS.Postventa', 'GET', `/vuelos/bookings/${id(booking['bookingId'])}/baggage-options`)).body,
    cancellationQuote: async (booking, _, { ms }) => (await ms.call('MS.Postventa', 'GET', `/vuelos/bookings/${id(booking['bookingId'])}/cancellation-quote`)).body,
    boardingPasses: async (booking, _, { ms }) => (await ms.call<Any>('MS.Reservas', 'GET', `/vuelos/bookings/${id(booking['bookingId'])}/boarding-passes`)).body['boardingPasses'] ?? [],
    assistance: async (booking, _, { ms }) => (await ms.call('MS.Reservas', 'GET', `/ecoairlines/bookings/${id(booking['bookingId'])}/assistance`)).body,
    refunds: async (booking, _, { ms }) => (await ms.call('MS.Reservas', 'GET', `/ecoairlines/bookings/${id(booking['bookingId'])}/refunds`)).body,
  };

  const Telemetry: Record<string, Resolver> = {
    services: async (_, __, { ms }) =>
      ((await ms.call<Any[]>('MS.Admin', 'GET', '/ecoairlines/admin/telemetry/services')).body ?? []).map((s) => ({ service: s['service'], status: s['status'], latencyMs: s['latency_ms'] ?? null, version: s['version'] ?? null, checkedAt: s['checkedAt'] })),
    latency: async (_, { from, to }, { ms }) =>
      ((await ms.call<Any[]>('MS.Admin', 'GET', '/ecoairlines/admin/telemetry/latency', { query: { from, to } })).body ?? []).map((l) => ({ service: l['service'], p50Ms: l['p50_ms'], p95Ms: l['p95_ms'], p99Ms: l['p99_ms'], requests: l['requests'], errorRate: l['errorRate'] })),
    journey: async (_, { correlationId, from, to }, { ms }) => {
      try {
        return (await ms.call('MS.Admin', 'GET', `/ecoairlines/admin/telemetry/journeys/${id(correlationId)}`, { query: { from, to } })).body;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    systemMap: async (_, __, { ms }) => (await ms.call('MS.Admin', 'GET', '/ecoairlines/admin/telemetry/system-map')).body,
    trace: async (_, { correlationId, from, to }, { ms }) => {
      try {
        return map.trace((await ms.call('MS.Admin', 'GET', `/ecoairlines/admin/telemetry/traces/${id(correlationId)}`, { query: { from, to } })).body);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    queues: async (_, __, { ms }) => (await ms.call('MS.Admin', 'GET', '/ecoairlines/admin/telemetry/queues')).body,
    alerts: async (_, __, { ms }) => (await ms.call('MS.Admin', 'GET', '/ecoairlines/admin/telemetry/alerts')).body,
    bookingIntegration: async (_, __, { ms }) => {
      const body = (await ms.call<Any>('MS.Admin', 'GET', '/ecoairlines/admin/telemetry/booking-integration')).body;
      return { partnerId: body['partnerId'], lastTokenAt: body['lastTokenAt'] ?? null, webhooks: body['webhooks'], lastStockPushAt: body['stock']?.['lastPushAt'] ?? null, pendingStockPushes: body['stock']?.['pendingPushes'] ?? 0, lastInboundEventAt: body['lastInboundEventAt'] ?? null };
    },
  };

  return {
    Query,
    Mutation,
    Subscription: {
      bookingEvents: { subscribe: options.bookingEvents, resolve: (payload: Any) => payload['bookingEvents'] },
      traceProgress: { subscribe: options.traceProgress, resolve: (payload: Any) => payload['traceProgress'] },
      liveSystemMap: { subscribe: options.liveSystemMap, resolve: (payload: Any) => payload['liveSystemMap'] },
    },
    Booking,
    BookingSummary: { booking: (async (summary, _, { ms }) => map.booking((await ms.call('MS.Reservas', 'GET', `/vuelos/bookings/${id(summary['bookingId'])}`)).body)) as Resolver },
    Telemetry,
    AdminBooking: {
      timeline: (async (booking, _, { ms }) => map.bookingTimeline((await ms.call('MS.Admin', 'GET', `/ecoairlines/admin/bookings/${id(booking['bookingId'])}/timeline`)).body)) as Resolver,
    },
    Seat: { characteristics: ((seat) => seat['characteristics'] ?? []) as Resolver, isAvailable: ((seat) => seat['isAvailable'] ?? seat['status'] === 'AVAILABLE') as Resolver },
    PassengerCheckIn: { segments: ((passenger) => passenger['segments'] ?? []) as Resolver },
    DefaultAssistance: { needsCompanion: ((assistance) => assistance['needsCompanion'] ?? false) as Resolver },
    PassengerAssistance: { needsCompanion: ((assistance) => assistance['needsCompanion'] ?? false) as Resolver },
    FleetAircraftDay: { flights: ((day) => day['flights'] ?? []) as Resolver },
  };
}

function authPayload(body: Any, scopes: Set<string>): Any {
  return { accessToken: body['access_token'], expiresIn: body['expires_in'], user: { ...body['user'], scopes: map.scopesFrom(body['scope'], scopes) } };
}
