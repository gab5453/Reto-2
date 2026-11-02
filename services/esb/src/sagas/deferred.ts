import type { EventBus } from '@ecoairlines/shared/bus/amqp.js';
import type { SagaRecord } from '../repositories/esb.store.js';
import { RETRY_DELAYS_MS } from './engine.js';

/**
 * Reintentos diferidos del ESB por RabbitMQ (`events.asyncapi.yaml` → `esbDeferred`; PLAN.md §4.2: "mensaje diferido en
 * RabbitMQ, TTL + dead letter"). Cuando una saga queda pendiente (después del punto sin retorno, o con una compensación que no
 * pudo hacerse), se publica una `DeferredTask` en la cola de espera de esa demora (`esb.deferred.wait.<demora>`, con TTL fijo:
 * sin bloqueo "cabeza de fila"); al vencer, el *dead letter* la lleva a `esb.deferred` y el ESB retoma la saga en ese momento.
 * Es un acelerador: si RabbitMQ no está, el trabajador de recuperación igual encuentra la saga en `saga_log`.
 */
export const DEFERRED_QUEUE = 'esb.deferred';

const label = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000}m` : `${ms / 1_000}s`);
export const waitQueue = (ms: number) => `${DEFERRED_QUEUE}.wait.${label(ms)}`;

export interface DeferredTask {
  sagaId: string;
  sagaType: string;
  step: string;
  attempt: number;
  notBefore: string;
  correlationId?: string;
}

export class DeferredScheduler {
  constructor(private readonly bus: () => EventBus | undefined) {}

  /** Declara las colas: la de destino y una de espera por cada demora del motor. */
  static async setup(bus: EventBus): Promise<void> {
    await bus.assertQueue(DEFERRED_QUEUE);
    for (const ms of RETRY_DELAYS_MS) await bus.assertQueue(waitQueue(ms), { 'x-message-ttl': ms, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': DEFERRED_QUEUE });
  }

  async schedule(record: SagaRecord, delayMs: number): Promise<void> {
    const bus = this.bus();
    if (!bus) return;
    const ms = RETRY_DELAYS_MS.find((d) => d >= delayMs) ?? RETRY_DELAYS_MS.at(-1)!;
    const task: DeferredTask = {
      sagaId: record.sagaId,
      sagaType: record.type,
      step: record.steps.find((s) => s.status === 'STARTED')?.name ?? record.steps.at(-1)?.name ?? 'start',
      attempt: record.attempts,
      notBefore: record.nextAttemptAt,
      correlationId: record.correlationId,
    };
    await bus.sendToQueue(waitQueue(ms), task, { correlationId: record.correlationId });
  }
}
