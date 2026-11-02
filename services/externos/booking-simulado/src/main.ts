import './telemetry.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { InventoryGrpcServer } from './grpc/inventory.server.js';
import { AppModule, setupApp } from './app.module.js';

/** booking-simulado: HTTP en PORT (4090) y gRPC en GRPC_PORT (50051, el puerto del contrato v2 §9). */
const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, bufferLogs: true });
setupApp(app);
await app.get(InventoryGrpcServer).start(Number(process.env['GRPC_PORT'] ?? 50051));
await app.listen(Number(process.env['PORT'] ?? 4090));
