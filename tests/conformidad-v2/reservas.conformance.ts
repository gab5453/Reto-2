import { call, config, expectConforms, live, newKey, newPaymentReference } from './support/client.js';
import { type Booking, type Hold, type OfferChoice, bookingBody, createHold, findOffer } from './support/flows.js';

/**
 * MS.Reservas — 12 operaciones: hold (crear, ver, liberar), reservas (crear, listar, ver), boletos (emitir, listar, ver),
 * asientos, check-in y pases de abordar. Canal Booking: el pago es un paymentReference que la aerolínea solo valida (D28).
 */
describe.skipIf(!live)('MS.Reservas (contrato v2)', () => {
  let choice: OfferChoice;
  let hold: Hold;
  let booking: Booking;

  beforeAll(async () => {
    choice = await findOffer();
  });

  describe('createHold / getHold / releaseHold', () => {
    it('201 con Location; el reintento con la misma Idempotency-Key responde 200 y el mismo hold', async () => {
      const key = newKey();
      const body = {
        offerId: choice.offer.offerId,
        itinerarySelections: [{ itineraryId: choice.itinerary.itineraryId, cabinClass: choice.pricing.cabinClass, fareBrand: choice.pricing.fareBrand }],
        passengersBreakdown: { adults: 1 },
        ttlMinutes: 10,
      };
      const first = await call('createHold', { body, idempotencyKey: key });
      expectConforms(first, { status: 201 });
      expect((first.body as { ttlMinutes: number }).ttlMinutes).toBe(10);
      const replay = await call('createHold', { body, idempotencyKey: key });
      expectConforms(replay, { status: 200 });
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect((replay.body as Hold).holdId).toBe((first.body as Hold).holdId);

      const reused = await call('createHold', { body: { ...body, ttlMinutes: 20 }, idempotencyKey: key });
      expectConforms(reused, { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });

      const holdId = (first.body as Hold).holdId;
      const status = await call('getHold', { params: { holdId } });
      expectConforms(status, { status: 200 });
      expect((status.body as { status: string }).status).toBe('HELD');

      const released = await call('releaseHold', { params: { holdId } });
      expectConforms(released, { status: 204 });
      const again = await call('releaseHold', { params: { holdId } });
      expectConforms(again, { status: 204 }); // idempotente
    });

    it('404 al consultar un hold de otro usuario (X-User-Id distinto)', async () => {
      const other = await createHold(choice);
      const response = await call('getHold', { params: { holdId: other.holdId }, userId: `${config.userId}-otro` });
      expectConforms(response, { status: 404 });
      await call('releaseHold', { params: { holdId: other.holdId } });
    });

    it('401 sin token', async () => {
      const response = await call('getHold', { auth: 'none', params: { holdId: '3f1c2a9e-8b7d-4c21-9f0a-6e5d4c3b2a10' } });
      expectConforms(response, { status: 401 });
    });
  });

  describe('createBooking / getBooking / listBookings', () => {
    it('201 CONFIRMED o 202 TICKET_ISSUING; el reintento devuelve la misma reserva', async () => {
      hold = await createHold(choice);
      const key = newKey();
      const body = bookingBody(hold);
      const created = await call('createBooking', { body, idempotencyKey: key });
      expectConforms(created, { status: [201, 202] });
      booking = created.body as Booking;
      expect(['CONFIRMED', 'TICKET_ISSUING']).toContain(booking.status);
      const replay = await call('createBooking', { body, idempotencyKey: key });
      expectConforms(replay, { status: 200 });
      expect((replay.body as Booking).bookingId).toBe(booking.bookingId);
    });

    it('410 HOLD_EXPIRED o 409 HOLD_ALREADY_CONSUMED al reutilizar un hold ya convertido', async () => {
      const response = await call('createBooking', { body: bookingBody(hold) });
      expectConforms(response, { status: [409, 410] });
    });

    it('422 PAYMENT_REFERENCE_INVALID con una referencia ya usada (D34)', async () => {
      const another = await createHold(choice);
      const reference = newPaymentReference();
      const first = await call('createBooking', { body: bookingBody(another, reference) });
      expectConforms(first, { status: [201, 202] });
      const third = await createHold(choice);
      const reused = await call('createBooking', { body: bookingBody(third, reference) });
      expectConforms(reused, { status: 422, code: 'PAYMENT_REFERENCE_INVALID' });
      await call('releaseHold', { params: { holdId: third.holdId } });
    });

    it('422 AMOUNT_MISMATCH si el monto no es el precio congelado', async () => {
      const another = await createHold(choice);
      const body = bookingBody(another);
      (body['payment'] as { amount: { total: string } }).amount = { ...another.lockedPrice, total: '1.00' };
      const response = await call('createBooking', { body });
      expectConforms(response, { status: 422, code: 'AMOUNT_MISMATCH' });
      await call('releaseHold', { params: { holdId: another.holdId } });
    });

    it('400 VALIDATION_FAILED sin Idempotency-Key', async () => {
      const response = await call('createBooking', { body: bookingBody(hold), idempotencyKey: false });
      expectConforms(response, { status: 400, code: 'VALIDATION_FAILED' });
    });

    it('getBooking: 200 para el dueño y 404 para otro usuario', async () => {
      const own = await call('getBooking', { params: { bookingId: booking.bookingId } });
      expectConforms(own, { status: 200 });
      const foreign = await call('getBooking', { params: { bookingId: booking.bookingId }, userId: `${config.userId}-otro` });
      expectConforms(foreign, { status: 404 });
    });

    it('listBookings: 200 e incluye la reserva creada', async () => {
      const response = await call('listBookings', { query: { pnr: booking.pnr } });
      expectConforms(response, { status: 200 });
      expect((response.body as { items: Booking[] }).items.map((b) => b.bookingId)).toContain(booking.bookingId);
    });
  });

  describe('issueTickets / listTickets / getTicket', () => {
    it('emitir es idempotente: issued = 0 si ya estaban emitidos', async () => {
      const first = await call('issueTickets', { params: { bookingId: booking.bookingId } });
      expectConforms(first, { status: 200 });
      const second = await call('issueTickets', { params: { bookingId: booking.bookingId } });
      expectConforms(second, { status: 200 });
      expect((second.body as { issued: number }).issued).toBe(0);
    });

    it('listTickets y getTicket: 200; un boleto inexistente responde 404', async () => {
      const list = await call('listTickets', { params: { bookingId: booking.bookingId } });
      expectConforms(list, { status: 200 });
      const ticketId = (list.body as { tickets: { ticketId: string }[] }).tickets[0].ticketId;
      const one = await call('getTicket', { params: { bookingId: booking.bookingId, ticketId } });
      expectConforms(one, { status: 200 });
      const missing = await call('getTicket', { params: { bookingId: booking.bookingId, ticketId: 'TKT-NO-EXISTE' } });
      expectConforms(missing, { status: 404 });
    });
  });

  describe('changeSeats', () => {
    it('200 al pasar a otro asiento libre de la misma cabina', async () => {
      const map = await call('getSeatMap', { params: { offerId: choice.offer.offerId }, query: { segmentId: choice.segment.segmentId } });
      const seat = (map.body as { cabins: { cabinClass: string; rows: { seats: { seatNumber: string; status: string }[] }[] }[] }).cabins
        .find((c) => c.cabinClass === choice.pricing.cabinClass)!
        .rows.flatMap((r) => r.seats)
        .find((s) => s.status === 'AVAILABLE')!;
      const response = await call('changeSeats', {
        params: { bookingId: booking.bookingId },
        body: { seats: [{ passengerId: 'PAX-1', segmentId: choice.segment.segmentId, seatNumber: seat.seatNumber }] },
      });
      expectConforms(response, { status: 200 });
    });

    it('409 SEAT_TAKEN o 422 SEAT_CABIN_MISMATCH con un asiento inválido', async () => {
      const response = await call('changeSeats', {
        params: { bookingId: booking.bookingId },
        body: { seats: [{ passengerId: 'PAX-1', segmentId: choice.segment.segmentId, seatNumber: '99Z' }] },
      });
      expectConforms(response, { status: [400, 409, 422] });
    });
  });

  describe('checkIn / listBoardingPasses', () => {
    it(`fuera de la ventana de 48 h responde 409 CHECK_IN_NOT_AVAILABLE (vuelo a ${config.daysAhead} días)`, async () => {
      const response = await call('checkIn', { params: { bookingId: booking.bookingId } });
      expectConforms(response, { status: 409, code: 'CHECK_IN_NOT_AVAILABLE' });
    });

    it('sin check-in, los pases responden 409 BOARDING_PASS_NOT_AVAILABLE', async () => {
      const response = await call('listBoardingPasses', { params: { bookingId: booking.bookingId } });
      expectConforms(response, { status: 409, code: 'BOARDING_PASS_NOT_AVAILABLE' });
    });
  });
});
