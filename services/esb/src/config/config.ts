import type { ObservabilityUrls } from '../clients/observability.client.js';
/**
 * Configuración del ESB. Las direcciones de los MS.G llegan por configuración (Docker Compose o la nube), nunca escritas en el
 * código. En producción son obligatorias las de los 9 MS.G, la JWKS y el secreto del ESB en Identity, el bus y la base; la
 * Payment API (canal web, V2.15) y el bus de Booking (BKG-01) son opcionales.
 */
export const REST_SERVICES = ['identity', 'customers', 'webhooks', 'schedule', 'flight-status', 'bookings', 'check-in'] as const;
export type RestService = (typeof REST_SERVICES)[number];

export interface EsbConfig {
  port: number;
  production: boolean;
  databaseUrl?: string;
  busUrl?: string;
  /** Bus del ecosistema de Booking (exchange `booking.events`, BKG-01). Sin él, los eventos de Booking llegan solo por webhook. */
  bookingBusUrl?: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
  /** Credenciales del ESB en Identity (`client_credentials` → token de servicio, D41). */
  clientId: string;
  clientSecret: string;
  /** URL base de cada MS.G REST. */
  urls: Record<RestService, string>;
  /** MS.G.Offers: gRPC (`host:puerto`) y su HTTP (solo `/health`). */
  offersGrpcAddress: string;
  offersHealthUrl: string;
  /** MS.G.PostSale: URL base (el SOAP está en `/soap/post-sale`). */
  postSaleUrl: string;
  /** Payment API simulada (canal web): URL y clave secreta `sk_test_…`. */
  paymentApiUrl?: string;
  paymentApiSecretKey?: string;
  /**
   * Cuánto espera el paso de captura a que un pago PENDING de la tarjeta se autorice (V2.17; la tarjeta de prueba tarda ~30 s).
   * La respuesta ya salió como 202 (`sagaDeadlineMs`) y la saga sigue; debe ser menor que el lease de la saga (60 s).
   */
  paymentPendingWaitMs: number;
  /** Plataforma de observabilidad (V2.16, D50): sin ellas, la telemetría del panel responde 503. */
  observability: ObservabilityUrls;
  /** Secreto compartido con Booking para la firma `X-Webhook-Signature` de sus eventos (BKG-01). */
  bookingEventsSecret: string;
  /** Formato de la referencia de pago de Booking (BKG-02: por confirmar con el grupo). */
  bookingPaymentReferencePattern: RegExp;
  /** Plazo de cada llamada a un MS.G: menor que el timeout de 5 s de Booking. */
  upstreamTimeoutMs: number;
  /** Cada cuánto se recalcula el health en segundo plano (se sirve desde caché, < 1 s). */
  healthRefreshMs: number;
  /** Cada cuánto se procesan los eventos de Booking pendientes (y los reintentos). */
  inboundIntervalMs: number;
  /** Cuánto espera una petición a su saga antes de responder 202: menor que el timeout del MS de respuesta (4,5 s), y este que los 5 s de Booking. */
  sagaDeadlineMs: number;
  /** Cada cuánto el trabajador de recuperación busca sagas abandonadas o pendientes de reintento. */
  sagaRecoveryMs: number;
  /** Cada cuánto se lee el catálogo de aeropuertos de Schedule (M-1); 0 lo apaga. */
  airportSyncMs: number;
  /** Cada cuánto el relé publica los eventos pendientes del outbox (además de hacerlo apenas se guarda uno). */
  outboxIntervalMs: number;
}

export const ESB_CONFIG = Symbol('ESB_CONFIG');

const DEV = {
  clientSecret: 'secreto-esb-dev-solo-local-0001',
  bookingEventsSecret: 'secreto-de-prueba-eventos-booking',
};

const DEFAULT_URLS: Record<RestService, string> = {
  identity: 'http://localhost:4001',
  customers: 'http://localhost:4002',
  webhooks: 'http://localhost:4003',
  schedule: 'http://localhost:4004',
  'flight-status': 'http://localhost:4005',
  bookings: 'http://localhost:4006',
  'check-in': 'http://localhost:4007',
};

/** `flight-status` → `FLIGHT_STATUS_URL`. */
export const urlVariable = (service: string) => `${service.toUpperCase().replace(/-/g, '_')}_URL`;

/**
 * URL de la plataforma de observabilidad. La API de administración de RabbitMQ usa, por defecto, el usuario y la contraseña
 * del bus (`BUS_URL`), así no se repiten secretos (`RABBITMQ_MANAGEMENT_USER`/`_PASSWORD` los reemplazan).
 */
