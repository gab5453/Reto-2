import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SEED_FLEET, SEED_ROUTES } from '../domain/seed-network.js';
import { SCHEDULE_REPOSITORY, type ScheduleRepository } from '../repositories/schedule.repository.js';
import { AircraftTypesService } from './aircraft-types.service.js';
import { AirportsService } from './airports.service.js';
import { PricingService } from './pricing.service.js';
import { PromotionsService } from './promotions.service.js';

/** Partner con el que la aerolínea tiene integración (el mismo `clientId` de MS.G.Identity). */
export const BOOKING_PARTNER_ID = 'BOOKING_PROTOTIPO';

/**
 * Al arrancar: crea las tablas y, si la base está vacía, siembra la red de prueba (un avión con su horario,
 * `seed-network.ts`, `source = NETWORK`). Los precios de referencia y el acuerdo "sin promociones" con Booking se crean si
 * faltan. Nunca pisa cambios del administrador.
 */
@Injectable()
export class ScheduleSeed implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ScheduleSeed');

  constructor(
    @Inject(SCHEDULE_REPOSITORY) private readonly repository: ScheduleRepository,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(PromotionsService) private readonly promotions: PromotionsService,
    @Inject(AirportsService) private readonly airports: AirportsService,
    @Inject(AircraftTypesService) private readonly aircraftTypes: AircraftTypesService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.repository.init();
    // M-1: primero el catálogo de aeropuertos (las rutas y el horario lo leen).
    if (await this.airports.seed()) this.logger.log('Catálogo de aeropuertos sembrado con los 34 de siempre.');
    // M-2: y el de tipos de avión (asientos, alcance y tiempo en tierra).
    if (await this.aircraftTypes.seed()) this.logger.log('Catálogo de tipos de avión sembrado con los 3 de siempre.');
    const now = new Date().toISOString();
    const audit = { source: 'NETWORK' as const, createdAt: now, updatedAt: now, updatedBy: null };
    const seeded = await this.repository.seedSchedule({
      fleet: SEED_FLEET.map((plane) => ({ ...plane, ...audit })),
      routes: SEED_ROUTES.map((route) => ({
        routeId: route.routeId,
        origin: route.origin,
        destination: route.destination,
        outbound: { ...route.outbound },
        inbound: { ...route.inbound },
        weekdays: [...route.weekdays],
        aircraftType: route.aircraftType,
        aircraft: [...route.aircraft],
        ...audit,
      })),
    });
    await this.pricing.seed();
    await this.promotions.seedWithoutPromotions(BOOKING_PARTNER_ID);
    this.logger.log(seeded ? `Red de prueba sembrada (${this.repository.kind}): ${SEED_ROUTES.length} rutas, ${SEED_FLEET.length} avión.` : 'La base ya tenía rutas: no se siembra la red.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.repository.close();
  }
}
