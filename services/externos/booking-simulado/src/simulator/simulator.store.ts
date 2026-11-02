import { Injectable } from '@nestjs/common';

/** Lo que el simulador recibió de EcoAirlines, en memoria (solo pruebas). */
export interface ReceivedWebhook {
  id: string;
  type: string;
  subject?: string;
  correlationId: string;
  /** El X-Correlation-Id de la cabecera debe ser igual al `correlationid` del CloudEvent. */
  headerCorrelationId?: string;
  receivedAt: string;
  deliveries: number;
  event: Record<string, unknown>;
}

export interface ReceivedStock {
  itemId: string;
  date: string;
  timeSlot: string;
  availableUnits: number;
  serviceId: string;
  correlationId?: string;
  receivedAt: string;
}

const MAX_WEBHOOKS = 500;

@Injectable()
export class SimulatorStore {
  private webhooks: ReceivedWebhook[] = [];
  private readonly stock = new Map<string, ReceivedStock>();
  streamedChanges = 0;

  /** Guarda un webhook; si el `id` ya llegó (reintento), solo cuenta la entrega. Devuelve `true` si es nuevo. */
  addWebhook(webhook: Omit<ReceivedWebhook, 'deliveries'>): boolean {
    const existing = this.webhooks.find((item) => item.id === webhook.id);
    if (existing) {
      existing.deliveries++;
      return false;
    }
    this.webhooks.unshift({ ...webhook, deliveries: 1 });
    this.webhooks = this.webhooks.slice(0, MAX_WEBHOOKS);
    return true;
  }

  listWebhooks(type?: string): ReceivedWebhook[] {
    return type ? this.webhooks.filter((item) => item.type.endsWith(`.${type}`) || item.type === type) : this.webhooks;
  }

  /** Último valor por vuelo, cabina y fecha (PushStockUpdate manda el valor absoluto). */
  putStock(stock: ReceivedStock): void {
    this.stock.set(`${stock.itemId}|${stock.date}`, stock);
  }

  listStock(): ReceivedStock[] {
    return [...this.stock.values()].sort((a, b) => a.itemId.localeCompare(b.itemId) || a.date.localeCompare(b.date));
  }

  reset(): void {
    this.webhooks = [];
    this.stock.clear();
    this.streamedChanges = 0;
  }
}
