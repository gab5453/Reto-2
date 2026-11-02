import { defineConfig } from 'vitest/config';

/**
 * Suite de conformidad con el contrato de Vuelos v2 (V2.1, paso 10). Caja negra: llama por HTTP a CONFORMANCE_BASE_URL,
 * así sirve igual contra el gateway local, el monolito o la URL pública (ver support/client.ts).
 *
 *   npm run test:conformidad-v2                                   solo autoverificación (sin red)
 *   CONFORMANCE_BASE_URL=http://localhost:8080/api/v2 \
 *   CONFORMANCE_CLIENT_ID=BOOKING_PROTOTIPO CONFORMANCE_CLIENT_SECRET=… npm run test:conformidad-v2
 */
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['tests/conformidad-v2/**/*.conformance.ts'],
    globalSetup: ['tests/conformidad-v2/support/global-setup.ts'],
    // Las pruebas crean holds y reservas reales: se ejecutan en serie para no competir por los mismos asientos.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
