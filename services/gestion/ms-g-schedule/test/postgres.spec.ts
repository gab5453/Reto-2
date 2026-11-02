import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ProblemDetailsException } from '@ecoairlines/shared';
import { loadConfig } from '../src/config/config.js';
import { PostgresScheduleRepository } from '../src/repositories/postgres.repository.js';
import { PricingService } from '../src/services/pricing.service.js';
import { PromotionsService } from '../src/services/promotions.service.js';
import { ScheduleService } from '../src/services/schedule.service.js';
import { ScheduleSeed } from '../src/services/seed.js';

/**
 * Integración con PostgreSQL real (opcional):
 * `SCHEDULE_TEST_DATABASE_URL=postgres://schedule_svc:dev-schedule@localhost:5432/schedule` con `npm run infra:up`.
 * Trabaja en un esquema propio que borra al terminar: no toca los datos del servicio que corre en Docker.
 */
const url = process.env['SCHEDULE_TEST_DATABASE_URL'];
const ACTOR = '6b0f1c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

describe.skipIf(!url)('PostgresScheduleRepository', () => {
  const schema = `prueba_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: url });
  let repository: PostgresScheduleRepository;
  let schedule: ScheduleService;
  let pricing: PricingService;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    repository = new PostgresScheduleRepository(`${url}?options=${encodeURIComponent(`-c search_path=${schema}`)}`);
    schedule = new ScheduleService(repository);
    pricing = new PricingService(repository);
    const config = loadConfig({ NODE_ENV: 'test' });
    await new ScheduleSeed(repository, pricing, new PromotionsService(repository, schedule, config)).onModuleInit();
  }, 60_000);

  afterAll(async () => {
    await repository?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('siembra la red de prueba una sola vez y el horario se reconstruye igual desde la base', async () => {
    const { state } = await schedule.current();
    expect(state.routes).toHaveLength(2);
    expect(state.fleet).toHaveLength(1);
    expect(await repository.seedSchedule(state)).toBe(false);
  });

  it('dos rutas creadas a la vez (en transacciones distintas) reciben números y aviones distintos', async () => {
    const body = (time: string, back: string) => ({ origin: 'UIO', destination: 'CUE', outboundDepartureLocal: time, inboundDepartureLocal: back, weekdays: ['TUE' as const] });
    const [a, b] = await Promise.all([schedule.createRoute(body('04:00', '05:30'), ACTOR), schedule.createRoute(body('04:20', '05:50'), ACTOR)]);
    expect(new Set([a.routeId, b.routeId]).size).toBe(2);
    expect(a.aircraft[0]).not.toBe(b.aircraft[0]);
    const { state } = await schedule.current();
    expect(state.routes).toHaveLength(4);
  });

  it('un error en medio de un cambio no guarda nada (ROLLBACK)', async () => {
    const before = await repository.version();
    await expect(
      repository.changeSchedule(() => {
        throw new Error('falla simulada');
      }),
    ).rejects.toThrow('falla simulada');
    expect(await repository.version()).toBe(before);
  });

  it('precios: todo o nada y con historial', async () => {
    await pricing.save([{ cabinClass: 'ECONOMY', fareBrand: 'BROTE', multiplier: 1.45 }], ACTOR);
    const failed = await pricing
      .save([{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 1.2 }, { cabinClass: 'BUSINESS', fareBrand: 'SEMILLA', multiplier: 2 }], ACTOR)
      .catch((error: ProblemDetailsException) => error.problem.code);
    expect(failed).toBe('NOT_FOUND');
    const table = await pricing.table();
    expect(table.items.find((p) => p.fareBrand === 'SEMILLA')!.multiplier).toBe(1);
    expect(table.items.find((p) => p.fareBrand === 'BROTE')!.multiplier).toBe(1.45);
    expect((await pricing.history(10)).items[0]).toMatchObject({ oldMultiplier: 1.35, newMultiplier: 1.45 });
  });

  it('acuerdo de promociones: fecha sin corrimiento de zona horaria y campos opcionales ausentes', async () => {
    const promotions = new PromotionsService(repository, schedule, loadConfig({ NODE_ENV: 'test' }));
    await promotions.save('BOOKING_PROTOTIPO', { permite_promociones: true, porcentaje_descuento_maximo: 12.5, vigencia_hasta: '2099-12-31' }, ACTOR);
    const read = await promotions.get('BOOKING_PROTOTIPO');
    expect(read).toMatchObject({ porcentaje_descuento_maximo: 12.5, vigencia_hasta: '2099-12-31' });
    expect(read).not.toHaveProperty('rutas_habilitadas');
  });
});
