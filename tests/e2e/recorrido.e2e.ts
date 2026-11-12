import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { cancelarComoAdmin, comprar, enDias, ingresar, oferta, tokenDe, USUARIOS, type Reserva } from './apoyo.js';

/**
 * E-7 (Pruebas.md §5.4): una compra con un X-Correlation-Id conocido y, con ese ID, el administrador ve su recorrido en
 * Telemetría: la saga de la compra (ESB) y los pasos de cada servicio (trazas de OpenTelemetry en Tempo).
 */
let reserva: Reserva | undefined;
test.afterEach(async () => cancelarComoAdmin(reserva?.bookingId));

test('E-7: con el correlation ID de una compra, el administrador ve su recorrido', async ({ page }) => {
  const correlationId = `corr-e2e-${randomUUID()}`;
  reserva = await comprar(await tokenDe(USUARIOS.pasajero), await oferta('UIO', 'GYE', enDias(45)), { apellido: 'Recorrido', correlationId });

  await ingresar(page, USUARIOS.admin);
  const tarjeta = page.locator('section', { has: page.getByRole('heading', { name: 'Buscar un proceso por correlation ID' }) });

  // Los logs y las trazas llegan a Loki y Tempo en lotes (≈1–3 s): se repite la búsqueda hasta que estén los pasos de la compra
  // en varios servicios. Cada intento recarga la pantalla, porque la web no repite una búsqueda con el mismo ID.
  let texto = '';
  await expect(async () => {
    await page.goto('/admin/telemetria');
    await tarjeta.getByLabel('X-Correlation-Id').fill(correlationId);
    await tarjeta.getByRole('button', { name: 'Buscar' }).click();
    await expect(tarjeta.getByText(/\d+ pasos en \d+ servicios/)).toBeVisible({ timeout: 10_000 });
    texto = (await tarjeta.innerText()).replace(/\s+/g, ' ');
    // La compra pasó por varios servicios: MS de respuesta, ESB, MS.G, Payment API…
    expect(Number(/\d+ pasos en (\d+) servicios/.exec(texto)![1])).toBeGreaterThanOrEqual(3);
  }).toPass({ timeout: 90_000, intervals: [2_000, 3_000, 5_000] });

  expect(texto).toMatch(/sagas: CREATE_BOOKING \(COMPLETED\)/);
  expect(texto).not.toContain('Faltan los pasos');
});
