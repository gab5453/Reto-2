import { MessageProviderPact, providerWithMetadata } from '@pact-foundation/pact';
import { DEFAULT_PRICING_SETTINGS, type FlightRecord, type OutboxRecord } from '../../../services/gestion/ms-g-offers/src/domain/model.js';
import type { OffersStore, OffersTx } from '../../../services/gestion/ms-g-offers/src/repositories/offers.store.js';
import { HoldsService } from '../../../services/gestion/ms-g-offers/src/services/holds.service.js';
import { pactFile, PARTICIPANTES } from '../comun.js';

/**
 * Verificación del PROVEEDOR de mensajes (CT-1): el evento lo produce el código REAL de MS.G.Offers (`HoldsService.create`, con
 * su repositorio como doble) y se toma tal como queda en el outbox, que es lo que el relé publica en RabbitMQ con la cabecera
 * `x-owner-id`. Pact compara ese mensaje con el que espera MS.G.Webhooks. Si Offers renombra un campo del evento, esto falla.
 */
const DUENO_HOLD = 'partner:BOOKING_PROTOTIPO:usr-pact';

/** Crea un hold con el código real de Offers y devuelve el evento que dejó en el outbox. */
async function eventoDeHoldCreado(): Promise<OutboxRecord> {
  const salida = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const segmentId = `EA100-${salida.replaceAll('-', '')}`;
  const vuelo: FlightRecord = {
    segmentId, flightNumber: 'EA100', date: salida, routeId: 'UIO-GYE', origin: 'UIO', destination: 'GYE',
    departureAt: `${salida}T08:00:00-05:00`, arrivalAt: `${salida}T08:50:00-05:00`, aircraftType: 'Airbus A220-300', registration: 'HC-J01', onSale: true,
  };
  const outbox: OutboxRecord[] = [];
  const tx = {
    flight: async () => vuelo,
    inventory: async () => [{ segmentId, cabinClass: 'ECONOMY', total: 110, counts: { HELD: 0, BOOKED: 0, TICKETED: 0, CHECKED_IN: 0, BOARDED: 0 } }],
    moveCupos: async () => true,
    farePrices: async () => [],
    pricingSettings: async () => DEFAULT_PRICING_SETTINGS,
    insertHold: async () => undefined,
    markStock: async () => undefined,
    addOutbox: async (record: OutboxRecord) => void outbox.push(record),
  } as unknown as OffersTx;
  const holds = new HoldsService({ transaction: (work: (t: OffersTx) => unknown) => work(tx) } as unknown as OffersStore);
  await holds.create({ offerId: segmentId, selections: [{ itineraryId: segmentId, cabinClass: 'ECONOMY', fareBrand: 'SEMILLA' }], passengers: { adults: 2 }, ownerId: DUENO_HOLD });
  return outbox[0];
}

it('MS.G.Offers produce el evento hold.created que espera MS.G.Webhooks', () =>
  new MessageProviderPact({
    provider: PARTICIPANTES.offers,
    pactUrls: [pactFile(PARTICIPANTES.webhooks, PARTICIPANTES.offers)],
    messageProviders: {
      'un evento hold.created': providerWithMetadata(async () => (await eventoDeHoldCreado()).event, { contentType: 'application/json', 'x-owner-id': DUENO_HOLD }),
    },
    stateHandlers: { 'un usuario de Booking retuvo asientos': async () => undefined },
    logLevel: 'warn',
  }).verify());

it('el dueño que viaja en x-owner-id es el del outbox (lo que el relé pone en la cabecera AMQP)', async () => {
  const record = await eventoDeHoldCreado();
  expect(record.ownerId).toBe(DUENO_HOLD);
  expect(JSON.stringify(record.event)).not.toContain(DUENO_HOLD); // el dueño nunca va en el cuerpo del evento
});
