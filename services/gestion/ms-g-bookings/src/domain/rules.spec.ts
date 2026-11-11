import type { PassengerCounts, ProblemDetailsException } from '@ecoairlines/shared';
import type { BookingRecord, PassengerItem, Ticket } from './model.js';
import { channelOf, partnerOf } from './model.js';
import {
  AGE_RANGES,
  ageOn,
  assertPassengers,
  fareOfSegment,
  fullName,
  generatePnr,
  identityKey,
  isValidEcuadorianId,
  issueTickets,
  MAX_EXTRA_BAGS,
  normalizeDocument,
  pendingTickets,
  reissueCoupons,
  segmentsOf,
  unflown,
  type SegmentInfo,
} from './rules.js';

/** PU-1 (Informacion_General/Pruebas.md §5.1.1): reglas puras de MS.G.Bookings, sin NestJS ni base de datos. */

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
};

const VUELO = '2026-12-10';
const NACIONAL: SegmentInfo[] = [{ segmentId: 'S1', departureAt: `${VUELO}T08:00:00-05:00`, international: false }];
const INTERNACIONAL: SegmentInfo[] = [{ segmentId: 'S1', departureAt: `${VUELO}T08:00:00-05:00`, international: true }];

const adulto = (over: Partial<PassengerItem> = {}): PassengerItem => ({
  passengerId: 'P1',
  passengerType: 'ADULT',
  firstName: 'Ana',
  lastName: 'Pérez',
  documentType: 'NATIONAL_ID',
  documentNumber: '1710034065',
  nationality: 'EC',
  birthDate: '1990-05-01',
  gender: 'F',
  contact: { email: 'ana@example.com', phone: '+593999999999' },
  ...over,
});
const counts = (over: Partial<PassengerCounts> = {}): PassengerCounts => ({ adults: 1, youths: 0, children: 0, infants: 0, ...over });

describe('ageOn: edad cumplida en una fecha', () => {
  it('cuenta los años completos', () => expect(ageOn('1990-05-01', '2026-12-10')).toBe(36));
  it('el día del cumpleaños ya los cumplió', () => expect(ageOn('2014-12-10', '2026-12-10')).toBe(12));
  it('un día antes del cumpleaños todavía no', () => expect(ageOn('2014-12-11', '2026-12-10')).toBe(11));
  it('un mes antes del cumpleaños todavía no', () => expect(ageOn('2014-12-01', '2026-11-30')).toBe(11));
  it('nacido el 29 de febrero: el 28 de febrero de un año no bisiesto aún no cumple', () => expect(ageOn('2024-02-29', '2027-02-28')).toBe(2));
});

describe('normalizeDocument e identityKey', () => {
  it('quita espacios, puntos y guiones y pasa a mayúsculas', () => expect(normalizeDocument(' ab-12.34 5 ')).toBe('AB12345'));
  it('identityKey une país y documento normalizados', () => expect(identityKey({ nationality: ' ec ', documentNumber: '171-003.4065' })).toBe('EC:1710034065'));
  it('el mismo número en otro país es otra persona', () =>
    expect(identityKey({ nationality: 'EC', documentNumber: 'X1234567' })).not.toBe(identityKey({ nationality: 'PE', documentNumber: 'X1234567' })));
});

describe('isValidEcuadorianId: cédula ecuatoriana', () => {
  it.each(['1710034065', '0912345675', '3000000004', '2400000010'])('%s es válida', (id) => expect(isValidEcuadorianId(id)).toBe(true));
  it('dígito verificador incorrecto', () => expect(isValidEcuadorianId('1710034066')).toBe(false));
  it('provincia 00 no existe', () => expect(isValidEcuadorianId('0010034065')).toBe(false));
  it('provincia 25 no existe (solo 01–24 y 30)', () => expect(isValidEcuadorianId('2510034065')).toBe(false));
  it('tercer dígito 6 o más no es de persona natural', () => expect(isValidEcuadorianId('1760034065')).toBe(false));
  it('menos de 10 dígitos', () => expect(isValidEcuadorianId('171003406')).toBe(false));
  it('con letras', () => expect(isValidEcuadorianId('17100340A5')).toBe(false));
});

