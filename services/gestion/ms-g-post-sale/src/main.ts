import './telemetry.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PostSaleModule, setupApp } from './app.module.js';
import { loadConfig } from './config/config.js';

/** MS.G.PostSale: SOAP en /soap/post-sale (WSDL en ?wsdl) y /health, en PORT (4008 en local, 8080 en el contenedor). */
const config = loadConfig();
const app = await NestFactory.create<NestExpressApplication>(PostSaleModule.register(config), { bufferLogs: true });
await setupApp(app);
await app.listen(config.port);
