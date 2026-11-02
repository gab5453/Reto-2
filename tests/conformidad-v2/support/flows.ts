import { randomInt } from 'node:crypto';
import { call, config, dateInDays, expectConforms, newKey, newPaymentReference } from './client.js';

/** Tipos mínimos de las respuestas del contrato que usan los flujos (la forma completa la valida Ajv). */
export interface Money {
  currency: string;
  total: string;
}
interface Pricing {
  cabinClass: string;
  fareBrand: string;
  availableSeats: number;
  fareRules: { isRefundable: boolean; isChangeable: boolean };
}
interface Segment {
  segmentId: string;
  flightNumber: string;
  departure: { iataCode: string; at: string };
}
interface Itinerary {
  itineraryId: string;
  segments: Segment[];
  pricingOptions: Pricing[];
}
interface Offer {
  offerId: string;
  itineraries: Itinerary[];
}
export interface Hold {
  holdId: string;
  lockedPrice: Money;
}
export interface Booking {
  bookingId: string;
  pnr: string;
  status: string;
}

export interface OfferChoice {
  offer: Offer;
  itinerary: Itinerary;
  pricing: Pricing;
  segment: Segment;
  departureDate: string;
}

/** Busca, desde `daysAhead` y hasta 7 días después, una oferta de solo ida con cupos que cumpla `accept`. */
export async function findOffer(accept: (pricing: Pricing) => boolean = () => true): Promise<OfferChoice> {
  const [origin, destination] = config.route;
  for (let offset = 0; offset < 7; offset++) {
    const departureDate = dateInDays(config.daysAhead + offset);
    const response = await call('searchFlights', {
      body: { itineraries: [{ origin, destination, departureDate }], passengers: { adults: 1 } },
    });
    expectConforms(response, { status: 200 });
    for (const offer of (response.body as { offers: Offer[] }).offers) {
      const itinerary = offer.itineraries[0]!;
      const pricing = itinerary.pricingOptions.find((p) => p.availableSeats >= 2 && accept(p));
      if (pricing) return { offer, itinerary, pricing, segment: itinerary.segments[0]!, departureDate };
    }
  }
  throw new Error(`No hay ofertas ${origin}-${destination} con cupos entre ${config.daysAhead} y ${config.daysAhead + 6} días`);
}

export async function createHold(choice: OfferChoice): Promise<Hold> {
  const response = await call('createHold', {
    body: {
      offerId: choice.offer.offerId,
      itinerarySelections: [{ itineraryId: choice.itinerary.itineraryId, cabinClass: choice.pricing.cabinClass, fareBrand: choice.pricing.fareBrand }],
      passengersBreakdown: { adults: 1 },
    },
  });
  expectConforms(response, { status: 201 });
  return response.body as Hold;
}

/**
 * Cédula ecuatoriana VÁLIDA y aleatoria: provincia 01–24, tercer dígito < 6 y dígito verificador módulo 10 (coeficientes
 * 2,1,2,1…; si el producto pasa de 9 se le resta 9). Bookings la valida: un número cualquiera responde 400.
 */
export function newCedula(): string {
  const digits = [...String(randomInt(1, 25)).padStart(2, '0'), String(randomInt(0, 6)), ...Array.from({ length: 6 }, () => String(randomInt(0, 10)))].map(Number);
  const sum = digits.reduce((total, digit, index) => {
    const product = digit * (index % 2 === 0 ? 2 : 1);
    return total + (product > 9 ? product - 9 : product);
  }, 0);
  return `${digits.join('')}${(10 - (sum % 10)) % 10}`;
}

export function passenger(): Record<string, unknown> {
  return {
    passengerId: 'PAX-1',
    passengerType: 'ADULT',
    firstName: 'Prueba',
    lastName: 'Conformidad',
    documentType: 'NATIONAL_ID',
    documentNumber: newCedula(),
    nationality: 'EC',
    documentExpiryDate: dateInDays(3_000),
    birthDate: '1995-03-14',
    gender: 'F',
    contact: { email: 'conformidad@ecoairlines.test', phone: '+593987654321' },
  };
}

export function bookingBody(hold: Hold, paymentReference = newPaymentReference()): Record<string, unknown> {
  return {
    holdId: hold.holdId,
    passengers: [passenger()],
    payment: { paymentReference, amount: hold.lockedPrice, provider: 'BOOKING_PROTOTIPO' },
    salesChannel: { partnerId: config.partnerId, partnerOrderId: `ORD-CONF-${randomInt(100_000, 999_999)}` },
  };
}

/** Oferta → hold → reserva (canal Booking). Devuelve la reserva y el contexto. */
export async function createBooking(accept?: (pricing: Pricing) => boolean): Promise<{ booking: Booking; choice: OfferChoice; hold: Hold }> {
  const choice = await findOffer(accept);
  const hold = await createHold(choice);
  const response = await call('createBooking', { body: bookingBody(hold), idempotencyKey: newKey() });
  expectConforms(response, { status: [201, 202] });
  return { booking: response.body as Booking, choice, hold };
}
