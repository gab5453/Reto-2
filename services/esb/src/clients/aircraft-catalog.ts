import { Logger } from '@nestjs/common';
import { type AircraftTypeSpec, registerAircraftTypes } from '@ecoairlines/shared';
import type { RestClient } from './rest.client.js';

/**
 * Tipos de avión para Offers (PLAN_Telemetria_Asientos M-2). El dueño es MS.G.Schedule; la saga «Publicar horario» los pide antes
 * de publicar y se los manda a Offers con el horario (mapa de asientos y cupos por cabina). Si Schedule no responde, van los que
 * ya tiene el ESB (al principio, la semilla de shared).
 */
const logger = new Logger('AircraftCatalog');

interface AircraftTypeInfo {
  aircraftType: string;
  registrationPrefix: string;
  maxRouteKm: number | null;
  turnaroundMinutes: number;
  cabins?: { cabinClass: 'ECONOMY' | 'BUSINESS'; firstRow: number; lastRow: number; layout: string; exitRows?: number[]; extraLegroomRows?: number[] }[];
}

export async function refreshAircraftTypes(schedule: RestClient): Promise<void> {
  try {
    const types = await schedule.json<AircraftTypeInfo[]>('GET', '/aircraft-types');
    if (!Array.isArray(types)) return;
    registerAircraftTypes(
      types
        .filter((type) => type.cabins?.length)
        .map((type): AircraftTypeSpec => ({
          name: type.aircraftType,
          registrationPrefix: type.registrationPrefix,
          maxRouteKm: type.maxRouteKm,
          turnaroundMinutes: type.turnaroundMinutes,
          cabins: type.cabins!.map(({ cabinClass, firstRow, lastRow, layout, exitRows, extraLegroomRows }) => ({ cabinClass, firstRow, lastRow, layout, exitRows: exitRows ?? [], extraLegroomRows: extraLegroomRows ?? [] })),
        })),
    );
  } catch (error) {
    logger.debug(`No se pudo leer el catálogo de tipos de avión de Schedule: ${error instanceof Error ? error.message : String(error)}`);
  }
}
