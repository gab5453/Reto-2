import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { type CloudEvent, eventName, isPublicEvent, ProblemDetailsException } from '@ecoairlines/shared';

/** Reglas de MS.G.Webhooks (contract/ms-g-webhooks.openapi.yaml). Funciones puras salvo la resolución DNS de la URL. */
export const PUBLIC_EVENTS = [
  'hold.created', 'hold.expired', 'booking.confirmed', 'booking.failed', 'booking.changed', 'booking.cancelled', 'booking.baggage_added',
  'booking.seat_changed', 'booking.ticket_issuing', 'booking.ticket_issued', 'booking.ticket_failed', 'booking.checked_in',
  'flight.status_changed', 'flight.schedule_changed', 'flight.cancelled',
] as const;
export type PublicEventName = (typeof PUBLIC_EVENTS)[number];

/** Reintentos tras el primer intento fallido: 1 min, 5 min, 30 min, 2 h y 6 h; después EXHAUSTED. */
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];
export const DELIVERY_TIMEOUT_MS = 5_000;

export interface SubscriptionRecord {
  id: string;
  ownerId: string;
  url: string;
  events: PublicEventName[];
  secretEncrypted: string;
  active: boolean;
  createdAt: string;
}

export interface EventRecord {
  seq: number;
  id: string;
  type: string;
  name: string;
  subject: string | null;
  time: string;
  correlationId: string | null;
  /** Dueño del hold o la reserva (cabecera AMQP `x-owner-id`); nunca sale en la entrega. */
  ownerId: string | null;
  public: boolean;
  event: CloudEvent;
}

export type DeliveryOutcome = 'PENDING' | 'DELIVERED' | 'RETRYING' | 'EXHAUSTED' | 'CANCELLED';

export interface DeliveryRecord {
  eventSeq: number;
  subscriptionId: string;
  outcome: DeliveryOutcome;
  attempts: number;
  httpStatus: number | null;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  deliveredAt: string | null;
}

/**
 * Quién recibe qué (D40). Un suscriptor partner (`partner:<clientId>`) recibe `hold.*` y `booking.*` solo de su canal
 * (`ownerId` = `partner:<clientId>:…`) y `flight.*` siempre; un suscriptor de EcoAirlines (`sub` de un ADMIN) recibe todo lo
 * público. Los eventos internos no salen nunca.
 */
export function canReceive(subscriberOwnerId: string, event: Pick<EventRecord, 'name' | 'public' | 'ownerId'>): boolean {
  if (!event.public) return false;
  if (!subscriberOwnerId.startsWith('partner:')) return true;
  if (event.name.startsWith('flight.')) return true;
  return !!event.ownerId && event.ownerId.startsWith(`${subscriberOwnerId}:`);
}

/**
 * Quién lee qué en el feed (`GET /vuelos/eventos`, V2.13). El partner, como en sus webhooks (`canReceive`). Un usuario de la
 * web: si es ADMIN (el ESB manda `X-Actor-Id` = su `sub`), todo lo público, como su suscripción; si no (un CLIENTE), **solo
 * los eventos de sus propias reservas** (`ownerId` = su `sub`). Antes un CLIENTE veía los eventos de todos los canales.
 */
export function canReadFeed(ownerId: string, actorId: string | undefined, event: Pick<EventRecord, 'name' | 'public' | 'ownerId'>): boolean {
  if (ownerId.startsWith('partner:') || (actorId !== undefined && actorId === ownerId)) return canReceive(ownerId, event);
  return event.public && event.ownerId === ownerId;
}

export const toEventRecord = (event: CloudEvent, ownerId: string | undefined): Omit<EventRecord, 'seq'> => ({
  id: event.id,
  type: event.type,
  name: eventName(event.type),
  subject: event.subject ?? null,
  time: event.time,
  correlationId: event.correlationid ?? null,
  ownerId: ownerId ?? null,
  public: isPublicEvent(event),
  event,
});

/** Siguiente intento después de `attempts` intentos fallidos; `null` = agotado. */
export const nextRetryAt = (attempts: number, now: number): string | null =>
  attempts - 1 < RETRY_DELAYS_MS.length ? new Date(now + RETRY_DELAYS_MS[attempts - 1]!).toISOString() : null;

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const isPrivateAddress = (address: string) =>
  isIP(address) === 6 ? /^(::1|fc|fd|fe80|::ffff:(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i.test(address) || address === '::' : PRIVATE_V4.some((range) => range.test(address));

/**
 * URL de una suscripción (contra SSRF): en producción `https` y un host que resuelva a direcciones públicas; en desarrollo
 * también `http` y la red interna (para booking-simulado).
 */
export async function assertAllowedUrl(raw: string, production: boolean): Promise<void> {
  const reject = (reason: string) =>
    new ProblemDetailsException({ status: 422, code: 'WEBHOOK_URL_NOT_ALLOWED', title: 'La URL del webhook debe ser https y pública.', invalidParams: [{ name: 'url', reason }] });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw reject('no es una URL');
  }
  if (url.username || url.password) throw reject('sin credenciales en la URL');
  if (!production) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw reject('http o https');
    return;
  }
  if (url.protocol !== 'https:') throw reject('debe ser https');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw reject('host interno');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
  if (!addresses.length) throw reject('el host no resuelve');
  if (addresses.some(isPrivateAddress)) throw reject('apunta a una red privada');
}

/** El secreto se necesita en claro para firmar: se guarda cifrado con AES-256-GCM (clave de WEBHOOKS_ENCRYPTION_KEY). */
export class SecretBox {
  private readonly key: Buffer;

  constructor(material: string) {
    this.key = createHash('sha256').update(material).digest();
  }

  seal(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
  }

  open(sealed: string): string {
    const [iv, tag, data] = sealed.split('.').map((part) => Buffer.from(part, 'base64url')) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}

/** Host de la URL, sin ruta ni query (para no exponer tokens en el historial). */
export const targetOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};
