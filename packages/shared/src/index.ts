/**
 * @ecoairlines/shared — código común de los microservicios (V2.2). La telemetría NO se exporta aquí: debe iniciarse antes
 * de cargar NestJS, con `import { startTelemetry } from '@ecoairlines/shared/telemetry/telemetry.js'` en la primera línea
 * del `main.ts` de cada servicio.
 */
export * from './correlation/correlation.js';
export * from './problem-details/problem-details.js';
export * from './problem-details/problem-details.filter.js';
export * from './logging/logging.js';
export * from './health/health.js';
export * from './cloudevents/cloudevents.js';
export * from './service/service.js';
export * from './auth/jwt.js';
export * from './auth/service-token.guard.js';
export * from './domain/money.js';
export * from './domain/passenger-counts.js';
export * from './domain/airports.js';
export * from './domain/aircraft.js';
export type { components as VuelosV2, operations as VuelosV2Operations } from './contract/vuelos-v2.js';
