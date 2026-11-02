import type { AssignedSeat } from '../services/holds.service.js';
import type { CabinPricing, FlightOffer, FlightSegment, HoldRecord, ItineraryOption, PricedSelection } from '../domain/model.js';

/**
 * Conversión entre el dominio (nombres del contrato v2, p. ej. `ECONOMY`) y los mensajes del proto (enums con prefijo,
 * p. ej. `CABIN_CLASS_ECONOMY`). proto-loader ya convierte los campos snake_case ↔ camelCase.
 */
export const toEnum = (prefix: string, value: string) => `${prefix}_${value}`;
export function fromEnum<T extends string>(prefix: string, value: unknown): T | undefined {
  if (typeof value !== 'string' || value.endsWith('_UNSPECIFIED')) return undefined;
  return (value.startsWith(`${prefix}_`) ? value.slice(prefix.length + 1) : value) as T;
}

export const cabin = (value: string) => toEnum('CABIN_CLASS', value);

const segment = (s: FlightSegment) => ({ ...s, status: toEnum('FLIGHT_OPERATIONAL_STATUS', s.status) });
const pricing = (p: CabinPricing) => ({
  ...p,
  cabinClass: cabin(p.cabinClass),
  pricePerPassengerType: p.pricePerPassengerType.map((price) => ({ passengerType: toEnum('PASSENGER_TYPE', price.passengerType), price: price.price })),
});
export const itinerary = (i: ItineraryOption) => ({ ...i, segments: i.segments.map(segment), pricingOptions: i.pricingOptions.map(pricing) });
export const offer = (o: FlightOffer) => ({ ...o, itineraries: o.itineraries.map(itinerary) });

const selection = (s: PricedSelection) => ({ ...s, cabinClass: cabin(s.cabinClass), itinerary: itinerary(s.itinerary) });

export function hold(h: HoldRecord, now = Date.now()) {
  return {
    holdId: h.holdId,
    status: toEnum('HOLD_STATUS', h.status),
    expiresAt: h.expiresAt,
    ttlMinutes: h.ttlMinutes,
    remainingSeconds: h.status === 'HELD' ? Math.max(0, Math.floor((Date.parse(h.expiresAt) - now) / 1000)) : 0,
    lockedPrice: h.lockedPrice,
    offerId: h.offerId,
    channel: toEnum('SALES_CHANNEL', h.channel),
    passengersBreakdown: h.counts,
    selections: h.selections.map(selection),
    ...(h.bookingId ? { bookingId: h.bookingId } : {}),
    createdAt: h.createdAt,
  };
}

export const assignedSeat = (s: AssignedSeat) => ({ ...s, status: toEnum('SEAT_STATUS', s.status) });
export const seatResult = (r: { bookingId: string; seats: AssignedSeat[]; seatsAffected: number }) => ({ ...r, seats: r.seats.map(assignedSeat) });
