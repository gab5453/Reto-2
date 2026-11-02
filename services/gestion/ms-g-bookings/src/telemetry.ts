import { startTelemetry } from '@ecoairlines/shared/telemetry/telemetry.js';

// Primer import de main.ts: la instrumentación de `http` debe aplicarse antes de cargar NestJS (la de `pg` llega en V2.16).
startTelemetry('ms-g-bookings', '1.0.0');
