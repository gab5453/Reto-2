import './telemetry.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createRuntime, GatewayModule, setupGateway } from './app.module.js';
import { loadGatewayConfig } from './config.js';

/** gateway: HTTP en PORT (8080), `/api/v2/vuelos/*` (REST del contrato v2), `/api/graphql` (web) y `/api/docs` (Swagger). */
const config = loadGatewayConfig(process.env);
const runtime = createRuntime(config);
const app = await NestFactory.create<NestExpressApplication>(GatewayModule.register(runtime), { bufferLogs: true, bodyParser: false });
setupGateway(app, runtime);
await app.listen(config.port);
