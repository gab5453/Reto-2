import { expect, test, type Page } from '@playwright/test';
import { buscar, datos, enDias, gql, ingresar, USUARIOS } from './apoyo.js';

/**
 * E-6 (Pruebas.md §5.4): el administrador pone un precio exacto a una ruta y la búsqueda de la web lo refleja (MS.Admin → ESB
 * → MS.G.Schedule → evento de precios → MS.G.Offers). Al final se quita el precio exacto y se comprueba que todo volvió a la
 * fórmula de antes.
 */
const FECHA = enDias(44);
const PRECIOS = { Semilla: '71', Brote: '96', Bosque: '126', Dosel: '221' };

const panel = (page: Page) => page.locator('section', { has: page.getByRole('heading', { name: 'Tarifa base y precio por ruta' }) });
const precioDe = (page: Page, paquete: string) => page.locator('label.fare', { hasText: paquete }).first().locator('.fare-price');

async function elegirRuta(page: Page): Promise<void> {
  const select = panel(page).getByLabel('Ruta para ver cuánto cuesta cada paquete');
  const opcion = select.locator('option', { hasText: '(UIO–BOG)' });
  await opcion.waitFor({ state: 'attached' });
  await select.selectOption((await opcion.getAttribute('value')));
}

/** Tarifa base (sin impuestos) de cada paquete en la búsqueda, por la API. */
async function tarifasBase(): Promise<Record<string, number>> {
  const r = datos(await gql<{ searchFlights: { offers: { itineraries: { pricingOptions: { fareBrand: string; pricePerPassengerType: { price: { baseFare: string } }[] }[] }[] }[] } }>(
    'query($i: SearchFlightsInput!){ searchFlights(input:$i){ offers { itineraries { pricingOptions { fareBrand pricePerPassengerType { price { baseFare } } } } } } }',
    { i: { itineraries: [{ origin: 'UIO', destination: 'BOG', departureDate: FECHA }], passengers: { adults: 1 } } },
  ));
  return Object.fromEntries(r.searchFlights.offers[0].itineraries[0].pricingOptions.map((p) => [p.fareBrand, Number(p.pricePerPassengerType[0].price.baseFare)]));
}

async function precioEnBusqueda(page: Page): Promise<string> {
  await buscar(page, 'UIO', 'BOG', FECHA);
  return (await precioDe(page, 'Bosque').innerText()).trim();
}

test('E-6: el administrador cambia un precio y la búsqueda lo refleja', async ({ page }) => {
  const antes = await precioEnBusqueda(page);

  await ingresar(page, USUARIOS.admin);
  await page.goto('/admin/precios');
  await elegirRuta(page);
  let guardado = false;
  try {
    for (const [paquete, valor] of Object.entries(PRECIOS)) await panel(page).getByLabel(`Precio exacto de ${paquete}`).fill(valor);
    await panel(page).getByRole('button', { name: 'Guardar precio de esta ruta' }).click();
    await expect(panel(page).getByText('Precio exacto guardado para UIO ⇄ BOG')).toBeVisible();
    guardado = true;

    // La búsqueda de la web ya cotiza con el precio nuevo (el cambio viaja por eventos). La web muestra el total por adulto
    // CON impuestos; la tarifa base de cada paquete es exactamente la que guardó el administrador.
    await expect.poll(() => precioEnBusqueda(page), { timeout: 30_000 }).not.toBe(antes);
    expect(await tarifasBase()).toEqual({ SEMILLA: 71, BROTE: 96, BOSQUE: 126, DOSEL: 221 });
  } finally {
    if (guardado) {
      await page.goto('/admin/precios');
      await elegirRuta(page);
      await panel(page).getByRole('button', { name: 'Quitar precio exacto (volver a la fórmula)' }).click();
      await expect(panel(page).getByText(/vuelve a la fórmula/).first()).toBeVisible();
    }
  }
  // Quedó como estaba.
  await expect.poll(() => precioEnBusqueda(page), { timeout: 30_000 }).toBe(antes);
});
