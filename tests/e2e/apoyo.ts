import { randomInt, randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

/**
 * Apoyo de las E2E (E2E-1). Lo que la prueba NO está probando (preparar una reserva, limpiar al final) se hace por la API, como
 * un cliente más; lo que sí prueba se hace en el navegador. Todo apunta al sistema LOCAL de docker compose:
 *   web :5173 · gateway :8088 · Payment API :4010   (las claves son las de desarrollo de infra/docker-compose.yml)
 */
export const WEB = process.env['E2E_WEB'] ?? 'http://localhost:5173';
export const GATEWAY = process.env['E2E_GATEWAY'] ?? 'http://localhost:8088';
export const PAYMENT = process.env['E2E_PAYMENT'] ?? 'http://localhost:4010';
const PAYMENT_PUBLIC_KEY = 'pk_test_dev_solo_local_ecoairlines_0001';
export const BOOKING_PARTNER = { clientId: 'BOOKING_PROTOTIPO', clientSecret: 'secreto-booking-dev-solo-local-0001' };

// Candado: estas pruebas compran, cancelan y cambian precios. Nunca contra la nube ni otro equipo.
for (const url of [WEB, GATEWAY, PAYMENT]) {
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') throw new Error(`Las E2E solo corren contra el sistema local (docker compose), no contra ${url}`);
}

export const USUARIOS = {
  pasajero: { email: 'demo@ecoairlines.test', password: 'EcoDemo2026' },
  admin: { email: 'admin@ecoairlines.test', password: 'EcoAdmin2026' },
} as const;
type Usuario = (typeof USUARIOS)[keyof typeof USUARIOS];

/** Fecha local de Ecuador (UTC−5) dentro de `days` días, en AAAA-MM-DD: el horario de la aerolínea está en hora local. */
export function enDias(days: number): string {
  return new Date(Date.now() - 5 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------------------- navegador

export async function ingresar(page: Page, usuario: Usuario): Promise<void> {
  await page.goto('/ingresar');
  await page.getByLabel('Correo').fill(usuario.email);
  await page.getByLabel('Contraseña').fill(usuario.password);
  await page.getByRole('button', { name: 'Ingresar' }).last().click();
  await expect(page).not.toHaveURL(/\/ingresar/);
}

/** Datos del pasajero en el pago (un solo adulto), con un documento único por llamada. */
export async function llenarPasajero(page: Page, apellido: string): Promise<void> {
  await page.getByLabel('Nombres').first().fill('Prueba');
  await page.getByLabel('Apellidos').first().fill(apellido);
  await page.getByLabel('Tipo de documento').first().selectOption('PASSPORT');
  await page.getByLabel('Número de documento').first().fill(documento('W'));
  await page.getByLabel('Nacionalidad (código de país)').first().fill('EC');
  await page.getByLabel(/Fecha de nacimiento/).first().fill('1990-01-01');
  await page.getByLabel('Género').first().selectOption({ index: 1 });
  await page.getByLabel('Correo').first().fill(USUARIOS.pasajero.email);
  await page.getByLabel('Teléfono').first().fill('+593991234567');
}

/** Búsqueda de solo ida desde la portada, hasta los resultados. */
export async function buscar(page: Page, origen: string, destino: string, fecha: string): Promise<void> {
  await page.goto('/');
  await page.getByText('Solo ida').first().click();
  await page.getByRole('combobox', { name: 'Origen' }).first().selectOption(origen);
  await page.getByRole('combobox', { name: 'Destino' }).first().selectOption(destino);
  await page.getByLabel('Fecha').first().fill(fecha);
  await page.getByRole('button', { name: 'Buscar vuelos' }).click();
  await expect(page).toHaveURL(/\/vuelos/);
}

/** Paga con la tarjeta de prueba que autoriza (la Payment API simulada) y envía la reserva. */
export async function pagar(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Usar tarjeta de prueba' }).click();
  await page.getByLabel('Tarjeta de prueba').selectOption({ index: 1 });
  await page.getByRole('button', { name: /Pagar y reservar/ }).click();
}

export const textoDe = async (page: Page, selector = 'main'): Promise<string> => (await page.locator(selector).innerText()).replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------------------------------------------- API (preparar y limpiar)

interface GqlError { message: string; extensions?: { code?: string } }
export interface GqlRespuesta<T> { data?: T; errors?: GqlError[] }

export async function gql<T = Record<string, unknown>>(query: string, variables: Record<string, unknown> = {}, token?: string, correlationId?: string): Promise<GqlRespuesta<T>> {
  const response = await fetch(`${GATEWAY}/api/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-device-fingerprint': 'e2e',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as GqlRespuesta<T>;
}

export function datos<T>(respuesta: GqlRespuesta<T>): T {
  if (respuesta.errors?.length) throw new Error(JSON.stringify(respuesta.errors.map((e) => `${e.extensions?.code ?? ''} ${e.message}`)));
  return respuesta.data!;
}

const tokens = new Map<string, Promise<string>>();
/** Token de usuario para preparar y limpiar por la API; uno por usuario y por archivo (no gasta inicios de sesión). */
export function tokenDe(usuario: Usuario): Promise<string> {
  let token = tokens.get(usuario.email);
  if (!token) {
    token = gql<{ login: { accessToken: string } }>('mutation($i: LoginInput!){ login(input:$i){ accessToken } }', { i: usuario }).then((r) => datos(r).login.accessToken);
    token.catch(() => tokens.delete(usuario.email));
    tokens.set(usuario.email, token);
  }
  return token;
}

export const documento = (prefijo: string): string => `E2E${prefijo}${randomInt(1_000_000, 9_999_999)}`;

export interface Oferta {
  offerId: string;
  itineraryId: string;
  segmentId: string;
  flightNumber: string;
  cabinClass: string;
  fareBrand: string;
}

/** Primera oferta directa con cupos de `origen`→`destino` en `fecha` (tarifa Bosque si existe). */
export async function oferta(origen: string, destino: string, fecha: string): Promise<Oferta> {
  const search = datos(
    await gql<{ searchFlights: { offers: { offerId: string; itineraries: { itineraryId: string; segments: { segmentId: string; flightNumber: string }[]; pricingOptions: { cabinClass: string; fareBrand: string; availableSeats: number }[] }[] }[] } }>(
      'query($i: SearchFlightsInput!){ searchFlights(input:$i){ offers { offerId itineraries { itineraryId segments { segmentId flightNumber } pricingOptions { cabinClass fareBrand availableSeats } } } } }',
      { i: { itineraries: [{ origin: origen, destination: destino, departureDate: fecha }], passengers: { adults: 1 } } },
    ),
  ).searchFlights;
  for (const offer of search.offers) {
    const itinerary = offer.itineraries[0];
    if (itinerary.segments.length !== 1) continue;
    const fare = itinerary.pricingOptions.find((p) => p.fareBrand === 'BOSQUE' && p.availableSeats > 0) ?? itinerary.pricingOptions.find((p) => p.availableSeats > 0);
    if (fare) return { offerId: offer.offerId, itineraryId: itinerary.itineraryId, segmentId: itinerary.segments[0].segmentId, flightNumber: itinerary.segments[0].flightNumber, cabinClass: fare.cabinClass, fareBrand: fare.fareBrand };
  }
  throw new Error(`No hay vuelos directos con cupos ${origen} → ${destino} el ${fecha}`);
}

/** Pago con la tarjeta de prueba que autoriza, como lo hace el navegador (clave pública). Devuelve la referencia. */
async function pagarPorApi(amount: { currency: string; total: number }): Promise<string> {
  const headers = { 'content-type': 'application/json', 'X-Api-Key': PAYMENT_PUBLIC_KEY };
  const cards = (await (await fetch(`${PAYMENT}/test-cards`, { headers })).json()) as { number: string; expectedResult: string; expMonth?: number; expYear?: number; cvv?: string }[];
  const card = cards.find((c) => c.expectedResult === 'AUTHORIZED')!;
  const method = (await (await fetch(`${PAYMENT}/payment-methods`, { method: 'POST', headers, body: JSON.stringify({ holderName: 'Prueba E2E', number: card.number, expMonth: card.expMonth ?? 12, expYear: card.expYear ?? 2030, cvv: card.cvv ?? '123' }) })).json()) as { token: string };
  const payment = (await (await fetch(`${PAYMENT}/payments`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ paymentMethodToken: method.token, amount, description: 'Prueba E2E' }) })).json()) as { status: string; paymentReference: string };
  if (!['AUTHORIZED', 'PENDING'].includes(payment.status)) throw new Error(`Pago no autorizado: ${JSON.stringify(payment)}`);
  return payment.paymentReference;
}

export interface Reserva { bookingId: string; pnr: string; status: string }

/** Compra por la API del canal web (hold → pago → reserva), opcionalmente con un asiento. Para PREPARAR una prueba. */
export async function comprar(token: string, o: Oferta, opciones: { asiento?: string; apellido?: string; correlationId?: string } = {}): Promise<Reserva> {
  const hold = datos(
    await gql<{ holdInventory: { holdId: string; lockedPrice: { currency: string; total: number } } }>(
      'mutation($k: UUID!, $i: HoldInput!){ holdInventory(idempotencyKey:$k, input:$i){ holdId lockedPrice { currency total } } }',
      { k: randomUUID(), i: { offerId: o.offerId, itinerarySelections: [{ itineraryId: o.itineraryId, cabinClass: o.cabinClass, fareBrand: o.fareBrand }], passengersBreakdown: { adults: 1 } } },
      token,
      opciones.correlationId,
    ),
  ).holdInventory;
  const paymentReference = await pagarPorApi(hold.lockedPrice);
  const booking = datos(
    await gql<{ createBooking: { booking: Reserva } }>(
      'mutation($k: UUID!, $i: CreateBookingInput!){ createBooking(idempotencyKey:$k, input:$i){ outcome booking { bookingId pnr status } } }',
      {
        k: randomUUID(),
        i: {
          holdId: hold.holdId,
          payment: { paymentReference },
          passengers: [{
            passengerId: 'PAX-1', passengerType: 'ADULT', firstName: 'Prueba', lastName: opciones.apellido ?? 'Preparada', documentType: 'PASSPORT', documentNumber: documento('A'),
            nationality: 'EC', documentExpiryDate: '2030-01-01', birthDate: '1995-05-05', gender: 'X', contact: { email: USUARIOS.pasajero.email, phone: '+593991234567' },
            ...(opciones.asiento ? { assignedSeats: [{ segmentId: o.segmentId, seatNumber: opciones.asiento }] } : {}),
          }],
        },
      },
      token,
      opciones.correlationId,
    ),
  ).createBooking;
  return booking.booking;
}

/**
 * LIMPIEZA: cancela la reserva como administrador (reembolso completo y asientos devueltos), aunque tenga check-in. Si ya
 * estaba cancelada no hace nada. Nunca lanza: una limpieza fallida no debe ocultar el resultado de la prueba.
 */
export async function cancelarComoAdmin(bookingId: string | undefined): Promise<void> {
  if (!bookingId) return;
  try {
    const admin = await tokenDe(USUARIOS.admin);
    const estado = await gql<{ adminBooking: { status: string } }>('query($id: UUID!){ adminBooking(bookingId:$id){ status } }', { id: bookingId }, admin);
    if (estado.data?.adminBooking.status === 'CANCELLED') return;
    await gql('mutation($id: UUID!, $r: String!){ adminCancelBooking(bookingId:$id, reason:$r) }', { id: bookingId, r: 'Limpieza de la prueba E2E' }, admin);
  } catch (error) {
    console.warn(`No se pudo limpiar la reserva ${bookingId}: ${String(error)}`);
  }
}

/** LIMPIEZA: libera un hold que la prueba dejó sin comprar (si ya expiró o se usó, no hace nada). */
export async function liberarHold(token: string, holdId: string | undefined): Promise<void> {
  if (holdId) await gql('mutation($id: UUID!){ releaseHold(holdId:$id){ holdId status } }', { id: holdId }, token).catch(() => undefined);
}
