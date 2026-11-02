import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { currentCorrelation, newCorrelationId } from '../correlation/correlation.js';

/**
 * CloudEvents 1.0 en modo estructurado (contrato v2 §8 y `contract/events.asyncapi.yaml`).
 * - `type` público: `ec.edu.epn.booking.vuelos.<evento>`; interno: `ec.ecoairlines.internal.<evento>`.
 * - `correlationid`: el X-Correlation-Id del proceso que originó el evento, sin cambios.
 * - Webhooks: `X-Webhook-Signature: sha256=<HMAC-SHA256(secret, cuerpo)>` en hexadecimal.
 */
export const CLOUDEVENT_SOURCE = '/aerolineas/ecoairlines/vuelos';
export const PUBLIC_TYPE_PREFIX = 'ec.edu.epn.booking.vuelos.';
export const INTERNAL_TYPE_PREFIX = 'ec.ecoairlines.internal.';
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
    type: (event.visibility === 'public' ? PUBLIC_TYPE_PREFIX : INTERNAL_TYPE_PREFIX) + event.name,
    source: CLOUDEVENT_SOURCE,
    id: randomUUID(),
    time: new Date().toISOString(),
    ...(event.subject ? { subject: event.subject } : {}),
    datacontenttype: 'application/json',
    correlationid: event.correlationId ?? currentCorrelation()?.correlationId ?? newCorrelationId(),
    data: event.data,
  };
}

/** Nombre corto (routing key) a partir del `type`. */
export function eventName(type: string): string {
  return type.startsWith(PUBLIC_TYPE_PREFIX) ? type.slice(PUBLIC_TYPE_PREFIX.length) : type.slice(INTERNAL_TYPE_PREFIX.length);
}

export const isPublicEvent = (event: Pick<CloudEvent, 'type'>): boolean => event.type.startsWith(PUBLIC_TYPE_PREFIX);

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
