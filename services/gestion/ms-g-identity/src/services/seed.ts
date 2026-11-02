import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config/config.js';
import { PARTNER_SCOPES, type RoleName, ROLES } from '../domain/model.js';
import { IDENTITY_REPOSITORY, type IdentityRepository } from '../repositories/identity.repository.js';
import { AccountsService } from './accounts.service.js';
import { PartnersService } from './partners.service.js';
import { seedSub } from './security.js';

/** Partner de semilla: Booking Prototipo, con todos los scopes del contrato v2 (nunca flights:admin). */
export const BOOKING_CLIENT_ID = 'BOOKING_PROTOTIPO';

/** Usuarios de prueba migrados de dev-auth, con el mismo `sub` (así conservan sus reservas). */
const DEMO_USERS: [string, string, string][] = [
  ['Usuario Demo', 'demo@ecoairlines.test', 'EcoDemo2026'],
  ['María Torres', 'maria@ecoairlines.test', 'EcoMaria2026'],
  ['Luis Andrade', 'luis@ecoairlines.test', 'EcoLuis2026'],
];

/**
 * Al arrancar: crea las tablas, los roles con sus scopes, el administrador, los clientes de prueba (solo en local) y el
 * partner Booking. Es idempotente: en cada arranque se vuelven a aplicar ADMIN_PASSWORD y BOOKING_CLIENT_SECRET.
 */
@Injectable()
export class IdentitySeed implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('IdentitySeed');

  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly repository: IdentityRepository,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(PartnersService) private readonly partners: PartnersService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.repository.init();
    await this.repository.seedRoles([...ROLES]);
    const users: [string, string, string, RoleName][] = [
      ...(this.config.seedDemoUsers ? DEMO_USERS.map(([name, email, password]) => [name, email, password, 'CUSTOMER'] as [string, string, string, RoleName]) : []),
      ['Administrador de Operaciones EcoAirlines', 'admin@ecoairlines.test', this.config.adminPassword, 'ADMIN'],
    ];
    for (const [fullName, email, password, role] of users) {
      await this.accounts.upsertSeedUser({ sub: seedSub(email), fullName, email, password, role });
    }
    await this.partners.upsertSeedPartner({
      clientId: BOOKING_CLIENT_ID,
      name: 'Booking Prototipo (RDA2)',
      secret: this.config.bookingClientSecret,
      scopes: [...PARTNER_SCOPES],
    });
    this.logger.log(`Semilla aplicada (${this.repository.kind}): ${users.length} usuarios, partner ${BOOKING_CLIENT_ID}.`);
    if (this.config.ephemeralKey) this.logger.warn('Sin IDENTITY_PRIVATE_KEY: clave de firma temporal (los tokens no sobreviven a un reinicio).');
  }

  async onModuleDestroy(): Promise<void> {
    await this.repository.close();
  }
}
