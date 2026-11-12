import type { ProblemDetailsException } from '@ecoairlines/shared';
import {
  assertCompensable,
  assertConfirmed,
  baggageOptions,
  compensationWaived,
  dateChangeOptions,
  MAX_DATE_CHANGE_OFFERS,
  MAX_EXTRA_BAGS,
  refundOf,
  validateBaggage,
  type Alternative,
  type BaggageLine,
  type BookingContext,
  type PurchasedFare,
} from './rules.js';

/** PU-1 (Informacion_General/Pruebas.md §5.1.1): reglas de postventa — reembolsos, cambio de fecha y maletas, en centavos. */

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
};

const tarifa = (over: Partial<PurchasedFare> = {}): PurchasedFare => ({
  itineraryId: 'IDA',
  cabinClass: 'ECONOMY',
  fareBrand: 'SEMILLA',
  price: { currency: 'USD', baseFare: '100.00', taxes: '27.00', total: '127.00' },
  isRefundable: false,
  isChangeable: false,
  changeFeeUsd: '0.00',
  departureAt: '2026-12-10T08:00:00-05:00',
  departed: false,
  ...over,
});
const reserva = (fares: PurchasedFare[], over: Partial<BookingContext> = {}): BookingContext => ({
  bookingId: 'b-1',
  status: 'CONFIRMED',
  channel: 'WEB',
  currency: 'USD',
  seatedPassengers: 2,
  fares,
  ...over,
});

describe('estados que admiten postventa', () => {
  it('CONFIRMED tiene postventa', () => expect(codeOf(() => assertConfirmed(reserva([tarifa()])))).toBeUndefined());
  it('CANCELLED → ALREADY_CANCELLED', () => expect(codeOf(() => assertConfirmed(reserva([tarifa()], { status: 'CANCELLED' })))).toBe('ALREADY_CANCELLED'));
  it.each(['PENDING_PAYMENT', 'TICKET_ISSUING', 'FAILED'])('%s → BOOKING_NOT_CONFIRMED', (status) =>
    expect(codeOf(() => assertConfirmed(reserva([tarifa()], { status })))).toBe('BOOKING_NOT_CONFIRMED'));

  it.each(['CONFIRMED', 'TICKET_ISSUING', 'CHANGE_PENDING', 'CANCELLATION_PENDING'])('una compensación acepta %s', (status) =>
    expect(codeOf(() => assertCompensable(reserva([tarifa()], { status })))).toBeUndefined());
  it('una compensación no acepta una reserva FAILED ni PENDING_PAYMENT', () => {
    expect(codeOf(() => assertCompensable(reserva([tarifa()], { status: 'FAILED' })))).toBe('BOOKING_NOT_CONFIRMED');
    expect(codeOf(() => assertCompensable(reserva([tarifa()], { status: 'PENDING_PAYMENT' })))).toBe('BOOKING_NOT_CONFIRMED');
  });
  it('una compensación sobre una reserva ya cancelada → ALREADY_CANCELLED', () =>
    expect(codeOf(() => assertCompensable(reserva([tarifa()], { status: 'CANCELLED' })))).toBe('ALREADY_CANCELLED'));
});

