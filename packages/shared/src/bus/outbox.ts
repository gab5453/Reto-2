import type { CloudEvent } from '../cloudevents/cloudevents.js';
import type { EventBus } from './amqp.js';

/**
 * Outbox (`events.asyncapi.yaml`, V2.11): el productor guarda el evento en SU base, en la misma transacción que el cambio (o en el
 * mismo paso de la saga, en el ESB), y este relé lo publica después. Así no se pierden eventos si RabbitMQ está caído, ni se
 * publican eventos de cambios que no se guardaron.
 * - Cada ronda toma los pendientes con un plazo (`leaseMs`): dos réplicas no publican el mismo a la vez; si una se cae a la mitad,
 *   al vencer el plazo otra lo retoma.
 * - Publica en orden, con confirmación del broker, y solo entonces lo marca publicado. Si el bus falla, la ronda se corta y se
 *   reintenta después (el evento sigue pendiente).
 * - Un evento puede llegar a publicarse dos veces (la réplica se cayó entre publicar y marcar): los consumidores lo deduplican
 *   por su `id` (garantía "al menos una vez").
 */
export interface OutboxEntry {
  id: string;
  event: CloudEvent;
  ownerId?: string | null;
}

export interface OutboxSource {
  /** Pendientes, del más antiguo al más nuevo, tomados por esta réplica durante `leaseMs`. */
  claimOutbox(limit: number, leaseMs: number): Promise<OutboxEntry[]>;
  markOutboxPublished(id: string, publishedAt: string): Promise<void>;
}

export interface RelayLogger {
  log(message: string): void;
  warn(message: string): void;
}

export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  private kicked = false;
  /** Último error de publicación (health y operaciones); `undefined` si la última ronda anduvo bien. */
  lastError?: string;
  published = 0;

  constructor(
    private readonly source: OutboxSource,
    private readonly bus: () => EventBus | undefined,
    private readonly logger: RelayLogger,
    private readonly options: { intervalMs: number; batch?: number; leaseMs?: number } = { intervalMs: 1_000 },
  ) {}

  start(): void {
    this.timer = setInterval(() => this.background(), this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Publicar ya (después de guardar un evento) en lugar de esperar al próximo intervalo. */
  kick(): void {
    if (this.running) {
      this.kicked = true;
      return;
    }
    setImmediate(() => this.background());
  }

  /**
   * Ronda en segundo plano: si la base no responde, el error queda en `lastError` y en el log, y la próxima ronda reintenta.
   * Una promesa rechazada sin manejar terminaría el proceso.
   */
  private background(): void {
    void this.runOnce().catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Outbox: la ronda falló (${this.lastError}); se reintenta`);
    });
  }

  /** Una ronda; devuelve cuántos publicó. Nunca dos rondas a la vez en la misma réplica. */
  runOnce(): Promise<number> {
    this.running ??= this.round().finally(() => {
      this.running = undefined;
      if (this.kicked) {
        this.kicked = false;
        setImmediate(() => this.background());
      }
    });
    return this.running;
  }

  private async round(): Promise<number> {
    const bus = this.bus();
    if (!bus) return 0;
    let total = 0;
    for (;;) {
      const batch = await this.source.claimOutbox(this.options.batch ?? 50, this.options.leaseMs ?? 30_000);
      if (!batch.length) return total;
      for (const entry of batch) {
        try {
          await bus.publish(entry.event, entry.ownerId ?? undefined);
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Outbox: no se pudo publicar ${entry.event.type} ${entry.id} (${this.lastError}); se reintenta`);
          return total;
        }
        await this.source.markOutboxPublished(entry.id, new Date().toISOString());
        total++;
        this.published++;
      }
      this.lastError = undefined;
    }
  }
}
