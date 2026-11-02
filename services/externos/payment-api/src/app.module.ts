import { type DynamicModule, Inject, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { configureService, EcoServiceModule, type HealthCheck } from '@ecoairlines/shared';
import { PAYMENT_API_CONFIG, type PaymentApiConfig } from './config.js';
import { PaymentKeysGuard, PaymentsController } from './http/payments.controller.js';
import { InMemoryPaymentsStore, PAYMENTS_STORE, type PaymentsStore, PostgresPaymentsStore } from './repositories/payments.store.js';
import { PaymentsService } from './services/payments.service.js';

/**
 * Payment API simulada (V2.15, D7, D28, D49): pasarela de pagos con tarjeta del canal web. Es un SISTEMA EXTERNO (como Stripe):
 * no es un microservicio de EcoAirlines, no usa los tokens de Identity y solo la llaman el navegador y el ESB.
 */
export const SERVICE = { name: 'payment-api', version: '1.0.0' };

@Injectable()
export class PaymentsLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(PAYMENTS_STORE) private readonly store: PaymentsStore) {}
  async onModuleInit(): Promise<void> {
    await this.store.init();
  }
  async onModuleDestroy(): Promise<void> {
    await this.store.close();
  }
}

export interface PaymentApiModuleOptions {
  store?: PaymentsStore;
}

@Module({})
export class PaymentApiModule {
  static register(config: PaymentApiConfig, options: PaymentApiModuleOptions = {}): DynamicModule {
    const store = options.store ?? (config.databaseUrl ? new PostgresPaymentsStore(config.databaseUrl) : new InMemoryPaymentsStore());
    const checks: HealthCheck[] = [{ name: 'database', check: async () => (store.kind === 'memory' ? 'memory' : (await store.ping()) ? 'up' : 'down') }];
    return {
      module: PaymentApiModule,
      imports: [EcoServiceModule.forRoot({ ...SERVICE, healthChecks: checks })],
      controllers: [PaymentsController],
      providers: [
        { provide: PAYMENT_API_CONFIG, useValue: config },
        { provide: PAYMENTS_STORE, useValue: store },
        PaymentsService,
        PaymentKeysGuard,
        PaymentsLifecycle,
      ],
    };
  }
}

/**
 * Plantilla común (correlation ID, ProblemDetails, validación estricta) + lo propio de una pasarela: solo JSON (CSP
 * `default-src 'none'`), CORS solo para la web con `X-Api-Key`, y cuerpos chicos (una tarjeta o un monto).
 */
export function setupApp(app: NestExpressApplication, config: PaymentApiConfig): void {
  configureService(app, SERVICE);
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, strictTransportSecurity: config.production ? { maxAge: 31_536_000, includeSubDomains: true } : false }));
  app.enableCors({
    origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Api-Key', 'Idempotency-Key', 'X-Correlation-Id', 'X-Request-Id'],
    exposedHeaders: ['X-Correlation-Id', 'X-Request-Id', 'Location', 'Idempotent-Replayed', 'Retry-After'],
    credentials: false,
    maxAge: 600,
  });
  app.useBodyParser('json', { limit: '16kb' });
}
