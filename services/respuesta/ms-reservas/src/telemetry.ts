import { startTelemetry } from '@ecoairlines/shared/telemetry/telemetry.js';

// Primer import de main.ts: la instrumentación de `http` debe aplicarse antes de cargar NestJS.
startTelemetry('ms-reservas', '1.0.0');
