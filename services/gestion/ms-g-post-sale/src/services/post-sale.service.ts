import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type Alternative,
  assertCompensable,
  assertConfirmed,
  type BaggageLine,
  baggageOptions,
  type BookingContext,
  type CancellationQuote,
  compensationWaived,
  dateChangeOptions,
  type DateChangeOffer,
  fault,
  QUOTE_TTL_MINUTES,
  refundOf,
  validateBaggage,
} from '../domain/rules.js';
import { POST_SALE_STORE, type PostSaleStore, type Stored } from '../repositories/post-sale.store.js';

/**
 * MS.G.PostSale: los "documentos de negocio" con vencimiento de la postventa (cotizaciones de cancelación y ofertas de cambio,
 * 15 min) y el límite y precio de las maletas. No toca reservas ni inventario: eso lo hacen Bookings y Offers en otros pasos.
 */
@Injectable()
export class PostSaleService {
  constructor(@Inject(POST_SALE_STORE) private readonly store: PostSaleStore) {}

  now = (): number => Date.now();
  private expiry = () => new Date(this.now() + QUOTE_TTL_MINUTES * 60_000).toISOString();

  async createCancellationQuote(booking: BookingContext): Promise<CancellationQuote> {
    assertConfirmed(booking);
    const quote: CancellationQuote = { quoteId: randomUUID(), ...refundOf(booking, { waived: false }), expiresAt: this.expiry() };
    await this.store.transaction((tx) => tx.saveQuote({ data: quote, status: 'AVAILABLE', sagaId: null }));
    return quote;
  }

  /** Primer paso de "Cancelar": la cotización se usa una sola vez; el mismo `sagaId` la puede repetir. */
  consumeCancellationQuote(sagaId: string, bookingId: string, quoteId: string): Promise<CancellationQuote> {
    return this.store.transaction(async (tx) => {
      const quote = await tx.quote(quoteId);
      this.checkUsable(quote, bookingId, sagaId, 'QUOTE_EXPIRED', 'La cotización');
      if (quote!.status === 'AVAILABLE') await tx.saveQuote({ ...quote!, status: 'CONSUMED', sagaId });
      return quote!.data;
    });
  }

  /**
   * "Cancelar" sin cotización (FLIGHT_CANCELLED o SAGA_COMPENSATION): siempre sin penalidad (D42). `partnerAgreement` se
   * acepta (es parte del XSD) pero ya no cambia el resultado. Idempotente por `sagaId`.
   */
  calculateCompensationRefund(input: { sagaId: string; reasonCode: 'FLIGHT_CANCELLED' | 'SAGA_COMPENSATION'; booking: BookingContext; partnerAgreement?: { partnerId: string; allowsPromotions: boolean; validUntil?: string } }): Promise<CancellationQuote> {
    return this.store.transaction(async (tx) => {
      const key = `compensation:${input.sagaId}`;
      const previous = await tx.sagaResult<CancellationQuote>(key);
      if (previous) return previous;
      assertCompensable(input.booking);
      const waived = compensationWaived(input.reasonCode);
      const quote: CancellationQuote = { quoteId: randomUUID(), ...refundOf(input.booking, { waived }) };
      await tx.saveSagaResult(key, quote);
      // Dos llamadas simultáneas con el mismo sagaId: gana la primera que se guardó (en PostgreSQL, ON CONFLICT DO NOTHING
      // espera a la otra transacción y la relectura ya la ve). Las dos devuelven ese mismo resultado.
      return (await tx.sagaResult<CancellationQuote>(key)) ?? quote;
    });
  }

  async createDateChangeOffers(booking: BookingContext, alternatives: Alternative[]): Promise<DateChangeOffer[]> {
    assertConfirmed(booking);
    const offers = dateChangeOptions(booking, alternatives).map((option) => ({ changeOfferId: randomUUID(), expiresAt: this.expiry(), ...option }));
    await this.store.transaction(async (tx) => {
      for (const offer of offers) await tx.saveOffer({ data: offer, status: 'AVAILABLE', sagaId: null });
    });
    return offers;
  }

  consumeDateChangeOffer(sagaId: string, bookingId: string, changeOfferId: string): Promise<DateChangeOffer> {
    return this.store.transaction(async (tx) => {
      const offer = await tx.offer(changeOfferId);
      this.checkUsable(offer, bookingId, sagaId, 'CHANGE_OFFER_EXPIRED', 'La oferta de cambio');
      if (offer!.status === 'AVAILABLE') await tx.saveOffer({ ...offer!, status: 'CONSUMED', sagaId });
      return offer!.data;
    });
  }

  /** Compensación de "Cambiar fecha": la oferta que usó esa saga vuelve a estar disponible (idempotente). */
  releaseDateChangeOffer(sagaId: string, changeOfferId: string): Promise<boolean> {
    return this.store.transaction(async (tx) => {
      const offer = await tx.offer(changeOfferId);
      if (!offer || offer.status !== 'CONSUMED' || offer.sagaId !== sagaId) return false;
      await tx.saveOffer({ ...offer, status: 'AVAILABLE', sagaId: null });
      return true;
    });
  }

  getBaggageOptions(lines: BaggageLine[]) {
    return baggageOptions(lines);
  }

  validateBaggagePurchase(line: BaggageLine, quantity: number) {
    return validateBaggage(line, quantity);
  }

  /** De otra reserva, inexistente o usada por otra saga → NOT_FOUND (409, como pide el XSD); vencida → *_EXPIRED (410). */
  private checkUsable<T extends { bookingId: string; expiresAt?: string }>(stored: Stored<T> | undefined, bookingId: string, sagaId: string, expiredCode: string, name: string): void {
    if (!stored || stored.data.bookingId !== bookingId.toLowerCase()) throw fault(409, 'NOT_FOUND', `${name} no existe para esta reserva.`);
    if (stored.status === 'CONSUMED') {
      if (stored.sagaId === sagaId) return;
      throw fault(409, 'NOT_FOUND', `${name} ya se usó.`);
    }
    if (stored.data.expiresAt && Date.parse(stored.data.expiresAt) <= this.now()) throw fault(410, expiredCode, `${name} venció.`, `Venció a las ${stored.data.expiresAt}.`);
  }
}
