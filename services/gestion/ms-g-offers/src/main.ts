import './telemetry.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { OffersModule, setupApp } from './app.module.js';
import { loadConfig } from './config/config.js';

/** MS.G.Offers: gRPC en GRPC_PORT (50061) y HTTP solo para /health en PORT (4009 en local, 8080 en el contenedor). */
const config = loadConfig();
const app = await NestFactory.create<NestExpressApplication>(OffersModule.register(config), { bufferLogs: true });
const grpcServer = setupApp(app);
await app.init();
await grpcServer.start(config.grpcPort);
await app.listen(config.httpPort);
