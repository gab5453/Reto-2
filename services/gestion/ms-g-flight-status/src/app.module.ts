import { type DynamicModule, Inject, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type CloudEvent, configureService, EcoServiceModule, type HealthCheck, JwksTokenVerifier, ServiceTokenGuard, TOKEN_VERIFIER, type TokenVerifier } from '@ecoairlines/shared';
import { EventBus } from '@ecoairlines/shared/bus/amqp.js';
import { FLIGHT_STATUS_CONFIG, type FlightStatusConfig } from './config/config.js';
import { FlightStatusController } from './http/flight-status.controller.js';
import { FLIGHT_STATUS_STORE, type FlightStatusStore, InMemoryFlightStatusStore, PostgresFlightStatusStore } from './repositories/flight-status.store.js';
import { FlightStatusService, type SchedulePublishedData } from './services/flight-status.service.js';

export const SERVICE = { name: 'ms-g-flight-status', version: '1.0.0' };
/** Cola propia de FlightStatus en `ecoairlines.events` (events.asyncapi.yaml: consumeSchedulePublishedInternal). */
export const SCHEDULE_QUEUE = 'flight-status.schedule';

/** Al arrancar: tablas y suscripción a `schedule.published` (si hay bus). */
@Injectable()
export class FlightStatusLifecycle implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ScheduleProjection');
  bus?: EventBus;

  constructor(
    @Inject(FLIGHT_STATUS_STORE) private readonly store: FlightStatusStore,
    @Inject(FLIGHT_STATUS_CONFIG) private readonly config: FlightStatusConfig,
    @Inject(FlightStatusService) private readonly service: FlightStatusService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.init();
    if (!this.config.busUrl) return;
    this.bus = await EventBus.connect(this.config.busUrl);
    await this.bus.consume(SCHEDULE_QUEUE, ['schedule.published'], async ({ event }) => {
      const published = event as unknown as CloudEvent<SchedulePublishedData>;
      const applied = await this.service.applySchedulePublished(published);
      this.logger.log(applied ? `schedule.published ${published.data.from}…${published.data.to}: ${published.data.flights.length} vuelos` : `schedule.published ${event.id} ya aplicado`);
    }, { onDeadLetter: (info) => this.logger.error(`ALERTA: ${info.type ?? 'mensaje'} ${info.messageId ?? ''} a la cola de fallidos ${info.queue}.dlq tras ${info.attempts} intentos: ${info.reason}`) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.bus?.close();
    await this.store.close();
  }
}

export interface FlightStatusModuleOptions {
  store?: FlightStatusStore;
  verifier?: TokenVerifier;
}

let lifecycle: FlightStatusLifecycle | undefined;

@Module({})
export class FlightStatusModule {
  static register(config: FlightStatusConfig, options: FlightStatusModuleOptions = {}): DynamicModule {
    const store = options.store ?? (config.databaseUrl ? new PostgresFlightStatusStore(config.databaseUrl) : new InMemoryFlightStatusStore());
    const checks: HealthCheck[] = [
      { name: 'database', check: async () => (store.kind === 'memory' ? 'memory' : (await store.ping()) ? 'up' : 'down') },
      { name: 'bus', check: async () => (!config.busUrl ? 'memory' : (await lifecycle?.bus?.ping()) ? 'up' : 'down') },
    ];
    return {
      module: FlightStatusModule,
      imports: [EcoServiceModule.forRoot({ ...SERVICE, healthChecks: checks })],
      controllers: [FlightStatusController],
      providers: [
        { provide: FLIGHT_STATUS_CONFIG, useValue: config },
        { provide: FLIGHT_STATUS_STORE, useValue: store },
        { provide: TOKEN_VERIFIER, useValue: options.verifier ?? new JwksTokenVerifier(config.jwksUrl, { issuer: config.issuer, audience: config.audience }) },
        FlightStatusService,
        FlightStatusLifecycle,
        ServiceTokenGuard,
      ],
    };
  }
}

export function setupApp(app: NestExpressApplication): void {
  configureService(app, SERVICE);
  lifecycle = app.get(FlightStatusLifecycle);
}
