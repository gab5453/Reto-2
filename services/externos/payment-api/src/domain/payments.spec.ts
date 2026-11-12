import type { ProblemDetailsException } from '@ecoairlines/shared';
import { brandOf, passesLuhn, TEST_CARDS, validateCard } from './cards.js';
import { capture, effectiveStatus, fromCents, paymentView, refund, toCents, voidPayment, type PaymentRecord } from './payments.js';

/** PU-4 (Informacion_General/Pruebas.md §5.1.4): reglas de la Payment API — tarjetas, estados del pago, captura, anulación y reembolso. */

const AHORA = Date.parse('2026-12-01T12:00:00Z');
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
};

describe('tarjetas', () => {
  it('Luhn: las tarjetas de prueba son válidas; cambiar un dígito no', () => {
    for (const card of TEST_CARDS) expect(passesLuhn(card.number)).toBe(true);
    expect(passesLuhn('4242424242424241')).toBe(false);
  });
  it.each([
    ['4242424242424242', 'VISA'],
    ['4222222222222', 'VISA'],
    ['5555555555554444', 'MASTERCARD'],
    ['2221000000000009', 'MASTERCARD'],
    ['378282246310005', 'AMEX'],
    ['6011111111111117', undefined],
  ])('%s es %s', (number, brand) => expect(brandOf(number)).toBe(brand));
  const tarjeta = (over = {}) => ({ number: '4242424242424242', expMonth: 12, expYear: 2030, cvv: '123', ...over });
  it('una tarjeta válida devuelve solo la marca, los últimos 4 y su resultado de prueba', () =>
    expect(validateCard(tarjeta(), new Date(AHORA))).toEqual({ brand: 'VISA', last4: '4242', outcome: 'AUTHORIZED' }));
  it('la tarjeta 3220 queda PENDIENTE; la 0002 se rechaza', () => {
    expect(validateCard(tarjeta({ number: '4000000000003220' }), new Date(AHORA)).outcome).toBe('PENDING');
    expect(validateCard(tarjeta({ number: '4000000000000002' }), new Date(AHORA)).outcome).toBe('DECLINED_CARD');
  });
  it('vence al TERMINAR el mes indicado', () => {
    expect(codeOf(() => validateCard(tarjeta({ expMonth: 12, expYear: 2026 }), new Date(AHORA)))).toBeUndefined();
    expect(codeOf(() => validateCard(tarjeta({ expMonth: 11, expYear: 2026 }), new Date(AHORA)))).toBe('CARD_EXPIRED');
  });
  it('CVV: 3 dígitos; 4 en American Express', () => {
    expect(codeOf(() => validateCard(tarjeta({ cvv: '1234' }), new Date(AHORA)))).toBe('CVV_INVALID');
    expect(codeOf(() => validateCard(tarjeta({ number: '378282246310005', cvv: '1234' }), new Date(AHORA)))).toBeUndefined();
  });
  it('número inválido o marca no aceptada', () => {
    expect(codeOf(() => validateCard(tarjeta({ number: '4242424242424241' }), new Date(AHORA)))).toBe('CARD_NUMBER_INVALID');
    expect(codeOf(() => validateCard(tarjeta({ number: '6011111111111117' }), new Date(AHORA)))).toBe('CARD_BRAND_NOT_SUPPORTED');
  });
});

describe('montos en centavos (sin punto flotante)', () => {
  it('toCents y fromCents', () => {
    expect(toCents('127.5')).toBe(12750);
    expect(toCents('127')).toBe(12700);
    expect(fromCents(12705)).toBe('127.05');
    expect(fromCents(5)).toBe('0.05');
  });
});

const pago = (over: Partial<PaymentRecord> = {}): PaymentRecord => ({
  paymentReference: 'pay_1',
  status: 'AUTHORIZED',
  declineCode: null,
  amount: { currency: 'USD', total: '127.00' },
  card: { brand: 'VISA', last4: '4242' },
  createdAt: 'x',
  pendingUntil: null,
  authorizationExpiresAt: new Date(AHORA + 15 * 60_000).toISOString(),
  capturedAmount: null,
  capturedAt: null,
  orderId: null,
  operation: null,
  refundedCents: 0,
  voidedAt: null,
  correlationId: 'c',
  ...over,
});
const capturar = (p: PaymentRecord, over = {}) => capture(p, { orderId: 'saga-1', operation: 'BOOKING', expectedAmount: { currency: 'USD', total: '127.00' }, ...over }, AHORA);

