import { Inject, Injectable } from '@nestjs/common';
import { ProblemDetailsException } from '@ecoairlines/shared';
import type { Caller } from '../clients/rest.client.js';
import { UPSTREAMS, type Upstreams } from '../clients/upstreams.js';
import { ESB_STORE, type EsbStore } from '../repositories/esb.store.js';
import { baggageLine, postSaleContext } from '../sagas/booking-sagas.js';
import { type BookingFares, type BookingView, fromProto, type Itinerary } from '../sagas/support.js';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Consultas de postventa (contrato v2: `getCancellationQuote`, `getBaggageOptions`, `searchDateChange`). Leen la reserva en
 * Bookings y piden a PostSale la cotización u oferta (que PostSale guarda con vencimiento); no cambian la reserva.
 * La búsqueda de cambio de fecha además consulta las alternativas en Offers y el ESB recuerda los itinerarios de cada oferta
 * hasta que se confirma (`change_offers`).
 */
@Injectable()
export class PostSaleComposition {
  constructor(
    @Inject(UPSTREAMS) private readonly upstreams: Upstreams,
    @Inject(ESB_STORE) private readonly store: EsbStore,
  ) {}

  private async booking(bookingId: string, caller: Caller) {
    const bookings = this.upstreams.rest.bookings;
    const [booking, fares] = await Promise.all([
      bookings.json<BookingView>('GET', `/bookings/${bookingId}`, { caller }),
      bookings.json<BookingFares>('GET', `/bookings/${bookingId}/fares`, { caller }),
    ]);
    return { booking, fares };
  }

  /** `CancellationQuoteResponse`: lo que se reembolsaría hoy, válido 15 min (`quoteId` para `POST /cancel`). */
  async cancellationQuote(bookingId: string, caller: Caller) {
    const { booking, fares } = await this.booking(bookingId, caller);
    const { quote } = await this.upstreams.postSale.call<Any>('CreateCancellationQuote', { booking: postSaleContext(booking, fares) });
    return {
      quoteId: quote['quoteId'],
      isRefundable: quote['isRefundable'] === true || quote['isRefundable'] === 'true',
      refundAmount: Number(quote['refundAmount']).toFixed(2),
      penaltyAmount: Number(quote['penaltyAmount']).toFixed(2),
      penaltyWaived: quote['penaltyWaived'] === true || quote['penaltyWaived'] === 'true',
      percentage: Number(quote['percentage']),
      currency: quote['currency'],
      expiresAt: quote['expiresAt'] instanceof Date ? quote['expiresAt'].toISOString() : String(quote['expiresAt']),
    };
  }

  /** `BaggageOptionsResponse`: por pasajero (sin infantes) e itinerario no volado, precio y cuántas más admite. */
  async baggageOptions(bookingId: string, caller: Caller) {
    const { booking, fares } = await this.booking(bookingId, caller);
    const lines = booking.passengers
      .filter((p) => p.passengerType !== 'INFANT')
      .flatMap((p) => booking.itineraries.filter((i) => fares.unflownItineraryIds.includes(i.itineraryId) && i.pricingOptions?.[0]?.extraCheckedBaggagePrice).map((i) => baggageLine(booking, fares, p.passengerId, i.itineraryId)));
    if (!lines.length) return [];
    const result = await this.upstreams.postSale.call<Any>('GetBaggageOptions', { bookingId, line: lines });
    return list<Any>(result?.['option']).map((o) => ({
      passengerId: o['passengerId'],
      itineraryId: o['itineraryId'],
      price: { currency: o['price']['currency'], ...(o['price']['baseFare'] !== undefined ? { baseFare: Number(o['price']['baseFare']).toFixed(2) } : {}), ...(o['price']['taxes'] !== undefined ? { taxes: Number(o['price']['taxes']).toFixed(2) } : {}), total: Number(o['price']['total']).toFixed(2) },
      maxAllowed: Number(o['maxAllowed']),
      alreadyPurchased: Number(o['alreadyPurchased']),
    }));
  }

