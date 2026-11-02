import { Controller, Delete, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { CORRELATION_HEADER, PUBLIC_TYPE_PREFIX, ProblemDetailsException, verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from '@ecoairlines/shared';
import { SimulatorStore } from '../simulator/simulator.store.js';

/**
 * Receptor de webhooks como el de Booking (callback `vuelosEvent` de `POST /vuelos/webhooks`, contrato v2 §8):
 * verifica `X-Webhook-Signature` con el secreto de la suscripción, exige un CloudEvent público y deduplica por `id`.
 */
export const webhookSecret = (): string => process.env['BOOKING_SIM_WEBHOOK_SECRET'] ?? 'secreto-de-prueba-booking-simulado';

@Controller()
export class WebhooksController {
  constructor(@Inject(SimulatorStore) private readonly store: SimulatorStore) {}

  @Post('webhooks/vuelos')
  @HttpCode(204)
  receive(@Req() request: RawBodyRequest<Request>): void {
    const raw = request.rawBody;
    if (!raw || !verifyWebhookSignature(webhookSecret(), raw, request.header(WEBHOOK_SIGNATURE_HEADER))) {
      throw new ProblemDetailsException({ status: 401, code: 'UNAUTHORIZED', title: 'Firma del webhook inválida o ausente.' });
    }
    const event = request.body as Record<string, unknown>;
    const missing = ['specversion', 'type', 'source', 'id', 'time', 'correlationid', 'data'].filter((field) => event?.[field] === undefined);
    if (missing.length || event['specversion'] !== '1.0' || !String(event['type']).startsWith(PUBLIC_TYPE_PREFIX)) {
      throw new ProblemDetailsException({
        status: 400,
        code: 'VALIDATION_FAILED',
        title: 'El cuerpo no es un CloudEvent público de vuelos.',
        invalidParams: missing.map((name) => ({ name, reason: 'obligatorio en CloudEvents 1.0' })),
      });
    }
    this.store.addWebhook({
      id: String(event['id']),
      type: String(event['type']),
      subject: event['subject'] as string | undefined,
      correlationId: String(event['correlationid']),
      headerCorrelationId: request.header(CORRELATION_HEADER),
      receivedAt: new Date().toISOString(),
      event,
    });
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
