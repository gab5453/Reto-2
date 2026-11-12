import { defineConfig, devices } from '@playwright/test';

/**
 * E2E-1 (Informacion_General/Pruebas.md §5.4): la punta de la pirámide. Pocas pruebas (los flujos críticos) contra el sistema
 * ENTERO levantado con docker compose (infra/docker-compose.e2e.yml) y la web compilada como en producción (`vite preview`, con
 * su service worker). Nunca contra la nube: `apoyo.ts` se niega a correr si la web o la API no son locales.
 *
 *   npm run test:e2e            (con el sistema arriba; la web se compila y se sirve sola en :5173)
 *
 * - En serie (`workers: 1`): las pruebas comparten la base de datos, y el administrador cambia vuelos y precios que otra prueba
 *   podría estar mirando. Cada prueba deja todo como estaba.
 * - En la CI usa el Chromium de Playwright; en Windows, el Edge instalado (sin descargar navegadores).
 */
const CI = Boolean(process.env['CI']);

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: CI ? [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]] : 'list',
  outputDir: '../../test-results/e2e',
  use: {
    baseURL: process.env['E2E_WEB'] ?? 'http://localhost:5173',
    locale: 'es-EC',
    timezoneId: 'America/Guayaquil',
    viewport: { width: 1366, height: 900 },
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: CI ? 'chromium' : 'edge', use: { ...devices['Desktop Chrome'], ...(CI ? {} : { channel: 'msedge' }) } }],
  // La web compilada (como en Azure Static Web Apps) en el puerto que permite el CORS del gateway y de la Payment API.
  webServer: {
    command: 'npm run build && npm run preview -- --port 5173 --strictPort',
    cwd: '../../ecoairlines-web',
    url: 'http://localhost:5173',
    reuseExistingServer: !CI,
    timeout: 180_000,
  },
});
