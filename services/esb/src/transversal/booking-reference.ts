import { ProblemDetailsException, type MoneyAmount } from '@ecoairlines/shared';

/**
 * Validador de referencias de pago de Booking (canal B2B, D28; hallazgo BKG-02). La aerolínea NO cobra: solo comprueba
 * 1. el **formato** (`PAY-BKP-AAAAMMDD-NNNNNN` del contrato; configurable con `BOOKING_PAYMENT_REFERENCE_PATTERN` hasta que
 *    Booking lo confirme), con una fecha real que no esté en el futuro;
 * 2. el **monto**, si Booking lo envía: igual al precio congelado (`AMOUNT_MISMATCH`).
 * El **uso único** lo garantiza MS.G.Bookings (`payment_records`, índice único) en el paso `claim` de la saga.
 */
export function assertBookingPaymentReference(reference: unknown, pattern: RegExp, now = new Date()): string {
  const value = typeof reference === 'string' ? reference.trim() : '';
  const match = pattern.exec(value);
  if (!match) throw invalidReference(value ? 'no tiene el formato PAY-BKP-AAAAMMDD-NNNNNN' : 'falta la referencia de pago');
  // Con el patrón del contrato, el primer grupo es la fecha del cobro: debe existir y no ser posterior a mañana (zonas horarias).
  const date = match[1];
  if (date && /^\d{8}$/.test(date)) {
    const parsed = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`);
    const valid = !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10).replace(/-/g, '') === date;
    if (!valid) throw invalidReference(`la fecha ${date} no existe`);
    if (parsed.getTime() > now.getTime() + 86_400_000) throw invalidReference(`la fecha ${date} está en el futuro`);
  }
  return value;
}

/** `amount` es opcional en `PaymentReference` (BKG-02): si llega, debe ser exactamente el total esperado. */
export function assertAmountMatches(received: MoneyAmount | undefined, expected: MoneyAmount): void {
  if (!received) return;
  const cents = (amount: MoneyAmount) => Math.round(Number(amount.total) * 100);
  if (received.currency !== expected.currency || cents(received) !== cents(expected)) {
    throw new ProblemDetailsException({
      status: 422,
      code: 'AMOUNT_MISMATCH',
      title: 'El monto pagado no coincide con el precio de la reserva.',
      detail: `Se recibió ${received.total} ${received.currency}; el precio es ${expected.total} ${expected.currency}.`,
    });
  }
}

function invalidReference(reason: string): ProblemDetailsException {
  return new ProblemDetailsException({
    status: 422,
    code: 'PAYMENT_REFERENCE_INVALID',
    title: 'La referencia de pago no es válida.',
    detail: `paymentReference: ${reason}.`,
    invalidParams: [{ name: 'paymentReference', reason }],
  });
}