describe('refundOf: reembolso de lo no volado', () => {
  it('tarifa no reembolsable: se devuelven solo los impuestos; la base es penalidad', () =>
    expect(refundOf(reserva([tarifa()]), { waived: false })).toMatchObject({
      isRefundable: false,
      refundAmount: '27.00',
      penaltyAmount: '100.00',
      penaltyWaived: false,
      percentage: '21.26',
      unflownItineraryIds: ['IDA'],
    }));
  it('tarifa reembolsable: se devuelve el total, sin penalidad', () =>
    expect(refundOf(reserva([tarifa({ isRefundable: true })]), { waived: false })).toMatchObject({
      isRefundable: true,
      refundAmount: '127.00',
      penaltyAmount: '0.00',
      percentage: '100.00',
    }));
  it('con penalidad exonerada (vuelo cancelado o combo fallido): el 100 % aunque no sea reembolsable', () =>
    expect(refundOf(reserva([tarifa()]), { waived: true })).toMatchObject({ refundAmount: '127.00', penaltyAmount: '0.00', penaltyWaived: true, percentage: '100.00' }));
  it('lo ya volado no se reembolsa: solo la vuelta', () => {
    const quote = refundOf(reserva([tarifa({ departed: true }), tarifa({ itineraryId: 'VUELTA', isRefundable: true, price: { currency: 'USD', baseFare: '80.00', taxes: '20.00', total: '100.00' } })]), {
      waived: false,
    });
    expect(quote).toMatchObject({ refundAmount: '100.00', unflownItineraryIds: ['VUELTA'], isRefundable: true });
  });
  it('mezcla de reembolsable y no reembolsable: suma cada una con su regla', () =>
    expect(refundOf(reserva([tarifa(), tarifa({ itineraryId: 'VUELTA', isRefundable: true })]), { waived: false })).toMatchObject({
      isRefundable: false,
      refundAmount: '154.00', // 27 + 127
      penaltyAmount: '100.00',
      percentage: '60.63', // 154 / 254
    }));
  it('sin baseFare, la base se deduce como total − impuestos', () =>
    expect(refundOf(reserva([tarifa({ price: { currency: 'USD', taxes: '15.50', total: '65.50' } })]), { waived: false })).toMatchObject({
      refundAmount: '15.50',
      penaltyAmount: '50.00',
    }));
  it('no hay errores de redondeo con centavos (0,10 + 0,20)', () =>
    expect(
      refundOf(
        reserva([
          tarifa({ isRefundable: true, price: { currency: 'USD', total: '0.10' } }),
          tarifa({ itineraryId: 'VUELTA', isRefundable: true, price: { currency: 'USD', total: '0.20' } }),
        ]),
        { waived: false },
      ).refundAmount,
    ).toBe('0.30'));
  it('si todo ya voló → BOOKING_NOT_CANCELLABLE', () => expect(codeOf(() => refundOf(reserva([tarifa({ departed: true })]), { waived: false }))).toBe('BOOKING_NOT_CANCELLABLE'));
  it('compensationWaived: sin cotización la penalidad siempre se exonera (D42)', () => {
    expect(compensationWaived('FLIGHT_CANCELLED')).toBe(true);
    expect(compensationWaived('SAGA_COMPENSATION')).toBe(true);
  });
});

describe('dateChangeOptions: ofertas de cambio de fecha', () => {
  const cambiable = tarifa({ isChangeable: true, changeFeeUsd: '25.00' });
  const alternativa = (newItineraryId: string, baseFare: string, taxes: string, replaced = 'IDA'): Alternative => ({
    replacedItineraryId: replaced,
    newItineraryId,
    segmentIds: [newItineraryId],
    price: { currency: 'USD', baseFare, taxes, total: (Number(baseFare) + Number(taxes)).toFixed(2) },
  });

  it('más cara: paga la diferencia de tarifa e impuestos + el cargo por cada pasajero con asiento', () => {
    const [oferta] = dateChangeOptions(reserva([cambiable]), [alternativa('NUEVA', '130.00', '31.50')]);
    expect(oferta.priceDifference).toEqual({ fareDifference: '30.00', taxDifference: '4.50', changeFee: '50.00', totalToPay: '84.50', currency: 'USD' });
  });
  it('más barata: el saldo a favor no se devuelve, solo se paga el cargo', () => {
    const [oferta] = dateChangeOptions(reserva([cambiable]), [alternativa('NUEVA', '70.00', '22.00')]);
    expect(oferta.priceDifference).toMatchObject({ fareDifference: '-30.00', taxDifference: '-5.00', totalToPay: '50.00' });
  });
  it('una oferta por alternativa', () =>
    expect(dateChangeOptions(reserva([cambiable]), [alternativa('A', '100.00', '27.00'), alternativa('B', '110.00', '27.00')])).toHaveLength(2));
  it('cambiando ida y vuelta: combina las alternativas de cada una y suma los cargos', () => {
    const vuelta = tarifa({ itineraryId: 'VUELTA', isChangeable: true, changeFeeUsd: '10.00' });
    const ofertas = dateChangeOptions(reserva([cambiable, vuelta]), [
      alternativa('I1', '100.00', '27.00'),
      alternativa('I2', '100.00', '27.00'),
      alternativa('V1', '100.00', '27.00', 'VUELTA'),
    ]);
    expect(ofertas.map((o) => o.replacements.map((r) => r.newItineraryId))).toEqual([
      ['I1', 'V1'],
      ['I2', 'V1'],
    ]);
    expect(ofertas[0].priceDifference.changeFee).toBe('70.00'); // (25 + 10) × 2 pasajeros
  });
  it(`como máximo ${MAX_DATE_CHANGE_OFFERS} ofertas`, () => {
    const muchas = Array.from({ length: 15 }, (_, i) => alternativa(`N${i}`, '100.00', '27.00'));
    expect(dateChangeOptions(reserva([cambiable]), muchas)).toHaveLength(MAX_DATE_CHANGE_OFFERS);
  });
  it('si un itinerario a cambiar no tiene alternativas, no hay ofertas', () => {
    const vuelta = tarifa({ itineraryId: 'VUELTA', isChangeable: true });
    expect(dateChangeOptions(reserva([cambiable, vuelta]), [])).toEqual([]);
  });
  it('tarifa no cambiable → FARE_NOT_CHANGEABLE', () => expect(codeOf(() => dateChangeOptions(reserva([tarifa()]), [alternativa('N', '1.00', '1.00')]))).toBe('FARE_NOT_CHANGEABLE'));
  it('itinerario que ya salió → FLIGHT_ALREADY_DEPARTED', () =>
    expect(codeOf(() => dateChangeOptions(reserva([tarifa({ isChangeable: true, departed: true })]), [alternativa('N', '1.00', '1.00')]))).toBe('FLIGHT_ALREADY_DEPARTED'));
  it('una alternativa de un itinerario ajeno a la reserva → VALIDATION_FAILED', () =>
    expect(codeOf(() => dateChangeOptions(reserva([cambiable]), [alternativa('N', '1.00', '1.00', 'OTRO')]))).toBe('VALIDATION_FAILED'));
});

