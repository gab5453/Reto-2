import { call, expectConforms, live, newPaymentReference } from './support/client.js';
import { type Booking, type OfferChoice, createBooking } from './support/flows.js';

/**
 * MS.Postventa — 6 operaciones: opciones y compra de maletas, búsqueda y confirmación de cambio de fecha, cotización y
 * cancelación. En el canal Booking el reembolso se CALCULA y lo ejecuta Booking (D28).
 */
describe.skipIf(!live)('MS.Postventa (contrato v2)', () => {
  let booking: Booking;
  let choice: OfferChoice;

  beforeAll(async () => {
    // Una tarifa cambiable, para poder probar el cambio de fecha.
    ({ booking, choice } = await createBooking((pricing) => pricing.fareRules.isChangeable));
  });

  describe('getBaggageOptions / addBaggage', () => {
    it('opciones 200 y compra de 1 maleta 200 o 202 con el monto de la opción', async () => {
      const options = await call('getBaggageOptions', { params: { bookingId: booking.bookingId } });
      expectConforms(options, { status: 200 });
      const option = (options.body as { passengerId: string; itineraryId: string; price: { currency: string; total: string } }[])[0]!;
      const response = await call('addBaggage', {
        params: { bookingId: booking.bookingId },
        body: {
          passengerId: option.passengerId,
          itineraryId: option.itineraryId,
          quantity: 1,
          payment: { paymentReference: newPaymentReference(), amount: option.price, provider: 'BOOKING_PROTOTIPO' },
        },
      });
      expectConforms(response, { status: [200, 202] });
    });

    it('422 BAGGAGE_LIMIT_EXCEEDED al pasar el máximo', async () => {
      const options = await call('getBaggageOptions', { params: { bookingId: booking.bookingId } });
      const option = (options.body as { passengerId: string; itineraryId: string; maxAllowed: number; price: { currency: string; total: string } }[])[0]!;
      const response = await call('addBaggage', {
        params: { bookingId: booking.bookingId },
        body: {
          passengerId: option.passengerId,
          itineraryId: option.itineraryId,
          quantity: option.maxAllowed + 1,
          payment: { paymentReference: newPaymentReference(), provider: 'BOOKING_PROTOTIPO' },
        },
      });
      expectConforms(response, { status: [409, 422], code: 'BAGGAGE_LIMIT_EXCEEDED' });
    });
  });

  describe('searchDateChange / confirmDateChange', () => {
    it('busca alternativas (200) y, si hay, confirma el cambio (200 o 202)', async () => {
      // Se busca el día siguiente al vuelo original.
      const next = new Date(`${choice.departureDate}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const options = await call('searchDateChange', {
        params: { bookingId: booking.bookingId },
        body: { changes: [{ itineraryId: choice.itinerary.itineraryId, newDepartureDate: next.toISOString().slice(0, 10) }] },
      });
      expectConforms(options, { status: 200 });
      const offer = (options.body as { changeOfferId: string; priceDifference: { totalToPay: string } }[])[0];
      if (!offer) return;
      const toPay = Number(offer.priceDifference.totalToPay);
      const response = await call('confirmDateChange', {
        params: { bookingId: booking.bookingId },
        body: {
          changeOfferId: offer.changeOfferId,
          ...(toPay > 0
            ? { payment: { paymentReference: newPaymentReference(), amount: { currency: 'USD', total: offer.priceDifference.totalToPay }, provider: 'BOOKING_PROTOTIPO' } }
            : {}),
        },
      });
      expectConforms(response, { status: [200, 202] });
    });

    // El contrato documenta 404, 409 y 410: la saga del ESB (V2.10) responde 404 NOT_FOUND si la oferta no es de la reserva;
    // el monolito respondía 409.
    it('404, 409 o 410 al confirmar una oferta de cambio inexistente', async () => {
      const response = await call('confirmDateChange', { params: { bookingId: booking.bookingId }, body: { changeOfferId: 'CHG-NO-EXISTE' } });
      expectConforms(response, { status: [404, 409, 410] });
    });
  });

  describe('getCancellationQuote / cancelBooking', () => {
    it('cotiza (200) y cancela con la cotización (200 o 202) con reembolso CALCULATED; cancelar otra vez → 409', async () => {
      const quote = await call('getCancellationQuote', { params: { bookingId: booking.bookingId } });
      expectConforms(quote, { status: 200 });
      const { quoteId } = quote.body as { quoteId: string };
      const cancelled = await call('cancelBooking', {
        params: { bookingId: booking.bookingId },
        body: { quoteId, reasonCode: 'CUSTOMER_REQUEST', reason: 'Prueba de conformidad' },
      });
      expectConforms(cancelled, { status: [200, 202] });
      const refund = (cancelled.body as { refund?: { status: string } }).refund;
      if (refund) expect(['CALCULATED', 'NOT_REFUNDABLE']).toContain(refund.status);
      const again = await call('cancelBooking', { params: { bookingId: booking.bookingId }, body: { quoteId, reasonCode: 'CUSTOMER_REQUEST' } });
      expectConforms(again, { status: 409, code: 'ALREADY_CANCELLED' });
    });

    it('SAGA_COMPENSATION cancela sin cotización (compensación de un combo de Booking)', async () => {
      const { booking: other } = await createBooking();
      const response = await call('cancelBooking', { params: { bookingId: other.bookingId }, body: { reasonCode: 'SAGA_COMPENSATION' } });
      expectConforms(response, { status: [200, 202] });
    });
  });
});
