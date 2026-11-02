import { type DynamicModule, Inject, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureService, EcoServiceModule, type HealthCheck, JwksTokenVerifier, ServiceTokenGuard, TOKEN_VERIFIER, type TokenVerifier } from '@ecoairlines/shared';
import { BOOKINGS_CONFIG, type BookingsConfig } from './config/config.js';
import { BookingsController } from './http/bookings.controller.js';
import { BOOKINGS_STORE, type BookingsStore } from './repositories/bookings.store.js';
import { InMemoryBookingsStore } from './repositories/in-memory.store.js';
import { PostgresBookingsStore } from './repositories/postgres.store.js';
import { BookingsService } from './services/bookings.service.js';

export const SERVICE = { name: 'ms-g-bookings', version: '1.0.0' };

/** Crea las tablas al arrancar y cierra la base al apagar. */
@Injectable()
class StoreLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(BOOKINGS_STORE) private readonly store: BookingsStore) {}
  onModuleInit() {
    return this.store.init();
  }
  onModuleDestroy() {
    return this.store.close();
  }
}

export interface BookingsModuleOptions {
  store?: BookingsStore;
  /** Las pruebas pasan uno con su propia clave; en ejecución se usa la JWKS de Identity. */
  verifier?: TokenVerifier;
}

@Module({})
export class BookingsModule {
  static register(config: BookingsConfig, options: BookingsModuleOptions = {}): DynamicModule {
    const store = options.store ?? (config.databaseUrl ? new PostgresBookingsStore(config.databaseUrl) : new InMemoryBookingsStore());
    const database: HealthCheck = { name: 'database', check: async () => (store.kind === 'memory' ? 'memory' : (await store.ping()) ? 'up' : 'down') };
    return {
      module: BookingsModule,
      imports: [EcoServiceModule.forRoot({ ...SERVICE, healthChecks: [database] })],
      controllers: [BookingsController],
      providers: [
        { provide: BOOKINGS_CONFIG, useValue: config },
        { provide: BOOKINGS_STORE, useValue: store },
        { provide: TOKEN_VERIFIER, useValue: options.verifier ?? new JwksTokenVerifier(config.jwksUrl, { issuer: config.issuer, audience: config.audience }) },
        BookingsService,
        StoreLifecycle,
        ServiceTokenGuard,
      ],
    };
  }
}

export function setupApp(app: NestExpressApplication): void {
  configureService(app, SERVICE);
  // Una reserva trae sus itinerarios completos de Offers: hasta ~1 MB.
  app.useBodyParser('json', { limit: '1mb' });
}
