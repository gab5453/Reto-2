import { randomInt } from 'node:crypto';
import { countPassengers, type PassengerCounts, ProblemDetailsException } from '@ecoairlines/shared';
import type { BookingRecord, ItineraryOption, PassengerItem, PassengerType, PurchasedFare, Ticket } from './model.js';

/**
 * Reglas de Bookings, migradas de `passenger-rules.ts`, `passenger-identity-rules.ts` y `booking-records.ts` del monolito,
 * con los códigos del contrato v2. Funciones puras: se prueban sin base de datos.
 */
const problem = (status: number, code: string, title: string, name?: string, reason?: string, detail?: string) =>
  new ProblemDetailsException({ status, code, title, ...(detail ? { detail } : {}), ...(name ? { invalidParams: [{ name, reason: reason ?? '' }] } : {}) });

/** Máximo de maletas extra por pasajero e itinerario (política comercial del monolito). */
export const MAX_EXTRA_BAGS = 3;

/**
 * Rangos de edad de EcoAirlines (los del buscador). Adulto ≥ 15; joven 12–14; niño 2–11; infante < 2 durante todo el viaje.
 * La edad se mide el día del primer vuelo; la del infante, también el día del último.
 */
export const AGE_RANGES: Record<PassengerType, { min: number; max?: number; label: string }> = {
  ADULT: { min: 15, label: 'Adulto (15 años o más)' },
  YOUTH: { min: 12, max: 14, label: 'Joven (12 a 14 años)' },
  CHILD: { min: 2, max: 11, label: 'Niño (2 a 11 años)' },
  INFANT: { min: 0, max: 1, label: 'Infante (menor de 2 años)' },
};

export function ageOn(birthDate: string, date: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

export const normalizeDocument = (documentNumber: string): string => documentNumber.replace(/[\s.-]/g, '').toUpperCase();

/** Cédula ecuatoriana: 10 dígitos, provincia 01–24 o 30, tercer dígito < 6 y verificador módulo 10. */
export function isValidEcuadorianId(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  const province = Number(value.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30) || Number(value[2]) >= 6) return false;
  const sum = value
    .slice(0, 9)
    .split('')
    .reduce((acc, digit, index) => {
      const product = Number(digit) * (index % 2 === 0 ? 2 : 1);
      return acc + (product > 9 ? product - 9 : product);
    }, 0);
  return (10 - (sum % 10)) % 10 === Number(value[9]);
}

/** Persona por documento: país + número normalizado (dos personas pueden llamarse igual: gemelos). */
export const identityKey = (passenger: Pick<PassengerItem, 'nationality' | 'documentNumber'>): string =>
  `${passenger.nationality.trim().toUpperCase()}:${normalizeDocument(passenger.documentNumber)}`;

export interface SegmentInfo {
  segmentId: string;
  departureAt: string;
  international: boolean;
}

/**
 * Pasajeros frente al hold (contrato: `POST /passengers/validate`): cantidad por tipo (PASSENGER_COUNT_MISMATCH), infante con
 * un adulto propio y sin asiento (INFANT_WITHOUT_ADULT, INFANT_SEAT_NOT_ALLOWED), documento válido, no repetido y vigente al
 * último vuelo (DOCUMENT_EXPIRED), pasaporte en vuelos internacionales (PASSPORT_REQUIRED_INTERNATIONAL) y edad acorde al tipo.
 */