describe('assertPassengers: pasajeros frente al hold', () => {
  it('un adulto válido en un vuelo nacional pasa', () => expect(codeOf(() => assertPassengers([adulto()], counts(), NACIONAL))).toBeUndefined());

  it('passengerId repetido', () =>
    expect(codeOf(() => assertPassengers([adulto(), adulto({ documentNumber: '0912345675' })], counts({ adults: 2 }), NACIONAL))).toBe('VALIDATION_FAILED'));

  it('cantidad distinta a la del hold → PASSENGER_COUNT_MISMATCH', () =>
    expect(codeOf(() => assertPassengers([adulto()], counts({ adults: 2 }), NACIONAL))).toBe('PASSENGER_COUNT_MISMATCH'));

  it('tipo distinto al del hold (niño donde se retuvo un adulto) → PASSENGER_COUNT_MISMATCH', () =>
    expect(codeOf(() => assertPassengers([adulto({ passengerType: 'CHILD', birthDate: '2018-01-01' })], counts(), NACIONAL))).toBe('PASSENGER_COUNT_MISMATCH'));

  describe('infantes', () => {
    const infante = (over: Partial<PassengerItem> = {}) =>
      adulto({ passengerId: 'I1', passengerType: 'INFANT', birthDate: '2026-01-15', documentNumber: '0912345675', associatedAdultId: 'P1', ...over });

    it('un infante con su adulto pasa', () => expect(codeOf(() => assertPassengers([adulto(), infante()], counts({ infants: 1 }), NACIONAL))).toBeUndefined());
    it('sin associatedAdultId → INFANT_WITHOUT_ADULT', () =>
      expect(codeOf(() => assertPassengers([adulto(), infante({ associatedAdultId: undefined })], counts({ infants: 1 }), NACIONAL))).toBe('INFANT_WITHOUT_ADULT'));
    it('con un adulto que no está en la reserva → INFANT_WITHOUT_ADULT', () =>
      expect(codeOf(() => assertPassengers([adulto(), infante({ associatedAdultId: 'NADIE' })], counts({ infants: 1 }), NACIONAL))).toBe('INFANT_WITHOUT_ADULT'));
    it('dos infantes con el mismo adulto → INFANT_WITHOUT_ADULT', () =>
      expect(
        codeOf(() => assertPassengers([adulto(), infante(), infante({ passengerId: 'I2', documentNumber: '3000000004' })], counts({ infants: 2 }), NACIONAL)),
      ).toBe('INFANT_WITHOUT_ADULT'));
    it('un infante con asiento → INFANT_SEAT_NOT_ALLOWED', () =>
      expect(codeOf(() => assertPassengers([adulto(), infante({ assignedSeats: [{ segmentId: 'S1', seatNumber: '12A' }] })], counts({ infants: 1 }), NACIONAL))).toBe(
        'INFANT_SEAT_NOT_ALLOWED',
      ));
    it('un adulto no puede tener associatedAdultId', () =>
      expect(codeOf(() => assertPassengers([adulto({ associatedAdultId: 'P9' })], counts(), NACIONAL))).toBe('VALIDATION_FAILED'));
    it('un infante que cumple 2 años antes del último vuelo ya no es infante', () => {
      const idaYVuelta: SegmentInfo[] = [...NACIONAL, { segmentId: 'S2', departureAt: '2026-12-20T08:00:00-05:00', international: false }];
      expect(codeOf(() => assertPassengers([adulto(), infante({ birthDate: '2024-12-15' })], counts({ infants: 1 }), idaYVuelta))).toBe('VALIDATION_FAILED');
    });
  });

  describe('documentos', () => {
    it('documento demasiado corto', () => expect(codeOf(() => assertPassengers([adulto({ documentType: 'PASSPORT', documentNumber: 'A12' })], counts(), NACIONAL))).toBe('VALIDATION_FAILED'));
    it('cédula ecuatoriana con verificador incorrecto', () => expect(codeOf(() => assertPassengers([adulto({ documentNumber: '1710034066' })], counts(), NACIONAL))).toBe('VALIDATION_FAILED'));
    it('una cédula de otro país no se valida con la regla ecuatoriana', () =>
      expect(codeOf(() => assertPassengers([adulto({ nationality: 'PE', documentNumber: '12345678' })], counts(), NACIONAL))).toBeUndefined());
    it('el mismo documento en dos pasajeros (aunque se escriba distinto)', () =>
      expect(codeOf(() => assertPassengers([adulto(), adulto({ passengerId: 'P2', documentNumber: '171-003-4065' })], counts({ adults: 2 }), NACIONAL))).toBe(
        'VALIDATION_FAILED',
      ));
    it('vuelo internacional con cédula → PASSPORT_REQUIRED_INTERNATIONAL', () =>
      expect(codeOf(() => assertPassengers([adulto({ documentExpiryDate: '2030-01-01' })], counts(), INTERNACIONAL))).toBe('PASSPORT_REQUIRED_INTERNATIONAL'));
    it('vuelo internacional con pasaporte sin vencimiento', () =>
      expect(codeOf(() => assertPassengers([adulto({ documentType: 'PASSPORT', documentNumber: 'AB123456' })], counts(), INTERNACIONAL))).toBe('VALIDATION_FAILED'));
    it('vuelo internacional con pasaporte vigente pasa', () =>
      expect(codeOf(() => assertPassengers([adulto({ documentType: 'PASSPORT', documentNumber: 'AB123456', documentExpiryDate: '2030-01-01' })], counts(), INTERNACIONAL))).toBeUndefined());
    it('documento que vence antes del vuelo → DOCUMENT_EXPIRED', () =>
      expect(codeOf(() => assertPassengers([adulto({ documentExpiryDate: '2026-12-09' })], counts(), NACIONAL))).toBe('DOCUMENT_EXPIRED'));
    it('documento que vence el mismo día del vuelo es válido', () =>
      expect(codeOf(() => assertPassengers([adulto({ documentExpiryDate: VUELO })], counts(), NACIONAL))).toBeUndefined());
  });

  describe('edades', () => {
    it('nacimiento posterior al viaje', () => expect(codeOf(() => assertPassengers([adulto({ birthDate: '2027-01-01' })], counts(), NACIONAL))).toBe('VALIDATION_FAILED'));
    it('un adulto de 14 años no es adulto', () => expect(codeOf(() => assertPassengers([adulto({ birthDate: '2012-06-01' })], counts(), NACIONAL))).toBe('VALIDATION_FAILED'));
    it('un adulto que cumple 15 el día del vuelo sí es adulto', () => expect(codeOf(() => assertPassengers([adulto({ birthDate: '2011-12-10' })], counts(), NACIONAL))).toBeUndefined());
    it('un joven de 12 a 14 pasa', () =>
      expect(codeOf(() => assertPassengers([adulto({ passengerType: 'YOUTH', birthDate: '2013-01-01' })], counts({ adults: 0, youths: 1 }), NACIONAL))).toBeUndefined());
    it('un niño de 12 ya no es niño', () =>
      expect(codeOf(() => assertPassengers([adulto({ passengerType: 'CHILD', birthDate: '2014-01-01' })], counts({ adults: 0, children: 1 }), NACIONAL))).toBe('VALIDATION_FAILED'));
    it('los rangos no se superponen y cubren de 0 en adelante', () => {
      expect([AGE_RANGES.INFANT.max, AGE_RANGES.CHILD.min]).toEqual([1, 2]);
      expect([AGE_RANGES.CHILD.max, AGE_RANGES.YOUTH.min]).toEqual([11, 12]);
      expect([AGE_RANGES.YOUTH.max, AGE_RANGES.ADULT.min]).toEqual([14, 15]);
    });
  });

  describe('asientos y maletas', () => {
    it('asiento de un segmento que no es de la reserva', () =>
      expect(codeOf(() => assertPassengers([adulto({ assignedSeats: [{ segmentId: 'OTRO', seatNumber: '1A' }] })], counts(), NACIONAL))).toBe('VALIDATION_FAILED'));
    it('dos asientos en el mismo segmento', () =>
      expect(
        codeOf(() => assertPassengers([adulto({ assignedSeats: [{ segmentId: 'S1', seatNumber: '1A' }, { segmentId: 'S1', seatNumber: '1B' }] })], counts(), NACIONAL)),
      ).toBe('VALIDATION_FAILED'));
    it(`hasta ${MAX_EXTRA_BAGS} maletas extra por itinerario pasan`, () =>
      expect(codeOf(() => assertPassengers([adulto({ extraBaggage: [{ itineraryId: 'IT1', quantity: 2 }, { itineraryId: 'IT1', quantity: 1 }] })], counts(), NACIONAL))).toBeUndefined());
    it(`más de ${MAX_EXTRA_BAGS} maletas en un itinerario (sumando las líneas)`, () =>
      expect(codeOf(() => assertPassengers([adulto({ extraBaggage: [{ itineraryId: 'IT1', quantity: 2 }, { itineraryId: 'IT1', quantity: 2 }] })], counts(), NACIONAL))).toBe(
        'VALIDATION_FAILED',
      ));
    it('cero maletas no es una línea válida', () =>
      expect(codeOf(() => assertPassengers([adulto({ extraBaggage: [{ itineraryId: 'IT1', quantity: 0 }] })], counts(), NACIONAL))).toBe('VALIDATION_FAILED'));
  });
});

