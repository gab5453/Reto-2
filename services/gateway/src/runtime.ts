import type { TokenVerifier } from '@ecoairlines/shared';
import { ContractFiles, RateLimiter } from '@ecoairlines/shared/respuesta/index.js';
import type { GatewayConfig } from './config.js';
import { buildRestRoutes, type RestRoutes } from './rest/routes.js';
import { Upstreams } from './upstream.js';

export const GATEWAY_RUNTIME = Symbol('GATEWAY_RUNTIME');

/** Lo que el gateway arma una vez al arrancar (y que las pruebas pueden reemplazar: el verificador y las URL de los MS). */
export class GatewayRuntime {
  readonly files = new ContractFiles();
  readonly routes: RestRoutes;
  readonly limiter: RateLimiter;
  readonly upstreams: Upstreams;

  constructor(
    readonly config: GatewayConfig,
    readonly verifier: TokenVerifier,
  ) {
    this.routes = buildRestRoutes(this.files);
    this.limiter = new RateLimiter(config.security.rateLimit.windowMs);
    this.upstreams = new Upstreams(config);
  }
}
