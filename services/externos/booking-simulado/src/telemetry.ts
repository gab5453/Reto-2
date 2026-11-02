import { startTelemetry } from '@ecoairlines/shared/telemetry/telemetry.js';

// Primer import de main.ts: la instrumentación de `http` debe aplicarse antes de cargar NestJS/Express.
startTelemetry('booking-simulado', '1.0.0');
