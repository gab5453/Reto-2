import { createCloudEvent, signWebhook, WEBHOOK_SIGNATURE_HEADER, type ProblemDetailsException } from '@ecoairlines/shared';
import type { WebhooksConfig } from '../config/config.js';
import { SecretBox, type DeliveryRecord, type EventRecord, type SubscriptionRecord } from '../domain/rules.js';
import type { WebhooksStore } from '../repositories/webhooks.store.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * PU-2 (Informacion_General/Pruebas.md §5.1.2): WebhooksService con el repositorio y `fetch` como dobles: suscripciones, a quién
 * se entrega cada evento (D40), la firma HMAC y los reintentos. Nada sale a la red.
 */

const AHORA = Date.parse('2026-12-01T12:00:00Z');
const CONFIG = { encryptionKey: 'clave-de-prueba', allowPrivateUrls: true } as WebhooksConfig;
const caja = new SecretBox(CONFIG.encryptionKey);
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
};

const suscripcion = (over: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  id: 'sub-1',
  ownerId: 'partner:BOOKING_PROTOTIPO',
  url: 'http://booking-simulado:3000/hooks',
  events: ['booking.confirmed'],
  secretEncrypted: caja.seal('whsec_secreto_1234'),
  active: true,
  createdAt: 'x',
  ...over,
});
const evento = (name = 'booking.confirmed', ownerId: string | null = 'partner:BOOKING_PROTOTIPO:u-1'): EventRecord => {
  const cloud = createCloudEvent({ name, visibility: 'public', subject: 'b-1', data: { bookingId: 'b-1' }, correlationId: 'corr-1' });
  return { seq: 7, id: cloud.id, type: cloud.type, name, subject: 'b-1', time: cloud.time, correlationId: 'corr-1', ownerId, public: true, event: cloud };
};
const entrega = (over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({ eventSeq: 7, subscriptionId: 'sub-1', outcome: 'PENDING', attempts: 0, httpStatus: null, lastAttemptAt: null, nextRetryAt: null, deliveredAt: null, ...over });

let store: { [K in keyof WebhooksStore]: ReturnType<typeof vi.fn> };
let service: WebhooksService;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  store = {
    insertSubscription: vi.fn(),
    subscriptions: vi.fn().mockResolvedValue([]),
    subscription: vi.fn().mockResolvedValue(suscripcion()),
    activeSubscriptionsFor: vi.fn().mockResolvedValue([]),
    deactivate: vi.fn(),
    countActiveSubscriptions: vi.fn(),
    ingest: vi.fn(async (record) => ({ ...record, seq: 7 })),
    eventById: vi.fn(),
    eventBySeq: vi.fn().mockResolvedValue(evento()),
    publicEventsAfter: vi.fn().mockResolvedValue([]),
    history: vi.fn(),
    deliveriesOf: vi.fn(),
    claimDue: vi.fn().mockResolvedValue([]),
    saveDelivery: vi.fn(),
    deliveryStats: vi.fn(),
  } as unknown as typeof store;
  service = new WebhooksService(store as unknown as WebhooksStore, CONFIG);
  service.now = () => AHORA;
  fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  service.fetcher = fetcher as unknown as typeof fetch;
});

describe('suscripciones', () => {
  it('guarda el secreto cifrado, sin eventos repetidos, y muestra solo sus últimos 4 caracteres', async () => {
    const view = await service.subscribe('partner:BOOKING_PROTOTIPO', { url: 'http://booking-simulado:3000/hooks', events: ['booking.confirmed', 'booking.confirmed'], secret: 'whsec_secreto_1234' });
    const guardada = store.insertSubscription.mock.calls[0][0] as SubscriptionRecord;
    expect(guardada.events).toEqual(['booking.confirmed']);
    expect(guardada.secretEncrypted).not.toContain('whsec');
    expect(view.secretHint).toBe('1234');
    expect(view).not.toHaveProperty('secretEncrypted');
  });
  it('en producción, una URL interna se rechaza (SSRF) y no se guarda', async () => {
    const produccion = new WebhooksService(store as unknown as WebhooksStore, { ...CONFIG, allowPrivateUrls: false });
    expect(await codeOf(produccion.subscribe('p', { url: 'https://10.0.0.1/x', events: [], secret: 's' }))).toBe('WEBHOOK_URL_NOT_ALLOWED');
    expect(store.insertSubscription).not.toHaveBeenCalled();
  });
  it('dar de baja la suscripción de otro dueño → 404', async () => {
    expect(await codeOf(service.unsubscribe('otro', 'sub-1'))).toBe('NOT_FOUND');
    expect(store.deactivate).not.toHaveBeenCalled();
  });
});