function observabilityUrls(value: (name: string) => string | undefined): ObservabilityUrls {
  const trim = (url: string | undefined) => url?.replace(/\/+$/, '');
  const management = trim(value('RABBITMQ_MANAGEMENT_URL'));
  let rabbitmq: ObservabilityUrls['rabbitmq'];
  const bus = value('BUS_URL') ? new URL(value('BUS_URL')!) : undefined;
  const user = value('RABBITMQ_MANAGEMENT_USER') ?? (bus ? decodeURIComponent(bus.username) : undefined);
  const password = value('RABBITMQ_MANAGEMENT_PASSWORD') ?? (bus ? decodeURIComponent(bus.password) : undefined);
  if (management && user && password) rabbitmq = { url: management, user, password };
  return { ...(trim(value('PROMETHEUS_URL')) ? { prometheus: trim(value('PROMETHEUS_URL'))! } : {}), ...(trim(value('LOKI_URL')) ? { loki: trim(value('LOKI_URL'))! } : {}), ...(trim(value('ALERTMANAGER_URL')) ? { alertmanager: trim(value('ALERTMANAGER_URL'))! } : {}), ...(trim(value('TEMPO_URL')) ? { tempo: trim(value('TEMPO_URL'))! } : {}), ...(rabbitmq ? { rabbitmq } : {}) };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EsbConfig {
  const production = env['NODE_ENV'] === 'production';
  const required = [
    'DATABASE_URL',
    'BUS_URL',
    'IDENTITY_JWKS_URL',
    'ESB_CLIENT_SECRET',
    'BOOKING_EVENTS_SECRET',
    ...REST_SERVICES.map(urlVariable),
    'OFFERS_GRPC_ADDRESS',
    'OFFERS_URL',
    'POST_SALE_URL',
  ];
  const missing = required.filter((name) => production && !env[name]?.trim());
  if (missing.length) throw new Error(`Configuración inválida del ESB:\n - falta ${missing.join('\n - falta ')}`);
  const value = (name: string) => env[name]?.trim() || undefined;
  if (value('PAYMENT_API_URL') && !value('PAYMENT_API_SECRET_KEY')) throw new Error('Configuración inválida del ESB:\n - PAYMENT_API_URL sin PAYMENT_API_SECRET_KEY');
  const pattern = value('BOOKING_PAYMENT_REFERENCE_PATTERN');
  return {
    port: Number(env['PORT'] ?? 4000),
    production,
    databaseUrl: value('DATABASE_URL'),
    busUrl: value('BUS_URL'),
    bookingBusUrl: value('BOOKING_BUS_URL'),
    jwksUrl: value('IDENTITY_JWKS_URL') ?? 'http://localhost:4001/.well-known/jwks.json',
    issuer: env['IDENTITY_ISSUER'] ?? 'ecoairlines-identity',
    audience: env['IDENTITY_AUDIENCE'] ?? 'ecoairlines',
    clientId: value('ESB_CLIENT_ID') ?? 'ECOAIRLINES_ESB',
    clientSecret: value('ESB_CLIENT_SECRET') ?? DEV.clientSecret,
    urls: Object.fromEntries(REST_SERVICES.map((service) => [service, (value(urlVariable(service)) ?? DEFAULT_URLS[service]).replace(/\/+$/, '')])) as Record<RestService, string>,
    offersGrpcAddress: value('OFFERS_GRPC_ADDRESS') ?? 'localhost:50061',
    offersHealthUrl: (value('OFFERS_URL') ?? 'http://localhost:4009').replace(/\/+$/, ''),
    postSaleUrl: (value('POST_SALE_URL') ?? 'http://localhost:4008').replace(/\/+$/, ''),
    paymentApiUrl: value('PAYMENT_API_URL')?.replace(/\/+$/, ''),
    paymentApiSecretKey: value('PAYMENT_API_SECRET_KEY'),
    paymentPendingWaitMs: Number(env['PAYMENT_PENDING_WAIT_MS'] ?? 45_000),
    observability: observabilityUrls(value),
    bookingEventsSecret: value('BOOKING_EVENTS_SECRET') ?? DEV.bookingEventsSecret,
    bookingPaymentReferencePattern: pattern ? new RegExp(pattern) : /^PAY-BKP-(\d{8})-(\d{6})$/,
    upstreamTimeoutMs: Number(env['UPSTREAM_TIMEOUT_MS'] ?? 4_000),
    healthRefreshMs: Number(env['HEALTH_REFRESH_MS'] ?? 5_000),
    inboundIntervalMs: Number(env['INBOUND_INTERVAL_MS'] ?? 1_000),
    // 3,5 s: después de esperar, el ESB todavía consulta la reserva para el 202, y el MS de respuesta corta a los 4,5 s
    // (EsbClient). Con 4,5 s aquí el 202 llegaba tarde y el cliente veía 503 (V2.17, tarjeta pendiente).
    sagaDeadlineMs: Number(env['SAGA_DEADLINE_MS'] ?? 3_500),
    sagaRecoveryMs: Number(env['SAGA_RECOVERY_MS'] ?? 5_000),
    airportSyncMs: Number(env['AIRPORT_SYNC_MS'] ?? 60_000),
    outboxIntervalMs: Number(env['OUTBOX_INTERVAL_MS'] ?? 1_000),
  };
}
