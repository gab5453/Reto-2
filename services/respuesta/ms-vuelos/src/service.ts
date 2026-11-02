import { ProblemDetailsException } from '@ecoairlines/shared';
import { fromProto, type Handler, replayHeaders, type ResponseServiceDefinition, sagaOutcome, stillRunning, withQuery } from '@ecoairlines/shared/respuesta/index.js';

/**
 * MS.Vuelos (contract/ms-vuelos.openapi.yaml): las 9 operaciones del contrato v2 con `x-microservice: MS.Vuelos`. Cada una
 * es una llamada al ESB (enrutador, orquestador o composición); la plantilla común valida, autentica y proyecta.
 */
export const SERVICE = { name: 'ms-vuelos', version: '1.0.0' };
export const CLIENT_ID = 'ECOAIRLINES_MS_VUELOS';
export const DEFAULT_PORT = 5001;

/** Identidad del nodo en el health (la misma que publica el ESB) para cuando el ESB no responde. */
const NODE = { nodo_id: 'NODE_VUE_ECOAIRLINES', nombre_proveedor: 'EcoAirlines', vertical: 'VUELOS', version: '2.0.0' };
const HEALTH_BUDGET_MS = 900;

const forbidden = (title: string) => new ProblemDetailsException({ status: 403, code: 'FORBIDDEN', title });

export interface VuelosOptions {
  /** Partner cuyo acuerdo de promociones administra el panel (un usuario ADMIN no tiene `clientId`). */
  promotionsPartnerId: string;
}

export function vuelosHandlers(options: VuelosOptions): Record<string, Handler> {
  /**
   * Con token de partner, su propio acuerdo; un usuario solo si es ADMIN (es un acuerdo B2B, no un dato del cliente). Para
   * otro usuario no existe (`404`, documentado; `403` no lo está en esta operación).
   */
  const agreementPartner = (principal: Parameters<Handler>[0]['principal'], actor: string | undefined) => {
    if (principal.kind === 'partner') return principal.clientId;
    if (actor) return options.promotionsPartnerId;
    throw ProblemDetailsException.notFound('No hay un acuerdo de promociones para este cliente.');
  };

  return {
    /** Semáforo del Panel 1 desde la caché del ESB (< 1 s). Si el ESB no contesta a tiempo, el nodo está DOWN. */
    getHealth: async (context) => {
      const fallback = { status: 503, body: { status: 'DOWN', ...NODE, dependencias: [{ nombre: 'esb', status: 'DOWN' }], timestamp: new Date().toISOString() } };
      try {
        const response = await Promise.race([
          context.esbRaw({ method: 'GET', path: '/composition/health', timeoutMs: HEALTH_BUDGET_MS }),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), HEALTH_BUDGET_MS)),
        ]);
        if (response && (response.status === 200 || response.status === 503)) return { status: response.status, body: response.body };
      } catch {
        // Identity o el ESB caídos: el nodo no puede atender.
      }
      return fallback;
    },

    /** Feed de respaldo de los webhooks: solo los eventos que le corresponden al partner (D40). */
    /** El partner lee lo de su canal; un usuario, sus reservas; un ADMIN (con `X-Actor-Id`), todo lo público (V2.13). */
    listOutboxEvents: async (context) => {
      const response = await context.esb({ method: 'GET', path: withQuery('/router/webhooks/events', context.query), ownerId: context.partnerOwner(), actorId: context.actor() });
      return { status: 200, body: response.body };
    },

    getPromotionAgreement: async (context) => {
      const partnerId = agreementPartner(context.principal, context.actor());
      const response = await context.esb({ method: 'GET', path: `/router/schedule/promotion-agreements/${partnerId}`, actorId: context.actor() });
      return { status: 200, body: response.body };
    },

    /** `flights:admin` (solo nuestro ADMIN, D35): saga "Guardar precios y descuento máximo" (máximo 50 %). */
    putPromotionAgreement: async (context) => {
      const actorId = context.actor();
      if (!actorId) throw forbidden('El acuerdo de promociones lo define un administrador de EcoAirlines.');
      const response = await context.esb({ method: 'PUT', path: `/sagas/promotion-agreements/${options.promotionsPartnerId}`, json: context.body, actorId, idempotencyKey: context.headers['idempotency-key'] });
      return { status: 200, body: response.body, headers: replayHeaders(response.replayed) };
    },

    searchFlights: async (context) => {
      const { itineraries, passengers } = context.body as { itineraries: unknown[]; passengers: unknown };
      const response = await context.esb({ method: 'POST', path: '/router/offers/Search', json: { itineraries, passengers } });
      return { status: 200, body: fromProto(response.body) };
    },

    getSeatMap: async (context) => {
      const response = await context.esb<{ seatMap: unknown }>({ method: 'POST', path: '/router/offers/GetSeatMap', json: { offerId: context.params['offerId'], segmentId: context.query['segmentId'] } });
      return { status: 200, body: fromProto(response.body.seatMap) };
    },

    getFlightStatus: async (context) => {
      const response = await context.esb({ method: 'GET', path: withQuery(`/router/flight-status/flights/${context.params['flightNumber']}/status`, { date: context.query['date'] }) });
      return { status: 200, body: response.body };
    },

    /**
     * Saga "Cambiar estado de vuelo" (D37). La auditoría exige el `sub` de un administrador (`X-Actor-Id`); un partner con
     * `flights:ops` recibe 403 hasta que se decida cómo se registra su usuario (D45, pendiente).
     */
    updateFlightStatus: async (context) => {
      const actorId = context.actor();
      if (!actorId) throw forbidden('Por ahora el estado de vuelo lo cambia un administrador de EcoAirlines (D45, pendiente).');
      const response = await context.esb({ method: 'PATCH', path: `/sagas/flights/${context.params['flightNumber']}/status`, json: context.body, actorId, idempotencyKey: context.headers['idempotency-key'] });
      const outcome = await sagaOutcome(context, response, { actorId });
      if (!outcome.done) throw stillRunning(outcome.sagaId);
      return { status: 200, body: outcome.body, headers: replayHeaders(outcome.replayed) };
    },

    listFlightOperations: async (context) => {
      const response = await context.esb({ method: 'GET', path: withQuery('/composition/flight-operations', context.query), actorId: context.actor() });
      return { status: 200, body: response.body };
    },
  };
}

export function definition(env: NodeJS.ProcessEnv = process.env): ResponseServiceDefinition {
  return { ...SERVICE, contract: 'ms-vuelos.openapi.yaml', handlers: vuelosHandlers({ promotionsPartnerId: env['PROMOTIONS_PARTNER_ID']?.trim() || 'BOOKING_PROTOTIPO' }) };
}
