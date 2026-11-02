import { type DynamicModule, Inject, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureService, EcoServiceModule, type HealthCheck, JwksTokenVerifier, TOKEN_VERIFIER, type TokenVerifier } from '@ecoairlines/shared';
import { POST_SALE_CONFIG, type PostSaleConfig } from './config/config.js';
import { InMemoryPostSaleStore, POST_SALE_STORE, type PostSaleStore, PostgresPostSaleStore } from './repositories/post-sale.store.js';
import { PostSaleService } from './services/post-sale.service.js';
import { mountSoap } from './soap/soap.server.js';

export const SERVICE = { name: 'ms-g-post-sale', version: '1.0.0' };

@Injectable()
class StoreLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(POST_SALE_STORE) private readonly store: PostSaleStore) {}
  onModuleInit() {
    return this.store.init();
  }
  onModuleDestroy() {
    return this.store.close();
  }
}

export interface PostSaleModuleOptions {
  store?: PostSaleStore;
  verifier?: TokenVerifier;
}

@Module({})
export class PostSaleModule {
  static register(config: PostSaleConfig, options: PostSaleModuleOptions = {}): DynamicModule {
    const store = options.store ?? (config.databaseUrl ? new PostgresPostSaleStore(config.databaseUrl) : new InMemoryPostSaleStore());
    const database: HealthCheck = { name: 'database', check: async () => (store.kind === 'memory' ? 'memory' : (await store.ping()) ? 'up' : 'down') };
    return {
      module: PostSaleModule,
      imports: [EcoServiceModule.forRoot({ ...SERVICE, healthChecks: [database] })],
      providers: [
        { provide: POST_SALE_CONFIG, useValue: config },
        { provide: POST_SALE_STORE, useValue: store },
        { provide: TOKEN_VERIFIER, useValue: options.verifier ?? new JwksTokenVerifier(config.jwksUrl, { issuer: config.issuer, audience: config.audience }) },
        PostSaleService,
        StoreLifecycle,
      ],
    };
  }
}

/** Plantilla común + el servicio SOAP. Se llama ANTES de `app.init()`: la ruta SOAP debe quedar antes del 404 de NestJS. */
export async function setupApp(app: NestExpressApplication): Promise<void> {
  configureService(app, SERVICE);
  await mountSoap(app, app.get(PostSaleService), app.get(TOKEN_VERIFIER));
}
