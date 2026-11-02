import { REST_SERVICES, type EsbConfig, type RestService } from '../config/config.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { OffersClient } from './offers.client.js';
import { ObservabilityClient } from './observability.client.js';
import { PaymentApiClient } from './payment-api.client.js';
import { PostSaleClient } from './post-sale.client.js';
import { RestClient } from './rest.client.js';
import { ServiceTokenProvider, type TokenSource } from './service-token.js';

/** Nombre de cada MS.G en el health y en los mensajes de error. */
export const SERVICE_NAMES: Record<RestService | 'offers' | 'post-sale', string> = {
  identity: 'ms-g-identity',
  customers: 'ms-g-customers',
  webhooks: 'ms-g-webhooks',
  schedule: 'ms-g-schedule',
  'flight-status': 'ms-g-flight-status',
  bookings: 'ms-g-bookings',
  'check-in': 'ms-g-check-in',
  offers: 'ms-g-offers',
  'post-sale': 'ms-g-post-sale',
};

/** Los clientes hacia los 9 MS.G y la Payment API, con un mismo token de servicio (D41). */
export class Upstreams {
  readonly rest: Record<RestService, RestClient>;
  readonly offers: OffersClient;
  readonly postSale: PostSaleClient;
  readonly payments?: PaymentApiClient;
  /** Plataforma de observabilidad (V2.16): Prometheus, Loki, RabbitMQ y Alertmanager, solo lectura. */
  readonly observability: ObservabilityClient;

  constructor(
    readonly config: EsbConfig,
    readonly tokens: TokenSource = new ServiceTokenProvider(config.urls.identity, config.clientId, config.clientSecret, config.upstreamTimeoutMs),
  ) {
    this.rest = Object.fromEntries(REST_SERVICES.map((service) => [service, new RestClient(SERVICE_NAMES[service], config.urls[service], tokens, config.upstreamTimeoutMs)])) as Record<RestService, RestClient>;
    this.offers = new OffersClient(config.offersGrpcAddress, tokens, config.upstreamTimeoutMs);
    this.postSale = new PostSaleClient(config.postSaleUrl, tokens, config.upstreamTimeoutMs);
    if (config.paymentApiUrl && config.paymentApiSecretKey) this.payments = new PaymentApiClient(config.paymentApiUrl, config.paymentApiSecretKey, config.upstreamTimeoutMs);
    this.observability = new ObservabilityClient(config.observability);
  }

  breakers(): CircuitBreaker[] {
    return [...Object.values(this.rest).map((client) => client.breaker), this.offers.breaker, this.postSale.breaker, ...(this.payments ? [this.payments.breaker] : [])];
  }

  close(): void {
    this.offers.close();
  }
}

export const UPSTREAMS = Symbol('UPSTREAMS');
