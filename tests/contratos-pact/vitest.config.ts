import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config.v2.js';

/**
 * CT-1 (Informacion_General/Pruebas.md §5.3): contract testing consumer-driven con Pact (Semana 9, §9.2–9.3).
 * - `npm run test:pact`         → pruebas de CONSUMIDOR: cada una genera su `contract/pacts/<consumidor>-<proveedor>.json`.
 * - `npm run test:pact:verify`  → verificación de PROVEEDOR: levanta el servicio real y le reproduce cada interacción.
 * Usa los mismos alias que la suite v2 (`@ecoairlines/shared` sobre el código fuente).
 */
const config = mergeConfig(base, {
  test: {
    // Sin estadísticas de uso de Pact (no se envía nada a terceros).
    env: { PACT_DO_NOT_TRACK: 'true' },
    // Cada par consumidor-proveedor escribe su archivo; en serie para que dos pruebas nunca escriban el mismo a la vez.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
// mergeConfig concatena las listas: el `include` de la suite v2 se reemplaza, no se suma.
config.test!.include = ['tests/contratos-pact/**/*.spec.ts'];
export default config;