describe('estado visible del pago', () => {
  it('una autorización vencida se ve EXPIRED', () => expect(effectiveStatus(pago({ authorizationExpiresAt: new Date(AHORA).toISOString() }), AHORA)).toBe('EXPIRED'));
  it('una PENDIENTE pasa a AUTHORIZED cuando llega su hora', () => {
    const pendiente = pago({ status: 'PENDING', pendingUntil: new Date(AHORA + 30_000).toISOString() });
    expect(effectiveStatus(pendiente, AHORA)).toBe('PENDING');
    expect(effectiveStatus(pendiente, AHORA + 30_000)).toBe('AUTHORIZED');
  });
  it('capturado → reembolso parcial → reembolsado', () => {
    const capturado = capturar(pago());
    expect(effectiveStatus(capturado, AHORA)).toBe('CAPTURED');
    expect(effectiveStatus({ ...capturado, refundedCents: 2700 }, AHORA)).toBe('PARTIALLY_REFUNDED');
    expect(effectiveStatus({ ...capturado, refundedCents: 12700 }, AHORA)).toBe('REFUNDED');
  });
});

describe('captura, anulación y reembolso', () => {
  it('captura el monto exacto y guarda la orden (el sagaId)', () =>
    expect(capturar(pago())).toMatchObject({ status: 'CAPTURED', capturedAmount: { total: '127.00' }, orderId: 'saga-1', operation: 'BOOKING' }));
  it('repetir la captura con la misma orden es idempotente', () => {
    const capturado = capturar(pago());
    expect(capturar(capturado)).toBe(capturado);
  });
  it('otra orden con la misma referencia → ALREADY_CAPTURED (uso único)', () => expect(codeOf(() => capturar(capturar(pago()), { orderId: 'saga-2' }))).toBe('ALREADY_CAPTURED'));
  it('un monto distinto al autorizado → AMOUNT_MISMATCH', () => expect(codeOf(() => capturar(pago(), { expectedAmount: { currency: 'USD', total: '126.99' } }))).toBe('AMOUNT_MISMATCH'));
  it('una pendiente, vencida o rechazada no se captura → PAYMENT_NOT_CAPTURABLE', () => {
    expect(codeOf(() => capturar(pago({ status: 'PENDING', pendingUntil: new Date(AHORA + 1).toISOString() })))).toBe('PAYMENT_NOT_CAPTURABLE');
    expect(codeOf(() => capturar(pago({ authorizationExpiresAt: new Date(AHORA).toISOString() })))).toBe('PAYMENT_NOT_CAPTURABLE');
    expect(codeOf(() => capturar(pago({ status: 'DECLINED' })))).toBe('PAYMENT_NOT_CAPTURABLE');
  });
  it('anular una autorización; anular dos veces no cambia nada', () => {
    const anulado = voidPayment(pago(), AHORA);
    expect(anulado.status).toBe('VOIDED');
    expect(voidPayment(anulado, AHORA)).toBe(anulado);
  });
  it('un pago capturado no se anula: se reembolsa', () => expect(codeOf(() => voidPayment(capturar(pago()), AHORA))).toBe('PAYMENT_ALREADY_CAPTURED'));
  it('reembolsos parciales que suman lo capturado; uno más lo excede', () => {
    let capturado = capturar(pago());
    capturado = refund(capturado, { currency: 'USD', total: '100.00' }, AHORA);
    capturado = refund(capturado, { currency: 'USD', total: '27.00' }, AHORA);
    expect(capturado.refundedCents).toBe(12700);
    expect(codeOf(() => refund(capturado, { currency: 'USD', total: '0.01' }, AHORA))).toBe('REFUND_EXCEEDS_CAPTURED');
  });
  it('reembolso en 0, en otra moneda o de un pago no capturado se rechaza', () => {
    expect(codeOf(() => refund(capturar(pago()), { currency: 'USD', total: '0.00' }, AHORA))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => refund(capturar(pago()), { currency: 'EUR', total: '1.00' }, AHORA))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => refund(pago(), { currency: 'USD', total: '1.00' }, AHORA))).toBe('PAYMENT_NOT_CAPTURED');
  });
  it('la vista del pago nunca expone más que la marca y los últimos 4', () => {
    const view = paymentView({ ...capturar(pago()), refundedCents: 2700 }, AHORA);
    expect(view.card).toEqual({ brand: 'VISA', last4: '4242' });
    expect(view.refundedAmount).toEqual({ currency: 'USD', total: '27.00' });
    expect(JSON.stringify(view)).not.toContain('4242424242424242');
  });
});
