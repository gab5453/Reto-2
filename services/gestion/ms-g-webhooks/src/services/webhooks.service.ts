import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type CloudEvent, CLOUDEVENTS_CONTENT_TYPE, ProblemDetailsException, signWebhook, toContractFormat, WEBHOOK_SIGNATURE_HEADER } from '@ecoairlines/shared';
import { countWebhookDelivery } from '@ecoairlines/shared/telemetry/metrics.js';
import { WEBHOOKS_CONFIG, type WebhooksConfig } from '../config/config.js';
import {
  assertAllowedUrl,
  canReadFeed,
  canReceive,
  DELIVERY_TIMEOUT_MS,
  type DeliveryRecord,
  type EventRecord,
  nextRetryAt,
  type PublicEventName,
  SecretBox,
  type SubscriptionRecord,
  targetOf,
  toEventRecord,
} from '../domain/rules.js';
import { type HistoryFilter, WEBHOOKS_STORE, type WebhooksStore } from '../repositories/webhooks.store.js';

const HEALTH_EVENTS = new Set(['booking.assistance_requested']);
const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`).toString('base64url');
const decodeCursor = (cursor?: string) => Number(/^o:(\d{1,7})$/.exec(Buffer.from(cursor ?? '', 'base64url').toString('utf8'))?.[1] ?? 0);

/**
 * MS.G.Webhooks: suscripciones, `event_log`, entrega de CloudEvents firmados con reintentos (1 min → 6 h) y el feed de respaldo.
 * Es la única pieza que llama hacia afuera (a la URL de cada suscriptor). Filtro de destinatarios D40.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger('WebhookDelivery');
  private readonly box: SecretBox;

  constructor(
    @Inject(WEBHOOKS_STORE) private readonly store: WebhooksStore,
    @Inject(WEBHOOKS_CONFIG) private readonly config: WebhooksConfig,
  ) {
    this.box = new SecretBox(config.encryptionKey);
  }

  now = (): number => Date.now();
  /** Reemplazable en pruebas. */
  fetcher: typeof fetch = (input, init) => fetch(input, init);

  // ------------------------------------------------------------------ suscripciones
  async subscribe(ownerId: string, input: { url: string; events: PublicEventName[]; secret: string }) {
    await assertAllowedUrl(input.url, !this.config.allowPrivateUrls);
    const record: SubscriptionRecord = {
      id: randomUUID(),
      ownerId,
      url: input.url,
      events: [...new Set(input.events)],
      secretEncrypted: this.box.seal(input.secret),
      active: true,
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.store.insertSubscription(record);
    return this.view(record);
  }

  async list(ownerId: string) {
    return (await this.store.subscriptions(ownerId)).map((record) => this.view(record));
  }

  /**
   * La suscripción sin el secreto. `secretHint` (V2.14): sus últimos 4 caracteres, para que el administrador de la web reconozca
   * cuál configuró (`••••1234`). Los MS de respuesta lo quitan en `GET /vuelos/webhooks` (el contrato v2 no lo publica).
   */
  private view(record: SubscriptionRecord) {
    return { ...view(record), secretHint: this.box.open(record.secretEncrypted).slice(-4) };
  }

  /** Una suscripción de otro dueño responde 404; sus entregas pendientes se cancelan. */
  async unsubscribe(ownerId: string, id: string): Promise<void> {
    const subscription = await this.store.subscription(id);
    if (!subscription || !subscription.active || subscription.ownerId !== ownerId) throw new ProblemDetailsException({ status: 404, code: 'NOT_FOUND', title: 'Suscripción no encontrada.' });
    await this.store.deactivate(id);
  }

  // ------------------------------------------------------------------ eventos
  /** Consumidor del bus: guarda el evento (deduplicado por `id`) y crea una entrega por cada suscriptor que puede recibirlo (D40). */
  async ingest(event: CloudEvent, ownerId?: string): Promise<EventRecord | undefined> {
    const record = toEventRecord(event, ownerId);
    const targets = record.public ? (await this.store.activeSubscriptionsFor(record.name)).filter((s) => canReceive(s.ownerId, record)).map((s) => s.id) : [];
    return this.store.ingest(record, targets, new Date(this.now()).toISOString());
  }

  /** Feed de respaldo (`GET /vuelos/eventos`): eventos públicos que el dueño puede leer (`canReadFeed`), después de `after`. */
  async feed(ownerId: string, after: string | undefined, limit: number, name?: string, actorId?: string) {
    let afterSeq = 0;
    if (after) {
      const anchor = await this.store.eventById(after);
      if (!anchor) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'El evento `after` no existe.', invalidParams: [{ name: 'after', reason: 'id de CloudEvent desconocido' }] });
      afterSeq = anchor.seq;
    }
    const events: EventRecord[] = [];
    // Se lee por lotes porque el filtro D40 descarta eventos de otros canales.
    while (events.length < limit) {
      const batch = await this.store.publicEventsAfter(afterSeq, name, 200);
      if (!batch.length) break;
      for (const event of batch) if (canReadFeed(ownerId, actorId, event) && events.length < limit) events.push(event);
      afterSeq = batch.at(-1)!.seq;
      if (batch.length < 200) break;
    }
    return { events: events.map((e) => toContractFormat(e.event)), metadata: { total: events.length, next_after: events.at(-1)?.id ?? after ?? null, timestamp: new Date(this.now()).toISOString() } };
  }

  /** Historial completo (con los internos) para el panel; los eventos con datos de salud se muestran sin `data`. */
  async history(filter: HistoryFilter, limit: number, cursor?: string) {
    const offset = decodeCursor(cursor);
    const events = await this.store.history(filter, limit + 1, offset);
    const page = events.slice(0, limit);
    const deliveries = await this.store.deliveriesOf(page.map((e) => e.seq));
    const subscriptions = new Map<string, SubscriptionRecord | undefined>();
    for (const id of new Set(deliveries.map((d) => d.subscriptionId))) subscriptions.set(id, await this.store.subscription(id));
    return {
      items: page.map((e) => ({
        seq: e.seq,
        id: e.id,
        type: e.type,
        subject: e.subject,
        time: e.time,
        correlationId: e.correlationId,
        public: e.public,
        data: HEALTH_EVENTS.has(e.name) ? null : (e.event.data),
        deliveries: deliveries
          .filter((d) => d.eventSeq === e.seq)
          .map((d) => ({ subscriptionId: d.subscriptionId, target: targetOf(subscriptions.get(d.subscriptionId)?.url ?? ''), outcome: d.outcome, httpStatus: d.httpStatus, attempts: d.attempts, lastAttemptAt: d.lastAttemptAt, nextRetryAt: d.outcome === 'DELIVERED' ? null : d.nextRetryAt })),
      })),
      ...(events.length > limit ? { nextCursor: encodeCursor(offset + limit) } : {}),
    };
  }

  async stats() {
    const since = new Date(this.now() - 86_400_000).toISOString();
    const counts = await this.store.deliveryStats(since);
    return { subscriptions: await this.store.countActiveSubscriptions(), pending: counts.pending, retrying: counts.retrying, exhaustedLast24h: counts.exhausted, deliveredLast24h: counts.delivered, lastDeliveredAt: counts.lastDeliveredAt };
  }

  // ------------------------------------------------------------------ entrega
  /** Envía las entregas que tocan; devuelve cuántas salieron bien. Lo llama el despachador cada pocos segundos. */
  async deliverDue(limit = 50): Promise<number> {
    let delivered = 0;
    for (const delivery of await this.store.claimDue(new Date(this.now()).toISOString(), limit)) {
      if (await this.attempt(delivery)) delivered++;
    }
    return delivered;
  }

  /**
   * Un intento: POST del CloudEvent completo (sin el dueño: no está en el cuerpo) firmado con el secreto de la suscripción.
   * Éxito = cualquier 2xx en menos de 5 s; si no, reintento a 1 min, 5 min, 30 min, 2 h y 6 h, y luego EXHAUSTED.
   */
  private async attempt(delivery: DeliveryRecord): Promise<boolean> {
    const event = await this.store.eventBySeq(delivery.eventSeq);
    const subscription = await this.store.subscription(delivery.subscriptionId);
    const now = this.now();
    if (!event || !subscription?.active) {
      await this.store.saveDelivery({ ...delivery, outcome: 'CANCELLED', nextRetryAt: null });
      return false;
    }
    // Formato del contrato vigente (type corto, source `ecoairlines`), también para eventos guardados antes del 12/11/2026.
    const body = JSON.stringify(toContractFormat(event.event));
    let status: number | null = null;
    try {
      if (!this.config.allowPrivateUrls) await assertAllowedUrl(subscription.url, true); // la URL pudo cambiar de destino (DNS)
      const response = await this.fetcher(subscription.url, {
        method: 'POST',
        headers: { 'content-type': CLOUDEVENTS_CONTENT_TYPE, [WEBHOOK_SIGNATURE_HEADER]: signWebhook(this.box.open(subscription.secretEncrypted), body), 'x-correlation-id': event.correlationId ?? '' },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      status = response.status;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      this.logger.warn(`Entrega ${event.name} a ${targetOf(subscription.url)} falló: ${error instanceof Error ? error.message : String(error)}`);
    }
    const attempts = delivery.attempts + 1;
    const ok = status !== null && status >= 200 && status < 300;
    const retry = ok ? null : nextRetryAt(attempts, now);
    const outcome = ok ? 'DELIVERED' : retry ? 'RETRYING' : 'EXHAUSTED';
    countWebhookDelivery(outcome); // V2.16: alerta "webhooks agotados"
    await this.store.saveDelivery({
      ...delivery,
      attempts,
      httpStatus: status,
      lastAttemptAt: new Date(now).toISOString(),
      outcome,
      nextRetryAt: ok ? null : retry,
      deliveredAt: ok ? new Date(now).toISOString() : null,
    });
    return ok;
  }

}

function view(record: SubscriptionRecord) {
  return { id: record.id, url: record.url, events: record.events, active: record.active, createdAt: record.createdAt };
}
