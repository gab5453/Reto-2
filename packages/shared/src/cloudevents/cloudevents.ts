import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { currentCorrelation, newCorrelationId } from '../correlation/correlation.js';

/**
 * CloudEvents 1.0 en modo estructurado (contrato v2 §8 y `contract/events.asyncapi.yaml`).
 * - `type` público: el nombre corto del evento (`booking.checked_in`), como lo usa Booking; interno:
 *   `ec.ecoairlines.internal.<evento>` (nunca sale de EcoAirlines). `source` = `ecoairlines`.
 *   Hasta el 12/11/2026 el público era `ec.edu.epn.booking.vuelos.<evento>` y el `source` `/aerolineas/ecoairlines/vuelos`
 *   (contrato §8 anterior): Booking pidió el formato corto (BKG-16) y el responsable lo priorizó sobre el contrato del grupo.
 *   Los eventos ya guardados con el formato anterior se entregan normalizados (`toContractFormat`).
 * - `correlationid`: el X-Correlation-Id del proceso que originó el evento, sin cambios.
 * - Webhooks: `X-Webhook-Signature: sha256=<HMAC-SHA256(secret, cuerpo)>` en hexadecimal.
 */
export const CLOUDEVENT_SOURCE = 'ecoairlines';
/** Prefijo del `type` público ANTERIOR: solo para reconocer y normalizar eventos guardados antes del 12/11/2026. */
export const LEGACY_PUBLIC_TYPE_PREFIX = 'ec.edu.epn.booking.vuelos.';
const LEGACY_SOURCE = '/aerolineas/ecoairlines/vuelos';
export const INTERNAL_TYPE_PREFIX = 'ec.ecoairlines.internal.';
/** Un `type` público: dos palabras separadas por un punto (`booking.confirmed`, `flight.status_changed`). */
const PUBLIC_TYPE = /^[a-z_]+\.[a-z_]+$/;
export const CLOUDEVENTS_CONTENT_TYPE = 'application/cloudevents+json';
export const WEBHOOK_SIGNATURE_HEADER = 'X-Webhook-Signature';

export interface CloudEvent<T = Record<string, unknown>> {
  specversion: '1.0';
  type: string;
  source: string;
  id: string;
  time: string;
  subject?: string;
  datacontenttype: 'application/json';
  correlationid: string;
  data: T;
}

export interface NewEvent<T> {
  /** Nombre corto: `booking.confirmed`, `schedule.published`… */
  name: string;
  visibility: 'public' | 'internal';
  data: T;
  subject?: string;
  /** Por defecto el del contexto actual; se exige uno en procesos de fondo para no perder la trazabilidad. */
  correlationId?: string;
}

export function createCloudEvent<T>(event: NewEvent<T>): CloudEvent<T> {
  return {
    specversion: '1.0',
    type: event.visibility === 'public' ? event.name : INTERNAL_TYPE_PREFIX + event.name,
    source: CLOUDEVENT_SOURCE,
    id: randomUUID(),
    time: new Date().toISOString(),
    ...(event.subject ? { subject: event.subject } : {}),
    datacontenttype: 'application/json',
    correlationid: event.correlationId ?? currentCorrelation()?.correlationId ?? newCorrelationId(),
    data: event.data,
  };
}

/** Nombre corto (routing key) a partir del `type`, en el formato actual o en el anterior. */
export function eventName(type: string): string {
  if (type.startsWith(INTERNAL_TYPE_PREFIX)) return type.slice(INTERNAL_TYPE_PREFIX.length);
  if (type.startsWith(LEGACY_PUBLIC_TYPE_PREFIX)) return type.slice(LEGACY_PUBLIC_TYPE_PREFIX.length);
  return type;
}

/**
 * ¿Puede salir hacia Booking? Solo un `type` público, actual (`booking.confirmed`) o anterior. Explícito a propósito: un evento
 * interno o uno que NOS envía Booking (`ec.edu.epn.booking.pagos.payment.confirmed`) nunca se trata como público.
 */
export const isPublicEvent = (event: Pick<CloudEvent, 'type'>): boolean => PUBLIC_TYPE.test(event.type) || event.type.startsWith(LEGACY_PUBLIC_TYPE_PREFIX);

/**
 * Un evento público en el formato del contrato vigente (§8): `type` corto y `source` `ecoairlines`. Los eventos nuevos ya
 * vienen así; los guardados antes del 12/11/2026 se normalizan al entregarlos (webhook y `GET /vuelos/eventos`). El `id` no se
 * toca: es la clave de deduplicación y el cursor del feed.
 */
export function toContractFormat<T>(event: CloudEvent<T>): CloudEvent<T> {
  if (!event.type.startsWith(LEGACY_PUBLIC_TYPE_PREFIX) && event.source !== LEGACY_SOURCE) return event;
  return { ...event, type: eventName(event.type), source: CLOUDEVENT_SOURCE };
}

/** Firma de un webhook: `sha256=` + HMAC-SHA256 en hexadecimal del cuerpo EXACTO que se envía. */
export function signWebhook(secret: string, body: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Verifica la firma en tiempo constante (evita ataques de temporización). */
export function verifyWebhookSignature(secret: string, body: string | Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signWebhook(secret, body));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
