import { type DynamicModule, Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureService, EcoServiceModule, type HealthCheck, JwksTokenVerifier, type TokenVerifier } from '@ecoairlines/shared';
import { type GatewayConfig, RESPONSE_SERVICES } from './config.js';
import { setupDocs } from './docs.js';
import { buildGatewaySchema, graphqlOptions } from './graphql/schema.js';
import { applyGatewaySecurity } from './http.js';
import { RestController } from './rest/rest.controller.js';
import { GATEWAY_RUNTIME, GatewayRuntime } from './runtime.js';

/**
 * Gateway (V2.13, PLAN.md §4.4): la única puerta pública. Fachada REST del contrato v2 (`/api/v2/vuelos/*`, Booking), GraphQL
 * (`/api/graphql`, la web) y Swagger (`/api/docs`). Solo habla con los 5 MS de respuesta: nunca con el ESB ni con un MS.G.
 */
export const SERVICE = { name: 'gateway', version: '1.0.0' };

export interface GatewayModuleOptions {
  verifier?: TokenVerifier;
}

export function createRuntime(config: GatewayConfig, options: GatewayModuleOptions = {}): GatewayRuntime {
  const verifier = options.verifier ?? new JwksTokenVerifier(config.jwksUrl, { issuer: config.issuer, audience: config.audience });
  return new GatewayRuntime(config, verifier);
}

@Module({})
export class GatewayModule {
  static register(runtime: GatewayRuntime): DynamicModule {
    const schema = buildGatewaySchema(runtime);
    // `GET /health`: cada MS de respuesta (su propio /health ya incluye el ESB).
    const checks: HealthCheck[] = RESPONSE_SERVICES.map((service) => ({
      name: service,
      check: async () => {
        try {
          return (await fetch(`${runtime.config.upstreams[service]}/health`, { signal: AbortSignal.timeout(2_000) })).ok ? 'up' : 'down';
        } catch {
          return 'down';
        }
      },
    }));
    return {
      module: GatewayModule,
      imports: [EcoServiceModule.forRoot({ ...SERVICE, healthChecks: checks }), GraphQLModule.forRoot(graphqlOptions(runtime, schema))],
      controllers: [RestController],
      providers: [{ provide: GATEWAY_RUNTIME, useValue: runtime }],
    };
  }
}

/** Se llama antes de `listen` (la app se crea con `bodyParser: false`). */
export function setupGateway(app: NestExpressApplication, runtime: GatewayRuntime): void {
  configureService(app, SERVICE);
  applyGatewaySecurity(app, runtime.config.security);
  if (runtime.config.docsEnabled) setupDocs(app, runtime.files);
}
