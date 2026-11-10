import { Inject, Injectable } from '@nestjs/common';
import {
  type AircraftTypeSpec,
  buildCabinLayouts,
  configurationOf,
  ProblemDetailsException,
  registerAircraftTypes,
  removeAircraftType,
  SEAT_CONFIGURATIONS,
  SEED_AIRCRAFT_TYPES,
  seatsPerRow,
} from '@ecoairlines/shared';
import type { AircraftTypeRecord, ScheduleState } from '../domain/model.js';
import { SCHEDULE_REPOSITORY, type ScheduleRepository } from '../repositories/schedule.repository.js';

/** Lo que escribe el administrador (el nombre solo al crearlo: es la clave). */
export interface AircraftTypeInput {
  registrationPrefix: string;
  maxRouteKm: number | null;
  turnaroundMinutes: number;
  business: { seats: number; configuration: string };
  economy: { seats: number; configuration: string };
}

const problem = (status: number, code: string, title: string, detail?: string, invalidParams?: { name: string; reason: string }[]) =>
  new ProblemDetailsException({ status, code, title, ...(detail ? { detail } : {}), ...(invalidParams ? { invalidParams } : {}) });

/** Aviones de la flota y rutas que usan un tipo. */
function usage(name: string, state: ScheduleState) {
  return {
    aircraft: state.fleet.filter((plane) => plane.aircraftType === name).map((plane) => plane.registration),
    routes: state.routes.filter((route) => route.aircraftType === name).map((route) => route.routeId),
  };
}

const seatsOf = (cabin: AircraftTypeSpec['cabins'][number]) => (cabin.lastRow - cabin.firstRow + 1) * seatsPerRow(cabin.layout);

/** Ficha pública de un tipo: lo de siempre (`AircraftTypeInfo`) más la distribución de cada cabina (M-2). */
export function toAircraftTypeDto(type: AircraftTypeRecord, inFleet: number) {
  const seats = type.cabins.map((cabin) => ({ cabinClass: cabin.cabinClass, seats: seatsOf(cabin) }));
  return {
    aircraftType: type.name,
    registrationPrefix: type.registrationPrefix,
    seats,
    totalSeats: seats.reduce((sum, cabin) => sum + cabin.seats, 0),
    maxRouteKm: type.maxRouteKm,
    turnaroundMinutes: type.turnaroundMinutes,
    inFleet,
    cabins: type.cabins.map((cabin) => ({
      cabinClass: cabin.cabinClass,
      seats: seatsOf(cabin),
      configuration: configurationOf(cabin.layout),
      layout: cabin.layout,
      firstRow: cabin.firstRow,
      lastRow: cabin.lastRow,
      exitRows: cabin.exitRows ?? [],
      extraLegroomRows: cabin.extraLegroomRows ?? [],
    })),
    source: type.source,
    updatedAt: type.updatedAt,
  };
}

/** Ficha nueva a partir de lo que escribió el administrador; asientos exactos por fila. */
function specOf(name: string, input: AircraftTypeInput): AircraftTypeSpec {
  const invalid: { name: string; reason: string }[] = [];
  for (const [cabin, field] of [['BUSINESS', 'business'], ['ECONOMY', 'economy']] as const) {
    const layout = SEAT_CONFIGURATIONS[cabin][input[field].configuration];
    if (!layout) invalid.push({ name: `${field}.configuration`, reason: `una de ${Object.keys(SEAT_CONFIGURATIONS[cabin]).join(', ')}` });
    else if (input[field].seats % seatsPerRow(layout) !== 0) invalid.push({ name: `${field}.seats`, reason: `múltiplo de ${seatsPerRow(layout)} (asientos por fila en ${input[field].configuration})` });
  }
  if (invalid.length) throw problem(400, 'VALIDATION_FAILED', 'La distribución de asientos no es válida.', 'Cada cabina tiene filas completas: los asientos deben ser múltiplo de los asientos por fila.', invalid);
  return { name, registrationPrefix: input.registrationPrefix, maxRouteKm: input.maxRouteKm, turnaroundMinutes: input.turnaroundMinutes, cabins: buildCabinLayouts(input.business, input.economy) };
}

const sameSpec = (a: AircraftTypeSpec, b: AircraftTypeSpec) =>
  a.registrationPrefix === b.registrationPrefix && a.maxRouteKm === b.maxRouteKm && a.turnaroundMinutes === b.turnaroundMinutes && JSON.stringify(a.cabins) === JSON.stringify(b.cabins);

/**
 * Catálogo de tipos de avión (PLAN_Telemetria_Asientos M-2). Schedule es su dueño (tabla `aircraft_types`, sembrada con los 3 de
 * siempre si está vacía). Cada cambio actualiza el catálogo en memoria de este proceso (lo leen las reglas de rutas y el motor
 * del horario); a Offers le llega con la publicación del horario.
 * - Business y Economy siempre (D-T8): todo avión vende los 4 paquetes.
 * - Un tipo con aviones o rutas no cambia (D-T7): sus mapas de asientos están vendidos y sus rotaciones calculadas; se crea otro.
 */
