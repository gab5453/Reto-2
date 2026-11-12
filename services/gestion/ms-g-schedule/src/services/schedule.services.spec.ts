import { AIRCRAFT_LAYOUTS, AIRPORTS, removeAircraftType, removeAirport, type ProblemDetailsException } from '@ecoairlines/shared';
import type { ScheduleConfig } from '../config/config.js';
import type { AircraftTypeRecord, AirportRecord, FarePriceRecord, PricingSettings, ScheduleState } from '../domain/model.js';
import type { ScheduleRepository } from '../repositories/schedule.repository.js';
import { AircraftTypesService } from './aircraft-types.service.js';
import { AirportsService } from './airports.service.js';
import { PricingService } from './pricing.service.js';
import { PromotionsService } from './promotions.service.js';
import type { ScheduleService } from './schedule.service.js';

/**
 * PU-2 (Informacion_General/Pruebas.md §5.1.2): servicios de MS.G.Schedule con el repositorio como doble.
 * El repositorio recibe una función que DECIDE los cambios (`changePrices(work)`, `changeAirports(work)`…). El stub le pasa un
 * estado inventado y el spy guarda lo que la función decidió guardar: así se prueba la decisión sin base de datos.
 */

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
};

const ESTADO_VACIO: ScheduleState = { routes: [], fleet: [] };
const estadoCon = (over: Partial<ScheduleState>): ScheduleState => ({ ...ESTADO_VACIO, ...over });
const ruta = (over: Record<string, unknown> = {}) => ({ routeId: 'EA100-EA101', origin: 'UIO', destination: 'GYE', aircraftType: 'Airbus A220-300', ...over }) as ScheduleState['routes'][number];

function repositorio(state: ScheduleState = ESTADO_VACIO) {
  const decided: { changes?: unknown; history?: unknown } = {};
  let precios: FarePriceRecord[] = [];
  let pricing: PricingSettings = { fixedCharge: 35, perKm: 0.085, routePrices: {}, updatedAt: null, updatedBy: null };
  let aeropuertos: AirportRecord[] = [];
  let tipos: AircraftTypeRecord[] = [];
  const repo = {
    kind: 'memory',
    loadState: vi.fn(async () => state),
    listPrices: vi.fn(async () => precios),
    changePrices: vi.fn(async (work: (c: FarePriceRecord[]) => { updated: FarePriceRecord[]; history: unknown }) => {
      const { updated, history } = work(precios);
      decided.changes = updated;
      decided.history = history;
      return precios.map((p) => updated.find((u) => u.cabinClass === p.cabinClass && u.fareBrand === p.fareBrand) ?? p);
    }),
    listPriceChanges: vi.fn().mockResolvedValue({ items: [] }),
    getPricing: vi.fn(async () => pricing),
    changePricing: vi.fn(async (work: (c: PricingSettings) => { next: PricingSettings; history: unknown }) => {
      const { next, history } = work(pricing);
      decided.history = history;
      pricing = next;
      return next;
    }),
    listPricingChanges: vi.fn().mockResolvedValue([]),
    listAirports: vi.fn(async () => aeropuertos),
    changeAirports: vi.fn(async (work: (a: AirportRecord[], s: ScheduleState) => { changes: unknown; result: unknown }) => {
      const { changes, result } = work(aeropuertos, state);
      decided.changes = changes;
      return result;
    }),
    listAircraftTypes: vi.fn(async () => tipos),
    changeAircraftTypes: vi.fn(async (work: (t: AircraftTypeRecord[], s: ScheduleState) => { changes: unknown; result: unknown }) => {
      const { changes, result } = work(tipos, state);
      decided.changes = changes;
      return result;
    }),
    getAgreement: vi.fn().mockResolvedValue(undefined),
    saveAgreement: vi.fn().mockResolvedValue(undefined),
  };
  return {
    repo: repo as unknown as ScheduleRepository & typeof repo,
    decided,
    setPrecios: (p: FarePriceRecord[]) => (precios = p),
    setPricing: (p: Partial<PricingSettings>) => (pricing = { ...pricing, ...p }),
    setAeropuertos: (a: AirportRecord[]) => (aeropuertos = a),
    setTipos: (t: AircraftTypeRecord[]) => (tipos = t),
  };
}