describe('ingest: a quién se le entrega cada evento (D40)', () => {
  it('crea una entrega solo para los suscriptores que pueden recibirlo', async () => {
    store.activeSubscriptionsFor.mockResolvedValue([suscripcion(), suscripcion({ id: 'sub-otro', ownerId: 'partner:OTRO' }), suscripcion({ id: 'sub-admin', ownerId: 'admin-1' })]);
    await service.ingest(evento().event, 'partner:BOOKING_PROTOTIPO:u-1');
    expect(store.ingest.mock.calls[0][1]).toEqual(['sub-1', 'sub-admin']);
  });
  it('un evento interno se guarda pero no se entrega a nadie', async () => {
    const interno = createCloudEvent({ name: 'schedule.published', visibility: 'internal', subject: 'x', data: {}, correlationId: 'c' });
    await service.ingest(interno, undefined);
    expect(store.activeSubscriptionsFor).not.toHaveBeenCalled();
    expect(store.ingest.mock.calls[0][1]).toEqual([]);
  });
});

describe('entrega con firma y reintentos', () => {
  beforeEach(() => store.claimDue.mockResolvedValue([entrega()]));

  it('envía el CloudEvent firmado con HMAC del secreto y el correlation ID', async () => {
    expect(await service.deliverDue()).toBe(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('http://booking-simulado:3000/hooks');
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(signWebhook('whsec_secreto_1234', String(init.body)));
    expect(headers['x-correlation-id']).toBe('corr-1');
    expect(init.redirect).toBe('manual');
    expect(store.saveDelivery).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'DELIVERED', attempts: 1, httpStatus: 204, nextRetryAt: null }));
  });
  it('el cuerpo es el CloudEvent tal cual: nunca incluye el dueño', async () => {
    await service.deliverDue();
    const body = String((fetcher.mock.calls[0][1] as RequestInit).body);
    expect(body).not.toContain('partner:BOOKING_PROTOTIPO:u-1');
  });
  it('un 500 deja la entrega RETRYING para dentro de 1 minuto', async () => {
    fetcher.mockResolvedValue(new Response(null, { status: 500 }));
    expect(await service.deliverDue()).toBe(0);
    expect(store.saveDelivery).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'RETRYING', httpStatus: 500, nextRetryAt: new Date(AHORA + 60_000).toISOString() }));
  });
  it('una redirección (3xx) no cuenta como entregada', async () => {
    fetcher.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://otro' } }));
    await service.deliverDue();
    expect(store.saveDelivery).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'RETRYING' }));
  });
  it('si la red falla, también reintenta (sin código HTTP)', async () => {
    fetcher.mockRejectedValue(new Error('ECONNREFUSED'));
    await service.deliverDue();
    expect(store.saveDelivery).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'RETRYING', httpStatus: null }));
  });
  it('tras el sexto intento fallido queda EXHAUSTED', async () => {
    store.claimDue.mockResolvedValue([entrega({ attempts: 5 })]);
    fetcher.mockResolvedValue(new Response(null, { status: 500 }));
    await service.deliverDue();
    expect(store.saveDelivery).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'EXHAUSTED', attempts: 6, nextRetryAt: null }));
  });
  it('si la suscripción se dio de baja, la entrega se cancela sin enviar', async () => {
    store.subscription.mockResolvedValue(suscripcion({ active: false }));
    await service.deliverDue();
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.saveDelivery).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'CANCELLED' }));
  });
});

describe('feed de respaldo (GET /vuelos/eventos)', () => {
  it('un after que no existe → VALIDATION_FAILED', async () => expect(await codeOf(service.feed('p', 'no-existe', 10))).toBe('VALIDATION_FAILED'));
  it('devuelve solo lo que el dueño puede leer y el cursor siguiente', async () => {
    const mio = evento();
    store.publicEventsAfter.mockResolvedValue([mio, { ...evento('booking.confirmed', 'cliente-web'), seq: 8 }]);
    const feed = await service.feed('partner:BOOKING_PROTOTIPO', undefined, 10);
    expect(feed.events).toEqual([mio.event]);
    expect(feed.metadata).toMatchObject({ total: 1, next_after: mio.id });
  });
});
