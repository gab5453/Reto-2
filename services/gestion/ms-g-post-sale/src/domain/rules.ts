import { formatCents, ProblemDetailsException, toCents } from '@ecoairlines/shared';

/**
 * Reglas de postventa (contract/ms-g-post-sale.xsd; contrato v2: cancelación, cambio de fecha, maletas). Funciones puras: se
 * prueban sin base de datos ni SOAP. Los importes se calculan en centavos enteros.
 */
export const QUOTE_TTL_MINUTES = 15;
export const MAX_DATE_CHANGE_OFFERS = 10;
export const MAX_EXTRA_BAGS = 3;

export interface Money {
  currency: string;
  baseFare?: string;
  taxes?: string;
  total: string;
}

export interface PurchasedFare {
  itineraryId: string;
  cabinClass: string;
  fareBrand: string;
  price: Money;
  isRefundable: boolean;
  isChangeable: boolean;
  changeFeeUsd: string;
  departureAt: string;
  departed: boolean;
}

export interface BookingContext {
  bookingId: string;
  status: string;
  channel: 'WEB' | 'BOOKING';
  partnerId?: string;
  currency: string;
  seatedPassengers: number;
  fares: PurchasedFare[];
}

export interface CancellationQuote {
  quoteId: string;
  bookingId: string;
  isRefundable: boolean;
  refundAmount: string;
  penaltyAmount: string;
  penaltyWaived: boolean;
  percentage: string;
  currency: string;
  unflownItineraryIds: string[];
  expiresAt?: string;
}

export interface Alternative {
  replacedItineraryId: string;
  newItineraryId: string;
  segmentIds: string[];
  price: Money;
}

export interface DateChangeOffer {
  changeOfferId: string;
  bookingId: string;
  expiresAt: string;
  replacements: Alternative[];
  priceDifference: { fareDifference: string; taxDifference: string; changeFee: string; totalToPay: string; currency: string };
}

export const fault = (status: number, code: string, title: string, detail?: string, invalidParams?: { name: string; reason: string }[]) =>
  new ProblemDetailsException({ status, code, title, ...(detail ? { detail } : {}), ...(invalidParams ? { invalidParams } : {}) });

/** Base de la tarifa: `baseFare` si viene; si no, total − impuestos. */
const baseCents = (money: Money) => (money.baseFare !== undefined ? toCents(money.baseFare) : toCents(money.total) - toCents(money.taxes));
const taxCents = (money: Money) => (money.taxes !== undefined ? toCents(money.taxes) : toCents(money.total) - baseCents(money));

/** Solo una reserva CONFIRMED tiene postventa (ALREADY_CANCELLED si ya se canceló). */
export function assertConfirmed(booking: BookingContext): void {
  if (booking.status === 'CANCELLED') throw fault(409, 'ALREADY_CANCELLED', 'La reserva ya está cancelada.');
  if (booking.status !== 'CONFIRMED') throw fault(409, 'BOOKING_NOT_CONFIRMED', `La reserva está ${booking.status}: la postventa exige boletos emitidos.`);
}

/**
 * Compensación sin cotización (FLIGHT_CANCELLED, SAGA_COMPENSATION): también una reserva que todavía emite boletos o cambia de
 * fecha. Un combo de Booking puede fallar antes de que se emitan los boletos, y esa reserva igual se cancela y se reembolsa.
 */
export function assertCompensable(booking: BookingContext): void {
  if (booking.status === 'CANCELLED') throw fault(409, 'ALREADY_CANCELLED', 'La reserva ya está cancelada.');
  if (!['CONFIRMED', 'TICKET_ISSUING', 'CHANGE_PENDING', 'CANCELLATION_PENDING'].includes(booking.status)) {
    throw fault(409, 'BOOKING_NOT_CONFIRMED', `Una reserva ${booking.status} no se compensa.`);
  }
}

/**
 * Reembolso de lo no volado. Tarifa reembolsable → se devuelve el total; no reembolsable → solo los impuestos (la tarifa base
 * es penalidad). Con `waived` (vuelo cancelado por la aerolínea, o compensación con acuerdo vigente) → el 100 % sin penalidad.
 */
export function refundOf(booking: BookingContext, options: { waived: boolean }): Omit<CancellationQuote, 'quoteId' | 'expiresAt'> {
  const unflown = booking.fares.filter((fare) => !fare.departed);
  if (!unflown.length) throw fault(409, 'BOOKING_NOT_CANCELLABLE', 'Todos los itinerarios ya volaron: no hay nada que cancelar.');
  let refund = 0;
  let penalty = 0;
  let paid = 0;
  for (const fare of unflown) {
    const total = toCents(fare.price.total);
    paid += total;
    if (options.waived || fare.isRefundable) refund += total;
    else {
      refund += taxCents(fare.price);
      penalty += baseCents(fare.price);
    }
  }
  return {
    bookingId: booking.bookingId,
    isRefundable: unflown.every((fare) => fare.isRefundable),
    refundAmount: formatCents(refund),
    penaltyAmount: formatCents(penalty),
    penaltyWaived: options.waived,
    percentage: paid ? (Math.round((refund / paid) * 10_000) / 100).toFixed(2) : '0.00',
    currency: booking.currency,
    unflownItineraryIds: unflown.map((fare) => fare.itineraryId),
  };
}

