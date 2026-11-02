import { createHash, randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { currentCorrelation, ProblemDetailsException } from '@ecoairlines/shared';
import { PAYMENT_API_CONFIG, type PaymentApiConfig } from '../config.js';
import { TEST_CARDS, validateCard } from '../domain/cards.js';
import * as rules from '../domain/payments.js';
import type { CaptureOperation, MoneyAmount, PaymentMethodRecord, PaymentRecord, RefundRecord } from '../domain/payments.js';
import { type IdempotencyScope, PAYMENTS_STORE, type PaymentsStore } from '../repositories/payments.store.js';

/** Identificadores opacos con el formato del contrato: `pm_…`, `pay_…`, `re_…` (base 62). */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const opaqueId = (prefix: string, length = 20) => `${prefix}_${Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;

/** Huella del cuerpo para la idempotencia: claves ordenadas, así el orden de los campos no cuenta. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])])) : value;
const hashOf = (body: unknown) => createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');

export interface Result<T> {
  status: number;
  body: T;
  replayed?: boolean;
}

const notFound = () => new ProblemDetailsException({ status: 404, code: 'PAYMENT_NOT_FOUND', title: 'Pago no encontrado.' });

@Injectable()
export class PaymentsService {
  /** Reemplazable en pruebas (pagos pendientes, vencimientos). */
  now = (): number => Date.now();

  constructor(
    @Inject(PAYMENTS_STORE) private readonly store: PaymentsStore,
    @Inject(PAYMENT_API_CONFIG) private readonly config: PaymentApiConfig,
  ) {}

  testCards() {
    return TEST_CARDS;
  }

  // ------------------------------------------------------------------------------------------------------------- navegador

  /** Tokeniza la tarjeta: valida y guarda SOLO marca, últimos 4 y vencimiento (el número y el CVV no salen de esta función). */
  async tokenize(card: { holderName: string; number: string; expMonth: number; expYear: number; cvv: string }) {
    const now = this.now();
    const valid = validateCard(card, new Date(now));
    const method: PaymentMethodRecord = {
      token: opaqueId('pm', 24),
      brand: valid.brand,
      last4: valid.last4,
      expMonth: card.expMonth,
      expYear: card.expYear,
      outcome: valid.outcome,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.config.methodTtlMs).toISOString(),
      usedAt: null,
    };
    await this.store.insertMethod(method);
    return { token: method.token, brand: method.brand, last4: method.last4, expMonth: method.expMonth, expYear: method.expYear, expiresAt: method.expiresAt };
  }

  /** Autoriza (reserva el monto). Un rechazo NO es un error: `201` con `DECLINED` y su `declineCode`. */
  authorize(idempotencyKey: string, input: { paymentMethodToken: string; amount: MoneyAmount; description?: string }): Promise<Result<unknown>> {
    return this.idempotent('authorize', idempotencyKey, input, async () => {
      const now = this.now();
      let problem: ProblemDetailsException | undefined;
      const method = await this.store.updateMethod(input.paymentMethodToken, (current) => {
        if (current.usedAt) problem = new ProblemDetailsException({ status: 409, code: 'PAYMENT_METHOD_ALREADY_USED', title: 'El token de la tarjeta ya se usó en otro pago.' });
        else if (now >= Date.parse(current.expiresAt)) problem = new ProblemDetailsException({ status: 410, code: 'PAYMENT_METHOD_EXPIRED', title: 'El token de la tarjeta venció: vuelva a ingresarla.' });
        // Un token sirve para UN pago, también si el pago se rechaza (como las pasarelas reales).
        return problem ? current : { ...current, usedAt: new Date(now).toISOString() };
      });
      if (!method) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'El token de la tarjeta no existe.', invalidParams: [{ name: 'paymentMethodToken', reason: 'no existe' }] });
      if (problem) throw problem;
      const declined = method.outcome === 'DECLINED_CARD' || method.outcome === 'DECLINED_FUNDS';
      const payment: PaymentRecord = {
        paymentReference: opaqueId('pay', 20),
        status: declined ? 'DECLINED' : method.outcome === 'PENDING' ? 'PENDING' : 'AUTHORIZED',
        declineCode: method.outcome === 'DECLINED_CARD' ? 'card_declined' : method.outcome === 'DECLINED_FUNDS' ? 'insufficient_funds' : null,
        amount: input.amount,
        card: { brand: method.brand, last4: method.last4 },
        createdAt: new Date(now).toISOString(),
        pendingUntil: method.outcome === 'PENDING' ? new Date(now + this.config.pendingMs).toISOString() : null,
        authorizationExpiresAt: declined ? null : new Date(now + this.config.authorizationTtlMs).toISOString(),
        capturedAmount: null,
        capturedAt: null,
        orderId: null,
        operation: null,
        refundedCents: 0,
        voidedAt: null,
        correlationId: currentCorrelation()?.correlationId ?? null,
      };
      await this.store.insertPayment(payment);
      return { status: 201, body: rules.paymentView(payment, now) };
    });
  }

  // ------------------------------------------------------------------------------------------------------------------- ESB

  async get(reference: string) {
    const payment = await this.store.payment(reference);
    if (!payment) throw notFound();
    return rules.paymentView(payment, this.now());
  }

  async capture(reference: string, input: { orderId: string; operation: CaptureOperation; expectedAmount: MoneyAmount }) {
    const now = this.now();
    const result = await this.store.updatePayment(reference, (payment) => ({ payment: rules.capture(payment, input, now) }));
    if (!result) throw notFound();
    return rules.paymentView(result.payment, now);
  }

  async void(reference: string) {
    const now = this.now();
    const result = await this.store.updatePayment(reference, (payment) => ({ payment: rules.voidPayment(payment, now) }));
    if (!result) throw notFound();
    return rules.paymentView(result.payment, now);
  }

  /** Reembolso total o parcial; en el simulador queda `SETTLED` de inmediato. */
  refund(idempotencyKey: string, input: { paymentReference: string; amount: MoneyAmount; reason: RefundRecord['reason']; orderId?: string }): Promise<Result<unknown>> {
    return this.idempotent('refund', idempotencyKey, input, async () => {
      const now = this.now();
      const result = await this.store.updatePayment(input.paymentReference, (payment) => {
        const refund: RefundRecord = {
          refundId: opaqueId('re', 20),
          paymentReference: input.paymentReference,
          amount: { currency: input.amount.currency, total: rules.fromCents(rules.toCents(input.amount.total)) },
          reason: input.reason,
          orderId: input.orderId ?? null,
          status: 'SETTLED',
          createdAt: new Date(now).toISOString(),
        };
        return { payment: rules.refund(payment, input.amount, now), refund };
      });
      if (!result) throw notFound();
      const { refundId, paymentReference, amount, status, createdAt } = result.refund!;
      return { status: 201, body: { refundId, paymentReference, amount, status, createdAt } };
    });
  }

  /**
   * `Idempotency-Key` del contrato: la misma clave con el mismo cuerpo devuelve la respuesta original (`200` +
   * `Idempotent-Replayed`); con otro cuerpo, `409 IDEMPOTENCY_KEY_REUSED`. La clave se reserva antes de ejecutar y se libera
   * si la operación falla (el cliente puede reintentar).
   */
  private async idempotent(scope: IdempotencyScope, key: string, body: unknown, work: () => Promise<Result<unknown>>): Promise<Result<unknown>> {
    const claim = await this.store.claimIdempotency(scope, key, hashOf(body), new Date(this.now()).toISOString());
    if (claim.kind === 'mismatch') throw new ProblemDetailsException({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED', title: 'La Idempotency-Key ya se usó con otros datos.' });
    if (claim.kind === 'in-progress') throw new ProblemDetailsException({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED', title: 'Una petición con esta Idempotency-Key sigue en curso.', detail: 'Reintente en unos segundos.' });
    if (claim.kind === 'replay') return { status: 200, body: claim.body, replayed: true };
    try {
      const result = await work();
      await this.store.completeIdempotency(scope, key, result.status, result.body);
      return result;
    } catch (error) {
      await this.store.releaseIdempotency(scope, key).catch(() => undefined);
      throw error;
    }
  }
}