  /**
   * `DateChangeSearchResponse`: Offers busca vuelos de la misma cabina y familia en la fecha pedida, PostSale arma cada oferta
   * (diferencia de tarifa e impuestos, cargo) y el ESB guarda los itinerarios de cada `changeOfferId` para la confirmación.
   */
  async searchDateChange(bookingId: string, caller: Caller, body: { changes?: { itineraryId: string; newDepartureDate: string }[] }) {
    const changes = body?.changes ?? [];
    if (!Array.isArray(changes) || !changes.length || changes.some((c) => typeof c?.itineraryId !== 'string' || !DATE.test(String(c?.newDepartureDate)))) {
      throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'changes no es válido.', invalidParams: [{ name: 'changes', reason: 'al menos uno, con itineraryId y newDepartureDate (AAAA-MM-DD)' }] });
    }
    const { booking, fares } = await this.booking(bookingId, caller);
    const counts = { adults: 0, youths: 0, children: 0, infants: 0 };
    for (const p of booking.passengers) counts[({ ADULT: 'adults', YOUTH: 'youths', CHILD: 'children', INFANT: 'infants' } as const)[p.passengerType]]++;
    const found = await this.upstreams.offers.call<Any>('FindAlternatives', {
      bookingId,
      currentItineraries: booking.itineraries.map((i) => ({ itineraryId: i.itineraryId, segments: i.segments.map((s) => ({ segmentId: s.segmentId, flightNumber: s.flightNumber, departure: { iataCode: s.departure.iataCode, at: s.departure.at }, arrival: { iataCode: s.arrival.iataCode, at: s.arrival.at } })) })),
      purchasedFares: fares.fares.map((f) => ({ itineraryId: f.itineraryId, cabinClass: `CABIN_CLASS_${f.cabinClass}`, fareBrand: f.fareBrand, price: f.price })),
      changes,
      passengers: counts,
    });
    const alternatives = (found['alternatives'] as Any[]).map((a) => ({ replacedItineraryId: a['replacedItineraryId'], itinerary: fromProto<Itinerary>(a['itinerary']), price: cleanMoney(a['price']) }));
    if (!alternatives.length) return [];
    const result = await this.upstreams.postSale.call<Any>('CreateDateChangeOffers', {
      booking: postSaleContext(booking, fares),
      alternative: alternatives.map((a) => ({ replacedItineraryId: a.replacedItineraryId, newItineraryId: a.itinerary.itineraryId, segmentId: a.itinerary.segments.map((s) => s.segmentId), price: a.price })),
    });
    const response = [];
    for (const offer of list<Any>(result?.['offer'])) {
      const replacements = list<Any>(offer['replacement']).map((r) => alternatives.find((a) => a.replacedItineraryId === r['replacedItineraryId'] && a.itinerary.itineraryId === r['newItineraryId'])!).filter(Boolean);
      const expiresAt = offer['expiresAt'] instanceof Date ? offer['expiresAt'].toISOString() : String(offer['expiresAt']);
      await this.store.saveChangeOffer({ changeOfferId: offer['changeOfferId'], bookingId, data: { replacements }, expiresAt });
      const difference = offer['priceDifference'];
      response.push({
        changeOfferId: offer['changeOfferId'],
        expiresAt,
        segments: replacements.flatMap((r) => r.itinerary.segments),
        priceDifference: { fareDifference: String(difference['fareDifference']), taxDifference: String(difference['taxDifference']), changeFee: String(difference['changeFee']), totalToPay: String(difference['totalToPay']), currency: difference['currency'] },
      });
    }
    return response;
  }
}

const cleanMoney = (money: Any) => ({ currency: money['currency'], ...(money['baseFare'] ? { baseFare: money['baseFare'] } : {}), ...(money['taxes'] ? { taxes: money['taxes'] } : {}), total: money['total'] });
