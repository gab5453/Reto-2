import { type DynamicModule, Inject, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureService, EcoServiceModule, type HealthCheck, JwksTokenVerifier, ServiceTokenGuard, TOKEN_VERIFIER, type TokenVerifier } from '@ecoairlines/shared';
import { InMemoryProfilesStore, PostgresProfilesStore, PROFILES_STORE, ProfilesController, ProfilesService, type ProfilesStore } from './customers.js';

export const SERVICE = { name: 'ms-g-customers', version: '1.0.0' };

export interface CustomersConfig {
  port: number;
  databaseUrl?: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
}

/** En producción `IDENTITY_JWKS_URL` es obligatoria (la URL de Identity es configuración, no código). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CustomersConfig {
  const jwksUrl = env['IDENTITY_JWKS_URL']?.trim();
  if (env['NODE_ENV'] === 'production' && !jwksUrl) throw new Error('Configuración inválida de ms-g-customers:\n - falta IDENTITY_JWKS_URL');
  return {
    port: Number(env['PORT'] ?? 4002),
    databaseUrl: env['DATABASE_URL']?.trim() || undefined,
    jwksUrl: jwksUrl ?? 'http://localhost:4001/.well-known/jwks.json',
    issuer: env['IDENTITY_ISSUER'] ?? 'ecoairlines-identity',
    audience: env['IDENTITY_AUDIENCE'] ?? 'ecoairlines',
  };
}

@Injectable()
class StoreLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(PROFILES_STORE) private readonly store: ProfilesStore) {}
  onModuleInit() {
    return this.store.init();
  }
  onModuleDestroy() {
    return this.store.close();
  }
}

@Module({})
export class CustomersModule {
  static register(config: CustomersConfig, options: { store?: ProfilesStore; verifier?: TokenVerifier } = {}): DynamicModule {
    const store = options.store ?? (config.databaseUrl ? new PostgresProfilesStore(config.databaseUrl) : new InMemoryProfilesStore());
    const database: HealthCheck = { name: 'database', check: async () => (store.kind === 'memory' ? 'memory' : (await store.ping()) ? 'up' : 'down') };
    return {
      module: CustomersModule,
      imports: [EcoServiceModule.forRoot({ ...SERVICE, healthChecks: [database] })],
      controllers: [ProfilesController],
      providers: [
        { provide: PROFILES_STORE, useValue: store },
        { provide: TOKEN_VERIFIER, useValue: options.verifier ?? new JwksTokenVerifier(config.jwksUrl, { issuer: config.issuer, audience: config.audience }) },
        ProfilesService,
        StoreLifecycle,
        ServiceTokenGuard,
      ],
    };
  }
}

export function setupApp(app: NestExpressApplication): void {
  configureService(app, SERVICE);
}
