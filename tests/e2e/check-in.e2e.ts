import { expect, test } from '@playwright/test';
import { cancelarComoAdmin, comprar, enDias, gql, ingresar, oferta, tokenDe, USUARIOS, type Reserva } from './apoyo.js';

/**
 * E-3 y E-8 (Pruebas.md §5.4), sobre la MISMA reserva y en orden: el check-in abre 48 h antes, así que se compra (por la API,
 * como preparación) el vuelo UIO → BOG de mañana. E-3 hace el check-in en la web; E-8 corta la red y la PWA muestra el pase
 * guardado; y al final (D56, 12/11: revoca D55) el pasajero CANCELA en la web después del check-in: sus pases dejan de ser
 * válidos en el servidor y la PWA los retira del dispositivo.
 * Si algo falla antes, el administrador la cancela (limpieza).
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

test('E-3: el pasajero hace check-in en la web y obtiene su pase de abordar', async ({ page }) => {
  await ingresar(page, USUARIOS.pasajero);
  await page.goto(`/mis-viajes/${reserva.bookingId}`);
  await expect(page.getByText(reserva.pnr).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Check-in y pases' }).click();
  await page.getByRole('button', { name: 'Hacer check-in' }).click();
  await expect(page.getByRole('button', { name: 'Actualizar check-in' })).toBeVisible();
  const pases = await gql<{ booking: { boardingPasses: unknown[] | null } }>('query($id: UUID!){ booking(bookingId:$id){ boardingPasses { passengerId } } }', { id: reserva.bookingId }, token);
  expect(pases.data?.booking.boardingPasses?.length).toBeGreaterThan(0);
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

test('E-3 (D56): después del check-in el pasajero cancela en la web, y sus pases dejan de ser válidos (también sin conexión)', async ({ page, context }) => {
  await ingresar(page, USUARIOS.pasajero);
  await page.goto(`/mis-viajes/${reserva.bookingId}`);
  await expect(page.getByText('Ya hiciste check-in.')).toBeVisible();
  // Antes (D55) la pestaña desaparecía; ahora está, y avisa qué pasa con los pases.
  await page.getByRole('tab', { name: 'Cancelar' }).click();
  await expect(page.getByText('Ya hiciste check-in: si cancelas, tus pases de abordar dejan de ser válidos')).toBeVisible();
  await page.getByRole('button', { name: 'Ver cotización de cancelación' }).click();
  await page.getByLabel('Entiendo que la cancelación no se puede deshacer.').check();
  await page.getByRole('button', { name: 'Cancelar reserva' }).click();
  await expect(page.getByRole('heading', { name: 'Reembolso' })).toBeVisible();
  const estado = await gql<{ booking: { status: string } }>('query($id: UUID!){ booking(bookingId:$id){ status } }', { id: reserva.bookingId }, token);
  expect(estado.data?.booking.status).toBe('CANCELLED');

  // El check-in se anuló: el servidor ya no da pases…
  const pases = await gql('query($id: UUID!){ booking(bookingId:$id){ boardingPasses { passengerId } } }', { id: reserva.bookingId }, token);
  const sinPases = pases.errors?.[0]?.extensions?.code === 'BOARDING_PASS_NOT_AVAILABLE' || ((pases.data as { booking?: { boardingPasses?: unknown[] | null } } | undefined)?.booking?.boardingPasses ?? []).length === 0;
  expect(sinPases).toBe(true);
  // …y la PWA lo retiró del dispositivo: sin conexión ya no aparece el pase guardado en E-8.
  await context.setOffline(true);
  try {
    await page.goto('/sin-conexion');
    await expect(page.getByRole('heading', { name: 'Viajes guardados' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Código QR del pase de Prueba Check In' })).toHaveCount(0);
  } finally {
    await context.setOffline(false);
  }
});