describe('generatePnr', () => {
  it('6 caracteres sin letras ni dígitos ambiguos (0, O, 1, I)', () => {
    for (let i = 0; i < 200; i++) expect(generatePnr()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });
  it('no se repite en 1 000 intentos', () => expect(new Set(Array.from({ length: 1000 }, generatePnr)).size).toBe(1000));
});

// ------------------------------------------------------------------------------------------------ boletos
const segmento = (segmentId: string, flightNumber: string, at: string) => ({
  segmentId,
  flightNumber,
  departure: { iataCode: 'UIO', at },
  arrival: { iataCode: 'GYE', at },
});
const reserva = (over: Partial<BookingRecord> = {}): BookingRecord =>
  ({
    bookingId: 'abcdef12-3456-7890-abcd-ef1234567890',
    itineraries: [
      { itineraryId: 'IT1', segments: [segmento('S1', 'EA100', '2026-12-10T13:00:00Z'), segmento('S2', 'EA101', '2026-12-10T16:00:00Z')] },
      { itineraryId: 'IT2', segments: [segmento('S3', 'EA200', '2026-12-20T13:00:00Z')] },
    ],
    passengers: [adulto({ assignedSeats: [{ segmentId: 'S1', seatNumber: '3C' }] }), adulto({ passengerId: 'P2', firstName: 'Luis' })],
    fares: [
      { itineraryId: 'IT1', cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', segmentIds: ['S1', 'S2'], price: { amount: '50.00', currency: 'USD' }, isRefundable: false, isChangeable: false },
      { itineraryId: 'IT2', cabinClass: 'BUSINESS', fareBrand: 'DOSEL', segmentIds: ['S3'], price: { amount: '90.00', currency: 'USD' }, isRefundable: true, isChangeable: true },
    ],
    tickets: [],
    ...over,
  }) as BookingRecord;

describe('boletos: pendingTickets, issueTickets y reissueCoupons', () => {
  it('un boleto PENDIENTE por pasajero con un cupón por segmento', () => {
    const tickets = pendingTickets(reserva());
    expect(tickets).toHaveLength(2);
    expect(tickets[0]).toMatchObject({ ticketId: 'TKT-ABCDEF12-1', passengerName: 'Ana Pérez', status: 'PENDING', eTicketNumber: null, issuedAt: null });
    expect(tickets[0]!.segments.map((s) => [s.segmentId, s.status, s.couponNumber])).toEqual([
      ['S1', 'PENDING', null],
      ['S2', 'PENDING', null],
      ['S3', 'PENDING', null],
    ]);
  });

  it('el cupón lleva el asiento asignado de ese segmento y null en los demás', () => {
    const [ana] = pendingTickets(reserva());
    expect(ana!.segments.map((s) => s.seatNumber)).toEqual(['3C', null, null]);
  });

  it('emitir: número de e-ticket con prefijo 999 y 13 dígitos, cupones numerados', () => {
    const booking = reserva();
    const { tickets, issued } = issueTickets({ ...booking, tickets: pendingTickets(booking) }, '2026-11-11T10:00:00Z');
    expect(issued).toBe(2);
    for (const ticket of tickets) {
      expect(ticket.eTicketNumber).toMatch(/^999\d{10}$/);
      expect(ticket).toMatchObject({ status: 'ISSUED', issuedAt: '2026-11-11T10:00:00Z' });
      expect(ticket.segments.map((s) => s.couponNumber)).toEqual(['1', '2', '3']);
    }
  });

  it('emitir no toca los boletos ya emitidos ni los anulados', () => {
    const booking = reserva();
    const [a, b] = pendingTickets(booking);
    const yaEmitido: Ticket = { ...a!, status: 'ISSUED', eTicketNumber: '9990000000001', issuedAt: 'antes' };
    const anulado: Ticket = { ...b!, status: 'VOIDED' };
    const { tickets, issued } = issueTickets({ ...booking, tickets: [yaEmitido, anulado] }, 'ahora');
    expect(issued).toBe(0);
    expect(tickets).toEqual([yaEmitido, anulado]);
  });

  it('un boleto en ISSUING (emisión interrumpida) se emite', () => {
    const booking = reserva();
    const [a] = pendingTickets(booking);
    const { issued } = issueTickets({ ...booking, tickets: [{ ...a!, status: 'ISSUING' }] }, 'ahora');
    expect(issued).toBe(1);
  });

  it('reemitir conserva el número de e-ticket y actualiza los cupones con el asiento nuevo', () => {
    const booking = reserva();
    const emitidos = issueTickets({ ...booking, tickets: pendingTickets(booking) }, 'antes').tickets;
    const cambiada = reserva({
      tickets: emitidos,
      passengers: [adulto({ assignedSeats: [{ segmentId: 'S1', seatNumber: '7F' }] }), adulto({ passengerId: 'P2', firstName: 'Luis' })],
    });
    const reemitidos = reissueCoupons(cambiada, 'después');
    expect(reemitidos[0]!.eTicketNumber).toBe(emitidos[0]!.eTicketNumber);
    expect(reemitidos[0]!.issuedAt).toBe('después');
    expect(reemitidos[0]!.segments[0]!.seatNumber).toBe('7F');
  });

  it('reemitir no toca los boletos que no están emitidos', () => {
    const booking = reserva();
    const pendientes = pendingTickets(booking);
    expect(reissueCoupons({ ...booking, tickets: pendientes }, 'ahora')).toEqual(pendientes);
  });
});

describe('ayudas de la reserva', () => {
  it('segmentsOf aplana los segmentos de todos los itinerarios en orden', () => expect(segmentsOf(reserva()).map((s) => s.segmentId)).toEqual(['S1', 'S2', 'S3']));
  it('fullName une nombre y apellido', () => expect(fullName({ firstName: 'Ana', lastName: 'Pérez' })).toBe('Ana Pérez'));
  it('unflown devuelve solo los itinerarios cuyo primer vuelo no salió', () =>
    expect(unflown(reserva(), Date.parse('2026-12-15T00:00:00Z')).map((i) => i.itineraryId)).toEqual(['IT2']));
  it('unflown: un itinerario que sale exactamente ahora ya no se puede cambiar', () =>
    expect(unflown(reserva(), Date.parse('2026-12-10T13:00:00Z')).map((i) => i.itineraryId)).toEqual(['IT2']));
  it('fareOfSegment encuentra la tarifa que cubre el segmento', () => expect(fareOfSegment(reserva(), 'S2')?.fareBrand).toBe('SEMILLA'));
  it('fareOfSegment sin tarifa para el segmento', () => expect(fareOfSegment(reserva(), 'S9')).toBeUndefined());
});

describe('canal de venta (model.ts)', () => {
  it('un dueño partner:<id>:<usuario> es del canal BOOKING y su partner es el id', () => {
    expect(channelOf('partner:BOOKING_PROTOTIPO:u-1')).toBe('BOOKING');
    expect(partnerOf('partner:BOOKING_PROTOTIPO:u-1')).toBe('BOOKING_PROTOTIPO');
  });
  it('un usuario de la web es del canal WEB y no tiene partner', () => {
    expect(channelOf('3f1c0d2e-uuid')).toBe('WEB');
    expect(partnerOf('3f1c0d2e-uuid')).toBeNull();
  });
});
