import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { CORRELATION_KEY, type HealthCheck, newRequestId, runWithCorrelation } from '@ecoairlines/shared';
import { SimulatorStore } from '../simulator/simulator.store.js';

/**
 * Servidor gRPC `inventory.InventoryStockService` de Booking (contract/booking-inventory.proto, contrato v2 §9), para que
 * MS.G.Offers pruebe el envío de stock (D33) sin depender del despliegue de Booking. Valida lo que el contrato dice de
 * cada campo y responde `success: false` con el motivo si algo no cumple.
 */
const ITEM_ID = /^[A-Z0-9]{2}[0-9]{1,4}-(ECONOMY|PREMIUM_ECONOMY|BUSINESS|FIRST)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SLOT = /^([01]\d|2[0-3]):[0-5]\d$/;

interface StockUpdateMessage {
  service_id: string;
  item_id: string;
  date: string;
  time_slot: string;
  available_units: number;
  timestamp: string;
}

/** Busca `contract/<archivo>` subiendo desde este módulo (sirve en el repositorio y en la imagen Docker). */
export function findContractFile(file: string, from = dirname(fileURLToPath(import.meta.url))): string {
  if (process.env['BOOKING_PROTO_PATH']) return process.env['BOOKING_PROTO_PATH'];
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'contract', file);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No se encontró contract/${file}`);
}

export function validateStock(message: StockUpdateMessage): string | undefined {
  if (!message.service_id) return 'service_id es obligatorio';
  if (!ITEM_ID.test(message.item_id)) return `item_id inválido (${message.item_id}): se espera <vuelo>-<cabina>, p. ej. EA300-ECONOMY`;
  if (!DATE.test(message.date)) return 'date debe ser YYYY-MM-DD';
  if (!TIME_SLOT.test(message.time_slot)) return 'time_slot debe ser HH:mm';
  if (!Number.isInteger(message.available_units) || message.available_units < 0) return 'available_units debe ser un entero ≥ 0';
  return undefined;
}

@Injectable()
export class InventoryGrpcServer implements OnModuleDestroy {
  private readonly logger = new Logger('InventoryStockService');
  private server?: grpc.Server;
  private boundPort?: number;

  constructor(@Inject(SimulatorStore) private readonly store: SimulatorStore) {}

  /** Devuelve el puerto real (útil con 0 en pruebas). */
  async start(port: number): Promise<number> {
    const definition = protoLoader.loadSync(resolve(findContractFile('booking-inventory.proto')), { keepCase: true, longs: String, defaults: true });
    const inventory = (grpc.loadPackageDefinition(definition) as unknown as { inventory: { InventoryStockService: { service: grpc.ServiceDefinition } } }).inventory;
    this.server = new grpc.Server();
    this.server.addService(inventory.InventoryStockService.service, {
      PushStockUpdate: (call: grpc.ServerUnaryCall<StockUpdateMessage, unknown>, callback: grpc.sendUnaryData<unknown>) =>
        this.withCorrelation(call.metadata, () => {
          const error = validateStock(call.request);
          if (error) {
            this.logger.warn(`PushStockUpdate rechazado: ${error}`);
            callback(null, { success: false, message: error, processed_at: String(Date.now()) });
            return;
          }
          this.store.putStock({
            itemId: call.request.item_id,
            date: call.request.date,
            timeSlot: call.request.time_slot,
            availableUnits: call.request.available_units,
            serviceId: call.request.service_id,
            correlationId: String(call.metadata.get(CORRELATION_KEY)[0] ?? '') || undefined,
            receivedAt: new Date().toISOString(),
          });
          callback(null, { success: true, message: 'Stock actualizado', processed_at: String(Date.now()) });
        }),
      StreamInventoryChanges: (call: grpc.ServerReadableStream<{ item_id: string }, unknown>, callback: grpc.sendUnaryData<unknown>) => {
        let processed = 0;
        call.on('data', () => {
          processed++;
          this.store.streamedChanges++;
        });
        call.on('end', () => callback(null, { total_events_processed: processed, is_synchronized: true, last_sync_hash: `sim-${processed}` }));
      },
    });
    this.boundPort = await new Promise<number>((done, fail) =>
      this.server!.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (error, bound) => (error ? fail(error) : done(bound))),
    );
    this.logger.log(`gRPC inventory.InventoryStockService escuchando en el puerto ${this.boundPort}`);
    return this.boundPort;
  }

  healthCheck(): HealthCheck {
    return { name: 'grpc', check: async () => (this.boundPort ? 'up' : 'down') };
  }

  onModuleDestroy(): void {
    this.server?.forceShutdown();
  }

  private withCorrelation(metadata: grpc.Metadata, fn: () => void): void {
    const correlationId = String(metadata.get(CORRELATION_KEY)[0] ?? '') || 'sin-correlation-id';
    runWithCorrelation({ correlationId, requestId: newRequestId() }, fn);
  }
}