describe('maletas extra', () => {
  const linea = (over: Partial<BaggageLine> = {}): BaggageLine => ({
    passengerId: 'P1',
    itineraryId: 'IDA',
    alreadyPurchased: 0,
    unitPrice: { currency: 'USD', baseFare: '35.00', taxes: '0.00', total: '35.00' },
    departed: false,
    ...over,
  });

  it('opciones: lo que falta hasta 3, y nada de lo que ya voló', () =>
    expect(baggageOptions([linea({ alreadyPurchased: 1 }), linea({ itineraryId: 'VUELTA', departed: true }), linea({ passengerId: 'P2', alreadyPurchased: 5 })])).toEqual([
      { passengerId: 'P1', itineraryId: 'IDA', price: linea().unitPrice, maxAllowed: 2, alreadyPurchased: 1 },
      { passengerId: 'P2', itineraryId: 'IDA', price: linea().unitPrice, maxAllowed: 0, alreadyPurchased: 5 },
    ]));
  it('cobra precio unitario × cantidad', () =>
    expect(validateBaggage(linea(), 2)).toEqual({ amountToCharge: { currency: 'USD', baseFare: '70.00', taxes: '0.00', total: '70.00' }, totalAfterPurchase: 2 }));
  it(`llegar exactamente a ${MAX_EXTRA_BAGS} está permitido`, () => expect(validateBaggage(linea({ alreadyPurchased: 1 }), 2).totalAfterPurchase).toBe(3));
  it(`pasar de ${MAX_EXTRA_BAGS} → BAGGAGE_LIMIT_EXCEEDED`, () => expect(codeOf(() => validateBaggage(linea({ alreadyPurchased: 2 }), 2))).toBe('BAGGAGE_LIMIT_EXCEEDED'));
  it('un itinerario que ya salió → FLIGHT_ALREADY_DEPARTED', () => expect(codeOf(() => validateBaggage(linea({ departed: true }), 1))).toBe('FLIGHT_ALREADY_DEPARTED'));
  it('sin base ni impuestos en el precio, solo escala el total', () =>
    expect(validateBaggage(linea({ unitPrice: { currency: 'USD', total: '45.00' } }), 3).amountToCharge).toEqual({ currency: 'USD', total: '135.00' }));
});
