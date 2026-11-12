import { MatchersV3, PactV4 } from '@pact-foundation/pact';
import { RestClient } from '../../../services/esb/src/clients/rest.client.js';
import { DUENO_RESERVA as DUENO, PACT_DIR, PARTICIPANTES, RESERVA_ID, TOKEN_DE_EJEMPLO, tokenFijo } from '../comun.js';

/**
 * Contrato del CONSUMIDOR (CT-1): lo que el ESB necesita de MS.G.Bookings en sus sagas — leer una reserva, sus tarifas para la
 * postventa y registrar una referencia de pago de un solo uso. El consumidor es el `RestClient` real del ESB.
 *
 * Los matchers (`like`, `eachLike`, `regex`) declaran la FORMA, no los valores exactos: el ESB no exige que el PNR sea «ABC234»,
 * sino que exista y sea un texto de 6 caracteres. Así el contrato no se rompe por un dato, solo por un cambio de forma.
 */
const { like, eachLike, regex, integer, boolean, uuid, datetime } = MatchersV3;
const pact = new PactV4({ consumer: PARTICIPANTES.esb, provider: PARTICIPANTES.bookings, dir: PACT_DIR, logLevel: 'warn' });

const AUTORIZACION = regex(/^Bearer .+$/, `Bearer ${TOKEN_DE_EJEMPLO}`);
const dinero = (total: string) => like({ currency: 'USD', total });
const bookings = (url: string) => new RestClient('MS.G.Bookings', url, tokenFijo, 5_000);

