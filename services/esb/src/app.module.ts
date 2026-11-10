import { type DynamicModule, Inject, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AirportCatalogSync } from './clients/airport-catalog.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ACCEPTED_SERVICE_SCOPES, configureService, EcoServiceModule, ESB_CALLER_SCOPE, type HealthCheck, INTERNAL_SCOPE, JwksTokenVerifier, ServiceTokenGuard, TOKEN_VERIFIER, type TokenVerifier } from '@ecoairlines/shared';
import { EventBus } from '@ecoairlines/shared/bus/amqp.js';
import { OutboxRelay } from '@ecoairlines/shared/bus/outbox.js';
import { ProblemDetailsException } from '@ecoairlines/shared';
import { Upstreams, UPSTREAMS } from './clients/upstreams.js';
import { CompositionService } from './composition/composition.service.js';
import { PostSaleComposition } from './composition/post-sale.composition.js';
import { HealthCompositionService, OWN_CHECKS, type OwnChecks } from './composition/health.service.js';
import { ESB_CONFIG, type EsbConfig } from './config/config.js';
import { CompositionController } from './http/composition.controller.js';
import { SagasController } from './http/sagas.controller.js';
import { InboundController } from './http/inbound.controller.js';
import { RouterController } from './http/router.controller.js';
import { EVENTS_PUBLISHER, type EventsPublisher, OutboxEventsPublisher } from './inbound/events-publisher.js';
import { BOOKING_ROUTING_KEYS } from './inbound/inbound-event.js';
import { InboundHandlers } from './inbound/inbound-handlers.js';
import { InboundService } from './inbound/inbound.service.js';
import { ESB_STORE, type EsbStore, InMemoryEsbStore, PostgresEsbStore } from './repositories/esb.store.js';
import { RouterService } from './router/router.service.js';
import { AddBaggageSaga, AssistanceReadySaga, CancelBookingSaga, ChangeDateSaga, ChangeSeatsSaga, CheckInSaga, CreateBookingSaga, IssueTicketsSaga, PaymentFailedSaga, SagaDeps } from './sagas/booking-sagas.js';
import { DEFERRED_QUEUE, type DeferredTask, DeferredScheduler } from './sagas/deferred.js';
import { SagaEngine } from './sagas/engine.js';
import { FlightStatusSaga, PublishTimetableSaga, SavePricesSaga } from './sagas/operations-sagas.js';
import { SagasService } from './sagas/sagas.service.js';
import { IdempotencyService } from './transversal/idempotency.service.js';

export const SERVICE = { name: 'esb', version: '1.0.0' };
/** Exchange del ecosistema de Booking y la cola propia del ESB en él (BKG-01, events.asyncapi.yaml). */
export const BOOKING_EXCHANGE = 'booking.events';
export const BOOKING_QUEUE = 'ecoairlines.esb.booking-inbound';

/** Conexiones al bus interno y al de Booking (si están configurados) y el relé del outbox. */
export class Buses {
  internal?: EventBus;
  booking?: EventBus;
  relay?: OutboxRelay;
}

/** Al arrancar: tablas, buses, consumidor de Booking por AMQP, caché del health y trabajador de eventos entrantes. */
@Injectable()
export class EsbLifecycle implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Esb');

  constructor(
    @Inject(ESB_STORE) private readonly store: EsbStore,
    @Inject(ESB_CONFIG) private readonly config: EsbConfig,
    @Inject(Buses) private readonly buses: Buses,
    @Inject(UPSTREAMS) private readonly upstreams: Upstreams,
    @Inject(InboundService) private readonly inbound: InboundService,
    @Inject(HealthCompositionService) private readonly health: HealthCompositionService,
    @Inject(SagaEngine) private readonly engine: SagaEngine,
    // Se inyecta para que registre las sagas en el motor antes de la primera ronda de recuperación.
    @Inject(SagasService) private readonly _sagas: SagasService,
  ) {}

  private airports?: AirportCatalogSync;

  async onModuleInit(): Promise<void> {
    await this.store.init();
    this.airports = new AirportCatalogSync(this.upstreams.rest.schedule, this.config.airportSyncMs);
    this.airports.start();
    if (this.config.busUrl) {
      const bus = await EventBus.connect(this.config.busUrl);
      this.buses.internal = bus;
      // Outbox → RabbitMQ (V2.11) y reintentos diferidos de las sagas (esb.deferred, TTL + dead letter).
      this.buses.relay = new OutboxRelay(this.store, () => this.buses.internal, this.logger, { intervalMs: this.config.outboxIntervalMs });
      this.buses.relay.start();
      this.buses.relay.kick();
      await DeferredScheduler.setup(bus);
      const scheduler = new DeferredScheduler(() => this.buses.internal);
      this.engine.onRetryScheduled = (record, delay) => scheduler.schedule(record, delay);
      await bus.consumeTasks<DeferredTask>(DEFERRED_QUEUE, async (task) => void (await this.engine.resume(task.sagaId)));
    }
    if (this.config.bookingBusUrl) {
      this.buses.booking = await EventBus.connect(this.config.bookingBusUrl, BOOKING_EXCHANGE);
      await this.buses.booking.consume(BOOKING_QUEUE, BOOKING_ROUTING_KEYS, async ({ event }) => {
        try {
          await this.inbound.receive(event, 'AMQP');
        } catch (error) {
          // Un evento inválido no tiene arreglo: se registra y se confirma. Otro error (la base caída) se reintenta y, agotado,
          // va a la cola de fallidos: un evento de Booking nunca se pierde en silencio.
          if (!(error instanceof ProblemDetailsException) || error.problem.status >= 500) throw error;
          this.logger.warn(`Evento de Booking inválido por AMQP: ${error.problem.title}`);
        }
      }, { onDeadLetter: (info) => this.logger.error(`ALERTA: evento de Booking ${info.messageId ?? ''} a la cola de fallidos tras ${info.attempts} intentos: ${info.reason}`) });
      this.logger.log(`Escuchando eventos de Booking en ${this.buses.booking.toString()}`);
    }
    this.health.start();
    this.inbound.start();
    this.engine.startRecovery(this.config.sagaRecoveryMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.airports?.stop();
    this.buses.relay?.stop();
    await this.buses.booking?.close();
    await this.buses.internal?.close();
    this.upstreams.close();
    await this.store.close();
  }
}

