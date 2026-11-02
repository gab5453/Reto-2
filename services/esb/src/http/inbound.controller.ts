import { Controller, Get, HttpCode, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemDetailsException, ServiceTokenGuard, WEBHOOK_SIGNATURE_HEADER } from '@ecoairlines/shared';
import { InboundService } from '../inbound/inbound.service.js';
import { ESB_STORE, type EsbStore, type InboundStatus } from '../repositories/esb.store.js';
import { callerOf } from './caller.js';

const STATUSES: InboundStatus[] = ['PENDING', 'PROCESSING', 'RETRY', 'PROCESSED', 'REJECTED', 'WAITING_SAGA'];

/**
 * Entrada de eventos de Booking por webhook (BKG-01, `events.asyncapi.yaml` → `bookingEventsWebhookIn`). No lleva token: el
 * gateway publica `/api/integraciones/booking/eventos` y la autenticación es la firma HMAC del cuerpo con el secreto compartido.
 * Responde `202` en cuanto el evento quedó guardado (el proceso sigue en segundo plano, dentro del plazo de 5 s de Booking).
 */
@Controller()
export class InboundController {
  constructor(
    @Inject(InboundService) private readonly inbound: InboundService,
    @Inject(ESB_STORE) private readonly store: EsbStore,
  ) {}

  @Post('integraciones/booking/eventos')
  @HttpCode(202)
  async receive(@Req() request: Request & { rawBody?: Buffer }) {
    const result = await this.inbound.receiveWebhook(request.rawBody, request.header(WEBHOOK_SIGNATURE_HEADER));
    return { accepted: true, ...result };
  }

  /** Eventos recibidos de Booking (panel de administración: integración con Booking). Solo con `X-Actor-Id`. */
  @Get('inbound-events')
  @UseGuards(ServiceTokenGuard)
  async list(@Req() request: Request, @Query('status') status?: string, @Query('limit') limit?: string) {
    if (!callerOf(request).actorId) throw invalid('X-Actor-Id', 'obligatorio: sub del administrador');
    if (status !== undefined && !STATUSES.includes(status as InboundStatus)) throw invalid('status', `uno de ${STATUSES.join(', ')}`);
    const size = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > 200) throw invalid('limit', 'entero entre 1 y 200');
    const items = await this.store.listInbound({ ...(status ? { status: status as InboundStatus } : {}), limit: size });
    return { items: items.map(({ leaseUntil: _lease, ...item }) => item) };
  }
}

const invalid = (name: string, reason: string) =>
  new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La consulta no es válida.', invalidParams: [{ name, reason }] });
