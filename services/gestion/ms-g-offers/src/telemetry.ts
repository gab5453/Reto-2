import { startTelemetry } from '@ecoairlines/shared/telemetry/telemetry.js';

// Primer import de main.ts: la instrumentación de `http` debe aplicarse antes de cargar NestJS (gRPC y `pg` llegan en V2.16).
startTelemetry('ms-g-offers', '1.0.0');
