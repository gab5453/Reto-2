import { Controller, Get, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { isValidId, ProblemDetailsException, ServiceTokenGuard } from '@ecoairlines/shared';
import type { Caller } from '../clients/rest.client.js';
import { CompositionService, type OperationsQuery } from '../composition/composition.service.js';
import { HealthCompositionService } from '../composition/health.service.js';
import { CallerContext } from './caller.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** La telemetría es del panel de administración: exige el actor (un ADMIN, D41). */
const requireActor = (caller: Caller) => {
  if (!caller.actorId) throw new ProblemDetailsException({ status: 403, code: 'FORBIDDEN', title: 'La telemetría es solo para administradores (X-Actor-Id).' });
};

/** Composición (solo lectura): varios MS.G en paralelo, una respuesta (`contract/esb.openapi.yaml`). */
@Controller('composition')
@UseGuards(ServiceTokenGuard)
export class CompositionController {
  constructor(
    @Inject(HealthCompositionService) private readonly health: HealthCompositionService,
    @Inject(CompositionService) private readonly composition: CompositionService,
  ) {}

  /** Health del nodo con la forma del contrato v2 (`VuelosHealthResponse`), desde caché: 200 HEALTHY/DEGRADED, 503 DOWN. */
  @Get('health')
  async nodeHealth(@Res() response: Response): Promise<void> {
    const { health } = await this.health.current();
    response.status(health.status === 'DOWN' ? 503 : 200).json(health);
  }

  /** Salud de cada servicio para el panel (`ServiceHealth[]` de ms-admin), de la misma caché. */
  @Get('services-health')
  async servicesHealth() {
    const { dependencies, checkedAt } = await this.health.current();
    return dependencies.map((d) => ({ service: d.nombre, status: d.status, latency_ms: d.latencia_ms, ...(d.version ? { version: d.version } : {}), checkedAt }));
  }

  @Get('flight-operations')
  flightOperations(@Query() query: OperationsQuery) {
    return this.composition.flightOperations(query);
  }

  @Get('indicators')
  indicators(@Query('from') from: string | undefined, @Query('to') to: string | undefined, @CallerContext() caller: Caller) {
    return this.composition.indicators(caller, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
  }

  @Get('flights/:flightNumber/delay-impact')
  delayImpact(@Param('flightNumber') flightNumber: string, @Query('date') date: string | undefined, @Query('delayMinutes') delayMinutes: string | undefined, @CallerContext() caller: Caller) {
    return this.composition.delayImpact(flightNumber, date, delayMinutes, caller);
  }

  @Get('flights/:flightNumber/assistance')
  flightAssistance(@Param('flightNumber') flightNumber: string, @Query('date') date: string | undefined, @CallerContext() caller: Caller) {
    return this.composition.flightAssistance(flightNumber, date, caller);
  }

  @Get('bookings/:bookingId/boarding-passes')
  boardingPasses(@Param('bookingId') bookingId: string, @CallerContext() caller: Caller) {
    if (!UUID.test(bookingId)) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La petición no es válida.', invalidParams: [{ name: 'bookingId', reason: 'debe ser un UUID' }] });
    return this.composition.boardingPasses(bookingId.toLowerCase(), caller);
  }

  @Get('booking-integration')
  bookingIntegration(@CallerContext() caller: Caller) {
    return this.composition.bookingIntegration(caller);
  }

  // ------------------------------------------------------------------------- telemetría del panel (V2.16, D50; solo ADMIN)
  @Get('telemetry/latency')
  latency(@Query('from') from: string | undefined, @Query('to') to: string | undefined, @CallerContext() caller: Caller) {
    requireActor(caller);
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (value !== undefined && Number.isNaN(Date.parse(value))) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La petición no es válida.', invalidParams: [{ name, reason: 'fecha y hora RFC 3339' }] });
    }
    return this.composition.latency(from, to);
  }

  @Get('telemetry/traces/:correlationId')
  trace(@Param('correlationId') correlationId: string, @Query('from') from: string | undefined, @Query('to') to: string | undefined, @CallerContext() caller: Caller) {
    requireActor(caller);
    if (!isValidId(correlationId)) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La petición no es válida.', invalidParams: [{ name: 'correlationId', reason: 'hasta 100 caracteres visibles' }] });
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (value !== undefined && Number.isNaN(Date.parse(value))) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La petición no es válida.', invalidParams: [{ name, reason: 'fecha y hora RFC 3339' }] });
    }
    return this.composition.correlationTrace(correlationId, caller, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
  }

  /** Vista «Recorrido» (T-4): los saltos de un proceso de servicio en servicio, desde Tempo (solo ADMIN). */
  @Get('telemetry/journeys/:correlationId')
  journey(@Param('correlationId') correlationId: string, @Query('from') from: string | undefined, @Query('to') to: string | undefined, @CallerContext() caller: Caller) {
    requireActor(caller);
    if (!isValidId(correlationId)) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La petición no es válida.', invalidParams: [{ name: 'correlationId', reason: 'hasta 100 caracteres visibles' }] });
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (value !== undefined && Number.isNaN(Date.parse(value))) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La petición no es válida.', invalidParams: [{ name, reason: 'fecha y hora RFC 3339' }] });
    }
    return this.composition.journey(correlationId, caller, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
  }

  /** Mapa del sistema en vivo (T-4, solo ADMIN). */
  @Get('telemetry/system-map')
  systemMap(@CallerContext() caller: Caller) {
    requireActor(caller);
    return this.composition.systemMap();
  }

  /** Panel O-2: sagas y eventos de una reserva (solo ADMIN). */
  @Get('bookings/:bookingId/timeline')
  bookingTimeline(@Param('bookingId') bookingId: string, @CallerContext() caller: Caller) {
    requireActor(caller);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)) {
      throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La petición no es válida.', invalidParams: [{ name: 'bookingId', reason: 'UUID' }] });
    }
    return this.composition.bookingTimeline(bookingId.toLowerCase(), caller);
  }

  @Get('telemetry/queues')
  queues(@CallerContext() caller: Caller) {
    requireActor(caller);
    return this.composition.queues();
  }

  @Get('telemetry/alerts')
  alerts(@CallerContext() caller: Caller) {
    requireActor(caller);
    return this.composition.alerts();
  }
}
