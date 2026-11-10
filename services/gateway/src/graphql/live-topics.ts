import { GraphQLError } from 'graphql';
import { newCorrelationId, newRequestId, runWithCorrelation } from '@ecoairlines/shared';
import type { GqlContext } from './context.js';
import { unauthenticated } from './errors.js';

/**
 * Telemetría en tiempo real por WebSocket (PLAN_Telemetria_Asientos T-5, D-T13): las suscripciones `traceProgress` y
 * `liveSystemMap` del panel. El gateway no conoce Tempo ni Prometheus (solo habla con los MS de respuesta): **consulta a MS.Admin
 * solo mientras hay alguien suscrito**, una sola vez por tema aunque haya varios suscriptores, y empuja a cada uno lo nuevo.
 *
 * - Un **tema** es una clave (`system-map`, `journey:<correlationId>`) con su consulta y su intervalo. Nace con el primer
 *   suscriptor y se detiene (y se borra) cuando se va el último: sin nadie mirando no se consulta nada.
 * - La consulta usa el token de uno de los suscriptores vigentes (todos son administradores: `@auth` ya lo exigió al suscribirse).
 * - **Token vencido:** en cada vuelta se revisa el `exp` de cada suscriptor; al vencer, su suscripción termina con
 *   `UNAUTHENTICATED` (la web vuelve a conectarse con el token nuevo). Si MS.Admin no responde, se reintenta en la vuelta siguiente.
 * - Cada suscriptor recibe al entrar lo último que se sabe del tema, y después solo cuando cambia (`emit` decide qué mandar).
 */
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Topic<T> {
  key: string;
  intervalMs: number;
  /** Consulta (con el contexto de un suscriptor). `undefined` = todavía no hay nada (p. ej. un proceso sin trazas aún). */
  fetch: (context: GqlContext) => Promise<T | undefined>;
  /** Qué mandar dado lo anterior (para quien ya lo tenía) o `undefined` si no cambió nada. */
  emit: (previous: T | undefined, next: T) => Any | undefined;
  /** Lo que recibe un suscriptor nuevo con el último valor conocido. */
  snapshot: (latest: T) => Any;
}

class Subscriber implements AsyncIterableIterator<Any> {
  private readonly queue: Any[] = [];
  private wake?: () => void;
  private failure?: unknown;
  closed = false;

  constructor(
    readonly context: GqlContext,
    private readonly field: string,
    private readonly onClose: (subscriber: Subscriber) => void,
  ) {}

  [Symbol.asyncIterator]() {
    return this;
  }

  push(payload: Any): void {
    if (this.closed) return;
    this.queue.push(payload);
    this.wake?.();
  }

  fail(error: unknown): void {
    this.failure = error;
    this.wake?.();
  }

  /** ¿Venció su token? */
  expired(now: number): boolean {
    return (this.context.claims?.exp ?? 0) * 1000 <= now;
  }

  async next(): Promise<IteratorResult<Any>> {
    while (!this.closed) {
      if (this.failure) {
        this.close();
        throw this.failure;
      }
      const payload = this.queue.shift();
      if (payload) return { value: { [this.field]: payload }, done: false };
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
    return { value: undefined, done: true };
  }

  async return(): Promise<IteratorResult<Any>> {
    this.close();
    return { value: undefined, done: true };
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
    this.onClose(this);
  }
}

class LiveTopic<T> {
  readonly subscribers = new Set<Subscriber>();
  private latest: T | undefined;
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Cuántas consultas hizo (las pruebas lo miran: sin suscriptores, 0; con dos, una sola por vuelta). */
  polls = 0;

  constructor(
    readonly topic: Topic<T>,
    private readonly onEmpty: () => void,
    private readonly now: () => number,
  ) {}