// ================================================================================================ precios por clase
describe('PricingService: multiplicadores por clase', () => {
  const precio = (fareBrand: FarePriceRecord['fareBrand'], multiplier: number, cabinClass: FarePriceRecord['cabinClass'] = 'ECONOMY'): FarePriceRecord => ({
    cabinClass,
    fareBrand,
    referenceMultiplier: multiplier,
    multiplier,
    updatedAt: '2026-11-01T00:00:00.000Z',
    updatedBy: null,
  });

  it('guarda solo lo que cambió y deja un historial con el valor anterior y el nuevo', async () => {
    const r = repositorio();
    r.setPrecios([precio('SEMILLA', 1), precio('BROTE', 1.35)]);
    await new PricingService(r.repo).save([{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 1.1 }, { cabinClass: 'ECONOMY', fareBrand: 'BROTE', multiplier: 1.35 }], 'admin-1');
    expect(r.decided.changes).toEqual([expect.objectContaining({ fareBrand: 'SEMILLA', multiplier: 1.1, updatedBy: 'admin-1' })]);
    expect(r.decided.history).toEqual([expect.objectContaining({ fareBrand: 'SEMILLA', oldMultiplier: 1, newMultiplier: 1.1, changedBy: 'admin-1' })]);
  });
  it('redondea a 3 decimales: 1,1004 es igual a 1,1 y no deja historial', async () => {
    const r = repositorio();
    r.setPrecios([precio('SEMILLA', 1.1)]);
    await new PricingService(r.repo).save([{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 1.1004 }], 'admin-1');
    expect(r.decided.history).toEqual([]);
  });
  it('una combinación repetida se rechaza sin tocar el repositorio', async () => {
    const r = repositorio();
    expect(await codeOf(new PricingService(r.repo).save([{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 1 }, { cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 2 }], 'a'))).toBe(
      'VALIDATION_FAILED',
    );
    expect(r.repo.changePrices).not.toHaveBeenCalled();
  });
  it('un multiplicador fuera de 0,5–10 → MULTIPLIER_OUT_OF_RANGE', async () =>
    expect(await codeOf(new PricingService(repositorio().repo).save([{ cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', multiplier: 12 }], 'a'))).toBe('MULTIPLIER_OUT_OF_RANGE'));
  it('una combinación que no existe → NOT_FOUND (todo o nada)', async () => {
    const r = repositorio();
    r.setPrecios([precio('SEMILLA', 1)]);
    expect(await codeOf(new PricingService(r.repo).save([{ cabinClass: 'BUSINESS', fareBrand: 'DOSEL', multiplier: 3 }], 'a'))).toBe('NOT_FOUND');
  });
  it('«Rellenar» devuelve los valores de referencia sin guardar', () => {
    const r = repositorio();
    expect(new PricingService(r.repo).reference().map((p) => p.multiplier)).toEqual([1, 1.35, 1.8, 3.2]);
    expect(r.repo.changePrices).not.toHaveBeenCalled();
  });
});

describe('PricingService: tarifa base y precio por ruta (P-1)', () => {
  const precios4 = (amount: number) => (['SEMILLA', 'BROTE', 'BOSQUE', 'DOSEL'] as const).map((fareBrand) => ({ fareBrand, amount }));

  it('guarda la tarifa base redondeada y deja historial de cada campo que cambió', async () => {
    const r = repositorio();
    const view = await new PricingService(r.repo).savePricing({ fixedCharge: 40.004, perKm: 0.12345, routePrices: [] }, 'admin-1');
    expect(view).toMatchObject({ fixedCharge: 40, perKm: 0.1235, updatedBy: 'admin-1' });
    expect((r.decided.history as { field: string }[]).map((h) => h.field)).toEqual(['FIXED_CHARGE', 'PER_KM']);
  });
  it('guardar lo mismo no deja historial ni cambia quién lo editó', async () => {
    const r = repositorio();
    const view = await new PricingService(r.repo).savePricing({ fixedCharge: 35, perKm: 0.085, routePrices: [] }, 'admin-1');
    expect(r.decided.history).toEqual([]);
    expect(view.updatedBy).toBeNull();
  });
  it('un precio exacto por ruta lleva los 4 paquetes', async () =>
    expect(
      await codeOf(new PricingService(repositorio(estadoCon({ routes: [ruta()] })).repo).savePricing({ fixedCharge: 35, perKm: 0.085, routePrices: [{ routeId: 'EA100-EA101', prices: precios4(50).slice(0, 3) }] }, 'a')),
    ).toBe('VALIDATION_FAILED'));
  it('una ruta repetida', async () =>
    expect(
      await codeOf(
        new PricingService(repositorio().repo).savePricing(
          { fixedCharge: 35, perKm: 0.085, routePrices: [{ routeId: 'R', prices: precios4(1) }, { routeId: 'R', prices: precios4(2) }] },
          'a',
        ),
      ),
    ).toBe('VALIDATION_FAILED'));
  it('una ruta que no existe en el horario → NOT_FOUND', async () =>
    expect(await codeOf(new PricingService(repositorio().repo).savePricing({ fixedCharge: 35, perKm: 0.085, routePrices: [{ routeId: 'EA900-EA901', prices: precios4(50) }] }, 'a'))).toBe(
      'NOT_FOUND',
    ));
  it('una ruta dada de baja puede conservar su precio anterior', async () => {
    const r = repositorio();
    r.setPricing({ routePrices: { 'EA900-EA901': { SEMILLA: 50, BROTE: 50, BOSQUE: 50, DOSEL: 50 } } });
    expect(await codeOf(new PricingService(r.repo).savePricing({ fixedCharge: 35, perKm: 0.085, routePrices: [{ routeId: 'EA900-EA901', prices: precios4(50) }] }, 'a'))).toBeUndefined();
  });
  it('quitar el precio de una ruta deja un cambio por paquete (de su valor a null)', async () => {
    const r = repositorio(estadoCon({ routes: [ruta()] }));
    r.setPricing({ routePrices: { 'EA100-EA101': { SEMILLA: 50, BROTE: 60, BOSQUE: 70, DOSEL: 200 } } });
    await new PricingService(r.repo).savePricing({ fixedCharge: 35, perKm: 0.085, routePrices: [] }, 'a');
    expect((r.decided.history as { field: string; newValue: number | null }[]).map((h) => [h.field, h.newValue])).toEqual([
      ['ROUTE_PRICE', null],
      ['ROUTE_PRICE', null],
      ['ROUTE_PRICE', null],
      ['ROUTE_PRICE', null],
    ]);
  });
});

// ================================================================================================ aeropuertos
describe('AirportsService (M-1)', () => {
  const entrada = (over = {}) => ({ city: ' Tena ', name: ' Aeropuerto Jumandy ', country: 'EC', province: 'Napo', lat: -1, lon: -77.8, utcOffsetMinutes: -300, ...over });
  const guardado = (over: Partial<AirportRecord> = {}): AirportRecord =>
    ({ code: 'TNW', city: 'Tena', name: 'Jumandy', country: 'EC', lat: -1, lon: -77.8, utcOffsetMinutes: -300, active: true, createdAt: 'x', updatedAt: 'x', updatedBy: null, ...over });
  afterEach(() => removeAirport('TNW'));

  it('crear: guarda limpio (sin espacios), activo por defecto, y lo agrega al catálogo del proceso', async () => {
    const r = repositorio();
    const dto = await new AirportsService(r.repo).create('TNW', entrada(), 'admin-1');
    expect(dto).toMatchObject({ code: 'TNW', city: 'Tena', name: 'Aeropuerto Jumandy', active: true });
    expect(AIRPORTS['TNW']?.city).toBe('Tena');
  });
  it('crear un código que ya existe → AIRPORT_ALREADY_EXISTS', async () => {
    const r = repositorio();
    r.setAeropuertos([guardado()]);
    expect(await codeOf(new AirportsService(r.repo).create('TNW', entrada(), 'a'))).toBe('AIRPORT_ALREADY_EXISTS');
  });
  it('un aeropuerto con rutas no cambia sus coordenadas → AIRPORT_IN_USE', async () => {
    const r = repositorio(estadoCon({ routes: [ruta({ destination: 'TNW' })] }));
    r.setAeropuertos([guardado()]);
    expect(await codeOf(new AirportsService(r.repo).update('TNW', entrada({ lat: -1.5 }), 'a'))).toBe('AIRPORT_IN_USE');
  });
  it('pero sí cambia su nombre o se desactiva', async () => {
    const r = repositorio(estadoCon({ routes: [ruta({ destination: 'TNW' })] }));
    r.setAeropuertos([guardado()]);
    expect(await new AirportsService(r.repo).update('TNW', entrada({ name: 'Nuevo nombre', active: false }), 'a')).toMatchObject({ name: 'Nuevo nombre', active: false });
  });
  it('borrar uno con aviones con base ahí → AIRPORT_IN_USE (y no se borra del catálogo)', async () => {
    const r = repositorio(estadoCon({ fleet: [{ registration: 'HC-J99', base: 'TNW', aircraftType: 'Airbus A220-300' }] as ScheduleState['fleet'] }));
    r.setAeropuertos([guardado()]);
    expect(await codeOf(new AirportsService(r.repo).delete('TNW'))).toBe('AIRPORT_IN_USE');
  });
  it('borrar uno sin uso decide borrarlo', async () => {
    const r = repositorio();
    r.setAeropuertos([guardado()]);
    await new AirportsService(r.repo).delete('TNW');
    expect(r.decided.changes).toEqual({ deleteAirports: ['TNW'] });
  });
  it('uno que no existe → AIRPORT_NOT_FOUND', async () => {
    expect(await codeOf(new AirportsService(repositorio().repo).get('XXX'))).toBe('AIRPORT_NOT_FOUND');
    expect(await codeOf(new AirportsService(repositorio().repo).delete('XXX'))).toBe('AIRPORT_NOT_FOUND');
  });
});

// ================================================================================================ tipos de avión
describe('AircraftTypesService (M-2)', () => {
  const entrada = (over = {}) => ({ registrationPrefix: 'HC-E', maxRouteKm: 2_000, turnaroundMinutes: 40, business: { seats: 8, configuration: '2-2' }, economy: { seats: 90, configuration: '3-3' }, ...over });
  const existente = (over: Partial<AircraftTypeRecord> = {}) =>
    ({ name: 'Airbus A220-300', registrationPrefix: 'HC-J', maxRouteKm: 1500, turnaroundMinutes: 35, cabins: AIRCRAFT_LAYOUTS['Airbus A220-300'], source: 'NETWORK', createdAt: 'x', updatedAt: 'x', updatedBy: null, ...over }) as AircraftTypeRecord;
  afterEach(() => removeAircraftType('Embraer E195'));

  it('crear: arma las filas desde los asientos (8 en 2-2 = 2 filas; 90 en 3-3 = 15 filas)', async () => {
    const r = repositorio();
    r.setTipos([existente()]);
    const dto = await new AircraftTypesService(r.repo).create('Embraer E195', entrada(), 'admin-1');
    expect(dto).toMatchObject({ aircraftType: 'Embraer E195', totalSeats: 98, source: 'ADMIN', inFleet: 0 });
    expect(dto.cabins.map((c) => [c.cabinClass, c.firstRow, c.lastRow])).toEqual([
      ['BUSINESS', 1, 2],
      ['ECONOMY', 3, 17],
    ]);
    expect(AIRCRAFT_LAYOUTS['Embraer E195']).toBeDefined();
  });
  it('asientos que no completan filas → VALIDATION_FAILED, sin tocar el repositorio', async () => {
    const r = repositorio();
    expect(await codeOf(new AircraftTypesService(r.repo).create('Embraer E195', entrada({ economy: { seats: 91, configuration: '3-3' } }), 'a'))).toBe('VALIDATION_FAILED');
    expect(r.repo.changeAircraftTypes).not.toHaveBeenCalled();
  });
  it('una configuración que no existe para la cabina', async () =>
    expect(await codeOf(new AircraftTypesService(repositorio().repo).create('Embraer E195', entrada({ business: { seats: 8, configuration: '3-3' } }), 'a'))).toBe('VALIDATION_FAILED'));
  it('el nombre no se repite (sin importar mayúsculas)', async () => {
    const r = repositorio();
    r.setTipos([existente({ name: 'Embraer E195', registrationPrefix: 'HC-X' })]);
    expect(await codeOf(new AircraftTypesService(r.repo).create('EMBRAER E195', entrada(), 'a'))).toBe('AIRCRAFT_TYPE_ALREADY_EXISTS');
  });
  it('el prefijo de matrícula no se repite', async () => {
    const r = repositorio();
    r.setTipos([existente()]);
    expect(await codeOf(new AircraftTypesService(r.repo).create('Embraer E195', entrada({ registrationPrefix: 'HC-J' }), 'a'))).toBe('AIRCRAFT_TYPE_ALREADY_EXISTS');
  });
  it('un tipo con aviones no cambia (D-T7) → AIRCRAFT_TYPE_IN_USE', async () => {
    const r = repositorio(estadoCon({ fleet: [{ registration: 'HC-J01', base: 'UIO', aircraftType: 'Airbus A220-300' }] as ScheduleState['fleet'] }));
    r.setTipos([existente()]);
    expect(await codeOf(new AircraftTypesService(r.repo).update('Airbus A220-300', entrada({ registrationPrefix: 'HC-J' }), 'a'))).toBe('AIRCRAFT_TYPE_IN_USE');
  });
  it('no se borra el único tipo que queda', async () => {
    const r = repositorio();
    r.setTipos([existente()]);
    expect(await codeOf(new AircraftTypesService(r.repo).delete('Airbus A220-300'))).toBe('AIRCRAFT_TYPE_IN_USE');
  });
  it('no se borra un tipo con rutas', async () => {
    const r = repositorio(estadoCon({ routes: [ruta()] }));
    r.setTipos([existente(), existente({ name: 'Boeing 787-9', registrationPrefix: 'HC-W' })]);
    expect(await codeOf(new AircraftTypesService(r.repo).delete('Airbus A220-300'))).toBe('AIRCRAFT_TYPE_IN_USE');
  });
  it('un tipo que no existe → AIRCRAFT_TYPE_NOT_FOUND', async () =>
    expect(await codeOf(new AircraftTypesService(repositorio().repo).update('Concorde', entrada(), 'a'))).toBe('AIRCRAFT_TYPE_NOT_FOUND'));
});

// ================================================================================================ acuerdo de promociones
describe('PromotionsService (D35)', () => {
  const config = { utcOffsetMinutes: -300, providerCode: 'ECOAIRLINES' } as ScheduleConfig;
  const schedule = { operatedRoutes: vi.fn().mockResolvedValue([{ origin: 'UIO', destination: 'GYE' }]) } as unknown as ScheduleService;

  it('sin acuerdo → 404', async () => expect(await codeOf(new PromotionsService(repositorio().repo, schedule, config).get('BOOKING_PROTOTIPO'))).toBe('NOT_FOUND'));
  it('guarda el acuerdo sin repetir rutas ni cabinas y responde con la forma del contrato v2', async () => {
    const r = repositorio();
    const response = await new PromotionsService(r.repo, schedule, config).save(
      'BOOKING_PROTOTIPO',
      { permite_promociones: true, porcentaje_descuento_maximo: 15, rutas_habilitadas: ['UIO-GYE', 'UIO-GYE'], cabinas_habilitadas: ['ECONOMY', 'ECONOMY'] },
      'admin-1',
    );
    expect(r.repo.saveAgreement).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'BOOKING_PROTOTIPO', rutas_habilitadas: ['UIO-GYE'], cabinas_habilitadas: ['ECONOMY'], updatedBy: 'admin-1' }));
    expect(response).toMatchObject({ proveedor_codigo: 'ECOAIRLINES', vertical: 'VUELOS', porcentaje_descuento_maximo: 15 });
    expect(response).not.toHaveProperty('partnerId');
  });
  it('un descuento mayor al 50 % no se guarda', async () => {
    const r = repositorio();
    expect(await codeOf(new PromotionsService(r.repo, schedule, config).save('X', { permite_promociones: true, porcentaje_descuento_maximo: 60 }, 'a'))).toBe('PROMOTION_DISCOUNT_OUT_OF_RANGE');
    expect(r.repo.saveAgreement).not.toHaveBeenCalled();
  });
  it('la semilla crea el acuerdo sin promociones solo si no existe (nunca pisa el del administrador)', async () => {
    const r = repositorio();
    await new PromotionsService(r.repo, schedule, config).seedWithoutPromotions('BOOKING_PROTOTIPO');
    expect(r.repo.saveAgreement).toHaveBeenCalledWith(expect.objectContaining({ permite_promociones: false, porcentaje_descuento_maximo: 0 }));
    r.repo.saveAgreement.mockClear();
    r.repo.getAgreement.mockResolvedValue({ partnerId: 'BOOKING_PROTOTIPO' });
    await new PromotionsService(r.repo, schedule, config).seedWithoutPromotions('BOOKING_PROTOTIPO');
    expect(r.repo.saveAgreement).not.toHaveBeenCalled();
  });
});