export interface EsbModuleOptions {
  store?: EsbStore;
  verifier?: TokenVerifier;
  upstreams?: Upstreams;
  publisher?: EventsPublisher;
}

@Module({})
export class EsbModule {
  static register(config: EsbConfig, options: EsbModuleOptions = {}): DynamicModule {
    const store = options.store ?? (config.databaseUrl ? new PostgresEsbStore(config.databaseUrl) : new InMemoryEsbStore());
    const buses = new Buses();
    const upstreams = options.upstreams ?? new Upstreams(config);
    // Los eventos van siempre al outbox; sin BUS_URL quedan pendientes (local sin RabbitMQ).
    const publisher = options.publisher ?? new OutboxEventsPublisher(store, () => buses.relay);
    const ownChecks: OwnChecks = {
      ...(config.busUrl ? { bus: async () => (await buses.internal?.ping()) ?? false } : {}),
      ...(config.bookingBusUrl ? { bookingBus: async () => (await buses.booking?.ping()) ?? false } : {}),
    };
    const checks: HealthCheck[] = [
      { name: 'database', check: async () => (store.kind === 'memory' ? 'memory' : (await store.ping()) ? 'up' : 'down') },
      { name: 'bus', check: async () => (!config.busUrl ? 'memory' : (await buses.internal?.ping()) ? 'up' : 'down') },
    ];
    return {
      module: EsbModule,
      imports: [EcoServiceModule.forRoot({ ...SERVICE, healthChecks: checks })],
      controllers: [RouterController, CompositionController, InboundController, SagasController],
      providers: [
        { provide: ESB_CONFIG, useValue: config },
        { provide: ESB_STORE, useValue: store },
        { provide: UPSTREAMS, useValue: upstreams },
        { provide: EVENTS_PUBLISHER, useValue: publisher },
        { provide: OWN_CHECKS, useValue: ownChecks },
        { provide: Buses, useValue: buses },
        // Lo llaman los MS de respuesta (`ecoairlines:esb`, D44); el token del propio ESB también sirve (scripts de verificación).
        { provide: ACCEPTED_SERVICE_SCOPES, useValue: [ESB_CALLER_SCOPE, INTERNAL_SCOPE] },
        { provide: TOKEN_VERIFIER, useValue: options.verifier ?? new JwksTokenVerifier(config.jwksUrl, { issuer: config.issuer, audience: config.audience }) },
        IdempotencyService,
        RouterService,
        CompositionService,
        HealthCompositionService,
        SagaEngine,
        SagaDeps,
        CreateBookingSaga,
        IssueTicketsSaga,
        PaymentFailedSaga,
        ChangeSeatsSaga,
        CheckInSaga,
        CancelBookingSaga,
        ChangeDateSaga,
        AddBaggageSaga,
        AssistanceReadySaga,
        FlightStatusSaga,
        SavePricesSaga,
        PublishTimetableSaga,
        SagasService,
        PostSaleComposition,
        InboundHandlers,
        InboundService,
        EsbLifecycle,
        ServiceTokenGuard,
      ],
    };
  }
}

/**
 * Antes de `app.init()`: plantilla de servicio y cuerpos. Los CloudEvents llegan como `application/cloudevents+json`, y la firma
 * del webhook se verifica sobre los bytes exactos (`rawBody`, que NestFactory guarda con `{ rawBody: true }`).
 */
export function setupApp(app: NestExpressApplication): void {
  configureService(app, SERVICE);
  app.useBodyParser('json', { type: ['application/json', 'application/*+json'], limit: '256kb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '16kb' });
}
