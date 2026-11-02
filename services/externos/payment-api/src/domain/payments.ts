import { ProblemDetailsException } from '@ecoairlines/shared';
import type { CardBrand, TestOutcome } from './cards.js';

/**
 * Pagos de la pasarela simulada (contract/payment-api.openapi.yaml). Modelo autorizar → capturar de las pasarelas reales:
 * - el navegador **autoriza** (reserva el monto); el ESB **captura** el monto exacto una sola vez, **anula** o **reembolsa**;
 * - los estados que dependen del tiempo se calculan al leer (sin temporizadores): un pago `PENDING` pasa a `AUTHORIZED` al
 *   cumplirse `pendingUntil`, y una autorización sin capturar vence (`EXPIRED`) en `authorizationExpiresAt`;
 * - las transiciones son funciones puras sobre el registro: el store las aplica de forma atómica (ver payments.store.ts).
 */
export interface MoneyAmount {
  currency: string;
  total: string;
}

export interface PaymentMethodRecord {
  token: string;
  brand: CardBrand;
  last4: string;
  expMonth: number;
  expYear: number;
  /** Lo que hará al autorizar (solo esto se deriva del número completo, que nunca se guarda). */
  outcome: TestOutcome;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export type StoredStatus = 'PENDING' | 'AUTHORIZED' | 'DECLINED' | 'CAPTURED' | 'VOIDED';
export type PaymentStatus = StoredStatus | 'EXPIRED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
export type CaptureOperation = 'BOOKING' | 'SEATS' | 'BAGGAGE' | 'DATE_CHANGE';

export interface PaymentRecord {
  paymentReference: string;
  status: StoredStatus;
  declineCode: 'card_declined' | 'insufficient_funds' | null;
  amount: MoneyAmount;
  card: { brand: CardBrand; last4: string };
  createdAt: string;
  /** `PENDING` hasta este momento (tarjeta 3220); luego `AUTHORIZED`. */
  pendingUntil: string | null;
  authorizationExpiresAt: string | null;
  capturedAmount: MoneyAmount | null;
  capturedAt: string | null;
  /** Orden que capturó la referencia (uso único, D34): el `sagaId` del ESB. */
  orderId: string | null;
  operation: CaptureOperation | null;
  refundedCents: number;
  voidedAt: string | null;
  correlationId: string | null;
}

export interface RefundRecord {
  refundId: string;
  paymentReference: string;
  amount: MoneyAmount;
  reason: 'CUSTOMER_REQUEST' | 'FLIGHT_CANCELLED' | 'SAGA_COMPENSATION' | 'OTHER';
  orderId: string | null;
  status: 'SETTLED';
  createdAt: string;
}

export const toCents = (total: string): number => {
  const [units, cents = '00'] = total.split('.');
  return Number(units) * 100 + Number(cents.padEnd(2, '0').slice(0, 2));
};
export const fromCents = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const sameAmount = (a: MoneyAmount, b: MoneyAmount) => a.currency === b.currency && toCents(a.total) === toCents(b.total);

const problem = (status: number, code: string, title: string, detail?: string) => new ProblemDetailsException({ status, code, title, ...(detail ? { detail } : {}) });

/** Estado visible en el instante `now`. */
export function effectiveStatus(payment: PaymentRecord, now: number): PaymentStatus {
  if (payment.status === 'CAPTURED') {
    if (payment.refundedCents === 0) return 'CAPTURED';
    return payment.refundedCents >= toCents(payment.capturedAmount!.total) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  }
  if (payment.status === 'PENDING' || payment.status === 'AUTHORIZED') {
    if (payment.authorizationExpiresAt && now >= Date.parse(payment.authorizationExpiresAt)) return 'EXPIRED';
    if (payment.status === 'PENDING' && payment.pendingUntil && now >= Date.parse(payment.pendingUntil)) return 'AUTHORIZED';
  }
  return payment.status;
}

/** Captura (paso `pago*` de las sagas): monto exacto, una sola orden. Repetir con la misma orden es idempotente. */
export function capture(payment: PaymentRecord, input: { orderId: string; operation: CaptureOperation; expectedAmount: MoneyAmount }, now: number): PaymentRecord {
  const status = effectiveStatus(payment, now);
  if (status === 'CAPTURED' || status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED') {
    if (payment.orderId === input.orderId) return payment;
    throw problem(409, 'ALREADY_CAPTURED', 'La referencia de pago ya se usó en otra orden.');
  }
  if (status !== 'AUTHORIZED') throw problem(409, 'PAYMENT_NOT_CAPTURABLE', 'El pago aún no se puede capturar.', `Estado actual ${status}.`);
  if (!sameAmount(payment.amount, input.expectedAmount)) {
    throw problem(422, 'AMOUNT_MISMATCH', 'El monto no es el autorizado.', `Autorizado ${payment.amount.total} ${payment.amount.currency}; se esperaba ${input.expectedAmount.total} ${input.expectedAmount.currency}.`);
  }
  return { ...payment, status: 'CAPTURED', capturedAmount: payment.amount, capturedAt: new Date(now).toISOString(), orderId: input.orderId, operation: input.operation, pendingUntil: null };
}

/** Anula una autorización sin capturar. Ya anulada, vencida o rechazada: sin cambios (idempotente). Capturada: `409`. */
export function voidPayment(payment: PaymentRecord, now: number): PaymentRecord {
  const status = effectiveStatus(payment, now);
  if (status === 'CAPTURED' || status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED') {
    throw problem(409, 'PAYMENT_ALREADY_CAPTURED', 'El pago ya se capturó: se compensa con un reembolso.');
  }
  if (status !== 'AUTHORIZED' && status !== 'PENDING') return payment;
  return { ...payment, status: 'VOIDED', voidedAt: new Date(now).toISOString(), pendingUntil: null };
}

/** Reembolso total o parcial de un pago capturado; la suma nunca supera lo capturado. */
export function refund(payment: PaymentRecord, amount: MoneyAmount, now: number): PaymentRecord {
  if (payment.status !== 'CAPTURED') throw problem(409, 'PAYMENT_NOT_CAPTURED', 'Solo se reembolsa un pago capturado.', `Estado actual ${effectiveStatus(payment, now)}.`);
  if (amount.currency !== payment.capturedAmount!.currency) {
    throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La moneda del reembolso no es la del pago.', invalidParams: [{ name: 'amount.currency', reason: `debe ser ${payment.capturedAmount!.currency}` }] });
  }
  const cents = toCents(amount.total);
  const captured = toCents(payment.capturedAmount!.total);
  if (cents <= 0) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'El monto del reembolso debe ser mayor a cero.', invalidParams: [{ name: 'amount.total', reason: 'mayor a 0.00' }] });
  if (payment.refundedCents + cents > captured) {
    throw problem(422, 'REFUND_EXCEEDS_CAPTURED', 'El reembolso supera lo capturado.', `Capturado ${fromCents(captured)}; ya reembolsado ${fromCents(payment.refundedCents)}.`);
  }
  return { ...payment, refundedCents: payment.refundedCents + cents };
}

/** `Payment` del contrato (nunca expone más que marca y últimos 4 de la tarjeta). */
export function paymentView(payment: PaymentRecord, now: number) {
  return {
    paymentReference: payment.paymentReference,
    status: effectiveStatus(payment, now),
    declineCode: payment.declineCode,
    amount: payment.amount,
    ...(payment.capturedAmount ? { capturedAmount: payment.capturedAmount } : {}),
    ...(payment.refundedCents > 0 ? { refundedAmount: { currency: payment.amount.currency, total: fromCents(payment.refundedCents) } } : {}),
    card: payment.card,
    orderId: payment.orderId,
    createdAt: payment.createdAt,
    authorizationExpiresAt: payment.authorizationExpiresAt,
    capturedAt: payment.capturedAt,
    correlationId: payment.correlationId,
    testMode: true as const,
  };
}
