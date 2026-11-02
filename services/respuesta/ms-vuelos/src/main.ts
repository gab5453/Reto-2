import './telemetry.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadResponseConfig, ResponseServiceModule, setupResponseApp } from '@ecoairlines/shared/respuesta/index.js';
import { CLIENT_ID, DEFAULT_PORT, definition } from './service.js';

/** ms-vuelos: HTTP en PORT (5001 en local, 8080 en el contenedor), bajo `/api/v2`. Solo llama al ESB. */
const config = loadResponseConfig(process.env, { clientId: CLIENT_ID, defaultPort: DEFAULT_PORT });
const service = definition(process.env);
const app = await NestFactory.create<NestExpressApplication>(ResponseServiceModule.register(service, config), { bufferLogs: true, bodyParser: false });
setupResponseApp(app, service, config);
await app.listen(config.port);
