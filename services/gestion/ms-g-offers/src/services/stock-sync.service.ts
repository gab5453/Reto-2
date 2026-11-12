import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CORRELATION_KEY, newCorrelationId } from '@ecoairlines/shared';
import { OFFERS_CONFIG, type OffersConfig } from '../config/config.js';
import { localDate } from '../domain/catalog.js';
import type { StockSyncRecord } from '../domain/model.js';
import { OFFERS_STORE, type OffersStore } from '../repositories/offers.store.js';

/** Busca `contract/<archivo>` subiendo desde este módulo (en el contenedor, `contract/` se copia junto al servicio). */
export function findContractFile(file: string, from = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'contract', file);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No se encontró contract/${file}`);
}

interface StockMessage {
  service_id: string;
  item_id: string;
  date: string;
  time_slot: string;
  available_units: number;
}

interface StockClient extends grpc.Client {
  PushStockUpdate(
    message: StockMessage & { timestamp: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, ack?: { success: boolean; message: string }) => void,
  ): void;
}

const MAX_BACKOFF_MS = 60_000;

/**
 * Stock hacia Booking (D33): Offers es CLIENTE de `inventory.InventoryStockService/PushStockUpdate` (`booking-inventory.proto`,
 * sin cambios). Cada cambio de cupos deja pendiente, en su misma transacción, el valor ABSOLUTO de esa cabina (`stock_sync`);
 * este componente lo envía en segundo plano. Nunca bloquea la operación del cliente: si Booking no responde, reintenta con
 * espera creciente (1 s, 2 s, 4 s… hasta 60 s). Si llegan varios cambios antes de enviar, se manda solo el último.
 * Desde V2.20 (D53) Booking en Azure lo recibe por REST (`BOOKING_STOCK_URL`): mismo mensaje sin `timestamp`, y vale solo
 * si responde `success: true`. Sin esa URL se usa el gRPC (el simulador local y las pruebas).
 */
@Injectable()
export class StockSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('StockSync');
  private client?: StockClient;
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  private again = false;

  constructor(
    @Inject(OFFERS_STORE) private readonly store: OffersStore,
    @Inject(OFFERS_CONFIG) private readonly config: OffersConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.bookingStockUrl) this.client = this.grpcClient();
    this.timer = setInterval(() => this.kick(), this.config.stockIntervalMs);
    this.timer.unref();
  }

  private grpcClient(): StockClient {
    const definition = protoLoader.loadSync(findContractFile('booking-inventory.proto'), { keepCase: true, longs: String, defaults: true });
    const { inventory } = grpc.loadPackageDefinition(definition) as unknown as { inventory: { InventoryStockService: new (address: string, credentials: grpc.ChannelCredentials) => StockClient } };
    return new inventory.InventoryStockService(this.config.bookingGrpcAddress, grpc.credentials.createInsecure());
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.client?.close();
  }

  /** Pide un envío pronto (después de cada operación que cambia cupos). Si ya hay uno en curso, se repite al terminar. */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    void this.flush().catch((error: unknown) => this.logger.error(`Envío de stock: ${String(error)}`));
  }

  /** Envía todo lo pendiente que ya toca; devuelve cuántos envíos salieron bien. */
  async flush(): Promise<number> {
    if (this.running) return this.running;
    this.running = (async () => {
      let ok = 0;
      do {
        this.again = false;
        let batch: StockSyncRecord[];
        do {
          batch = await this.store.pendingStock(new Date().toISOString(), 50);
          for (const row of batch) ok += (await this.push(row)) ? 1 : 0;
        } while (batch.length === 50);
      } while (this.again);
      return ok;
    })();
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async push(row: StockSyncRecord): Promise<boolean> {
    // Un vuelo que ya salió no se vende: su stock no se envía y queda cerrado (si no, se reintentaría para siempre).
    if (row.date < localDate(Date.now())) {
      await this.store.markStockPushed(row.segmentId, row.cabinClass, row.version, new Date().toISOString());
      return false;
    }
    const correlationId = row.correlationId ?? newCorrelationId();
    const message: StockMessage = {
      service_id: this.config.bookingServiceId,
      item_id: `${row.flightNumber}-${row.cabinClass}`,
      date: row.date,
      time_slot: row.timeSlot,
      available_units: row.units,
    };
    try {
      const ack = this.config.bookingStockUrl ? await this.sendRest(message, correlationId) : await this.sendGrpc(message, correlationId);
      if (!ack.success) throw new Error(`Booking rechazó el stock: ${ack.message}`);
      await this.store.markStockPushed(row.segmentId, row.cabinClass, row.version, new Date().toISOString());
      return true;
    } catch (error) {
      const wait = Math.min(1_000 * 2 ** row.attempts, MAX_BACKOFF_MS);
      await this.store.markStockFailed(row.segmentId, row.cabinClass, row.version, error instanceof Error ? error.message : String(error), new Date(Date.now() + wait).toISOString());
      if (row.attempts === 0) this.logger.warn(`Stock ${message.item_id} ${row.date} no se pudo enviar a Booking (se reintenta): ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private sendGrpc(message: StockMessage, correlationId: string): Promise<{ success: boolean; message: string }> {
    const metadata = new grpc.Metadata();
    metadata.set(CORRELATION_KEY, correlationId);
    return new Promise((resolve, reject) =>
      this.client!.PushStockUpdate({ ...message, timestamp: String(Date.now()) }, metadata, { deadline: Date.now() + this.config.bookingDeadlineMs }, (error, response) =>
        error ? reject(error) : resolve(response ?? { success: false, message: 'sin respuesta' }),
      ),
    );
  }

  /** Booking responde `{ success: true }` o un ProblemDetails (400 `VALIDATION_FAILED` con `detail`). */
  private async sendRest(message: StockMessage, correlationId: string): Promise<{ success: boolean; message: string }> {
    const response = await fetch(this.config.bookingStockUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CORRELATION_KEY]: correlationId },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.config.bookingDeadlineMs),
    });
    const body = (await response.json().catch(() => ({}))) as { success?: unknown; message?: unknown; detail?: unknown };
    // `detail` puede ser un objeto o una lista (errores de validación): se guarda como JSON, nunca como «[object Object]».
    const raw = body.detail ?? body.message ?? '';
    const detail = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 300);
    return { success: response.ok && body.success === true, message: `HTTP ${response.status}${detail ? ` ${detail}` : ''}` };
  }
}
