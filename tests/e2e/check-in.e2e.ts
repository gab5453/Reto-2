import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { cancelarComoAdmin, comprar, enDias, gql, ingresar, oferta, tokenDe, USUARIOS, type Reserva } from './apoyo.js';

/**
 * E-3 y E-8 (Pruebas.md §5.4), sobre la MISMA reserva y en orden: el check-in abre 48 h antes, así que se compra (por la API,
 * como preparación) el vuelo UIO → BOG de mañana. E-3 hace el check-in en la web y comprueba que ya no se puede cancelar (en la
 * web Y en el servidor); E-8 corta la red y la PWA muestra el pase guardado. Al final, el administrador la cancela (limpieza).
 */
test.describe.configure({ mode: 'serial' });

let reserva: Reserva;
let token: string;
let vuelo: string;
test.beforeAll(async () => {
  token = await tokenDe(USUARIOS.pasajero);
  const o = await oferta('UIO', 'BOG', enDias(1));
  vuelo = o.flightNumber;
  reserva = await comprar(token, o, { apellido: 'Check In' });
  expect(reserva.status).toBe('CONFIRMED');
});
test.afterAll(async () => cancelarComoAdmin(reserva?.bookingId));

test('E-3: el pasajero hace check-in y después la cancelación queda bloqueada', async ({ page }) => {
  await ingresar(page, USUARIOS.pasajero);
  await page.goto(`/mis-viajes/${reserva.bookingId}`);
  await expect(page.getByText(reserva.pnr).first()).toBeVisible();
  // Antes del check-in, la reserva sí se puede cancelar.
  await expect(page.getByRole('tab', { name: 'Cancelar' })).toBeVisible();

  await page.getByRole('tab', { name: 'Check-in y pases' }).click();
  await page.getByRole('button', { name: 'Hacer check-in' }).click();
  await expect(page.getByText('Ya hiciste check-in: tu reserva ya no se puede modificar.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Cancelar' })).toHaveCount(0);

  // No es solo la web escondiendo un botón: el servidor también lo rechaza (D55), sea al cotizar o al cancelar.
  const cotizacion = await gql<{ booking: { cancellationQuote: { quoteId: string } | null } }>('query($id: UUID!){ booking(bookingId:$id){ cancellationQuote { quoteId } } }', { id: reserva.bookingId }, token);
  const quoteId = cotizacion.data?.booking.cancellationQuote?.quoteId;
  const rechazo = quoteId
    ? await gql('mutation($k: UUID!, $id: UUID!, $i: CancelBookingInput!){ cancelBooking(idempotencyKey:$k, bookingId:$id, input:$i){ status } }', { k: randomUUID(), id: reserva.bookingId, i: { quoteId } }, token)
    : cotizacion;
  expect(rechazo.errors?.[0]?.extensions?.code).toBe('CUTOFF_PASSED');
  const estado = await gql<{ booking: { status: string } }>('query($id: UUID!){ booking(bookingId:$id){ status } }', { id: reserva.bookingId }, token);
  expect(estado.data?.booking.status).toBe('CONFIRMED');
});

test('E-8: sin conexión, la PWA muestra el pase de abordar guardado', async ({ page, context }) => {
  await ingresar(page, USUARIOS.pasajero);
  // Abrir los pases los guarda en el dispositivo (solo lo necesario para abordar).
  await page.goto(`/mis-viajes/${reserva.bookingId}`);
  await page.getByRole('tab', { name: 'Check-in y pases' }).click();
  await expect(page.getByText(reserva.pnr).first()).toBeVisible();
  // El service worker (precaché) tiene que estar controlando la página antes de cortar la red.
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 30_000 });

  await context.setOffline(true);
  try {
    await page.goto('/sin-conexion');
    await expect(page.getByRole('heading', { name: 'Viajes guardados' })).toBeVisible();
    const pases = page.locator('section[aria-labelledby="saved-passes-title"]');
    await expect(pases).toBeVisible();
    // Lo necesario para abordar: vuelo, pasajero, ruta, asiento y el código QR.
    await expect(pases).toContainText(vuelo);
    await expect(pases).toContainText('Prueba Check In');
    await expect(pases).toContainText('UIO → BOG');
    await expect(pases.getByRole('img', { name: 'Código QR del pase de Prueba Check In' })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
