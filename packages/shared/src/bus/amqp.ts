import { type ChannelModel, type ConfirmChannel, connect, type ConsumeMessage, type Options } from 'amqplib';
import { type CloudEvent, eventName } from '../cloudevents/cloudevents.js';
import { CORRELATION_KEY, newRequestId, REQUEST_ID_KEY, runWithCorrelation } from '../correlation/correlation.js';

/**
 * Bus interno de EcoAirlines (RabbitMQ; `contract/events.asyncapi.yaml`):
 * - Exchange `ecoairlines.events` (topic, durable) y routing key = nombre corto del evento (`booking.confirmed`…). Cada mensaje
 *   es el CloudEvent completo en JSON, persistente; `correlationid` va también en las propiedades AMQP y el dueño del hold o la
 *   reserva, en la cabecera `x-owner-id` (filtro D40 de MS.G.Webhooks; nunca sale en el webhook).
 * - Se publica con **confirmación del broker** (`publish` resuelve cuando RabbitMQ guardó el mensaje): el outbox solo marca un
 *   evento como publicado después de eso.
 * - Cada consumidor tiene su cola durable. Si el handler falla, el mensaje espera en `<cola>.retry.<n>` (TTL de 1 s, 5 s, 30 s y
 *   2 min) y vuelve SOLO a esa cola; al 5.º intento fallido va a la cola de fallidos `<cola>.dlq` por el exchange
 *   `ecoairlines.dlx`, con el motivo. Un mensaje ilegible va directo a la de fallidos. Los handlers deben ser idempotentes:
 *   los eventos se deduplican por `id`.
 *
 * No se exporta en el índice: `import … from '@ecoairlines/shared/bus/amqp.js'` (solo lo cargan los servicios que lo usan).
 */
export const EVENTS_EXCHANGE = 'ecoairlines.events';
export const DEAD_LETTER_EXCHANGE = 'ecoairlines.dlx';
export const OWNER_HEADER = 'x-owner-id';
export const ATTEMPTS_HEADER = 'x-attempts';
/** Esperas entre intentos: 5 intentos en total (el primero y 4 reintentos). */
export const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000];
/** Espera entre intentos de (re)conexión al broker. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface BusMessage {
  event: CloudEvent;
  ownerId?: string;
  /** 1 en la primera entrega; sube con cada reintento. */
  attempt: number;
}

export interface ConsumeOptions {
  retryDelaysMs?: number[];
  /** Se llama cuando un mensaje se agota y va a la cola de fallidos (para el log de alerta). */
  onDeadLetter?: (info: { queue: string; messageId?: string; type?: string; reason: string; attempts: number }) => void;
}

const ORIGINAL_KEY_HEADER = 'x-original-routing-key';
/** La routing key del evento (la del primer intento; los reintentos llegan con el nombre de la cola). */
const originalKey = (raw: ConsumeMessage) => String(raw.properties.headers?.[ORIGINAL_KEY_HEADER] ?? raw.fields.routingKey);
const delayLabel = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000}m` : ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`);

export class EventBus {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  /** Lo que hay que volver a declarar y consumir después de reconectar (colas, enlaces y consumidores). */
  private readonly setups: ((channel: ConfirmChannel) => Promise<void>)[] = [];
  private closing = false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  /** Se llama después de cada reconexión (p. ej. el relé del outbox publica lo pendiente). */
  onReconnect?: () => void;

  private constructor(
    private readonly url: string,
    /** Exchange topic durable: el nuestro (`ecoairlines.events`) o, en la entrada del ESB, el de Booking (`booking.events`). */
    readonly exchange: string,
  ) {}

  /**
   * La PRIMERA conexión también se reintenta (1 s, 2 s, 5 s, 10 s, 30 s…) hasta `initialTimeoutMs` (60 s por defecto): si
   * RabbitMQ está reiniciándose al arrancar el servicio (DNS sin resolver, ECONNREFUSED), el servicio espera en vez de caerse.
   */
  static async connect(url: string, exchange: string = EVENTS_EXCHANGE, options: { initialTimeoutMs?: number; delaysMs?: number[] } = {}): Promise<EventBus> {
    const bus = new EventBus(url, exchange);
    const until = Date.now() + (options.initialTimeoutMs ?? 60_000);
    const delays = options.delaysMs ?? RECONNECT_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        await bus.open();
        return bus;
      } catch (error) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        if (Date.now() + delay > until) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Conecta, declara los exchanges y vuelve a registrar las colas y los consumidores. Si RabbitMQ se cae o se reinicia, la
   * conexión se cierra y se reconecta sola (1 s, 2 s, 5 s, 10 s y luego cada 30 s); mientras tanto `publish` falla (el outbox
   * guarda los eventos) y los mensajes sin confirmar vuelven a su cola.
   */
  private async open(): Promise<void> {
    const connection = await connect(this.url);
    const channel = await connection.createConfirmChannel();
    await channel.assertExchange(this.exchange, 'topic', { durable: true });
    await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
    for (const setup of this.setups) await setup(channel);
    const lost = () => {
      if (this.connection !== connection) return;
      this.connection = undefined;
      this.channel = undefined;
      if (!this.closing) this.scheduleReconnect();
    };
    connection.on('close', lost);
    connection.on('error', () => undefined); // el 'close' que sigue hace el trabajo
    channel.on('error', () => undefined);
    channel.on('close', () => {
      if (this.channel === channel && !this.closing) void connection.close().catch(() => lost());
    });
    this.connection = connection;
    this.channel = channel;
    this.reconnectAttempt = 0;
  }

