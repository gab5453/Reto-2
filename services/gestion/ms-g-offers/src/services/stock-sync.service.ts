import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CORRELATION_KEY, newCorrelationId } from '@ecoairlines/shared';
import { OFFERS_CONFIG, type OffersConfig } from '../config/config.js';
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

interface StockClient extends grpc.Client {
  PushStockUpdate(
    message: { service_id: string; item_id: string; date: string; time_slot: string; available_units: number; timestamp: string },
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
    const definition = protoLoader.loadSync(findContractFile('booking-inventory.proto'), { keepCase: true, longs: String, defaults: true });
    const { inventory } = grpc.loadPackageDefinition(definition) as unknown as { inventory: { InventoryStockService: new (address: string, credentials: grpc.ChannelCredentials) => StockClient } };
    this.client = new inventory.InventoryStockService(this.config.bookingGrpcAddress, grpc.credentials.createInsecure());
    this.timer = setInterval(() => this.kick(), this.config.stockIntervalMs);
    this.timer.unref();
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
    const metadata = new grpc.Metadata();
    metadata.set(CORRELATION_KEY, row.correlationId ?? newCorrelationId());
    const message = {
      service_id: this.config.bookingServiceId,
      item_id: `${row.flightNumber}-${row.cabinClass}`,
      date: row.date,
      time_slot: row.timeSlot,
      available_units: row.units,
      timestamp: String(Date.now()),
    };
    try {
      const ack = await new Promise<{ success: boolean; message: string }>((resolve, reject) =>
        this.client!.PushStockUpdate(message, metadata, { deadline: Date.now() + this.config.bookingDeadlineMs }, (error, response) =>
          error ? reject(error) : resolve(response ?? { success: false, message: 'sin respuesta' }),
        ),
      );
      if (!ack.success) throw new Error(`Booking rechazó el stock: ${ack.message}`);
      await this.store.markStockPushed(row.segmentId, row.cabinClass, row.version, new Date().toISOString());
      return true;
    } catch (error) {
      const wait = Math.min(1_000 * 2 ** row.attempts, MAX_BACKOFF_MS);
      await this.store.markStockFailed(row.segmentId, row.cabinClass, row.version, error instanceof Error ? error.message : String(error), new Date(Date.now() + wait).toISOString());
      if (row.attempts === 0) this.logger.warn(`Stock ${message.item_id} ${row.date} no se pudo enviar a Booking (se reintenta): ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }
}
