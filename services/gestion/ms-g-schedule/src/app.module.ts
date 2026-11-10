import { type DynamicModule, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureService, EcoServiceModule, type HealthCheck, JwksTokenVerifier, ServiceTokenGuard, TOKEN_VERIFIER, type TokenVerifier } from '@ecoairlines/shared';
import { SCHEDULE_CONFIG, type ScheduleConfig } from './config/config.js';
import { AircraftTypesController, AirportsController, PricingController, ScheduleController } from './http/schedule.controller.js';
import { InMemoryScheduleRepository } from './repositories/in-memory.repository.js';
import { PostgresScheduleRepository } from './repositories/postgres.repository.js';
import { SCHEDULE_REPOSITORY, type ScheduleRepository } from './repositories/schedule.repository.js';
import { AircraftTypesService } from './services/aircraft-types.service.js';
import { AirportsService } from './services/airports.service.js';
import { PricingService } from './services/pricing.service.js';
import { PromotionsService } from './services/promotions.service.js';
import { ScheduleService } from './services/schedule.service.js';
import { ScheduleSeed } from './services/seed.js';

export const SERVICE = { name: 'ms-g-schedule', version: '1.0.0' };

export interface ScheduleModuleOptions {
  repository?: ScheduleRepository;
  /** Las pruebas pasan uno con su propia clave; en ejecución se usa la JWKS de Identity. */
  verifier?: TokenVerifier;
}

@Module({})
export class ScheduleModule {
  static register(config: ScheduleConfig, options: ScheduleModuleOptions = {}): DynamicModule {
    const repository = options.repository ?? (config.databaseUrl ? new PostgresScheduleRepository(config.databaseUrl) : new InMemoryScheduleRepository());
    const database: HealthCheck = {
      name: 'database',
      check: async () => (repository.kind === 'memory' ? 'memory' : (await repository.ping()) ? 'up' : 'down'),
    };
    return {
      module: ScheduleModule,
      imports: [EcoServiceModule.forRoot({ ...SERVICE, healthChecks: [database] })],
      controllers: [ScheduleController, PricingController, AirportsController, AircraftTypesController],
      providers: [
        { provide: SCHEDULE_CONFIG, useValue: config },
        { provide: SCHEDULE_REPOSITORY, useValue: repository },
        { provide: TOKEN_VERIFIER, useValue: options.verifier ?? new JwksTokenVerifier(config.jwksUrl, { issuer: config.issuer, audience: config.audience }) },
        ScheduleService,
        AirportsService,
        AircraftTypesService,
        PricingService,
        PromotionsService,
        ScheduleSeed,
        ServiceTokenGuard,
      ],
    };
  }
}

export function setupApp(app: NestExpressApplication): void {
  configureService(app, SERVICE);
  // El horario de 92 días (~16 000 vuelos) se responde completo; los cuerpos de entrada son chicos.
  app.useBodyParser('json', { limit: '100kb' });
}
