import { Injectable } from '@nestjs/common';
import type { EventBus } from '@ecoairlines/shared/bus/amqp.js';
import type { OutboxRelay } from '@ecoairlines/shared/bus/outbox.js';

/**
 * Relé del outbox de Offers (V2.11): `hold.created` y `hold.expired` se guardan en la misma transacción que el hold y este relé
 * los publica en el bus interno (con el dueño en `x-owner-id`, para el filtro D40 de Webhooks). El servidor gRPC lo "patea"
 * después de cada operación; además corre cada segundo.
 */
@Injectable()
export class OffersEvents {
  bus?: EventBus;
  relay?: OutboxRelay;

  kick(): void {
    this.relay?.kick();
  }
}
