import { type DynamicModule, Inject, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureService, EcoServiceModule, type HealthCheck, JwksTokenVerifier, ServiceTokenGuard, TOKEN_VERIFIER, type TokenVerifier } from '@ecoairlines/shared';
import { EventBus } from '@ecoairlines/shared/bus/amqp.js';
import { WEBHOOKS_CONFIG, type WebhooksConfig } from './config/config.js';
import { WebhooksController } from './http/webhooks.controller.js';
import { InMemoryWebhooksStore, PostgresWebhooksStore, WEBHOOKS_STORE, type WebhooksStore } from './repositories/webhooks.store.js';
import { WebhooksService } from './services/webhooks.service.js';

export const SERVICE = { name: 'ms-g-webhooks', version: '1.0.0' };
/** Cola propia de Webhooks: TODOS los eventos de `ecoairlines.events` (públicos para entregar; internos para el historial). */
export const EVENTS_QUEUE = 'webhooks.events';

/** Al arrancar: tablas, consumidor del bus y despachador de entregas (cada `dispatchIntervalMs`). */
@Injectable()
export class WebhooksLifecycle implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Webhooks');
  private timer?: NodeJS.Timeout;
  private dispatching = false;
  bus?: EventBus;

  constructor(
    @Inject(WEBHOOKS_STORE) private readonly store: WebhooksStore,
    @Inject(WEBHOOKS_CONFIG) private readonly config: WebhooksConfig,
    @Inject(WebhooksService) private readonly service: WebhooksService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.init();
    if (this.config.busUrl) {
      this.bus = await EventBus.connect(this.config.busUrl);
      await this.bus.consume(EVENTS_QUEUE, ['#'], async ({ event, ownerId }) => {
        await this.service.ingest(event, ownerId);
        void this.dispatch();
      }, { onDeadLetter: (info) => this.logger.error(`ALERTA: ${info.type ?? 'mensaje'} ${info.messageId ?? ''} a la cola de fallidos ${info.queue}.dlq tras ${info.attempts} intentos: ${info.reason}`) });
    }
    this.timer = setInterval(() => void this.dispatch(), this.config.dispatchIntervalMs);
    this.timer.unref();
  }

  /** Una vuelta del despachador (nunca dos a la vez en la misma réplica). */
  async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      await this.service.deliverDue();
    } catch (error) {
      this.logger.error(`Despachador: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.dispatching = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.bus?.close();
    await this.store.close();
  }
}

export interface WebhooksModuleOptions {
  store?: WebhooksStore;
  verifier?: TokenVerifier;
}

let lifecycle: WebhooksLifecycle | undefined;

@Module({})
export class WebhooksModule {
  static register(config: WebhooksConfig, options: WebhooksModuleOptions = {}): DynamicModule {
    const store = options.store ?? (config.databaseUrl ? new PostgresWebhooksStore(config.databaseUrl) : new InMemoryWebhooksStore());
    const checks: HealthCheck[] = [
      { name: 'database', check: async () => (store.kind === 'memory' ? 'memory' : (await store.ping()) ? 'up' : 'down') },
      { name: 'bus', check: async () => (!config.busUrl ? 'memory' : (await lifecycle?.bus?.ping()) ? 'up' : 'down') },
    ];
    return {
      module: WebhooksModule,
      imports: [EcoServiceModule.forRoot({ ...SERVICE, healthChecks: checks })],
      controllers: [WebhooksController],
      providers: [
        { provide: WEBHOOKS_CONFIG, useValue: config },
        { provide: WEBHOOKS_STORE, useValue: store },
        { provide: TOKEN_VERIFIER, useValue: options.verifier ?? new JwksTokenVerifier(config.jwksUrl, { issuer: config.issuer, audience: config.audience }) },
        WebhooksService,
        WebhooksLifecycle,
        ServiceTokenGuard,
      ],
    };
  }
}

export function setupApp(app: NestExpressApplication): void {
  configureService(app, SERVICE);
  lifecycle = app.get(WebhooksLifecycle);
}
