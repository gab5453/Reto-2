import { expect, test } from '@playwright/test';
import { cancelarComoAdmin, comprar, enDias, gql, GATEWAY, ingresar, oferta, textoDe, tokenDe, USUARIOS, type Reserva } from './apoyo.js';

/**
 * E-5 (Pruebas.md §5.4): el administrador registra un retraso en la web y el pasajero lo ve en su reserva; Booking lo ve por
 * REST. Atraviesa MS.Admin → ESB → MS.G.FlightStatus → evento → MS.G.Bookings. Al final se quita el retraso y se cancela la
 * reserva de preparación.
 */
const FECHA = enDias(43);
let reserva: Reserva | undefined;
let vuelo = '';

test.afterEach(async () => {
  if (vuelo) {
    const admin = await tokenDe(USUARIOS.admin);
    await gql('mutation($f: String!, $i: FlightStatusUpdateInput!){ updateFlightStatus(flightNumber:$f, input:$i){ previousStatus } }', { f: vuelo, i: { date: FECHA, status: 'SCHEDULED' } }, admin);
  }
  await cancelarComoAdmin(reserva?.bookingId);
});

test('E-5: el administrador registra un retraso y el pasajero lo ve en su reserva', async ({ page }) => {
  const o = await oferta('BOG', 'UIO', FECHA);
  vuelo = o.flightNumber;
  reserva = await comprar(await tokenDe(USUARIOS.pasajero), o, { apellido: 'Retraso' });

  // El administrador retrasa el vuelo 30 min desde «Operaciones».
  await ingresar(page, USUARIOS.admin);
  await page.goto('/admin/operaciones');
  await page.getByLabel('Fecha').fill(FECHA);
  await page.getByLabel('Buscar vuelo').fill(vuelo);
  await page.locator('tbody tr', { hasText: vuelo }).first().getByRole('button', { name: 'Gestionar' }).click();
  await page.getByLabel(/Nuevo estado/).selectOption('DELAYED');
  await page.getByRole('button', { name: '30 min', exact: true }).click();
  // La vista previa avisa a cuántas reservas afecta (al menos la de esta prueba).
  await expect(page.locator('.delay-impact')).toContainText(/Afecta a [1-9]\d* reserva/);
  await page.getByLabel(/Motivo/).fill('Prueba E2E: tráfico aéreo');
  await page.getByRole('button', { name: /^Retrasar 30 min/ }).click();
  await expect(page.getByText(/Retrasado 30 min: sale/).first()).toBeVisible();

  // Booking lo ve por REST (contrato v2).
  const estado = (await (await fetch(`${GATEWAY}/api/v2/vuelos/flights/${vuelo}/status?date=${FECHA}`)).json()) as { status: string; delayMinutes: number | null };
  expect(estado).toMatchObject({ status: 'DELAYED', delayMinutes: 30 });

  // El pasajero lo ve en su reserva, con la hora nueva.
  await page.getByRole('button', { name: 'Salir' }).click();
  await ingresar(page, USUARIOS.pasajero);
  await page.goto(`/mis-viajes/${reserva.bookingId}`);
  await expect(page.getByText(`Tu vuelo ${vuelo} está retrasado 30 min.`)).toBeVisible();
  expect(await textoDe(page)).toMatch(/Nueva salida \d{2}:\d{2} \(era \d{2}:\d{2}\)/);
});
