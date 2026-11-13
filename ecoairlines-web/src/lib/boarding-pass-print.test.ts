import { describe, expect, it } from 'vitest';
import type { AdminBooking } from '../api/admin';
import type { BoardingPass } from '../api/types';
import { boardingPassesPdf, nameLayout, NAME_WIDTH } from './boarding-pass-pdf';
import { minutesBefore, printablePasses } from './boarding-pass-print';

/**
 * D57 (PLAN/Check_in_Mostrador.md, M-2): el contenido del pase que el administrador imprime en mostrador. Se prueba el armado de
 * los datos (horas de embarque y cierre, equipaje, mayúsculas, sin datos sensibles) y que el PDF sea un PDF con esos datos.
 */

const segment = (segmentId: string, flightNumber: string, from: string, to: string, departure: string, arrival: string) => ({
  segmentId,
  flightNumber,
  departure: { iataCode: from, at: departure },
  arrival: { iataCode: to, at: arrival },
  marketingCarrier: 'EA',
  operatingCarrier: 'EA',
});

const booking = {
  bookingId: 'b-1',
  pnr: 'ECO7QK',
  status: 'CONFIRMED',
  itineraries: [
    {
      itineraryId: 'IT-1',
      totalDurationMinutes: 90,
      stopsCount: 0,
      segments: [segment('SEG-1', 'EA100', 'UIO', 'BOG', '2026-11-14T13:00:00-05:00', '2026-11-14T14:30:00-05:00')],
      pricingOptions: [{ cabinClass: 'ECONOMY', fareBrand: 'BOSQUE', availableSeats: 9, baggageAllowance: { personalItemIncluded: true, carryOnIncluded: 1, checkedBaggageIncluded: 2 } }],
    },
    {
      itineraryId: 'IT-2',
      totalDurationMinutes: 90,
      stopsCount: 0,
      segments: [segment('SEG-2', 'EA101', 'BOG', 'UIO', '2026-11-20T00:10:00-05:00', '2026-11-20T01:40:00-05:00')],
      pricingOptions: [],
    },
  ],
  passengers: [
    {
      passengerId: 'PAX-1',
      passengerType: 'ADULT',
      firstName: 'María José',
      lastName: 'Pérez Mostrador',
      documentType: 'PASSPORT',
      documentNumber: 'A1234567',
      nationality: 'EC',
      birthDate: '1990-01-01',
      gender: 'F',
      contact: { email: 'maria@correo.test', phone: '+593991234567' },
      extraBaggage: [{ itineraryId: 'IT-1', quantity: 1 }],
    },
  ],
  fares: [
    { itineraryId: 'IT-1', cabinClass: 'ECONOMY', fareBrand: 'BOSQUE', segmentIds: ['SEG-1'] },
    { itineraryId: 'IT-2', cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', segmentIds: ['SEG-2'] },
  ],
  tickets: [
    { ticketId: 't-0', bookingId: 'b-1', passengerId: 'PAX-1', eTicketNumber: '9990000000001', status: 'VOIDED' },
    { ticketId: 't-1', bookingId: 'b-1', passengerId: 'PAX-1', eTicketNumber: '9990000000002', status: 'ISSUED' },
  ],
  passengersWithAssistance: ['PAX-1'],
} as unknown as AdminBooking;

const pass = (segmentId: string, over: Partial<BoardingPass> = {}): BoardingPass => ({
  passengerId: 'PAX-1',
  segmentId,
  seat: '4A',
  boardingGroup: 'A',
  boardingPosition: '002',
  barcode: 'M1PEREZ MOSTRADOR/MARIAEECO7QK UIOBOGEA 0100 318Y004A0002 100',
  barcodeType: 'QR',
  gate: null,
  ...over,
});

/** El momento de la impresión: el día antes de la ida (las pruebas no dependen de la fecha en que se corren). */
const NOW = new Date('2026-11-13T12:00:00-05:00');
const imprimir = (passes: BoardingPass[], estimated: Record<string, string> = {}, now = NOW) => printablePasses(booking, passes, estimated, now);

describe('pase de abordar impreso en mostrador (D57)', () => {
  it('arma un pase por pasajero y tramo con el nombre en mayúsculas, la ruta y el e-ticket vigente', () => {
    const [ida, vuelta] = imprimir([pass('SEG-1'), pass('SEG-2', { seat: '12C', boardingGroup: 'C' })]);
    expect(ida).toMatchObject({
      pnr: 'ECO7QK',
      passengerName: 'PÉREZ MOSTRADOR / MARÍA JOSÉ',
      flightNumber: 'EA100',
      date: '14 NOV',
      origin: 'UIO',
      destination: 'BOG',
      departureTime: '13:00',
      arrivalTime: '14:30',
      group: 'A',
      seat: '4A',
      position: '002',
      cabin: 'Economy',
      fareBrand: 'Bosque',
      eTicket: '9990000000002',
      delayed: false,
    });
    expect(vuelta).toMatchObject({ flightNumber: 'EA101', origin: 'BOG', destination: 'UIO', seat: '12C', group: 'C', fareBrand: 'Semilla' });
  });

  it('embarque 40 min y cierre de puertas 15 min antes de la salida (CM-3), también pasando la medianoche', () => {
    const [ida, vuelta] = imprimir([pass('SEG-1'), pass('SEG-2')]);
    expect([ida?.boardingTime, ida?.doorsCloseTime]).toEqual(['12:20', '12:45']);
    expect([vuelta?.boardingTime, vuelta?.doorsCloseTime]).toEqual(['23:30', '23:55']);
    expect(minutesBefore('00:00', 1)).toBe('23:59');
  });

  it('con un retraso vigente, las horas salen de la salida estimada', () => {
    const [ida] = imprimir([pass('SEG-1')], { 'SEG-1': '2026-11-14T15:10:00-05:00' });
    expect(ida).toMatchObject({ departureTime: '15:10', boardingTime: '14:30', doorsCloseTime: '14:55', delayed: true });
  });

  it('equipaje: lo que incluye el paquete más las maletas extra; sin franquicia en la reserva, la del paquete', () => {
    const [ida, vuelta] = imprimir([pass('SEG-1'), pass('SEG-2')]);
    expect([ida?.carryOn, ida?.checkedBags]).toEqual(['Sí', '3 maletas (1 extra)']);
    // Semilla: solo artículo personal y sin maleta de bodega.
    expect([vuelta?.carryOn, vuelta?.checkedBags]).toEqual(['Solo artículo personal', '—']);
  });

  it('CM-4: no imprime el pase de un tramo que ya salió (la ida de un ida y vuelta, al imprimir la vuelta)', () => {
    const entreVuelos = new Date('2026-11-19T12:00:00-05:00');
    expect(imprimir([pass('SEG-1'), pass('SEG-2')], {}, entreVuelos).map((p) => p.flightNumber)).toEqual(['EA101']);
    // Con todo volado no queda nada (la web avisa en vez de descargar un PDF vacío).
    expect(imprimir([pass('SEG-1'), pass('SEG-2')], {}, new Date('2026-11-21T00:00:00-05:00'))).toEqual([]);
  });

  it('un vuelo retrasado se imprime hasta su salida ESTIMADA, aunque haya pasado la programada', () => {
    const despuesDeLaProgramada = new Date('2026-11-14T13:30:00-05:00');
    expect(imprimir([pass('SEG-1')], {}, despuesDeLaProgramada)).toEqual([]);
    expect(imprimir([pass('SEG-1')], { 'SEG-1': '2026-11-14T15:10:00-05:00' }, despuesDeLaProgramada)).toHaveLength(1);
  });

  it('sin puerta asignada queda en null (el PDF pide revisar las pantallas)', () => {
    expect(imprimir([pass('SEG-1')])[0]?.gate).toBeNull();
    expect(imprimir([pass('SEG-1', { gate: 'B7' })])[0]?.gate).toBe('B7');
  });

  it('un pase de un tramo o pasajero que no está en la reserva no se imprime', () =>
    expect(imprimir([pass('SEG-X'), pass('SEG-1', { passengerId: 'PAX-9' })])).toEqual([]));

  it('no lleva datos sensibles: ni asistencia médica, ni documento, ni contacto', () => {
    const text = JSON.stringify(imprimir([pass('SEG-1'), pass('SEG-2')]));
    for (const secret of ['A1234567', 'maria@correo.test', '+593991234567', 'assistance', 'PASSPORT']) expect(text).not.toContain(secret);
  });

  it('el PDF es un PDF de una página por pase, con el PNR, el vuelo y sin el documento', async () => {
    const doc = await boardingPassesPdf(imprimir([pass('SEG-1'), pass('SEG-2')]), new Date(2026, 10, 13, 9, 5));
    expect(doc.getNumberOfPages()).toBe(2);
    const pdf = doc.output();
    expect(pdf.startsWith('%PDF')).toBe(true);
    for (const text of ['ECO7QK', 'EA100', 'EA101', 'Check-in en mostrador', 'Revisa la puerta en las pantallas del aeropuerto', '13/11/2026 09:05']) expect(pdf).toContain(text);
    expect(pdf).not.toContain('A1234567');
  });

  it('un nombre muy largo se achica y no invade la columna del QR', async () => {
    const [base] = imprimir([pass('SEG-1')]);
    const passengerName = 'DE LOS SANTOS VILLAVICENCIO ECHEVERRÍA / MARÍA FERNANDA ALEJANDRA';
    const doc = await boardingPassesPdf([{ ...base!, passengerName }]);
    expect(doc.output()).toContain('ALEJANDRA');
    const layout = nameLayout(doc, passengerName);
    expect(layout.size).toBe(9);
    expect(layout.lines.length).toBeLessThanOrEqual(2);
    expect(layout.lines.join(' ')).toBe(passengerName);
    // Cada línea cabe antes de la columna del QR.
    for (const line of layout.lines) expect(doc.setFont('helvetica', 'bold').setFontSize(9).getTextWidth(line)).toBeLessThanOrEqual(NAME_WIDTH);
    // Un nombre corto conserva su tamaño, en una línea.
    expect(nameLayout(doc, 'PÉREZ / ANA')).toEqual({ size: 12, lines: ['PÉREZ / ANA'] });
  });
});
