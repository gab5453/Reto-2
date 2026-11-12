import { Controller, Delete, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CLOUDEVENTS_CONTENT_TYPE, CORRELATION_HEADER, ProblemDetailsException, verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from '@ecoairlines/shared';
import { SimulatorStore } from '../simulator/simulator.store.js';

/**
 * Receptor de webhooks con las MISMAS reglas que el de Booking (`POST /api/v2/webhooks/vuelos`, BKG-16, 12/11/2026), así la CI
 * detecta si EcoAirlines deja de cumplirlas:
 * - `Content-Type` exactamente `application/cloudevents+json` (con `application/json` lo rechaza) → si no, 400.
 * - `X-Webhook-Signature: sha256=<HMAC-SHA256 en hex del cuerpo>` con el secreto compartido → si no, 401.
 * - CloudEvent 1.0: `id` **UUID v4**, `type` corto del contrato (`booking.checked_in`), `source`, `time` ISO 8601 y `data` objeto
 *   → si no, 400.
 * - 202 recibido; 200 si el `id` ya llegó (duplicado).
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORT_TYPE = /^[a-z_]+\.[a-z_]+$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Los campos de un CloudEvent que no cumplen las reglas de Booking (vacío = válido). */
export function invalidCloudEvent(event: Record<string, unknown> | undefined): { name: string; reason: string }[] {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return [{ name: 'body', reason: 'debe ser un objeto JSON' }];
  const problems: { name: string; reason: string }[] = [];
  if (event['specversion'] !== '1.0') problems.push({ name: 'specversion', reason: 'debe ser 1.0' });
  if (typeof event['id'] !== 'string' || !UUID_V4.test(event['id'])) problems.push({ name: 'id', reason: 'debe ser un UUID v4' });
  if (typeof event['type'] !== 'string' || !SHORT_TYPE.test(event['type'])) problems.push({ name: 'type', reason: 'nombre corto del evento (booking.checked_in)' });
  if (typeof event['source'] !== 'string' || !event['source']) problems.push({ name: 'source', reason: 'obligatorio' });
  if (typeof event['time'] !== 'string' || !ISO_8601.test(event['time'])) problems.push({ name: 'time', reason: 'fecha ISO 8601' });
  if (!event['data'] || typeof event['data'] !== 'object' || Array.isArray(event['data'])) problems.push({ name: 'data', reason: 'debe ser un objeto' });
  return problems;
}
export const webhookSecret = (): string => process.env['BOOKING_SIM_WEBHOOK_SECRET'] ?? 'secreto-de-prueba-booking-simulado';

@Controller()
export class WebhooksController {
  constructor(@Inject(SimulatorStore) private readonly store: SimulatorStore) {}

  @Post('webhooks/vuelos')
  receive(@Req() request: RawBodyRequest<Request>, @Res({ passthrough: true }) response: Response): { status: string } {
    if (request.header('content-type') !== CLOUDEVENTS_CONTENT_TYPE) {
      throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: `El Content-Type debe ser exactamente ${CLOUDEVENTS_CONTENT_TYPE}.` });
    }
    const raw = request.rawBody;
    if (!raw || !verifyWebhookSignature(webhookSecret(), raw, request.header(WEBHOOK_SIGNATURE_HEADER))) {
      throw new ProblemDetailsException({ status: 401, code: 'UNAUTHORIZED', title: 'Firma del webhook inválida o ausente.' });
    }
    const event = request.body as Record<string, unknown>;
    const problems = invalidCloudEvent(event);
    if (problems.length) {
      throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'El cuerpo no cumple CloudEvents (reglas de Booking).', invalidParams: problems });
    }
    const nuevo = this.store.addWebhook({
      id: String(event['id']),
      type: String(event['type']),
      subject: event['subject'] as string | undefined,
      correlationId: String(event['correlationid'] ?? ''),
      headerCorrelationId: request.header(CORRELATION_HEADER),
      receivedAt: new Date().toISOString(),
      event,
    });
    response.status(nuevo ? 202 : 200);
    return { status: nuevo ? 'received' : 'duplicate' };
  }

  @Get('simulador/webhooks')
  list(@Query('type') type?: string) {
    return this.store.listWebhooks(type);
  }

  @Get('simulador/stock')
  stock() {
    return { items: this.store.listStock(), streamedChanges: this.store.streamedChanges };
  }

  @Delete('simulador')
  @HttpCode(204)
  reset(): void {
    this.store.reset();
  }
}
