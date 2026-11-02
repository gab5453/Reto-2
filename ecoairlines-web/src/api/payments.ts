import { PAYMENT_API_URL, PAYMENT_PUBLIC_KEY } from '../config';
import { ApiError } from './client';
import type { MoneyAmount, ProblemDetails } from './types';

/*
 * Payment API simulada (`contract/payment-api.openapi.yaml`, D7/D49): un sistema EXTERNO, como Stripe. El navegador tokeniza
 * la tarjeta y autoriza el pago con la clave PÚBLICA; a EcoAirlines (GraphQL) solo llega `paymentReference` y el ESB captura
 * el monto exacto en la saga. El número y el CVV viajan una sola vez, a la pasarela: no se guardan ni se registran aquí.
 */

export interface CardInput {
  holderName: string;
  /** Solo dígitos. */
  number: string;
  expMonth: number;
  expYear: number;
  cvv: string;
}

export interface TestCard {
  label: string;
  number: string;
  brand: string;
  expectedResult: 'AUTHORIZED' | 'DECLINED_CARD' | 'DECLINED_FUNDS' | 'PENDING';
  cvv?: string;
  expMonth?: number;
  expYear?: number;
}

export interface Payment {
  paymentReference: string;
  status: 'AUTHORIZED' | 'PENDING' | 'DECLINED' | 'CAPTURED' | 'VOIDED' | 'EXPIRED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
  declineCode?: 'card_declined' | 'insufficient_funds' | null;
  amount: MoneyAmount;
  card: { brand: string; last4: string };
}

async function request<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Api-Key': PAYMENT_PUBLIC_KEY };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(`${PAYMENT_API_URL}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'No se pudo conectar con la pasarela de pagos. Inténtalo de nuevo.');
  }
  const json = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    const problem = json && typeof json === 'object' && 'code' in json ? (json as ProblemDetails) : undefined;
    const retryAfter = Number(response.headers.get('Retry-After')) || undefined;
    throw new ApiError(response.status, problem?.title ?? `Error ${response.status} de la pasarela`, problem, retryAfter, response.headers.get('X-Correlation-Id') ?? undefined);
  }
  return json as T;
}

/** Tarjetas del entorno de prueba (botón «Usar tarjeta de prueba»). */
export const listTestCards = () => request<TestCard[]>('/test-cards');

/**
 * Tokeniza la tarjeta y autoriza `amount` con ella. Devuelve el pago: `AUTHORIZED` o `PENDING` (se puede usar su referencia)
 * o `DECLINED` (un rechazo no es un error de la pasarela: hay que pedir otra tarjeta).
 *
 * Cada intento usa un token de tarjeta nuevo, así que también una `Idempotency-Key` nueva (con la misma clave y otro token la
 * pasarela respondería `IDEMPOTENCY_KEY_REUSED`). Una autorización que sobre nunca se cobra: vence sola a los 30 minutos.
 */
export async function authorizeCard(card: CardInput, amount: MoneyAmount, description: string): Promise<Payment> {
  const method = await request<{ token: string }>('/payment-methods', { method: 'POST', body: card });
  return request<Payment>('/payments', {
    method: 'POST',
    idempotencyKey: crypto.randomUUID(),
    body: { paymentMethodToken: method.token, amount: { currency: amount.currency, total: amount.total }, description: description.slice(0, 120) },
  });
}
