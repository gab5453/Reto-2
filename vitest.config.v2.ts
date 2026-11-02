import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Pruebas del Reto 2 (microservicios): librería compartida, servicios y prueba de arquitectura v2.
 * Se ejecutan sobre el código fuente: `@ecoairlines/shared` y `@ecoairlines/shared/x.js` apuntan a `packages/shared/src`.
 * El monolito sigue con `vitest.config.ts` y `vitest.config.e2e.ts`.
 */
export default defineConfig({
  // Decoradores de NestJS (legacy) con metadatos de tipos, igual que tsconfig.base.json: sin esto los `*.spec.ts`, que
  // quedan fuera del tsconfig de cada paquete, no transforman `@Body()` ni dan el tipo del DTO al ValidationPipe.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  resolve: {
    alias: [
      { find: /^@ecoairlines\/shared$/, replacement: resolve(ROOT, 'packages/shared/src/index.ts') },
      { find: /^@ecoairlines\/shared\/(.*)\.js$/, replacement: resolve(ROOT, 'packages/shared/src/$1.ts') },
      // graphql 16 publica una entrada ESM (`module`) y otra CJS (`main`). Node siempre usa la CJS (también Apollo y
      // @graphql-tools); vite tomaría la ESM para el código fuente y habría dos copias de graphql (V2.13, gateway).
      { find: /^graphql$/, replacement: resolve(ROOT, 'node_modules/graphql/index.js') },
    ],
  },
  test: {
    globals: true,
    root: './',
    include: ['packages/*/src/**/*.spec.ts', 'services/**/src/**/*.spec.ts', 'services/**/test/**/*.spec.ts', 'tests/arquitectura-v2/**/*.spec.ts'],
    env: { NODE_ENV: 'test' },
    // Cada `beforeAll` levanta una app Nest completa; con la suite entera en paralelo (V2.13: también el gateway con Apollo)
    // varias pasaban los 10 s por defecto solo por esperar CPU. Cada archivo solo tarda < 3 s.
    hookTimeout: 30_000,
    // Con un worker por núcleo la CPU se satura y fallan al azar las pruebas que miden tiempos (health < 1 s, plazos de
    // sagas, límites por minuto). Con la mitad la suite tarda casi lo mismo y es estable.
    maxWorkers: '50%',
  },
});
