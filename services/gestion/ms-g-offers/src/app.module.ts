import { type DynamicModule, Inject, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { registerAircraftTypes, registerAirports } from '@ecoairlines/shared';
import { observeGauge } from '@ecoairlines/shared/telemetry/metrics.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureService, EcoServiceModule, type HealthCheck, JwksTokenVerifier, TOKEN_VERIFIER, type TokenVerifier } from '@ecoairlines/shared';
import { EventBus } from '@ecoairlines/shared/bus/amqp.js';
import { OutboxRelay } from '@ecoairlines/shared/bus/outbox.js';
import { OffersEvents } from './services/offers-events.js';
import { OFFERS_CONFIG, type OffersConfig } from './config/config.js';
import { OffersGrpcServer } from './grpc/offers.server.js';
import { InMemoryOffersStore } from './repositories/in-memory.store.js';
import { OFFERS_STORE, type OffersStore } from './repositories/offers.store.js';
import { PostgresOffersStore } from './repositories/postgres.store.js';
import { CatalogService } from './services/catalog.service.js';
import { HoldsService } from './services/holds.service.js';
import { InventoryService } from './services/inventory.service.js';
import { StockSyncService } from './services/stock-sync.service.js';

export const SERVICE = { name: 'ms-g-offers', version: '1.0.0' };

/** Crea las tablas al arrancar y vence los holds pasados de hora cada `sweepIntervalMs` (aunque nadie los consulte). */
@Injectable()
export class OffersLifecycle implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('HoldSweeper');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OFFERS_STORE) private readonly store: OffersStore,
    @Inject(OFFERS_CONFIG) private readonly config: OffersConfig,
    @Inject(HoldsService) private readonly holds: HoldsService,
    @Inject(StockSyncService) private readonly stock: StockSyncService,
    @Inject(OffersEvents) private readonly events: OffersEvents,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.init();
    // M-1: la copia del catálogo de aeropuertos que publicó el ESB (sin ella, la semilla de shared).
    const airports = await this.store.transaction((tx) => tx.airportCatalog());
    if (airports.length) registerAirports(airports);
    // M-2: y la copia de los tipos de avión (sin ella, los 3 de la semilla).
    const types = await this.store.transaction((tx) => tx.aircraftTypeCatalog());
    if (types.length) registerAircraftTypes(types);
    // V2.16: stock pendiente de enviar a Booking (alerta "stock sin enviar"; hoy BKG-13).
    observeGauge('ecoairlines.stock.pending', 'Cambios de stock pendientes de enviar a Booking', async () => (await this.store.stats(new Date().toISOString().slice(0, 10))).pendingStockPushes);
    if (this.config.busUrl) {
      this.events.bus = await EventBus.connect(this.config.busUrl);
      this.events.relay = new OutboxRelay(this.store, () => this.events.bus, new Logger('Outbox'), { intervalMs: 1_000 });
      this.events.relay.start();
      this.events.relay.kick();
    }
    this.timer = setInterval(() => {
      this.holds
        .sweep()
        .then((expired) => {
          if (expired) {
            this.logger.log(`${expired} hold(s) vencidos`);
            this.stock.kick();
            this.events.kick();
          }
        })
        .catch((error: unknown) => this.logger.error(String(error)));
    }, this.config.sweepIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.events.relay?.stop();
    await this.events.bus?.close();
    await this.store.close();
  }
}

export interface OffersModuleOptions {
  store?: OffersStore;
  /** Las pruebas pasan uno con su propia clave; en ejecución se usa la JWKS de Identity. */
  verifier?: TokenVerifier;
}

let grpcServer: OffersGrpcServer | undefined;

@Module({})
export class OffersModule {
  static register(config: OffersConfig, options: OffersModuleOptions = {}): DynamicModule {
    const store = options.store ?? (config.databaseUrl ? new PostgresOffersStore(config.databaseUrl) : new InMemoryOffersStore());
    const events = new OffersEvents();
    const checks: HealthCheck[] = [
      { name: 'database', check: async () => (store.kind === 'memory' ? 'memory' : (await store.ping()) ? 'up' : 'down') },
      { name: 'grpc', check: async () => (grpcServer?.isServing() ? 'up' : 'down') },
      { name: 'bus', check: async () => (!config.busUrl ? 'memory' : (await events.bus?.ping().catch(() => false)) ? 'up' : 'down') },
    ];
    return {
      module: OffersModule,
      imports: [EcoServiceModule.forRoot({ ...SERVICE, healthChecks: checks })],
      providers: [
        { provide: OFFERS_CONFIG, useValue: config },
        { provide: OFFERS_STORE, useValue: store },
        { provide: TOKEN_VERIFIER, useValue: options.verifier ?? new JwksTokenVerifier(config.jwksUrl, { issuer: config.issuer, audience: config.audience }) },
        CatalogService,
        HoldsService,
        InventoryService,
        StockSyncService,
        { provide: OffersEvents, useValue: events },
        OffersLifecycle,
        OffersGrpcServer,
      ],
    };
  }
}

/** Configuración común a main.ts y a las pruebas: HTTP solo para /health; el servicio es gRPC. */
export function setupApp(app: NestExpressApplication): OffersGrpcServer {
  configureService(app, SERVICE);
  const server = app.get(OffersGrpcServer);
  grpcServer = server;
  return server;
}
