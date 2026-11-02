import './telemetry.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ScheduleModule, setupApp } from './app.module.js';
import { loadConfig } from './config/config.js';

/** MS.G.Schedule: HTTP en PORT (4004 en local, 8080 en el contenedor). */
const config = loadConfig();
const app = await NestFactory.create<NestExpressApplication>(ScheduleModule.register(config), { bufferLogs: true });
setupApp(app);
await app.listen(config.port);
