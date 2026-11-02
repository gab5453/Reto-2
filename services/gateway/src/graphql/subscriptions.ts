import { GraphQLError } from 'graphql';
import { newRequestId, runWithCorrelation } from '@ecoairlines/shared';
import type { GqlContext } from './context.js';
import { bookingEvent } from './mappers.js';

/**
 * Suscripción `bookingEvents` (D47, propuesta): el equivalente en tiempo real de los webhooks para la web. El gateway no
 * conoce el bus (solo habla con los MS de respuesta): **consulta el feed `GET /vuelos/eventos` de MS.Vuelos** con el token del
 * usuario cada `pollMs`, y el feed ya filtra por dueño (MS.G.Webhooks: un CLIENTE solo ve los eventos de sus reservas).
 *
 * Al conectarse se avanza hasta el final del feed sin emitir nada: llegan solo los eventos nuevos. Si MS.Vuelos no responde se
 * sigue intentando; si el token vence (`UNAUTHENTICATED`) la suscripción termina con ese error.
 */
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PAGE = 100;
/** Tope del avance inicial (100 páginas = 10 000 eventos): el resto llega en las vueltas siguientes. */
const MAX_INITIAL_PAGES = 100;

export class FeedSubscription implements AsyncIterableIterator<{ bookingEvents: Any }> {
  private after: string | undefined;
  private started = false;
  private closed = false;
  private wake?: () => void;
  private readonly pending: Any[] = [];

  constructor(
    private readonly context: GqlContext,
    private readonly filter: Set<string> | undefined,
    private readonly known: Set<string>,
    private readonly pollMs: number,
  ) {}

  [Symbol.asyncIterator]() {
    return this;
  }

  private async page(): Promise<Any[]> {
    const call = () => this.context.ms.call<Any>('MS.Vuelos', 'GET', '/vuelos/eventos', { query: { after: this.after, limit: PAGE } });
    // Fuera de una petición HTTP: cada vuelta lleva el X-Correlation-Id de la suscripción y un X-Request-Id nuevo.
    const body = (await (this.context.correlationId ? runWithCorrelation({ correlationId: this.context.correlationId, requestId: newRequestId() }, call) : call())).body;
    const events = (body['events'] as Any[] | undefined) ?? [];
    if (events.length) this.after = events.at(-1)!['id'];
    return events;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async next(): Promise<IteratorResult<{ bookingEvents: Any }>> {
    if (!this.started) {
      this.started = true;
      for (let i = 0; i < MAX_INITIAL_PAGES && !this.closed; i++) if ((await this.page()).length < PAGE) break;
    }
    while (!this.closed) {
      const event = this.pending.shift();
      if (event) return { value: { bookingEvents: event }, done: false };
      try {
        for (const raw of await this.page()) {
          const mapped = bookingEvent(raw, this.known);
          if (mapped && (!this.filter || this.filter.has(mapped['eventType']))) this.pending.push(mapped);
        }
      } catch (error) {
        // MS.Vuelos caído o lento: se reintenta en la próxima vuelta. Cualquier otro error (token vencido) termina.
        if (!(error instanceof GraphQLError && error.extensions['code'] === 'PROVIDER_UNAVAILABLE')) throw error;
      }
      if (!this.pending.length) await this.sleep(this.pollMs);
    }
    return { value: undefined, done: true };
  }

  async return(): Promise<IteratorResult<{ bookingEvents: Any }>> {
    this.closed = true;
    this.wake?.();
    return { value: undefined, done: true };
  }
}

export function bookingEventsSubscriber(known: Set<string>, pollMs: number) {
  return (_source: unknown, args: { events?: string[] | null }, context: GqlContext) => {
    const filter = args.events?.length ? new Set(args.events) : undefined;
    return new FeedSubscription(context, filter, known, pollMs);
  };
}
