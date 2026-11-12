import { defineConfig } from 'vitest/config';

/**
 * Pruebas de la web (PU-4, Informacion_General/Pruebas.md §5.1.4). Separado de vite.config.ts para no cargar el plugin de la PWA:
 * aquí solo se ejecuta la lógica (cliente GraphQL, WebSocket, dibujo del grafo, hooks y validaciones) en un DOM simulado (jsdom).
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
