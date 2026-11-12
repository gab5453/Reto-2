import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lo que la web guarda en el dispositivo (V2.19, D52). Los pases sin conexión son datos personales: esta prueba fija que solo se
 * guarde lo necesario para abordar, que un usuario no vea lo de otro, que los vuelos pasados se purguen y que «Salir» lo borre.
 * También fija que el service worker guarde solo la aplicación: sin `runtimeCaching`, ninguna respuesta de la API llega a la caché.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WEB = join(ROOT, 'ecoairlines-web');
const KEY = 'eco.offline.v1';

type Fn = (...args: unknown[]) => unknown;
const webModule = (path: string): Promise<Record<string, Fn>> => import(/* @vite-ignore */ join(WEB, 'src', path));

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString();
const pass = (overrides: Record<string, unknown> = {}) => ({
  bookingId: 'B1',
  pnr: 'ABC123',
  passengerName: 'Ana Paz',
  flightNumber: 'EA100',
  origin: 'UIO',
  destination: 'GYE',
  departureAt: day(1),
  seat: '7A',
  boardingGroup: '2',
  boardingPosition: '14',
  gate: 'A12',
  barcode: 'M1PAZ/ANA',
  ...overrides,
});

describe('copia local para usar sin conexión', () => {
  let storage: Map<string, string>;
  let offline: Record<string, Fn>;

  beforeAll(async () => {
    offline = await webModule('lib/offline-trips.ts');
  });
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const load = (now?: number) => offline['loadOfflineData'](now) as { owner: string; trips: unknown[]; passes: { barcode: string }[] } | null;

  it('★ guarda solo lo necesario para abordar, aunque le pasen más datos', () => {
    const sensitive = { documentNumber: 'P1234567', contact: { email: 'ana@x.test' }, assistance: { notes: 'silla' }, paymentReference: 'pay_123', accessToken: 'jwt' };
    offline['savePasses']('ana@x.test', 'B1', [{ ...pass(), ...sensitive }]);
    offline['saveTrips']('ana@x.test', [{ bookingId: 'B1', pnr: 'ABC123', status: 'CONFIRMED', origin: 'UIO', destination: 'GYE', departureDate: day(1), grandTotal: { total: '10' }, ...sensitive }]);
    const raw = storage.get(KEY)!;
    for (const value of ['P1234567', 'silla', 'pay_123', 'jwt', 'grandTotal']) expect(raw).not.toContain(value);
    expect(load()!.passes).toHaveLength(1);
  });

  it('un segundo usuario en el mismo equipo no ve lo del primero', () => {
    offline['savePasses']('ana@x.test', 'B1', [pass()]);
    offline['savePasses']('luis@x.test', 'B2', [pass({ barcode: 'DE-LUIS' })]);
    expect(load()!.owner).toBe('luis@x.test');
    expect(load()!.passes.map((item) => item.barcode)).toEqual(['DE-LUIS']);
  });

  it('volver a ver una reserva reemplaza sus pases; cancelarla los retira', () => {
    offline['savePasses']('ana@x.test', 'B1', [pass()]);
    offline['savePasses']('ana@x.test', 'B1', [pass({ barcode: 'NUEVO' })]);
    expect(load()!.passes.map((item) => item.barcode)).toEqual(['NUEVO']);
    offline['saveTrips']('ana@x.test', [{ bookingId: 'B1', pnr: 'ABC123', status: 'CANCELLED' }]);
    expect(load()!.passes).toEqual([]);
  });

  it('★ los vuelos que ya pasaron se purgan también del dispositivo', () => {
    offline['savePasses']('ana@x.test', 'B1', [pass({ departureAt: day(-2), barcode: 'VIEJO' })]);
    offline['savePasses']('ana@x.test', 'B2', [pass({ bookingId: 'B2', departureAt: day(1) })]);
    expect(load()!.passes).toHaveLength(1);
    expect(storage.get(KEY)).not.toContain('VIEJO');
  });

  it('★ «Salir» borra todo y un dato corrupto no rompe la página', () => {
    offline['savePasses']('ana@x.test', 'B1', [pass()]);
    offline['clearOfflineData']();
    expect(storage.has(KEY)).toBe(false);
    expect(load()).toBeNull();
    storage.set(KEY, '{no es json');
    expect(load()).toBeNull();
  });
});

describe('service worker', () => {
  it('★ guarda solo la aplicación: sin runtimeCaching ninguna respuesta de la API llega a la caché', () => {
    const config = readFileSync(join(WEB, 'vite.config.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(config).toContain('VitePWA');
    expect(config).not.toMatch(/runtimeCaching\s*:/);
    expect(config).toContain("registerType: 'prompt'"); // actualizar recarga y cierra la sesión: lo decide el cliente
  });
});
