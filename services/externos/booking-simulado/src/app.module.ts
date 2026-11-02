import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureService, EcoServiceModule, type HealthCheck } from '@ecoairlines/shared';
import { InventoryGrpcServer } from './grpc/inventory.server.js';
import { EventsController } from './simulator/events.controller.js';
import { SimulatorStore } from './simulator/simulator.store.js';
import { WebhooksController } from './webhooks/webhooks.controller.js';

export const SERVICE = { name: 'booking-simulado', version: '1.0.0' };

/** El servidor gRPC se resuelve después de crear el módulo: su health check lo consulta en cada `/health`. */
let grpcServer: InventoryGrpcServer | undefined;
const grpcHealth: HealthCheck = { name: 'grpc', check: () => grpcServer?.healthCheck().check() ?? Promise.resolve('down') };

@Module({
  imports: [EcoServiceModule.forRoot({ ...SERVICE, healthChecks: [grpcHealth] })],
  controllers: [WebhooksController, EventsController],
  providers: [SimulatorStore, InventoryGrpcServer],
})
export class AppModule {}

/** Configuración común a main.ts y a las pruebas (misma cadena de middleware que en producción). */
export function setupApp(app: NestExpressApplication): void {
  configureService(app, SERVICE);
  // Los webhooks llegan como application/cloudevents+json: se parsean como JSON y se conserva el cuerpo crudo para la firma.
  app.useBodyParser('json', { type: ['application/json', 'application/*+json'], limit: '256kb' });
  grpcServer = app.get(InventoryGrpcServer);
}
