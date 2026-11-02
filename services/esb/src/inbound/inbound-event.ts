import { isValidId, newCorrelationId, ProblemDetailsException, type InvalidParam } from '@ecoairlines/shared';
import type { InboundChannel, InboundEventRecord } from '../repositories/esb.store.js';

/**
 * Eventos que publica Booking y consume la aerolínea (contrato v2 §8; `events.asyncapi.yaml`, entrada del ESB):
 * `payment.confirmed` → "Emitir boletos", `payment.failed` → "Pago fallido", `package.cancelled` → "Cancelar"
 * (`SAGA_COMPENSATION`).
 */
export const INBOUND_TYPES = {
  'ec.edu.epn.booking.pagos.payment.confirmed': 'payment.confirmed',
  'ec.edu.epn.booking.pagos.payment.failed': 'payment.failed',
  'ec.edu.epn.booking.paquetes.package.cancelled': 'package.cancelled',
} as const;
export type InboundName = (typeof INBOUND_TYPES)[keyof typeof INBOUND_TYPES];

/** Routing keys de la vía AMQP en el exchange `booking.events` (propuesta de BKG-01). */
export const BOOKING_ROUTING_KEYS = ['pagos.payment.confirmed', 'pagos.payment.failed', 'paquetes.package.cancelled'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[\x21-\x7E]{1,200}$/;

export interface PaymentEventData {
  paymentReference?: string;
  bookingId: string;
  amount?: { currency: string; total: string };
  failureReason?: string | null;
}

export interface PackageCancelledData {
  packageId?: string;
  bookingId: string;
  reason?: string;
}

/**
 * Valida el sobre CloudEvents 1.0 y los datos mínimos (`bookingId` UUID). Devuelve el registro para `inbound_events` o lanza
 * 400 con cada problema en `invalidParams`. El evento se guarda tal cual llegó (sin datos sensibles: Booking no envía tarjetas).
 */
export function toInboundRecord(body: unknown, channel: InboundChannel, now: string): InboundEventRecord {
  const event = (body ?? {}) as Record<string, unknown>;
  const issues: InvalidParam[] = [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalidEvent([{ name: 'body', reason: 'debe ser un CloudEvent JSON' }]);
  if (event['specversion'] !== '1.0') issues.push({ name: 'specversion', reason: 'debe ser "1.0"' });
  if (typeof event['id'] !== 'string' || !ID.test(event['id'])) issues.push({ name: 'id', reason: 'obligatorio, hasta 200 caracteres visibles' });
  if (typeof event['source'] !== 'string' || !event['source']) issues.push({ name: 'source', reason: 'obligatorio' });
  if (typeof event['type'] !== 'string' || !(event['type'] in INBOUND_TYPES)) issues.push({ name: 'type', reason: `uno de ${Object.keys(INBOUND_TYPES).join(', ')}` });
  const data = event['data'] as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object' || Array.isArray(data)) issues.push({ name: 'data', reason: 'obligatorio, objeto' });
  else if (typeof data['bookingId'] !== 'string' || !UUID.test(data['bookingId'])) issues.push({ name: 'data.bookingId', reason: 'obligatorio, UUID' });
  else if (event['type'] !== 'ec.edu.epn.booking.paquetes.package.cancelled' && data['paymentReference'] !== undefined && typeof data['paymentReference'] !== 'string') {
    issues.push({ name: 'data.paymentReference', reason: 'texto' });
  }
  if (issues.length) throw invalidEvent(issues);
  const correlation = typeof event['correlationid'] === 'string' && isValidId(event['correlationid']) ? event['correlationid'] : newCorrelationId();
  return {
    id: event['id'] as string,
    type: event['type'] as string,
    source: event['source'] as string,
    bookingId: String(data!['bookingId']).toLowerCase(),
    correlationId: correlation,
    channel,
    event: event,
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: now,
    leaseUntil: null,
    outcome: null,
    receivedAt: now,
    processedAt: null,
  };
}

const invalidEvent = (invalidParams: InvalidParam[]) =>
  new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'El evento no es un CloudEvent válido de Booking.', invalidParams });
