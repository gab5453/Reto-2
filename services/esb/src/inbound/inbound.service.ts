import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { newRequestId, ProblemDetailsException, runWithCorrelation, verifyWebhookSignature } from '@ecoairlines/shared';
import { isUnavailable } from '../clients/circuit-breaker.js';
import { ESB_CONFIG, type EsbConfig } from '../config/config.js';
import { ESB_STORE, type EsbStore, type InboundChannel, type InboundEventRecord, type InboundStatus } from '../repositories/esb.store.js';
import { INBOUND_TYPES, type PackageCancelledData, type PaymentEventData, toInboundRecord } from './inbound-event.js';
import { InboundHandlers } from './inbound-handlers.js';

/** Esperas entre reintentos de un evento cuyo paso falló por disponibilidad (un MS.G caído): nunca se descarta. */
export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000];

export interface ReceiveResult {
  id: string;
  duplicate: boolean;
}

/**
 * Entrada de eventos de Booking (PLAN.md §4.2, D34; BKG-01: el canal está por confirmar, así que se aceptan las dos vías).
 * 1. **Webhook** firmado (`POST /integraciones/booking/eventos`, `X-Webhook-Signature` con el secreto compartido) o **AMQP**
 *    (exchange `booking.events`): se valida el CloudEvent y se guarda en `inbound_events` por su `id`. Si ese `id` ya llegó, se
 *    responde OK y NO se procesa otra vez (capa 1).
 * 2. Un trabajador lo procesa con el MISMO `correlationid` del evento (si hay varias réplicas, cada evento lo toma una sola).
 * 3. Resultado: `PROCESSED`; `REJECTED` si es un error de negocio (p. ej. la referencia no es la de la reserva); `RETRY` con
 *    espera creciente si un MS.G no respondió. (`WAITING_SAGA` era el estado de `package.cancelled` en V2.9, antes de la saga
 *    "Cancelar": esos eventos se toman y se procesan ahora.)
 */
@Injectable()
export class InboundService implements OnModuleDestroy {
  private readonly logger = new Logger('InboundBooking');
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;

  constructor(
    @Inject(ESB_STORE) private readonly store: EsbStore,
    @Inject(ESB_CONFIG) private readonly config: EsbConfig,
    @Inject(InboundHandlers) private readonly handlers: InboundHandlers,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.processInBackground(), this.config.inboundIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Vía webhook: la firma se verifica sobre los bytes EXACTOS recibidos (antes de interpretar el JSON). */
  async receiveWebhook(raw: Buffer | undefined, signature: string | undefined): Promise<ReceiveResult> {
    if (!raw?.length || !verifyWebhookSignature(this.config.bookingEventsSecret, raw, signature)) {
      throw new ProblemDetailsException({ status: 401, code: 'UNAUTHORIZED', title: 'La firma X-Webhook-Signature no es válida.' });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'El cuerpo no es JSON válido.' });
    }
    return this.receive(body, 'WEBHOOK');
  }

  /** Vía AMQP (consumidor de `booking.events`) o webhook ya verificado. */
  async receive(body: unknown, channel: InboundChannel): Promise<ReceiveResult> {
    const record = toInboundRecord(body, channel, new Date().toISOString());
    const inserted = await this.store.insertInbound(record);
    this.logger.log(`${INBOUND_TYPES[record.type as keyof typeof INBOUND_TYPES]} ${record.id} por ${channel}${inserted ? '' : ' (repetido: no se procesa)'} [${record.correlationId}]`);
    if (inserted) setImmediate(() => this.processInBackground());
    return { id: record.id, duplicate: !inserted };
  }

  /**
   * En segundo plano: un error (p. ej. la base no respondió a tiempo) se registra y la ronda siguiente lo vuelve a intentar.
   * Sin esto, la promesa rechazada sin manejar terminaba el proceso del ESB.
   */
  private processInBackground(): void {
    void this.processDue().catch((error: unknown) => this.logger.error(`Ronda de eventos de Booking: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Procesa los eventos listos. Devuelve cuántos tomó (para las pruebas). Una sola ronda a la vez por réplica. */
  processDue(): Promise<number> {
    this.running ??= this.round().finally(() => (this.running = undefined));
    return this.running;
  }

  private async round(): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await this.store.claimInbound(new Date().toISOString(), 10);
      if (!batch.length) return total;
      total += batch.length;
      await Promise.all(batch.map((record) => runWithCorrelation({ correlationId: record.correlationId, requestId: newRequestId() }, () => this.process(record))));
    }
  }

  private async process(record: InboundEventRecord): Promise<void> {
    const name = INBOUND_TYPES[record.type as keyof typeof INBOUND_TYPES];
    const data = record.event['data'] as PaymentEventData;
    const finish = (status: Exclude<InboundStatus, 'PENDING' | 'PROCESSING'>, outcome: Record<string, unknown>, next?: string) =>
      this.store.finishInbound(record.id, status, outcome, new Date().toISOString(), next);
    try {
      const outcome =
        name === 'payment.confirmed'
          ? await this.handlers.paymentConfirmed(record.id, data)
          : name === 'payment.failed'
            ? await this.handlers.paymentFailed(record.id, data)
            : await this.handlers.packageCancelled(record.id, record.event['data'] as PackageCancelledData);
      await finish('PROCESSED', outcome);
      this.logger.log(`${name} ${record.id} → ${JSON.stringify(outcome)} [${record.correlationId}]`);
    } catch (error) {
      if (error instanceof ProblemDetailsException && !isUnavailable(error) && error.problem.status < 500) {
        await finish('REJECTED', { problem: error.problem });
        this.logger.warn(`${name} ${record.id} rechazado: ${error.problem.code} — ${error.problem.title} [${record.correlationId}]`);
        return;
      }
      const delay = RETRY_DELAYS_MS[Math.min(record.attempts - 1, RETRY_DELAYS_MS.length - 1)];
      const problem = error instanceof ProblemDetailsException ? error.problem : { code: 'INTERNAL_ERROR', title: error instanceof Error ? error.message : String(error) };
      await finish('RETRY', { problem, attempts: record.attempts }, new Date(Date.now() + delay).toISOString());
      this.logger.warn(`${name} ${record.id}: ${problem.code}; reintento ${record.attempts} en ${delay / 1000} s [${record.correlationId}]`);
    }
  }
}
