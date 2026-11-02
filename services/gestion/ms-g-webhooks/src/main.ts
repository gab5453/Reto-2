import './telemetry.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WebhooksModule, setupApp } from './app.module.js';
import { loadConfig } from './config/config.js';

/** MS.G.Webhooks: HTTP en PORT (4003 en local, 8080 en el contenedor). */
const config = loadConfig();
const app = await NestFactory.create<NestExpressApplication>(WebhooksModule.register(config), { bufferLogs: true });
setupApp(app);
await app.listen(config.port);
