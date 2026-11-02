import { createCloudEvent, type CloudEvent } from '@ecoairlines/shared';
import type { Caller } from '../clients/rest.client.js';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Eventos internos que produce el ENRUTADOR después de una escritura que salió bien (`events.asyncapi.yaml`: los produce el ESB
 * desde su outbox; "nunca salen de EcoAirlines"). Solo los consume MS.G.Webhooks para el historial del administrador.
 * - `user.created` / `user.role_changed` / `user.blocked` (también al activar): `UserChange`.
 * - `partner.created` / `partner.blocked` / `partner.secret_rotated`: `PartnerChange`, **nunca** con el secreto.
 * - `booking.assistance_requested`: solo QUE cambió la asistencia de un pasajero (dato de salud: nunca cuál).
 * Una respuesta repetida por idempotencia no vuelve a publicar (la petición no se ejecutó otra vez).
 */
export interface RouteEvent {
  event: CloudEvent;
  ownerId?: string;
}

interface Context {
  operationId: string;
  params: Record<string, string>;
  request: Any | undefined;
  response: Any | undefined;
  caller: Caller;
}

const userChange = (c: Context) => ({
  sub: c.response?.['sub'],
  role: c.response?.['role'],
  status: c.response?.['status'],
  actorId: c.caller.actorId,
  ...(typeof c.request?.['reason'] === 'string' ? { reason: String(c.request['reason']).slice(0, 200) } : {}),
});
const partnerChange = (c: Context) => ({
  clientId: c.response?.['clientId'] ?? c.params['clientId'],
  status: c.response?.['status'] ?? 'ACTIVE',
  actorId: c.caller.actorId,
  ...(typeof c.request?.['reason'] === 'string' ? { reason: String(c.request['reason']).slice(0, 200) } : {}),
});

const BUILDERS: Record<string, (c: Context) => { name: string; subject: string; data: Any; ownerId?: string } | undefined> = {
  createUser: (c) => ({ name: 'user.created', subject: c.response?.['sub'], data: userChange(c) }),
  changeUserRole: (c) => ({ name: 'user.role_changed', subject: c.params['sub']!, data: userChange(c) }),
  changeUserStatus: (c) => ({ name: 'user.blocked', subject: c.params['sub']!, data: userChange(c) }),
  createPartner: (c) => ({ name: 'partner.created', subject: c.response?.['clientId'], data: partnerChange(c) }),
  changePartnerStatus: (c) => ({ name: 'partner.blocked', subject: c.params['clientId']!, data: partnerChange(c) }),
  rotatePartnerSecret: (c) => ({ name: 'partner.secret_rotated', subject: c.params['clientId']!, data: partnerChange(c) }),
  saveAssistance: (c) => ({ name: 'booking.assistance_requested', subject: c.params['bookingId']!, data: { bookingId: c.params['bookingId'], passengerId: decodeURIComponent(c.params['passengerId']!), action: 'REQUESTED' }, ...(c.caller.ownerId ? { ownerId: c.caller.ownerId } : {}) }),
  deleteAssistance: (c) => ({ name: 'booking.assistance_requested', subject: c.params['bookingId']!, data: { bookingId: c.params['bookingId'], passengerId: decodeURIComponent(c.params['passengerId']!), action: 'REMOVED' }, ...(c.caller.ownerId ? { ownerId: c.caller.ownerId } : {}) }),
};

/** El evento de una escritura del enrutador que salió bien (2xx), o `undefined` si esa ruta no produce eventos. */
export function routeEvent(context: Context): RouteEvent | undefined {
  const built = BUILDERS[context.operationId]?.(context);
  if (!built || !built.subject) return undefined;
  return { event: createCloudEvent({ name: built.name, visibility: 'internal', subject: built.subject, data: built.data }), ...(built.ownerId ? { ownerId: built.ownerId } : {}) };
}

export const ROUTE_EVENT_OPERATIONS = Object.keys(BUILDERS);
