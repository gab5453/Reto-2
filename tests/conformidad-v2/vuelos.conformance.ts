import { call, config, dateInDays, expectConforms, hasAdmin, live } from './support/client.js';
import { type OfferChoice, findOffer } from './support/flows.js';

/** MS.Vuelos — 9 operaciones: health, eventos, promociones (GET/PUT), search, seatmap, estado (GET/PATCH), operaciones. */
describe.skipIf(!live)('MS.Vuelos (contrato v2)', () => {
  let choice: OfferChoice;
  beforeAll(async () => {
    choice = await findOffer();
  });

  describe('getHealth', () => {
    it('responde el semáforo en menos de 1 s, sin token', async () => {
      const response = await call('getHealth');
      expectConforms(response, { status: [200, 503] });
      expect(response.elapsedMs).toBeLessThan(1000);
      expect((response.body as { vertical: string }).vertical).toBe('VUELOS');
    });
  });

  describe('searchFlights', () => {
    it('200 con ofertas que solo muestran cabinas con asientos', async () => {
      const [origin, destination] = config.route;
      const response = await call('searchFlights', {
        body: { itineraries: [{ origin, destination, departureDate: choice.departureDate }], passengers: { adults: 1 } },
      });
      expectConforms(response, { status: 200 });
      const offers = (response.body as { offers: { itineraries: { pricingOptions: { availableSeats: number }[] }[] }[] }).offers;
      for (const offer of offers) for (const it of offer.itineraries) for (const p of it.pricingOptions) expect(p.availableSeats).toBeGreaterThan(0);
    });

    it('400 VALIDATION_FAILED con un código IATA inválido', async () => {
      const response = await call('searchFlights', {
        body: { itineraries: [{ origin: 'quito', destination: 'GYE', departureDate: dateInDays(10) }], passengers: { adults: 1 } },
      });
      expectConforms(response, { status: 400, code: 'VALIDATION_FAILED' });
    });
  });

  describe('getSeatMap', () => {
    it('200 con el estado de cada asiento', async () => {
      const response = await call('getSeatMap', { params: { offerId: choice.offer.offerId }, query: { segmentId: choice.segment.segmentId } });
      expectConforms(response, { status: 200 });
      const seats = (response.body as { cabins: { rows: { seats: { status: string; isAvailable: boolean }[] }[] }[] }).cabins.flatMap((c) =>
        c.rows.flatMap((r) => r.seats),
      );
      expect(seats.length).toBeGreaterThan(0);
      for (const seat of seats) expect(seat.isAvailable).toBe(seat.status === 'AVAILABLE');
    });

    it('404 o 410 con una oferta inexistente', async () => {
      const response = await call('getSeatMap', { params: { offerId: 'OFF-NO-EXISTE' }, query: { segmentId: 'SEG-NO-EXISTE' } });
      expectConforms(response, { status: [404, 410] });
    });
  });

  describe('getFlightStatus', () => {
    it('200 para un vuelo a la venta', async () => {
      const response = await call('getFlightStatus', {
        params: { flightNumber: choice.segment.flightNumber },
        query: { date: choice.departureDate },
      });
      expectConforms(response, { status: 200 });
    });

    it('404 para un vuelo que no opera', async () => {
      const response = await call('getFlightStatus', { params: { flightNumber: 'ZZ9999' }, query: { date: choice.departureDate } });
      expectConforms(response, { status: 404 });
    });
  });

  describe('updateFlightStatus', () => {
    it('401 sin token', async () => {
      const response = await call('updateFlightStatus', {
        auth: 'none',
        params: { flightNumber: choice.segment.flightNumber },
        body: { date: choice.departureDate, status: 'SCHEDULED' },
      });
      expectConforms(response, { status: 401 });
    });

    it.skipIf(!hasAdmin)('200 al registrar la puerta sin cambiar el estado (no altera el vuelo)', async () => {
      const response = await call('updateFlightStatus', {
        auth: 'admin',
        params: { flightNumber: choice.segment.flightNumber },
        body: { date: choice.departureDate, status: 'SCHEDULED', departureGate: 'A1' },
      });
      expectConforms(response, { status: 200 });
    });

    it.skipIf(!hasAdmin)('409 INVALID_STATUS_TRANSITION de SCHEDULED a ARRIVED', async () => {
      const response = await call('updateFlightStatus', {
        auth: 'admin',
        params: { flightNumber: choice.segment.flightNumber },
        body: { date: choice.departureDate, status: 'ARRIVED' },
      });
      expectConforms(response, { status: 409, code: 'INVALID_STATUS_TRANSITION' });
    });
  });

  describe('listFlightOperations', () => {
    it('401 sin token', async () => {
      const response = await call('listFlightOperations', { auth: 'none', query: { date: choice.departureDate } });
      expectConforms(response, { status: 401 });
    });

    it.skipIf(!hasAdmin)('200 con asientos por estado y ocupación', async () => {
      const response = await call('listFlightOperations', { auth: 'admin', query: { date: choice.departureDate } });
      expectConforms(response, { status: 200 });
    });
  });

  describe('listOutboxEvents', () => {
    it('200 con el feed de CloudEvents', async () => {
      const response = await call('listOutboxEvents', { query: { limit: 5 } });
      expectConforms(response, { status: 200 });
    });

    it('401 sin token', async () => {
      const response = await call('listOutboxEvents', { auth: 'none' });
      expectConforms(response, { status: 401 });
    });
  });

  describe('getPromotionAgreement / putPromotionAgreement', () => {
    it('GET: 200 con el acuerdo, o 404 si aún no existe', async () => {
      const response = await call('getPromotionAgreement');
      expectConforms(response, { status: [200, 404] });
    });

    it('PUT: 403 con token de partner (no tiene flights:admin, D35)', async () => {
      const response = await call('putPromotionAgreement', { body: { permite_promociones: true, porcentaje_descuento_maximo: 10 } });
      expectConforms(response, { status: 403 });
    });

    it.skipIf(!hasAdmin)('PUT: 422 PROMOTION_DISCOUNT_OUT_OF_RANGE con más de 50 % (BKG-12)', async () => {
      const response = await call('putPromotionAgreement', {
        auth: 'admin',
        body: { permite_promociones: true, porcentaje_descuento_maximo: 60 },
      });
      expectConforms(response, { status: 422, code: 'PROMOTION_DISCOUNT_OUT_OF_RANGE' });
    });

    it.skipIf(!hasAdmin)('PUT: 200 al volver a guardar el acuerdo vigente (no lo altera)', async () => {
      const current = await call('getPromotionAgreement');
      if (current.status !== 200) return;
      const { permite_promociones, porcentaje_descuento_maximo, rutas_habilitadas, cabinas_habilitadas, vigencia_hasta } =
        current.body as Record<string, unknown>;
      const response = await call('putPromotionAgreement', {
        auth: 'admin',
        body: { permite_promociones, porcentaje_descuento_maximo, rutas_habilitadas, cabinas_habilitadas, vigencia_hasta },
      });
      expectConforms(response, { status: 200 });
    });
  });
});