export function assertPassengers(passengers: PassengerItem[], breakdown: PassengerCounts, segments: SegmentInfo[]): void {
  const ids = passengers.map((passenger) => passenger.passengerId);
  if (new Set(ids).size !== ids.length) throw problem(400, 'VALIDATION_FAILED', 'Los passengerId deben ser únicos.', 'passengers', 'passengerId repetido');
  const provided = countPassengers(passengers);
  if (provided.adults !== breakdown.adults || provided.youths !== breakdown.youths || provided.children !== breakdown.children || provided.infants !== breakdown.infants) {
    throw problem(422, 'PASSENGER_COUNT_MISMATCH', 'Los pasajeros no coinciden con los retenidos en el hold.', 'passengers',
      `se esperan adults=${breakdown.adults}, youths=${breakdown.youths}, children=${breakdown.children}, infants=${breakdown.infants}`);
  }
  const dates = segments.map((segment) => segment.departureAt.slice(0, 10)).sort();
  const first = dates[0];
  const last = dates.at(-1)!;
  const international = segments.some((segment) => segment.international);
  const adults = new Set(passengers.filter((p) => p.passengerType === 'ADULT').map((p) => p.passengerId));
  const adultsWithInfant = new Set<string>();
  const documents = new Map<string, number>();
  const segmentIds = new Set(segments.map((segment) => segment.segmentId));

  passengers.forEach((passenger, index) => {
    const path = `passengers[${index}]`;
    if (passenger.passengerType === 'INFANT') {
      if (!passenger.associatedAdultId || !adults.has(passenger.associatedAdultId) || adultsWithInfant.has(passenger.associatedAdultId)) {
        throw problem(422, 'INFANT_WITHOUT_ADULT', 'Infante sin adulto asociado.', `${path}.associatedAdultId`, 'debe ser un ADULT de la reserva, distinto para cada infante',
          `El pasajero ${passenger.passengerId} (INFANT) debe indicar associatedAdultId de un ADULT de la misma reserva.`);
      }
      adultsWithInfant.add(passenger.associatedAdultId);
      if (passenger.assignedSeats?.length) throw problem(422, 'INFANT_SEAT_NOT_ALLOWED', 'Los infantes viajan en el regazo de un adulto y no tienen asiento.', `${path}.assignedSeats`, 'no permitido para INFANT');
    } else if (passenger.associatedAdultId !== undefined) {
      throw problem(400, 'VALIDATION_FAILED', 'Solo los infantes pueden tener associatedAdultId.', `${path}.associatedAdultId`, 'solo para INFANT');
    }

    const document = normalizeDocument(passenger.documentNumber);
    if (!/^[A-Z0-9]{5,20}$/.test(document)) throw problem(400, 'VALIDATION_FAILED', 'El número de documento debe tener entre 5 y 20 letras o dígitos.', `${path}.documentNumber`, 'formato inválido');
    if (passenger.documentType === 'NATIONAL_ID' && passenger.nationality.trim().toUpperCase() === 'EC' && !isValidEcuadorianId(document)) {
      throw problem(400, 'VALIDATION_FAILED', 'La cédula ecuatoriana no es válida.', `${path}.documentNumber`, 'dígito verificador incorrecto');
    }
    const key = identityKey(passenger);
    if (documents.has(key)) throw problem(400, 'VALIDATION_FAILED', `El documento está repetido en los pasajeros ${documents.get(key)! + 1} y ${index + 1}.`, `${path}.documentNumber`, 'documento repetido');
    documents.set(key, index);
    if (international && passenger.documentType !== 'PASSPORT') {
      throw problem(422, 'PASSPORT_REQUIRED_INTERNATIONAL', 'En vuelos internacionales todos los pasajeros viajan con pasaporte.', `${path}.documentType`, 'PASSPORT');
    }
    if (international && !passenger.documentExpiryDate) {
      throw problem(400, 'VALIDATION_FAILED', 'El pasaporte debe indicar su fecha de vencimiento.', `${path}.documentExpiryDate`, 'obligatoria con pasaporte en vuelos internacionales');
    }
    if (passenger.documentExpiryDate && passenger.documentExpiryDate < last) {
      throw problem(422, 'DOCUMENT_EXPIRED', 'El documento vence antes del último vuelo.', `${path}.documentExpiryDate`, `debe ser ${last} o posterior`);
    }
    if (passenger.birthDate > first) throw problem(400, 'VALIDATION_FAILED', 'La fecha de nacimiento no puede ser posterior al viaje.', `${path}.birthDate`, 'posterior al viaje');
    const range = AGE_RANGES[passenger.passengerType];
    const age = ageOn(passenger.birthDate, first);
    const ageAtEnd = ageOn(passenger.birthDate, last);
    if (age < range.min || (range.max !== undefined && (passenger.passengerType === 'INFANT' ? ageAtEnd : age) > range.max)) {
      throw problem(400, 'VALIDATION_FAILED', `La edad del pasajero ${index + 1} (${age} años el día del vuelo) no corresponde a ${range.label}.`, `${path}.birthDate`, `edad ${age} no válida para ${passenger.passengerType}`);
    }
    const seatSegments = (passenger.assignedSeats ?? []).map((seat) => seat.segmentId);
    if (seatSegments.some((segmentId) => !segmentIds.has(segmentId)) || new Set(seatSegments).size !== seatSegments.length) {
      throw problem(400, 'VALIDATION_FAILED', 'Cada asiento debe ser de un segmento de la reserva, uno por segmento.', `${path}.assignedSeats`, 'segmento desconocido o repetido');
    }
    const bags = new Map<string, number>();
    for (const bag of passenger.extraBaggage ?? []) bags.set(bag.itineraryId, (bags.get(bag.itineraryId) ?? 0) + bag.quantity);
    if ([...bags.values()].some((total) => total < 1 || total > MAX_EXTRA_BAGS)) {
      throw problem(400, 'VALIDATION_FAILED', `Entre 1 y ${MAX_EXTRA_BAGS} maletas extra por pasajero e itinerario.`, `${path}.extraBaggage`, `máximo ${MAX_EXTRA_BAGS}`);
    }
  });
}

