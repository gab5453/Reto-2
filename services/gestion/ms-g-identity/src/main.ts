import './telemetry.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IdentityModule, setupApp } from './app.module.js';
import { loadConfig } from './config/config.js';

/** MS.G.Identity: HTTP en PORT (4001 en local, 8080 en el contenedor). Sin la configuración obligatoria no arranca. */
const config = loadConfig();
const app = await NestFactory.create<NestExpressApplication>(IdentityModule.register(config), { bufferLogs: true });
setupApp(app);
await app.listen(config.port);
