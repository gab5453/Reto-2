import { BadRequestException, Body, Controller, Headers, HttpCode, Inject, Logger, Post } from '@nestjs/common';
import { CORRELATION_KEY } from '@ecoairlines/shared';
import { validateStock } from '../grpc/inventory.server.js';
import { SimulatorStore } from './simulator.store.js';

/**
 * Stock por REST, como lo publicó Booking en Azure (V2.20): `POST /api/v2/inventory/stock` con `service_id`, `item_id`, `date`,
 * `time_slot` y `available_units`. Responde `success: true` si lo acepta y 400 con el motivo si no. Mismas reglas que el gRPC.
 */
@Controller('api/v2/inventory/stock')
export class StockController {
  private readonly logger = new Logger('InventoryStockRest');

  constructor(@Inject(SimulatorStore) private readonly store: SimulatorStore) {}

  @Post()
  @HttpCode(200)
  push(@Body() body: Record<string, unknown>, @Headers(CORRELATION_KEY) correlationId?: string) {
    const message = { service_id: String(body['service_id'] ?? ''), item_id: String(body['item_id'] ?? ''), date: String(body['date'] ?? ''), time_slot: String(body['time_slot'] ?? ''), available_units: body['available_units'] as number, timestamp: '' };
    const error = validateStock(message);
    if (error) {
      this.logger.warn(`Stock REST rechazado: ${error}`);
      throw new BadRequestException(error);
    }
    this.store.putStock({
      itemId: message.item_id,
      date: message.date,
      timeSlot: message.time_slot,
      availableUnits: message.available_units,
      serviceId: message.service_id,
      correlationId: correlationId || undefined,
      receivedAt: new Date().toISOString(),
    });
    return { success: true, message: 'Stock actualizado' };
  }
}