// ------------------------------------------------------------------------------------------------ PNR y boletos

const PNR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Prefijo ficticio de los e-tickets, como el código de aerolínea. */
const TICKET_PREFIX = '999';

/** Localizador de 6 caracteres sin ambiguos (0/O, 1/I). */
export const generatePnr = (): string => Array.from({ length: 6 }, () => PNR_ALPHABET[randomInt(PNR_ALPHABET.length)]).join('');
const eTicketNumber = () => `${TICKET_PREFIX}${String(randomInt(10_000_000_000)).padStart(10, '0')}`;

export const segmentsOf = (booking: Pick<BookingRecord, 'itineraries'>) => booking.itineraries.flatMap((itinerary) => itinerary.segments);
export const fullName = (passenger: Pick<PassengerItem, 'firstName' | 'lastName'>) => `${passenger.firstName} ${passenger.lastName}`;

function coupons(booking: Pick<BookingRecord, 'itineraries'>, passenger: PassengerItem, issued: boolean): Ticket['segments'] {
  return segmentsOf(booking).map((segment, index) => ({
    segmentId: segment.segmentId,
    status: issued ? 'ISSUED' : 'PENDING',
    couponNumber: issued ? String(index + 1) : null,
    flightNumber: segment.flightNumber,
    departureIataCode: segment.departure.iataCode,
    arrivalIataCode: segment.arrival.iataCode,
    departureAt: segment.departure.at,
    arrivalAt: segment.arrival.at,
    seatNumber: passenger.assignedSeats?.find((seat) => seat.segmentId === segment.segmentId)?.seatNumber ?? null,
  }));
}

/** Un boleto por pasajero (incluidos infantes) con un cupón por segmento; al crear la reserva, pendientes de emisión. */
export function pendingTickets(booking: Pick<BookingRecord, 'bookingId' | 'itineraries' | 'passengers'>): Ticket[] {
  return booking.passengers.map((passenger, index) => ({
    ticketId: `TKT-${booking.bookingId.slice(0, 8).toUpperCase()}-${index + 1}`,
    bookingId: booking.bookingId,
    passengerId: passenger.passengerId,
    passengerName: fullName(passenger),
    eTicketNumber: null,
    status: 'PENDING',
    issuedAt: null,
    segments: coupons(booking, passenger, false),
    failureReason: null,
  }));
}

/** Emite los boletos pendientes (número de e-ticket y cupones); los ya emitidos no cambian. */
export function issueTickets(booking: BookingRecord, now: string): { tickets: Ticket[]; issued: number } {
  let issued = 0;
  const tickets = booking.tickets.map((ticket) => {
    if (ticket.status !== 'PENDING' && ticket.status !== 'ISSUING') return ticket;
    issued++;
    const passenger = booking.passengers.find((candidate) => candidate.passengerId === ticket.passengerId)!;
    return { ...ticket, eTicketNumber: eTicketNumber(), status: 'ISSUED' as const, issuedAt: now, segments: coupons(booking, passenger, true) };
  });
  return { tickets, issued };
}

/** Reemite los cupones tras un cambio de itinerario o de asiento (el número de e-ticket se conserva). */
export function reissueCoupons(booking: BookingRecord, now: string): Ticket[] {
  return booking.tickets.map((ticket) => {
    if (ticket.status !== 'ISSUED') return ticket;
    const passenger = booking.passengers.find((candidate) => candidate.passengerId === ticket.passengerId)!;
    return { ...ticket, issuedAt: now, segments: coupons(booking, passenger, true) };
  });
}

/** Itinerarios que todavía no salieron (los que se pueden cambiar, cancelar o con maletas nuevas). */
export const unflown = (booking: Pick<BookingRecord, 'itineraries'>, now: number): ItineraryOption[] =>
  booking.itineraries.filter((itinerary) => Date.parse(itinerary.segments[0].departure.at) > now);

export function fareOfSegment(booking: Pick<BookingRecord, 'fares'>, segmentId: string): PurchasedFare | undefined {
  return booking.fares.find((fare) => fare.segmentIds.includes(segmentId));
}