  add(subscriber: Subscriber): void {
    this.subscribers.add(subscriber);
    if (this.latest !== undefined) subscriber.push(this.topic.snapshot(this.latest));
    if (!this.timer) {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), this.topic.intervalMs);
      this.timer.unref?.();
    }
  }

  remove(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
    if (!this.subscribers.size) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.onEmpty();
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      for (const subscriber of this.subscribers) if (subscriber.expired(now)) subscriber.fail(unauthenticated('El token venció: vuelve a conectarte.'));
      const owner = [...this.subscribers].find((subscriber) => !subscriber.closed && !subscriber.expired(now));
      if (!owner) return;
      this.polls++;
      const correlationId = owner.context.correlationId ?? newCorrelationId();
      let next: T | undefined;
      try {
        next = await runWithCorrelation({ correlationId, requestId: newRequestId() }, () => this.topic.fetch(owner.context));
      } catch (error) {
        // MS.Admin, el ESB o Tempo lentos o caídos: se reintenta en la vuelta siguiente. Otro error (token rechazado) termina a ese.
        if (error instanceof GraphQLError && error.extensions['code'] === 'PROVIDER_UNAVAILABLE') return;
        owner.fail(error);
        return;
      }
      if (next === undefined) return;
      const payload = this.topic.emit(this.latest, next);
      this.latest = next;
      if (payload) for (const subscriber of this.subscribers) subscriber.push(payload);
    } finally {
      this.running = false;
    }
  }
}

/** Los temas vivos del gateway (uno por clave). */
export class LiveTopics {
  private readonly topics = new Map<string, LiveTopic<any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(private readonly now: () => number = Date.now) {}

  subscribe<T>(context: GqlContext, field: string, topic: Topic<T>): AsyncIterableIterator<Any> {
    let live = this.topics.get(topic.key) as LiveTopic<T> | undefined;
    if (!live) {
      live = new LiveTopic(topic, () => this.topics.delete(topic.key), this.now);
      this.topics.set(topic.key, live);
    }
    const subscriber = new Subscriber(context, field, (closed) => live!.remove(closed));
    live.add(subscriber);
    return subscriber;
  }

  /** Para las pruebas y el diagnóstico: los temas activos y sus consultas. */
  stats() {
    return [...this.topics.values()].map((live) => ({ key: live.topic.key, subscribers: live.subscribers.size, polls: live.polls }));
  }
}

// ── Los dos temas del panel ──

const hopKey = (journey: Any, hop: Any) => `${hop['traceId']}|${hop['from']}|${hop['to']}|${hop['operation']}|${Math.round(Date.parse(journey['startedAt']) + Number(hop['startMs']))}`;

/** `traceProgress(correlationId)`: el recorrido completo cada vez que llegan pasos nuevos, y cuáles son los nuevos. */
export function journeyTopic(correlationId: string, intervalMs: number): Topic<Any> {
  return {
    key: `journey:${correlationId}`,
    intervalMs,
    fetch: async (context) => {
      try {
        return (await context.ms.call<Any>('MS.Admin', 'GET', `/ecoairlines/admin/telemetry/journeys/${encodeURIComponent(correlationId)}`)).body;
      } catch (error) {
        // Todavía sin trazas en Tempo: se sigue esperando.
        if (error instanceof GraphQLError && error.extensions['code'] === 'NOT_FOUND') return undefined;
        throw error;
      }
    },
    emit: (previous, next) => {
      const known = new Set(previous ? (previous['hops'] as Any[]).map((hop) => hopKey(previous, hop)) : []);
      const added = (next['hops'] as Any[]).filter((hop) => !known.has(hopKey(next, hop)));
      return added.length ? { correlationId, journey: next, newHops: added } : undefined;
    },
    snapshot: (latest) => ({ correlationId, journey: latest, newHops: latest['hops'] }),
  };
}

/** `liveSystemMap`: el mapa cada vez que cambian sus aristas (tráfico, errores o latencia). */
export function systemMapTopic(intervalMs: number): Topic<Any> {
  return {
    key: 'system-map',
    intervalMs,
    fetch: async (context) => (await context.ms.call<Any>('MS.Admin', 'GET', '/ecoairlines/admin/telemetry/system-map')).body,
    emit: (previous, next) => (previous && JSON.stringify(previous['edges']) === JSON.stringify(next['edges']) ? undefined : next),
    snapshot: (latest) => latest,
  };
}
