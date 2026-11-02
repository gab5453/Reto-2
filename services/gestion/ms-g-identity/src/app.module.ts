import { type DynamicModule, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureService, EcoServiceModule, type HealthCheck, ServiceTokenGuard, TOKEN_VERIFIER } from '@ecoairlines/shared';
import { IDENTITY_CONFIG, type IdentityConfig } from './config/config.js';
import { AdminActorGuard } from './http/admin-actor.guard.js';
import { AdminController } from './http/admin.controller.js';
import { AuthController, OAuthController } from './http/auth.controller.js';
import { IDENTITY_REPOSITORY, type IdentityRepository } from './repositories/identity.repository.js';
import { InMemoryIdentityRepository } from './repositories/in-memory.repository.js';
import { PostgresIdentityRepository } from './repositories/postgres.repository.js';
import { AccountsService } from './services/accounts.service.js';
import { PartnersService } from './services/partners.service.js';
import { IdentitySeed } from './services/seed.js';
import { TokensService } from './services/tokens.service.js';

export const SERVICE = { name: 'ms-g-identity', version: '1.0.0' };

/** PostgreSQL si hay DATABASE_URL; en memoria si no (pruebas y arranque local rápido). */
export const createRepository = (config: IdentityConfig): IdentityRepository =>
  config.databaseUrl ? new PostgresIdentityRepository(config.databaseUrl) : new InMemoryIdentityRepository();

@Module({})
export class IdentityModule {
  static register(config: IdentityConfig, repository: IdentityRepository = createRepository(config)): DynamicModule {
    const database: HealthCheck = {
      name: 'database',
      check: async () => (repository.kind === 'memory' ? 'memory' : (await repository.ping()) ? 'up' : 'down'),
    };
    return {
      module: IdentityModule,
      imports: [EcoServiceModule.forRoot({ ...SERVICE, healthChecks: [database] })],
      controllers: [AuthController, OAuthController, AdminController],
      providers: [
        { provide: IDENTITY_CONFIG, useValue: config },
        { provide: IDENTITY_REPOSITORY, useValue: repository },
        TokensService,
        // Identity verifica los tokens del ESB con sus propias claves (sin pedirse la JWKS por red).
        { provide: TOKEN_VERIFIER, useExisting: TokensService },
        AccountsService,
        PartnersService,
        IdentitySeed,
        ServiceTokenGuard,
        AdminActorGuard,
      ],
    };
  }
}

/** Configuración común a main.ts y a las pruebas. */
export function setupApp(app: NestExpressApplication): void {
  configureService(app, SERVICE);
  // El límite de intentos es por IP del cliente: se confía en X-Forwarded-For solo si viene de la red interna (ESB, gateway).
  app.set('trust proxy', process.env['TRUST_PROXY'] ?? 'loopback, linklocal, uniquelocal');
}
