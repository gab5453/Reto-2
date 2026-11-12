import { expect, test } from '@playwright/test';
import { buscar, cancelarComoAdmin, comprar, datos, enDias, gql, ingresar, liberarHold, llenarPasajero, oferta, pagar, tokenDe, USUARIOS } from './apoyo.js';

/**
 * E-1 y E-2 (Pruebas.md §5.4): la compra en la web, de punta a punta: web → gateway → MS de respuesta → ESB (saga) → MS.G →
 * Payment API, y de vuelta al navegador. Fechas lejanas (40+ días) para no cruzarse con la suite de conformidad (20–26 días).
 */
let reservas: string[] = [];
test.afterEach(async () => {
  for (const id of reservas) await cancelarComoAdmin(id);
  reservas = [];
});

/** El bookingId de la URL a la que lleva el pago (`/mis-viajes/<id>`). */
const bookingIdDe = (url: string): string => /\/mis-viajes\/([0-9a-f-]{36})/.exec(url)?.[1] ?? '';

test('E-1: un pasajero busca, elige asiento, paga y recibe su reserva', async ({ page }) => {
  await ingresar(page, USUARIOS.pasajero);
  await buscar(page, 'UIO', 'GYE', enDias(40));
  await page.getByRole('button', { name: 'Continuar' }).first().click();
  await expect(page).toHaveURL(/\/reserva$/);

  await llenarPasajero(page, 'Compra Web');
  const asiento = page.getByRole('button', { name: /^Asiento 12C\b/ });
  await asiento.click();
  await expect(asiento).toHaveAttribute('aria-pressed', 'true');
  await pagar(page);

  // La saga terminó: la web lleva al detalle con el aviso de la compra, el PNR y el asiento elegido.
  await expect(page).toHaveURL(/\/mis-viajes\/[0-9a-f-]{36}/);
  const bookingId = bookingIdDe(page.url());
  reservas.push(bookingId);
  await expect(page.getByText('¡Reserva confirmada! Tus boletos ya fueron emitidos.')).toBeVisible();
  const { pnr } = datos(await gql<{ booking: { pnr: string } }>('query($id: UUID!){ booking(bookingId:$id){ pnr } }', { id: bookingId }, await tokenDe(USUARIOS.pasajero))).booking;
  await expect(page.locator('main')).toContainText(pnr);
  await expect(page.locator('main')).toContainText('12C');

  // Y aparece en «Mis viajes», confirmada.
  await page.goto('/mis-viajes');
  const viaje = page.locator(`a[href="/mis-viajes/${bookingId}"]`);
  await expect(viaje).toContainText(pnr);
  await expect(viaje).toContainText('Confirmada');
});

test('E-2: dos personas toman el mismo asiento; la segunda recibe el aviso y elige otro', async ({ page }) => {
  const fecha = enDias(41);
  const token = await tokenDe(USUARIOS.pasajero);
  let holdDelNavegador: string | undefined;
  let comproElNavegador = false;
  page.on('response', async (response) => {
    if (!response.url().includes('/api/graphql') || !(response.request().postData() ?? '').includes('holdInventory')) return;
    holdDelNavegador = ((await response.json().catch(() => null)) as { data?: { holdInventory?: { holdId: string } } } | null)?.data?.holdInventory?.holdId ?? holdDelNavegador;
  });

  try {
    // La segunda persona (este navegador) llega al pago con el 14A libre y lo elige…
    await ingresar(page, USUARIOS.pasajero);
    await buscar(page, 'UIO', 'GYE', fecha);
    await page.getByRole('button', { name: 'Continuar' }).first().click();
    await expect(page).toHaveURL(/\/reserva$/);
    await llenarPasajero(page, 'Asiento Tomado');
    const asiento = page.getByRole('button', { name: /^Asiento 14A\b/ });
    await asiento.click();
    await expect(asiento).toHaveAttribute('aria-pressed', 'true');

    // …pero la primera persona lo compra antes por su lado (otra compra real, por la API).
    const primera = await comprar(token, await oferta('UIO', 'GYE', fecha), { asiento: '14A', apellido: 'Primera' });
    reservas.push(primera.bookingId);
    expect(primera.status).toBe('CONFIRMED');

    // La segunda paga: SEAT_TAKEN. La web avisa, quita el asiento de la selección y sigue en el pago con el cupo retenido.
    await pagar(page);
    await expect(page.getByText('Ese asiento ya lo tomó otro viajero')).toBeVisible();
    await expect(page).toHaveURL(/\/reserva$/);
    await expect(page.getByRole('button', { name: /^Asiento 14A\b/ })).not.toHaveAttribute('aria-pressed', 'true');

    // Elige otro y la compra sí se completa.
    const otro = page.getByRole('button', { name: /^Asiento 14B\b/ });
    await otro.click();
    await page.getByRole('button', { name: /Pagar y reservar/ }).click();
    await expect(page).toHaveURL(/\/mis-viajes\/[0-9a-f-]{36}/);
    reservas.push(bookingIdDe(page.url()));
    comproElNavegador = true;
    await expect(page.locator('main')).toContainText('14B');
  } finally {
    // Si la prueba falló antes de comprar, el cupo retenido por el navegador no se queda tomado 15 min.
    if (!comproElNavegador) await liberarHold(token, holdDelNavegador);
  }
});
