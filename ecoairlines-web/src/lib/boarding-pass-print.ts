import type { AdminBooking } from '../api/admin';
import type { BoardingPass } from '../api/types';
import { cityOf } from '../data/airports';

/**
 * Contenido del pase de abordar impreso en mostrador (D57, `PLAN/Check_in_Mostrador.md`). Solo arma los datos (se prueba sin
 * dibujar): el PDF lo dibuja `boarding-pass-pdf.ts`.
 *
 * NUNCA lleva el tipo de asistencia médica (dato de salud), el documento, el contacto ni datos de pago.
 */
export interface PrintablePass {
  bookingId: string;
  pnr: string;
  /** `APELLIDOS / NOMBRES`, en mayúsculas, como en un pase de aerolínea. */
  passengerName: string;
  flightNumber: string;
  /** `14 NOV`. */
  date: string;
  origin: string;
  originCity: string;
  destination: string;
  destinationCity: string;
  /** Horas locales del aeropuerto (`HH:MM`). Con un retraso vigente, la salida es la ESTIMADA. */
  departureTime: string;
  arrivalTime: string;
  boardingTime: string;
  doorsCloseTime: string;
  delayed: boolean;
  group: string;
  seat: string;
  position: string;
  gate: string | null;
  cabin: string;
  fareBrand: string;
  eTicket: string | null;
  carryOn: string;
  checkedBags: string;
  barcode: string;
}

/** CM-3 (13/11): valores habituales en vuelos nacionales. El sistema no guarda estas horas: se calculan desde la salida. */
export const BOARDING_MINUTES_BEFORE = 40;
export const DOORS_CLOSE_MINUTES_BEFORE = 15;

const CABINS: Record<string, string> = { ECONOMY: 'Economy', PREMIUM_ECONOMY: 'Premium Economy', BUSINESS: 'Business', FIRST: 'First' };
const MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

/** Equipaje que incluye cada paquete si la reserva no trae su franquicia (`baggageAllowance`). */
const BRAND_BAGGAGE: Record<string, { carryOn: number; checked: number }> = {
  SEMILLA: { carryOn: 0, checked: 0 },
  BROTE: { carryOn: 1, checked: 1 },
  BOSQUE: { carryOn: 1, checked: 2 },
  DOSEL: { carryOn: 1, checked: 2 },
};

/** `HH:MM` de un ISO con su desfase (`2026-11-14T13:00:00-05:00` → `13:00`): la hora local del aeropuerto. */
const hhmm = (iso: string) => iso.slice(11, 16);

/** Resta minutos a una hora `HH:MM` (dando la vuelta a medianoche). */
export function minutesBefore(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const total = (((h * 60 + m - minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** `14 NOV` desde la fecha local del ISO. */
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

const titleCase = (text: string) => text.charAt(0) + text.slice(1).toLowerCase();

/**
 * Un pase por cada pase de abordar del servidor (pasajero y tramo), con los datos de la reserva. No se imprime el de un tramo que
 * ya salió (p. ej. la ida de un ida y vuelta, cuando se imprime la vuelta).
 * @param estimatedDepartures salida ESTIMADA por `segmentId` de los vuelos retrasados (de FlightStatus); sin ella, la programada.
 * @param now el momento de la impresión (las pruebas lo fijan).
 */
export function printablePasses(
  booking: AdminBooking,
  passes: BoardingPass[],
  estimatedDepartures: Record<string, string> = {},
  now: Date = new Date(),
): PrintablePass[] {
  return passes.flatMap((pass) => {
    const itinerary = booking.itineraries.find((it) => it.segments.some((s) => s.segmentId === pass.segmentId));
    const segment = itinerary?.segments.find((s) => s.segmentId === pass.segmentId);
    const passenger = booking.passengers.find((p) => p.passengerId === pass.passengerId);
    if (!itinerary || !segment || !passenger) return [];
    const fare = booking.fares.find((f) => f.segmentIds.includes(pass.segmentId)) ?? booking.fares.find((f) => f.itineraryId === itinerary.itineraryId);
    const allowance =
      itinerary.pricingOptions?.find((o) => o.cabinClass === fare?.cabinClass && o.fareBrand === fare?.fareBrand)?.baggageAllowance ?? null;
    const included = {
      carryOn: allowance?.carryOnIncluded ?? BRAND_BAGGAGE[fare?.fareBrand ?? '']?.carryOn ?? 0,
      checked: allowance?.checkedBaggageIncluded ?? BRAND_BAGGAGE[fare?.fareBrand ?? '']?.checked ?? 0,
    };
    const extra = passenger.extraBaggage?.find((b) => b.itineraryId === itinerary.itineraryId)?.quantity ?? 0;
    const checked = included.checked + extra;
    const estimated = estimatedDepartures[pass.segmentId];
    if (Date.parse(estimated ?? segment.departure.at) <= now.getTime()) return [];
    const departure = hhmm(estimated ?? segment.departure.at);
    const ticket = booking.tickets.find((t) => t.passengerId === pass.passengerId && t.status !== 'VOIDED') ?? booking.tickets.find((t) => t.passengerId === pass.passengerId);
    return [
      {
        bookingId: booking.bookingId,
        pnr: booking.pnr,
        passengerName: `${passenger.lastName} / ${passenger.firstName}`.toUpperCase(),
        flightNumber: segment.flightNumber,
        date: shortDate(estimated ?? segment.departure.at),
        origin: segment.departure.iataCode,
        originCity: cityOf(segment.departure.iataCode),
        destination: segment.arrival.iataCode,
        destinationCity: cityOf(segment.arrival.iataCode),
        departureTime: departure,
        arrivalTime: hhmm(segment.arrival.at),
        boardingTime: minutesBefore(departure, BOARDING_MINUTES_BEFORE),
        doorsCloseTime: minutesBefore(departure, DOORS_CLOSE_MINUTES_BEFORE),
        delayed: Boolean(estimated),
        group: pass.boardingGroup ?? '—',
        seat: pass.seat || (passenger.passengerType === 'INFANT' ? 'En brazos' : '—'),
        position: pass.boardingPosition ?? '—',
        gate: pass.gate ?? null,
        cabin: CABINS[fare?.cabinClass ?? 'ECONOMY'] ?? 'Economy',
        fareBrand: fare ? titleCase(fare.fareBrand) : '',
        eTicket: ticket?.eTicketNumber ?? null,
        carryOn: included.carryOn > 0 ? 'Sí' : 'Solo artículo personal',
        checkedBags: checked > 0 ? `${checked} maleta${checked === 1 ? '' : 's'}${extra > 0 ? ` (${extra} extra)` : ''}` : '—',
        barcode: pass.barcode,
      },
    ];
  });
}
