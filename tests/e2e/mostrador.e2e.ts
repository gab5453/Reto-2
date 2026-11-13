import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { cancelarComoAdmin, comprar, enDias, gql, ingresar, oferta, tokenDe, USUARIOS, type Reserva } from './apoyo.js';

/**
 * E-9 (Pruebas.md §5.4, D57, PLAN/Check_in_Mostrador.md): el check-in en mostrador. El pasajero compra (por la API, como
 * preparación) el vuelo UIO → BOG de mañana; el ADMINISTRADOR abre la reserva en el panel, pulsa «Check-in en mostrador e
 * imprimir» y se descarga el PDF de los pases. La reserva queda con check-in (el pasajero ve su pase) y un segundo clic
 * («Reimprimir pases») vuelve a descargar el PDF sin error (CM-4). Al final el administrador la cancela (limpieza).
 */
let reserva: Reserva;
let token: string;
let vuelo: string;
test.beforeAll(async () => {
  token = await tokenDe(USUARIOS.pasajero);
  const o = await oferta('UIO', 'BOG', enDias(1));
  vuelo = o.flightNumber;
  reserva = await comprar(token, o, { apellido: 'Mostrador' });
  expect(reserva.status).toBe('CONFIRMED');
});
test.afterAll(async () => cancelarComoAdmin(reserva?.bookingId));

/** Pulsa el botón y devuelve el PDF descargado (como texto latin1: jsPDF no comprime, el texto se puede buscar). */
async function descargar(page: Page, boton: string): Promise<{ nombre: string; pdf: string }> {
  const [descarga] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: boton }).click()]);
  const ruta = await descarga.path();
  return { nombre: descarga.suggestedFilename(), pdf: (await readFile(ruta)).toString('latin1') };
}

test('E-9: el administrador hace el check-in en mostrador e imprime el pase en PDF', async ({ page }) => {
  await ingresar(page, USUARIOS.admin);
  await page.goto(`/admin/reservas/${reserva.bookingId}`);
  await expect(page.getByRole('heading', { name: new RegExp(reserva.pnr) })).toBeVisible();
  // La primera vez pide confirmación (se aceptan los diálogos del navegador).
  page.on('dialog', (dialogo) => void dialogo.accept());

  const primero = await descargar(page, 'Check-in en mostrador e imprimir');
  expect(primero.nombre).toBe(`pases-${reserva.pnr}.pdf`);
  expect(primero.pdf.startsWith('%PDF')).toBe(true);
  for (const texto of [reserva.pnr, vuelo, 'MOSTRADOR / PRUEBA', 'Check-in en mostrador']) expect(primero.pdf).toContain(texto);

  // La reserva quedó con check-in: el pasajero ya ve su pase, y el historial dice que fue en mostrador.
  const pases = await gql<{ booking: { boardingPasses: unknown[] | null; changes: { description: string | null }[] } }>(
    'query($id: UUID!){ booking(bookingId:$id){ boardingPasses { passengerId } changes { description } } }',
    { id: reserva.bookingId },
    token,
  );
  expect(pases.data?.booking.boardingPasses?.length).toBeGreaterThan(0);
  expect(pases.data?.booking.changes.some((c) => c.description?.startsWith('Check-in en mostrador (administrador)'))).toBe(true);

  // CM-4: con pases, el botón reimprime; el 409 de «nada pendiente» no se muestra como error.
  const segundo = await descargar(page, 'Reimprimir pases');
  expect(segundo.pdf).toContain(reserva.pnr);
  await expect(page.locator('.counter-check-in [role="alert"]')).toHaveCount(0);
});