  private scheduleReconnect(): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt++, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectTimer = setTimeout(() => {
      this.open().then(
        () => this.onReconnect?.(),
        () => this.scheduleReconnect(),
      );
    }, delay);
    this.reconnectTimer.unref();
  }

  get connected(): boolean {
    return this.channel !== undefined;
  }

  /** Publica en un exchange y espera la confirmación del broker. */
  private send(exchange: string, routingKey: string, content: Buffer, options: Options.Publish): Promise<void> {
    const channel = this.channel;
    if (!channel) return Promise.reject(new Error('El bus está desconectado (se reconecta solo).'));
    return new Promise((resolve, reject) => {
      channel.publish(exchange, routingKey, content, options, (error: unknown) => (error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve()));
    });
  }

  /** Publica un CloudEvent con su routing key (persistente) y resuelve cuando RabbitMQ lo confirmó. */
  publish(event: CloudEvent, ownerId?: string): Promise<void> {
    return this.send(this.exchange, eventName(event.type), Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/cloudevents+json',
      messageId: event.id,
      correlationId: event.correlationid,
      headers: { [CORRELATION_KEY]: event.correlationid, [REQUEST_ID_KEY]: newRequestId(), ...(ownerId ? { [OWNER_HEADER]: ownerId } : {}) },
    });
  }

  /** Publica un mensaje JSON directo en una cola (p. ej. la espera de los reintentos diferidos del ESB), con TTL opcional. */
  async sendToQueue(queue: string, body: unknown, options: { correlationId?: string; expirationMs?: number } = {}): Promise<void> {
    await this.send('', queue, Buffer.from(JSON.stringify(body)), {
      persistent: true,
      contentType: 'application/json',
      ...(options.correlationId ? { correlationId: options.correlationId, headers: { [CORRELATION_KEY]: options.correlationId } } : {}),
      ...(options.expirationMs !== undefined ? { expiration: String(Math.max(0, Math.round(options.expirationMs))) } : {}),
    });
  }

  /** Declara una cola durable (con sus argumentos) para quien publica en ella. */
  async assertQueue(queue: string, args: Record<string, unknown> = {}): Promise<void> {
    const setup = async (channel: ConfirmChannel) => void (await channel.assertQueue(queue, { durable: true, arguments: args }));
    this.setups.push(setup);
    await setup(this.channel!);
  }

  /**
   * Consume una cola durable propia del servicio, ligada a `keys` (p. ej. `schedule.published` o `#`), con reintentos y cola de
   * fallidos (ver arriba). El handler corre con el correlation id del evento; si termina bien, el mensaje se confirma (ack).
   */
  async consume(queue: string, keys: string[], handler: (message: BusMessage) => Promise<void>, options: ConsumeOptions = {}): Promise<void> {
    const setup = async (channel: ConfirmChannel) => {
      const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
      const maxAttempts = delays.length + 1;
      await channel.assertQueue(queue, { durable: true });
      for (const key of keys) await channel.bindQueue(queue, this.exchange, key);
      // Cola de fallidos: la revisa un administrador (y dispara una alerta en la plataforma de observabilidad, V2.16).
      await channel.assertQueue(`${queue}.dlq`, { durable: true });
      await channel.bindQueue(`${queue}.dlq`, DEAD_LETTER_EXCHANGE, queue);
      // Una cola de espera por demora (un TTL fijo por cola: sin bloqueo "cabeza de fila"); al vencer, vuelve SOLO a `queue`.
      const retryQueues = delays.map((ms) => `${queue}.retry.${delayLabel(ms)}`);
      for (const [index, ms] of delays.entries()) {
        await channel.assertQueue(retryQueues[index], { durable: true, arguments: { 'x-message-ttl': ms, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': queue } });
      }
      await channel.prefetch(10);

      const deadLetter = async (raw: ConsumeMessage, attempts: number, reason: string, type?: string) => {
        await this.send(DEAD_LETTER_EXCHANGE, queue, raw.content, {
          persistent: true,
          contentType: raw.properties.contentType,
          messageId: raw.properties.messageId,
          correlationId: raw.properties.correlationId,
          headers: { ...raw.properties.headers, [ATTEMPTS_HEADER]: attempts, 'x-last-error': reason.slice(0, 500), [ORIGINAL_KEY_HEADER]: originalKey(raw), 'x-failed-at': new Date().toISOString() },
        });
        options.onDeadLetter?.({ queue, messageId: raw.properties.messageId, ...(type ? { type } : {}), reason, attempts });
      };

      await channel.consume(queue, (raw: ConsumeMessage | null) => {
        if (!raw) return;
        const attempt = Number(raw.properties.headers?.[ATTEMPTS_HEADER] ?? 1);
        let message: BusMessage;
        try {
          const event = JSON.parse(raw.content.toString('utf8')) as CloudEvent;
          if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('no es un CloudEvent');
          message = { event, attempt, ...(raw.properties.headers?.[OWNER_HEADER] ? { ownerId: String(raw.properties.headers[OWNER_HEADER]) } : {}) };
        } catch (error) {
          // Ilegible: reintentar no lo arregla.
          void deadLetter(raw, attempt, `mensaje ilegible: ${error instanceof Error ? error.message : String(error)}`).then(() => channel.ack(raw), () => channel.nack(raw, false, true));
          return;
        }
        const context = { correlationId: message.event.correlationid ?? String(raw.properties.correlationId ?? ''), requestId: newRequestId() };
        void runWithCorrelation(context, () => handler(message))
          .then(() => channel.ack(raw))
          .catch(async (error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            try {
              if (attempt >= maxAttempts) await deadLetter(raw, attempt, reason, message.event.type);
              else {
                // Al volver de la espera llega con la cola como routing key: se guarda la del evento para la cola de fallidos.
                await this.send('', retryQueues[attempt - 1], raw.content, { ...raw.properties, persistent: true, headers: { ...raw.properties.headers, [ATTEMPTS_HEADER]: attempt + 1, 'x-last-error': reason.slice(0, 500), [ORIGINAL_KEY_HEADER]: originalKey(raw) } });
              }
              channel.ack(raw);
            } catch {
              // Sin poder reprogramarlo (el broker cayó): vuelve a la cola original; no se pierde.
              setTimeout(() => channel.nack(raw, false, true), 1_000).unref();
            }
          });
      });
    };
    this.setups.push(setup);
    await setup(this.channel!);
  }

  /**
   * Consume una cola de TAREAS (JSON, sin enlazar al exchange; p. ej. `esb.deferred`). Si el handler falla, la tarea se descarta:
   * quien la programó tiene su propio respaldo (el ESB vuelve a encontrar la saga en `saga_log`).
   */
  async consumeTasks<T>(queue: string, handler: (task: T) => Promise<void>): Promise<void> {
    const setup = async (channel: ConfirmChannel) => {
      await channel.assertQueue(queue, { durable: true });
      await channel.consume(queue, (raw: ConsumeMessage | null) => {
        if (!raw) return;
        let task: T;
        try {
          task = JSON.parse(raw.content.toString('utf8')) as T;
        } catch {
          channel.ack(raw);
          return;
        }
        const context = { correlationId: String(raw.properties.correlationId ?? raw.properties.headers?.[CORRELATION_KEY] ?? ''), requestId: newRequestId() };
        void (context.correlationId ? runWithCorrelation(context, () => handler(task)) : handler(task)).then(
          () => channel.ack(raw),
          () => channel.ack(raw),
        );
      });
    };
    this.setups.push(setup);
    await setup(this.channel!);
  }

  /** Mensajes en una cola (operaciones y health: la de fallidos debería estar vacía). `undefined` si la cola no existe. */
  async messageCount(queue: string): Promise<number | undefined> {
    try {
      if (!this.connection) return undefined;
      const probe = await this.connection.createChannel();
      try {
        return (await probe.checkQueue(queue)).messageCount;
      } finally {
        await probe.close().catch(() => undefined);
      }
    } catch {
      return undefined;
    }
  }

  async ping(): Promise<boolean> {
    if (!this.channel) return false;
    await this.channel.checkExchange(this.exchange);
    return true;
  }

  async close(): Promise<void> {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  toString(): string {
    return `EventBus(${this.url.replace(/\/\/[^@]*@/, '//***@')}, ${this.exchange})`;
  }
}
