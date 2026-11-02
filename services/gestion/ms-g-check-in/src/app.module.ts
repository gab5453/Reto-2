import { type DynamicModule, Inject, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureService, EcoServiceModule, type HealthCheck, JwksTokenVerifier, ServiceTokenGuard, TOKEN_VERIFIER, type TokenVerifier } from '@ecoairlines/shared';
import { CHECK_IN_CONFIG, type CheckInConfig } from './config/config.js';
import { CheckInController } from './http/check-in.controller.js';
import { CHECK_IN_STORE, type CheckInStore, InMemoryCheckInStore, PostgresCheckInStore } from './repositories/check-in.store.js';
import { CheckInService } from './services/check-in.service.js';

export const SERVICE = { name: 'ms-g-check-in', version: '1.0.0' };

@Injectable()
class StoreLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(CHECK_IN_STORE) private readonly store: CheckInStore) {}
  onModuleInit() {
    return this.store.init();
  }
  onModuleDestroy() {
    return this.store.close();
  }
}

export interface CheckInModuleOptions {
  store?: CheckInStore;
  verifier?: TokenVerifier;
}

@Module({})
export class CheckInModule {
  static register(config: CheckInConfig, options: CheckInModuleOptions = {}): DynamicModule {
    const store = options.store ?? (config.databaseUrl ? new PostgresCheckInStore(config.databaseUrl) : new InMemoryCheckInStore());
    const database: HealthCheck = { name: 'database', check: async () => (store.kind === 'memory' ? 'memory' : (await store.ping()) ? 'up' : 'down') };
    return {
      module: CheckInModule,
      imports: [EcoServiceModule.forRoot({ ...SERVICE, healthChecks: [database] })],
      controllers: [CheckInController],
      providers: [
        { provide: CHECK_IN_CONFIG, useValue: config },
        { provide: CHECK_IN_STORE, useValue: store },
        { provide: TOKEN_VERIFIER, useValue: options.verifier ?? new JwksTokenVerifier(config.jwksUrl, { issuer: config.issuer, audience: config.audience }) },
        CheckInService,
        StoreLifecycle,
        ServiceTokenGuard,
      ],
    };
  }
}

export function setupApp(app: NestExpressApplication): void {
  configureService(app, SERVICE);
}
