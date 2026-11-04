/**
 * Configuración de MS.G.Offers por variables de entorno. En producción `IDENTITY_JWKS_URL` y un destino del stock
 * (`BOOKING_STOCK_URL` o `BOOKING_GRPC_ADDRESS`) son obligatorios (la dirección de Identity llega por configuración: un MS.G
 * no nombra a otro en el código).
 */
export interface OffersConfig {
  /** HTTP solo para /health; el servicio en sí es gRPC. */
  httpPort: number;
  grpcPort: number;
  databaseUrl?: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
  /** Booking Prototipo (D33): `inventory.InventoryStockService` en el puerto 50051 del contrato v2. */
  bookingGrpcAddress: string;
  /** Booking en Azure (V2.20, D53): `POST …/api/v2/inventory/stock`. Si está, el stock va por REST y no por gRPC. */
  bookingStockUrl?: string;
  /** `service_id` del stock: el código fijo de nuestro equipo que asignó Booking (`NODE_VUE_EQ5`). */
  bookingServiceId: string;
  /** Cada cuánto se revisan los envíos de stock pendientes y los holds vencidos (ms). */
  stockIntervalMs: number;
  sweepIntervalMs: number;
  /** Tiempo máximo de cada llamada a Booking (ms). */
  bookingDeadlineMs: number;
  /** Bus interno (V2.11): el relé publica ahí el outbox (`hold.created`, `hold.expired`). Sin él, los eventos quedan pendientes. */
  busUrl?: string;
}

export const OFFERS_CONFIG = Symbol('OFFERS_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OffersConfig {
  const production = env['NODE_ENV'] === 'production';
  const missing = ['IDENTITY_JWKS_URL', 'BUS_URL'].filter((name) => production && !env[name]?.trim());
  if (production && !env['BOOKING_STOCK_URL']?.trim() && !env['BOOKING_GRPC_ADDRESS']?.trim()) missing.push('BOOKING_STOCK_URL o BOOKING_GRPC_ADDRESS');
  if (missing.length) throw new Error(`Configuración inválida de ms-g-offers:\n - falta ${missing.join('\n - falta ')}`);
  return {
    httpPort: Number(env['PORT'] ?? 4009),
    grpcPort: Number(env['GRPC_PORT'] ?? 50061),
    databaseUrl: env['DATABASE_URL']?.trim() || undefined,
    jwksUrl: env['IDENTITY_JWKS_URL']?.trim() || 'http://localhost:4001/.well-known/jwks.json',
    issuer: env['IDENTITY_ISSUER'] ?? 'ecoairlines-identity',
    audience: env['IDENTITY_AUDIENCE'] ?? 'ecoairlines',
    bookingGrpcAddress: env['BOOKING_GRPC_ADDRESS']?.trim() || 'localhost:50051',
    bookingStockUrl: env['BOOKING_STOCK_URL']?.trim() || undefined,
    bookingServiceId: env['BOOKING_SERVICE_ID']?.trim() || 'NODE_VUE_EQ5',
    stockIntervalMs: Number(env['STOCK_SYNC_INTERVAL_MS'] ?? 2_000),
    sweepIntervalMs: Number(env['HOLD_SWEEP_INTERVAL_MS'] ?? 30_000),
    bookingDeadlineMs: Number(env['BOOKING_DEADLINE_MS'] ?? 3_000),
    busUrl: env['BUS_URL']?.trim() || undefined,
  };
}
