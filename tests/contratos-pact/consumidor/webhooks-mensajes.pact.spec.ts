import { MatchersV3, MessageConsumerPact } from '@pact-foundation/pact';
import type { CloudEvent } from '@ecoairlines/shared';
import type { WebhooksConfig } from '../../../services/gestion/ms-g-webhooks/src/config/config.js';
import { SecretBox, type SubscriptionRecord } from '../../../services/gestion/ms-g-webhooks/src/domain/rules.js';
import type { WebhooksStore } from '../../../services/gestion/ms-g-webhooks/src/repositories/webhooks.store.js';
import { WebhooksService } from '../../../services/gestion/ms-g-webhooks/src/services/webhooks.service.js';
import { PACT_DIR, PARTICIPANTES } from '../comun.js';

/**
 * Contrato de MENSAJES del CONSUMIDOR (CT-1, «Pact de mensajes»): MS.G.Offers publica `hold.created` en el bus (RabbitMQ,
 * CloudEvents) con el dueño del hold en la cabecera `x-owner-id`, y MS.G.Webhooks lo guarda y lo reparte a los suscriptores que
 * pueden recibirlo (D40). No hay HTTP: Pact entrega el mensaje de ejemplo directamente al código real del consumidor
 * (`WebhooksService.ingest`), y el proveedor demuestra después que su código produce un mensaje con esa misma forma.
 */
const { like, integer, uuid, regex, datetime } = MatchersV3;
const DUENO_HOLD = 'partner:BOOKING_PROTOTIPO:usr-pact';

/** Webhooks con su almacén como doble: una suscripción de Booking y una de otro partner (que no debe recibirlo). */
function webhooks() {
  const caja = new SecretBox('clave-de-prueba');
  const suscripcion = (id: string, ownerId: string): SubscriptionRecord => ({ id, ownerId, url: 'https://hooks.example/x', events: ['hold.created'], secretEncrypted: caja.seal('s'), active: true, createdAt: 'x' });
  const store = {
    activeSubscriptionsFor: vi.fn().mockResolvedValue([suscripcion('sub-booking', 'partner:BOOKING_PROTOTIPO'), suscripcion('sub-otro', 'partner:OTRO_PARTNER')]),
    ingest: vi.fn(async (record: object, _destinatarios: string[]) => ({ ...record, seq: 1 })),
  };
  return { store, service: new WebhooksService(store as unknown as WebhooksStore, { encryptionKey: 'clave-de-prueba', allowPrivateUrls: true } as WebhooksConfig) };
}

describe('MS.G.Offers → MS.G.Webhooks: evento hold.created (bus)', () => {
  const messagePact = new MessageConsumerPact({ consumer: PARTICIPANTES.webhooks, provider: PARTICIPANTES.offers, dir: PACT_DIR, logLevel: 'warn' });

  it('Webhooks guarda el evento público y lo entrega solo al partner dueño del hold (D40)', () => {
    const { store, service } = webhooks();
    return messagePact
      .given('un usuario de Booking retuvo asientos')
      .expectsToReceive('un evento hold.created')
      .withContent({
        specversion: '1.0',
        id: uuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301'),
        source: like('/aerolineas/ecoairlines/vuelos'),
        type: 'ec.edu.epn.booking.vuelos.hold.created',
        time: datetime("yyyy-MM-dd'T'HH:mm:ss.SSSX", '2026-12-01T12:00:00.000Z'),
        subject: uuid('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'),
        datacontenttype: 'application/json',
        correlationid: like('corr-de-ejemplo'),
        data: {
          holdId: uuid('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'),
          offerId: like('EA100-20271210'),
          seatsHeld: integer(2),
          expiresAt: datetime("yyyy-MM-dd'T'HH:mm:ss.SSSX", '2026-12-01T12:15:00.000Z'),
        },
      })
      .withMetadata({ 'x-owner-id': regex(/^partner:[A-Z_]+:.+$/, DUENO_HOLD) })
      .verify(async (message) => {
        // El código real del consumidor, con el contenido y la cabecera tal como llegan del bus.
        await service.ingest(message.contents as unknown as CloudEvent, (message.metadata as Record<string, string>)['x-owner-id']);
        const [record, destinatarios] = store.ingest.mock.calls[0];
        expect(record).toMatchObject({ name: 'hold.created', public: true, ownerId: DUENO_HOLD });
        expect(destinatarios).toEqual(['sub-booking']);
      });
  });
});
