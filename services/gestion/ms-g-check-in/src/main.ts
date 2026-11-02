import './telemetry.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CheckInModule, setupApp } from './app.module.js';
import { loadConfig } from './config/config.js';

/** MS.G.CheckIn: HTTP en PORT (4007 en local, 8080 en el contenedor). */
const config = loadConfig();
const app = await NestFactory.create<NestExpressApplication>(CheckInModule.register(config), { bufferLogs: true });
setupApp(app);
await app.listen(config.port);
