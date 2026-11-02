import type { CloudEvent } from '@ecoairlines/shared';
import type { OutboxRelay } from '@ecoairlines/shared/bus/outbox.js';
import type { EsbStore } from '../repositories/esb.store.js';

/**
 * Publicación de los eventos del ESB (`booking.*`, `flight.*` y los internos) con el dueño en `x-owner-id` (filtro D40 de
 * Webhooks). Desde V2.11 van al **outbox** de la base `esb`: el relé los publica en RabbitMQ con confirmación del broker. Si el
 * bus está caído, el evento queda pendiente y sale cuando vuelve. Guardar dos veces el mismo `id` (una saga que se reanuda) no
 * lo duplica. Sin bus (pruebas), los eventos quedan en memoria.
 */
export interface EventsPublisher {
  publish(event: CloudEvent, ownerId?: string): Promise<void>;
}

export const EVENTS_PUBLISHER = Symbol('EVENTS_PUBLISHER');

export class OutboxEventsPublisher implements EventsPublisher {
  constructor(
    private readonly store: EsbStore,
    private readonly relay: () => OutboxRelay | undefined,
  ) {}

  async publish(event: CloudEvent, ownerId?: string): Promise<void> {
    if (await this.store.insertOutbox(event, ownerId, new Date().toISOString())) this.relay()?.kick();
  }
}

export class InMemoryEventsPublisher implements EventsPublisher {
  readonly published: { event: CloudEvent; ownerId?: string }[] = [];

  async publish(event: CloudEvent, ownerId?: string): Promise<void> {
    if (this.published.some((p) => p.event.id === event.id)) return; // como el outbox: el mismo id una sola vez
    this.published.push({ event, ...(ownerId ? { ownerId } : {}) });
  }
}
