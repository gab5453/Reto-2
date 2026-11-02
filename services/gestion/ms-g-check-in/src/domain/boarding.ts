/**
 * Pase de abordar (MS.G.CheckIn): grupo, posición y código de barras. El código sigue el formato IATA BCBP (Resolución 792,
 * campos obligatorios de un tramo, "M1"), el que leen los escáneres de los aeropuertos en un PDF417:
 *
 *   M1 | NOMBRE (20) | E | PNR (7) | ORIGEN (3) | DESTINO (3) | AEROLÍNEA (3) | VUELO (5) | DÍA JULIANO (3) | CABINA (1)
 *      | ASIENTO (4) | SECUENCIA (5) | ESTADO (1) | TAMAÑO DE CAMPOS OPCIONALES (2, "00")
 *
 * p. ej. `M1TORRES/MARIA        EXK7P2Q UIOGYEEA 0100 299Y012A0001 100` (60 caracteres).
 */
export interface CheckInRecord {
  bookingId: string;
  segmentId: string;
  passengerId: string;
  sagaId: string;
  pnr: string;
  passengerType: 'ADULT' | 'YOUTH' | 'CHILD' | 'INFANT';
  firstName: string;
  lastName: string;
  eTicketNumber: string | null;
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  cabinClass: string;
  seat: string | null;
  gate: string | null;
  needsAssistance: boolean;
  boardingGroup: string;
  boardingPosition: number;
  checkedInAt: string;
}

export interface AssistanceReadyRecord {
  bookingId: string;
  segmentId: string;
  passengerId: string;
  ready: boolean;
  updatedBy: string;
  updatedAt: string;
}

/**
 * Grupo de abordaje: A = Business y pasajeros con asistencia (preembarque); en Economy, de atrás hacia adelante: B = filas 20 en
 * adelante, C = el resto. Un infante aborda con su adulto (B por defecto).
 */
export function boardingGroup(input: { cabinClass?: string; seat: string | null; needsAssistance: boolean }): string {
  if (input.needsAssistance || input.cabinClass === 'BUSINESS' || input.cabinClass === 'FIRST') return 'A';
  const row = input.seat ? Number(/^(\d+)/.exec(input.seat)?.[1]) : NaN;
  return Number.isFinite(row) && row < 20 ? 'C' : 'B';
}

const ascii = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z ]/g, '');

/** Día del año (001–366) de la fecha local de salida. */
export function julianDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const ordinal = (Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000 + 1;
  return String(ordinal).padStart(3, '0');
}

/** Código de barras BCBP de un pase (tramo único). */
export function bcbp(record: Pick<CheckInRecord, 'firstName' | 'lastName' | 'pnr' | 'origin' | 'destination' | 'flightNumber' | 'departureAt' | 'cabinClass' | 'seat' | 'boardingPosition'>): string {
  const name = `${ascii(record.lastName).replace(/ /g, '')}/${ascii(record.firstName).replace(/ /g, '')}`.slice(0, 20).padEnd(20, ' ');
  const carrier = record.flightNumber.slice(0, 2).padEnd(3, ' ');
  const flight = record.flightNumber.slice(2).padStart(4, '0').padEnd(5, ' ');
  const compartment = record.cabinClass === 'BUSINESS' ? 'J' : record.cabinClass === 'FIRST' ? 'F' : 'Y';
  const seatMatch = record.seat ? /^(\d+)([A-Z])$/.exec(record.seat) : null;
  const seat = seatMatch ? `${seatMatch[1]!.padStart(3, '0')}${seatMatch[2]}` : 'INF ';
  const sequence = String(record.boardingPosition).padStart(4, '0').padEnd(5, ' ');
  return `M1${name}E${record.pnr.padEnd(7, ' ')}${record.origin}${record.destination}${carrier}${flight}${julianDay(record.departureAt.slice(0, 10))}${compartment}${seat}${sequence}100`;
}
