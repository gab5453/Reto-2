import './telemetry.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PaymentApiModule, setupApp } from './app.module.js';
import { loadConfig } from './config.js';

/** Payment API simulada: HTTP en PORT (4010 en local, 8080 en el contenedor). */
const config = loadConfig();
const app = await NestFactory.create<NestExpressApplication>(PaymentApiModule.register(config), { bufferLogs: true, bodyParser: false });
setupApp(app, config);
await app.listen(config.port);
