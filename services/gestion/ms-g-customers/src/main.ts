import './telemetry.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CustomersModule, loadConfig, setupApp } from './app.module.js';

/** MS.G.Customers: HTTP en PORT (4002 en local, 8080 en el contenedor). */
const config = loadConfig();
const app = await NestFactory.create<NestExpressApplication>(CustomersModule.register(config), { bufferLogs: true });
setupApp(app);
await app.listen(config.port);
