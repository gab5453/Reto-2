import { Logger } from '@nestjs/common';
import { AIRPORTS, type Airport, registerAirports, removeAirport } from '@ecoairlines/shared';
import type { RestClient } from './rest.client.js';

/**
 * Catálogo de aeropuertos del ESB (PLAN_Telemetria_Asientos M-1). El dueño es MS.G.Schedule; el ESB lo usa para saber si un
 * vuelo es internacional (pasaporte) y lo reenvía a Offers al publicar el horario. Se mantiene al día de tres formas:
 * - al arrancar y cada `AIRPORT_SYNC_MS` (60 s por defecto) lo pide a Schedule;
 * - el enrutador lo actualiza en cuanto pasa una escritura de aeropuerto que salió bien;
 * - la saga «Publicar horario» lo vuelve a pedir antes de publicar.
 * Si Schedule no responde, se queda con lo que tenía (al principio, la semilla de shared): nunca falla una operación por esto.
 */
const logger = new Logger('AirportCatalog');

/** Reemplaza el catálogo de este proceso por el de Schedule. Devuelve `false` (sin cambiar nada) si Schedule no respondió. */
export async function refreshAirports(schedule: RestClient): Promise<boolean> {
  try {
    const airports = await schedule.json<Airport[]>('GET', '/airports');
    if (!Array.isArray(airports) || !airports.length) return false;
    replaceCatalog(airports);
    return true;
  } catch (error) {
    logger.debug(`No se pudo leer el catálogo de aeropuertos de Schedule: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function replaceCatalog(airports: readonly Airport[]): void {
  const codes = new Set(airports.map((airport) => airport.code));
  for (const code of Object.keys(AIRPORTS)) if (!codes.has(code)) removeAirport(code);
  registerAirports(airports.map(toCatalog));
}

/** Lo que pasó por el enrutador (`createAirport`, `updateAirport`, `deleteAirport`) con respuesta 2xx. */
export function applyAirportWrite(operationId: string, params: Record<string, string>, response: Record<string, unknown> | undefined): void {
  if (operationId === 'deleteAirport' && params['code']) removeAirport(params['code']);
  else if ((operationId === 'createAirport' || operationId === 'updateAirport') && typeof response?.['code'] === 'string') registerAirports([toCatalog(response as unknown as Airport)]);
}

/** Solo lo que necesitan las reglas (sin fechas de auditoría). */
export const toCatalog = (airport: Airport & { province?: string | null }): Airport => ({
  code: airport.code,
  city: airport.city,
  name: airport.name,
  country: airport.country,
  ...(airport.province ? { province: airport.province } : {}),
  lat: Number(airport.lat),
  lon: Number(airport.lon),
  utcOffsetMinutes: Number(airport.utcOffsetMinutes),
  active: airport.active !== false,
});

/** Lectura periódica (se apaga con `AIRPORT_SYNC_MS=0`, como en las pruebas). */
export class AirportCatalogSync {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly schedule: RestClient,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.intervalMs <= 0) return;
    void refreshAirports(this.schedule).then((ok) => ok && logger.log(`Catálogo de aeropuertos cargado de Schedule: ${Object.keys(AIRPORTS).length}.`));
    this.timer = setInterval(() => void refreshAirports(this.schedule), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