describe('ESB → MS.G.Bookings', () => {
  it('lee una reserva de su dueño con los campos que usan las sagas', () =>
    pact
      .addInteraction()
      .given('existe una reserva confirmada de un usuario de Booking')
      .uponReceiving('la lectura de la reserva por su dueño')
      .withRequest('GET', `/bookings/${RESERVA_ID}`, (b) => b.headers({ authorization: AUTORIZACION, 'x-owner-id': DUENO }))
      .willRespondWith(200, (b) =>
        b.jsonBody({
          bookingId: uuid(RESERVA_ID),
          pnr: regex(/^[A-Z2-9]{6}$/, 'ABC234'),
          status: 'CONFIRMED',
          ownerId: DUENO,
          channel: 'BOOKING',
          grandTotal: dinero('127.00'),
          paymentReference: like('PAY-BKP-20261201-000001'),
          itineraries: eachLike({
            itineraryId: like('EA100-20271210'),
            segments: eachLike({
              segmentId: like('EA100-20271210'),
              flightNumber: like('EA100'),
              departure: { iataCode: regex(/^[A-Z]{3}$/, 'UIO'), at: datetime("yyyy-MM-dd'T'HH:mm:ssXXX", '2027-12-10T08:00:00-05:00') },
              arrival: { iataCode: regex(/^[A-Z]{3}$/, 'GYE'), at: datetime("yyyy-MM-dd'T'HH:mm:ssXXX", '2027-12-10T08:50:00-05:00') },
            }),
          }),
          passengers: eachLike({ passengerId: like('P1'), passengerType: regex(/^(ADULT|YOUTH|CHILD|INFANT)$/, 'ADULT'), firstName: like('Ana'), lastName: like('Pérez') }),
          tickets: eachLike({ ticketId: like('TKT-5F1E6A0C-1'), passengerId: like('P1'), status: like('ISSUED'), eTicketNumber: regex(/^999\d{10}$/, '9991234567890') }),
        }),
      )
      .executeTest(async (mockServer) => {
        const reserva = await bookings(mockServer.url).json<{ pnr: string; itineraries: { segments: { departure: { iataCode: string } }[] }[]; tickets: unknown[] }>(
          'GET',
          `/bookings/${RESERVA_ID}`,
          { caller: { ownerId: DUENO } },
        );
        expect(reserva.pnr).toHaveLength(6);
        expect(reserva.itineraries[0].segments[0].departure.iataCode).toBe('UIO');
        expect(reserva.tickets.length).toBeGreaterThan(0);
      }));

  it('una reserva de otro dueño responde 404 NOT_FOUND (nunca 403) y el ESB lo propaga como ProblemDetails', () =>
    pact
      .addInteraction()
      .given('existe una reserva confirmada de un usuario de Booking')
      .uponReceiving('la lectura de la reserva por otro dueño')
      .withRequest('GET', `/bookings/${RESERVA_ID}`, (b) => b.headers({ authorization: AUTORIZACION, 'x-owner-id': 'partner:BOOKING_PROTOTIPO:otro-usuario' }))
      // ProblemDetails viaja como application/problem+json (RFC 9457): la cabecera va DESPUÉS de jsonBody, que pone application/json.
      .willRespondWith(404, (b) => b.jsonBody({ status: 404, code: 'NOT_FOUND', title: like('Reserva no encontrada.') }).headers({ 'Content-Type': 'application/problem+json' }))
      .executeTest(async (mockServer) => {
        await expect(bookings(mockServer.url).json('GET', `/bookings/${RESERVA_ID}`, { caller: { ownerId: 'partner:BOOKING_PROTOTIPO:otro-usuario' } })).rejects.toMatchObject({
          problem: { status: 404, code: 'NOT_FOUND' },
        });
      }));

  it('lee las tarifas, lo no volado y el equipaje para cotizar la postventa', () =>
    pact
      .addInteraction()
      .given('existe una reserva confirmada de un usuario de Booking')
      .uponReceiving('la lectura de las tarifas de la reserva')
      .withRequest('GET', `/bookings/${RESERVA_ID}/fares`, (b) => b.headers({ authorization: AUTORIZACION, 'x-owner-id': DUENO }))
      .willRespondWith(200, (b) =>
        b.jsonBody({
          bookingId: uuid(RESERVA_ID),
          status: 'CONFIRMED',
          channel: 'BOOKING',
          partnerId: 'BOOKING_PROTOTIPO',
          fares: eachLike({
            itineraryId: like('EA100-20271210'),
            cabinClass: like('ECONOMY'),
            fareBrand: like('SEMILLA'),
            segmentIds: eachLike('EA100-20271210'),
            price: dinero('127.00'),
            isRefundable: boolean(false),
            isChangeable: boolean(false),
          }),
          unflownItineraryIds: eachLike('EA100-20271210'),
          baggage: eachLike({ passengerId: like('P1'), itineraryId: like('EA100-20271210'), included: integer(0), purchased: integer(0) }),
          paymentReference: like('PAY-BKP-20261201-000001'),
        }),
      )
      .executeTest(async (mockServer) => {
        const tarifas = await bookings(mockServer.url).json<{ fares: { isRefundable: boolean }[]; unflownItineraryIds: string[] }>('GET', `/bookings/${RESERVA_ID}/fares`, { caller: { ownerId: DUENO } });
        expect(typeof tarifas.fares[0].isRefundable).toBe('boolean');
        expect(tarifas.unflownItineraryIds.length).toBeGreaterThan(0);
      }));

  it('registra una referencia de pago nueva (201) para el paso pago* de la saga', () => {
    const sagaId = '0c3e7a9b-1d2f-4a5b-8c6d-7e8f9a0b1c2d';
    const pedido = {
      sagaId,
      paymentReference: 'PAY-BKP-20261201-000099',
      provider: 'BOOKING_PROTOTIPO',
      operation: 'BOOKING',
      amount: { currency: 'USD', total: '127.00' },
      expectedAmount: { currency: 'USD', total: '127.00' },
    };
    return pact
      .addInteraction()
      .given('la referencia de pago PAY-BKP-20261201-000099 no se ha usado')
      .uponReceiving('el registro de una referencia de pago de Booking')
      .withRequest('POST', '/payment-references/claim', (b) => b.headers({ authorization: AUTORIZACION }).jsonBody(pedido))
      .willRespondWith(201, (b) =>
        b.jsonBody({
          paymentReference: 'PAY-BKP-20261201-000099',
          provider: 'BOOKING_PROTOTIPO',
          operation: 'BOOKING',
          amount: dinero('127.00'),
          sagaId: uuid(sagaId),
          claimedAt: datetime("yyyy-MM-dd'T'HH:mm:ss.SSSX", '2026-12-01T12:00:00.000Z'),
        }),
      )
      .executeTest(async (mockServer) => {
        const registro = await bookings(mockServer.url).json<{ sagaId: string }>('POST', '/payment-references/claim', { json: pedido });
        expect(registro.sagaId).toBe(sagaId);
      });
  });
});
