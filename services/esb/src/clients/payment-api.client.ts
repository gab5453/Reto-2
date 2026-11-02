import { randomUUID } from 'node:crypto';
import { correlationHeaders, type MoneyAmount, ProblemDetailsException } from '@ecoairlines/shared';
import { CircuitBreaker } from './circuit-breaker.js';
import { problemFrom } from './rest.client.js';

/** `Payment` de `contract/payment-api.openapi.yaml` (solo lo que usa el ESB). */
export interface Payment {
  paymentReference: string;
  status: 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'DECLINED' | 'VOIDED' | 'EXPIRED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
  amount: MoneyAmount;
  [key: string]: unknown;
}

export interface Refund {
  refundId: string;
  paymentReference: string;
  amount: MoneyAmount;
  status: 'SETTLED';
  createdAt: string;
}

export type PaymentOperation = 'BOOKING' | 'SEATS' | 'BAGGAGE' | 'DATE_CHANGE';

/**
 * `MoneyAmount` del contrato de la Payment API: solo `currency` y `total` (`additionalProperties: false`). El de las reservas
 * trae además `baseFare` y `taxes`, que la pasarela rechaza (V2.15: lo encontró la prueba con la Payment API real).
 */
const contractAmount = (amount: MoneyAmount) => ({ currency: amount.currency, total: amount.total });

/**
 * Adaptador de la Payment API simulada (canal web, D7 y D28; la usan las sagas de V2.10). Es un sistema externo: se autentica
 * con la clave secreta `sk_test_…` (no con el token de servicio de D41), que nunca sale del servidor ni se escribe en logs.
 * - `capture`: cobra el monto EXACTO autorizado, una sola vez (idempotente por `orderId` = `sagaId`).
 * - `void`: anula una autorización sin capturar (compensación antes del pago).
 * - `refund`: reembolso (cancelación web o compensación después de capturar); `Idempotency-Key` obligatoria.
 * Sus errores llegan como ProblemDetails (`AMOUNT_MISMATCH`, `ALREADY_CAPTURED`, `PAYMENT_NOT_CAPTURABLE`…) y se conservan.
 */
export class PaymentApiClient {
  readonly breaker = new CircuitBreaker('Payment API');

  constructor(
    private readonly baseUrl: string,
    private readonly secretKey: string,
    private readonly timeoutMs: number,
  ) {}

  get(paymentReference: string): Promise<Payment> {
    return this.send('GET', `/payments/${encodeURIComponent(paymentReference)}`);
  }

  capture(paymentReference: string, input: { orderId: string; operation: PaymentOperation; expectedAmount: MoneyAmount }): Promise<Payment> {
    return this.send('POST', `/payments/${encodeURIComponent(paymentReference)}/capture`, { ...input, expectedAmount: contractAmount(input.expectedAmount) });
  }

  void(paymentReference: string): Promise<Payment> {
    return this.send('POST', `/payments/${encodeURIComponent(paymentReference)}/void`);
  }

  /** `idempotencyKey`: la misma en cada reintento del mismo reembolso (p. ej. derivada del `sagaId`). */
  refund(input: { paymentReference: string; amount: MoneyAmount; reason: 'CUSTOMER_REQUEST' | 'FLIGHT_CANCELLED' | 'SAGA_COMPENSATION' | 'OTHER'; orderId?: string }, idempotencyKey: string = randomUUID()): Promise<Refund> {
    return this.send('POST', '/refunds', { ...input, amount: contractAmount(input.amount) }, { 'idempotency-key': idempotencyKey });
  }

  async ping(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  }

  private send<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    return this.breaker.run(async () => {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${this.secretKey}`, accept: 'application/json', ...correlationHeaders(), ...extra, ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title: 'La Payment API no está disponible.', retryAfterSeconds: 5 });
      }
      const parsed = await response.json().catch(() => undefined);
      if (response.ok) return parsed as T;
      throw problemFrom(response.status, parsed, 'La Payment API');
    });
  }
}
