import './telemetry.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { EsbModule, setupApp } from './app.module.js';
import { loadConfig } from './config/config.js';

/** ESB: HTTP en PORT (4000 en local, 8080 en el contenedor). `rawBody` para verificar la firma de los eventos de Booking. */
const config = loadConfig();
const app = await NestFactory.create<NestExpressApplication>(EsbModule.register(config), { bufferLogs: true, rawBody: true, bodyParser: false });
setupApp(app);
await app.listen(config.port);
