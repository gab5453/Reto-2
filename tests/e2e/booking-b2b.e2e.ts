import { randomInt, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BOOKING_PARTNER, cancelarComoAdmin, enDias, GATEWAY, ingresar, USUARIOS } from './apoyo.js';

/**
 * E-4 (Pruebas.md §5.4): Booking compra por la API REST v2 del contrato del grupo (OAuth2 → búsqueda → hold → reserva →
 * consulta) y la venta aparece en el panel del administrador con su canal y su orden. La suite de conformidad comprueba cada
 * operación contra el OpenAPI; aquí importa el VIAJE completo y que los dos canales vean lo mismo.
 */
const API = `${GATEWAY}/api/v2`;
const USUARIO_BOOKING = 'usr-e2e-b2b';
let bookingId: string | undefined;
test.afterEach(async () => cancelarComoAdmin(bookingId));

async function tokenDePartner(): Promise<string> {
  const response = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${BOOKING_PARTNER.clientId}:${BOOKING_PARTNER.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

test('E-4: Booking compra por la API v2 y la venta se ve en el panel del administrador', async ({ page }) => {
  const token = await tokenDePartner();
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    'x-user-id': USUARIO_BOOKING,
    'x-device-fingerprint': 'booking-e2e',
    'x-correlation-id': `corr-e2e-b2b-${randomUUID().slice(0, 8)}`,
    'content-type': 'application/json',
    ...extra,
  });
  const llamar = async (method: string, path: string, body?: unknown, extra?: Record<string, string>) => {
    const response = await fetch(`${API}${path}`, { method, headers: headers(extra), ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  // 1. Búsqueda (solo ida, un adulto).
  const busqueda = await llamar('POST', '/vuelos/search', { itineraries: [{ origin: 'GYE', destination: 'UIO', departureDate: enDias(42) }], passengers: { adults: 1 } });
  expect(busqueda.status).toBe(200);
  const offer = busqueda.body['offers'][0];
  const itinerary = offer.itineraries[0];
  const pricing = itinerary.pricingOptions.find((p: { availableSeats: number }) => p.availableSeats > 0);

  // 2. Hold: el precio queda congelado.
  const hold = await llamar('POST', '/vuelos/offers/hold', { offerId: offer.offerId, itinerarySelections: [{ itineraryId: itinerary.itineraryId, cabinClass: pricing.cabinClass, fareBrand: pricing.fareBrand }], passengersBreakdown: { adults: 1 } }, { 'idempotency-key': randomUUID() });
  expect(hold.status).toBe(201);

  // 3. Reserva con el pago que Booking ya cobró en su sistema (formato BKG-02) y su número de orden.
  const orden = `ORD-BKP-E2E-${randomInt(100_000, 999_999)}`;
  const dia = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const reserva = await llamar('POST', '/vuelos/bookings', {
    holdId: hold.body['holdId'],
    passengers: [{
      passengerId: 'PAX-1', passengerType: 'ADULT', firstName: 'Prueba', lastName: 'Booking B2B', documentType: 'PASSPORT', documentNumber: `E2EB${randomInt(1_000_000, 9_999_999)}`,
      nationality: 'EC', documentExpiryDate: '2030-01-01', birthDate: '1992-02-02', gender: 'F', contact: { email: 'b2b@booking.test', phone: '+593987654321' },
    }],
    payment: { paymentReference: `PAY-BKP-${dia}-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`, amount: hold.body['lockedPrice'], provider: 'BOOKING_PROTOTIPO' },
    salesChannel: { partnerId: BOOKING_PARTNER.clientId, partnerOrderId: orden },
  }, { 'idempotency-key': randomUUID() });
  expect([201, 202]).toContain(reserva.status);
  bookingId = reserva.body['bookingId'];
  const pnr: string = reserva.body['pnr'];

  // 4. Booking la consulta: confirmada (la saga pudo responder 202 y terminar después).
  await expect.poll(async () => (await llamar('GET', `/vuelos/bookings/${bookingId}`)).body['status'], { timeout: 30_000 }).toBe('CONFIRMED');

  // 5. El administrador la encuentra en la web por la orden de Booking, con su canal.
  await ingresar(page, USUARIOS.admin);
  await page.goto('/admin/reservas');
  await page.getByLabel('PNR, orden de Booking o referencia de pago').fill(orden);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const fila = page.locator('tbody tr', { hasText: pnr });
  await expect(fila).toBeVisible();
  await expect(fila).toContainText(/Booking/i);
});