/**
 * Sin cotización (CalculateCompensationRefund) la penalidad SIEMPRE se exonera (D42):
 * - FLIGHT_CANCELLED (D37): la aerolínea canceló el vuelo.
 * - SAGA_COMPENSATION: el combo de Booking falló y la cancelación no la pidió el cliente. Decisión del responsable (25/10): se
 *   exonera sin mirar el acuerdo de promociones (el contrato v2 lo permite: "si así lo permite el acuerdo B2B"; la aerolínea
 *   decide permitirlo siempre).
 */
export const compensationWaived = (_reason: 'FLIGHT_CANCELLED' | 'SAGA_COMPENSATION'): true => true;

/**
 * Ofertas de cambio: combina las alternativas de cada itinerario a cambiar (máximo 10). Cada tarifa debe ser cambiable
 * (FARE_NOT_CHANGEABLE) y no haber salido (FLIGHT_ALREADY_DEPARTED). Diferencias con signo; cargo = changeFeeUsd × pasajeros con
 * asiento; totalToPay = max(0, diferencia de tarifa + de impuestos) + cargo (el saldo a favor no se reembolsa).
 */
export function dateChangeOptions(booking: BookingContext, alternatives: Alternative[]): Omit<DateChangeOffer, 'changeOfferId' | 'expiresAt'>[] {
  const replaced = [...new Set(alternatives.map((alternative) => alternative.replacedItineraryId))];
  const fares = replaced.map((itineraryId) => {
    const fare = booking.fares.find((candidate) => candidate.itineraryId === itineraryId);
    if (!fare) throw fault(400, 'VALIDATION_FAILED', 'Una alternativa reemplaza un itinerario que no es de la reserva.', undefined, [{ name: 'alternative.replacedItineraryId', reason: itineraryId }]);
    if (fare.departed) throw fault(409, 'FLIGHT_ALREADY_DEPARTED', `El itinerario ${itineraryId} ya salió.`);
    if (!fare.isChangeable) throw fault(409, 'FARE_NOT_CHANGEABLE', `La tarifa ${fare.fareBrand} no permite cambios.`);
    return fare;
  });
  const groups = fares.map((fare) => alternatives.filter((alternative) => alternative.replacedItineraryId === fare.itineraryId));
  if (!groups.length || groups.some((group) => !group.length)) return [];
  const combinations: Alternative[][] = groups.reduce<Alternative[][]>((acc, group) => acc.flatMap((combo) => group.map((option) => [...combo, option])), [[]]).slice(0, MAX_DATE_CHANGE_OFFERS);
  const changeFee = fares.reduce((sum, fare) => sum + toCents(fare.changeFeeUsd) * booking.seatedPassengers, 0);
  return combinations.map((replacements) => {
    const fareDifference = replacements.reduce((sum, option, index) => sum + baseCents(option.price) - baseCents(fares[index]!.price), 0);
    const taxDifference = replacements.reduce((sum, option, index) => sum + taxCents(option.price) - taxCents(fares[index]!.price), 0);
    return {
      bookingId: booking.bookingId,
      replacements,
      priceDifference: {
        fareDifference: formatCents(fareDifference),
        taxDifference: formatCents(taxDifference),
        changeFee: formatCents(changeFee),
        totalToPay: formatCents(Math.max(0, fareDifference + taxDifference) + changeFee),
        currency: booking.currency,
      },
    };
  });
}

export interface BaggageLine {
  passengerId: string;
  itineraryId: string;
  alreadyPurchased: number;
  unitPrice: Money;
  departed: boolean;
}

/** Opciones de maletas extra de lo no volado: máximo 3 por pasajero e itinerario. */
export const baggageOptions = (lines: BaggageLine[]) =>
  lines
    .filter((line) => !line.departed)
    .map((line) => ({ passengerId: line.passengerId, itineraryId: line.itineraryId, price: line.unitPrice, maxAllowed: Math.max(0, MAX_EXTRA_BAGS - line.alreadyPurchased), alreadyPurchased: line.alreadyPurchased }));

/** Antes del pago: límite (BAGGAGE_LIMIT_EXCEEDED) y monto a cobrar = precio unitario × cantidad. */
export function validateBaggage(line: BaggageLine, quantity: number) {
  if (line.departed) throw fault(409, 'FLIGHT_ALREADY_DEPARTED', `El itinerario ${line.itineraryId} ya salió.`);
  if (line.alreadyPurchased + quantity > MAX_EXTRA_BAGS) {
    throw fault(422, 'BAGGAGE_LIMIT_EXCEEDED', `Máximo ${MAX_EXTRA_BAGS} maletas extra por pasajero e itinerario.`, `Ya tiene ${line.alreadyPurchased}; pidió ${quantity}.`, [{ name: 'quantity', reason: `máximo ${MAX_EXTRA_BAGS - line.alreadyPurchased}` }]);
  }
  const scale = (amount?: string) => (amount === undefined ? undefined : formatCents(toCents(amount) * quantity));
  return {
    amountToCharge: { currency: line.unitPrice.currency, ...(line.unitPrice.baseFare !== undefined ? { baseFare: scale(line.unitPrice.baseFare) } : {}), ...(line.unitPrice.taxes !== undefined ? { taxes: scale(line.unitPrice.taxes) } : {}), total: scale(line.unitPrice.total)! },
    totalAfterPurchase: line.alreadyPurchased + quantity,
  };
}