@Injectable()
export class AircraftTypesService {
  constructor(@Inject(SCHEDULE_REPOSITORY) private readonly repository: ScheduleRepository) {}

  async seed(): Promise<boolean> {
    const now = new Date().toISOString();
    const seeded = await this.repository.seedAircraftTypes(SEED_AIRCRAFT_TYPES.map((spec) => ({ ...spec, source: 'NETWORK' as const, createdAt: now, updatedAt: now, updatedBy: null })));
    const types = await this.repository.listAircraftTypes();
    const names = new Set(types.map((type) => type.name));
    for (const spec of SEED_AIRCRAFT_TYPES) if (!names.has(spec.name)) removeAircraftType(spec.name);
    registerAircraftTypes(types);
    return seeded;
  }

  async list() {
    const [types, state] = await Promise.all([this.repository.listAircraftTypes(), this.repository.loadState()]);
    return types.map((type) => toAircraftTypeDto(type, usage(type.name, state).aircraft.length));
  }

  async create(name: string, input: AircraftTypeInput, actor: string) {
    const spec = specOf(name, input);
    const created = await this.repository.changeAircraftTypes((types) => {
      if (types.some((type) => type.name.toLowerCase() === name.toLowerCase())) {
        throw problem(409, 'AIRCRAFT_TYPE_ALREADY_EXISTS', `Ya existe el tipo «${name}».`, undefined, [{ name: 'aircraftType', reason: 'ya existe' }]);
      }
      const prefix = types.find((type) => type.registrationPrefix === spec.registrationPrefix);
      if (prefix) throw problem(409, 'AIRCRAFT_TYPE_ALREADY_EXISTS', `El prefijo ${spec.registrationPrefix} ya es del ${prefix.name}.`, 'Cada tipo tiene su propio prefijo de matrícula.', [{ name: 'registrationPrefix', reason: 'ya en uso' }]);
      const now = new Date().toISOString();
      const record: AircraftTypeRecord = { ...spec, source: 'ADMIN', createdAt: now, updatedAt: now, updatedBy: actor };
      return { changes: { saveAircraftTypes: [record] }, result: record };
    });
    registerAircraftTypes([created]);
    return toAircraftTypeDto(created, 0);
  }

  async update(name: string, input: AircraftTypeInput, actor: string) {
    const spec = specOf(name, input);
    const { updated, inFleet } = await this.repository.changeAircraftTypes((types, state) => {
      const current = types.find((type) => type.name === name);
      if (!current) throw problem(404, 'AIRCRAFT_TYPE_NOT_FOUND', `No existe el tipo «${name}».`);
      if (sameSpec(current, spec)) return { changes: {}, result: { updated: current, inFleet: usage(name, state).aircraft.length } };
      const use = usage(name, state);
      if (use.aircraft.length || use.routes.length) {
        throw problem(
          409,
          'AIRCRAFT_TYPE_IN_USE',
          `El ${name} tiene aviones: no se cambia.`,
          `Lo usan ${[use.aircraft.length ? `los aviones ${use.aircraft.join(', ')}` : '', use.routes.length ? `las rutas ${use.routes.join(', ')}` : ''].filter(Boolean).join(' y ')}. Cambiar sus asientos, alcance o tiempo en tierra rompería mapas de asientos vendidos y rotaciones: crea un tipo nuevo.`,
        );
      }
      const other = types.find((type) => type.name !== name && type.registrationPrefix === spec.registrationPrefix);
      if (other) throw problem(409, 'AIRCRAFT_TYPE_ALREADY_EXISTS', `El prefijo ${spec.registrationPrefix} ya es del ${other.name}.`, undefined, [{ name: 'registrationPrefix', reason: 'ya en uso' }]);
      const next: AircraftTypeRecord = { ...current, ...spec, updatedAt: new Date().toISOString(), updatedBy: actor };
      return { changes: { saveAircraftTypes: [next] }, result: { updated: next, inFleet: 0 } };
    });
    registerAircraftTypes([updated]);
    return toAircraftTypeDto(updated, inFleet);
  }

  async delete(name: string) {
    await this.repository.changeAircraftTypes((types, state) => {
      if (!types.some((type) => type.name === name)) throw problem(404, 'AIRCRAFT_TYPE_NOT_FOUND', `No existe el tipo «${name}».`);
      if (types.length <= 1) throw problem(409, 'AIRCRAFT_TYPE_IN_USE', 'Es el único tipo de avión: no se puede borrar.');
      const use = usage(name, state);
      if (use.aircraft.length || use.routes.length) throw problem(409, 'AIRCRAFT_TYPE_IN_USE', `El ${name} tiene aviones o rutas: no se puede borrar.`, 'Retira primero sus aviones (y sus rutas).');
      return { changes: { deleteAircraftTypes: [name] }, result: undefined };
    });
    removeAircraftType(name);
  }
}
