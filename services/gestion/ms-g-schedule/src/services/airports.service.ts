import { Inject, Injectable } from '@nestjs/common';
import { type Airport, ProblemDetailsException, registerAirports, removeAirport, SEED_AIRPORTS } from '@ecoairlines/shared';
import type { AirportRecord, ScheduleState } from '../domain/model.js';
import { SCHEDULE_REPOSITORY, type ScheduleRepository } from '../repositories/schedule.repository.js';

/** Lo que el administrador escribe de un aeropuerto (el código solo al crearlo). */
export interface AirportInput {
  city: string;
  name: string;
  country: string;
  province?: string | null;
  lat: number;
  lon: number;
  utcOffsetMinutes: number;
  active?: boolean;
}

/** Campos que mueven distancias y horas: no cambian si el aeropuerto tiene rutas o aviones (M-1, como D-T7). */
const GEOGRAPHY = ['country', 'lat', 'lon', 'utcOffsetMinutes'] as const;

const problem = (status: number, code: string, title: string, detail?: string, invalidParams?: { name: string; reason: string }[]) =>
  new ProblemDetailsException({ status, code, title, ...(detail ? { detail } : {}), ...(invalidParams ? { invalidParams } : {}) });

/** Rutas y aviones que usan un aeropuerto. */
function usage(code: string, state: ScheduleState) {
  return {
    routes: state.routes.filter((route) => route.origin === code || route.destination === code).map((route) => route.routeId),
    aircraft: state.fleet.filter((plane) => plane.base === code).map((plane) => plane.registration),
  };
}

const usageText = (use: ReturnType<typeof usage>) =>
  [use.routes.length ? `las rutas ${use.routes.join(', ')}` : '', use.aircraft.length ? `los aviones con base ahí ${use.aircraft.join(', ')}` : ''].filter(Boolean).join(' y ');

export const toAirportDto = (airport: AirportRecord) => ({
  code: airport.code,
  city: airport.city,
  name: airport.name,
  country: airport.country,
  province: airport.province ?? null,
  lat: airport.lat,
  lon: airport.lon,
  utcOffsetMinutes: airport.utcOffsetMinutes,
  active: airport.active,
  updatedAt: airport.updatedAt,
});

/**
 * Catálogo de aeropuertos (PLAN_Telemetria_Asientos M-1). Schedule es su dueño: la tabla `airports`, sembrada con los 34 de
 * siempre. Cada cambio actualiza también el catálogo en memoria de este proceso (`AIRPORTS` de shared), que es el que leen las
 * reglas de rutas y el motor del horario. Al ESB y a Offers les llega por el ESB.
 */
@Injectable()
export class AirportsService {
  constructor(@Inject(SCHEDULE_REPOSITORY) private readonly repository: ScheduleRepository) {}

  /** Al arrancar: siembra si la tabla está vacía y carga el catálogo de la base en memoria. */
  async seed(): Promise<boolean> {
    const now = new Date().toISOString();
    const seeded = await this.repository.seedAirports(Object.values(SEED_AIRPORTS).map((airport) => ({ ...airport, active: true, createdAt: now, updatedAt: now, updatedBy: null })));
    const airports = await this.repository.listAirports();
    const codes = new Set(airports.map((airport) => airport.code));
    // El catálogo en memoria queda igual a la base: los de la semilla que el administrador borró también se quitan.
    for (const code of Object.keys(SEED_AIRPORTS)) if (!codes.has(code)) removeAirport(code);
    registerAirports(airports.map(toCatalog));
    return seeded;
  }

  async list() {
    return (await this.repository.listAirports()).map(toAirportDto);
  }

  async get(code: string) {
    const airport = (await this.repository.listAirports()).find((candidate) => candidate.code === code);
    if (!airport) throw problem(404, 'AIRPORT_NOT_FOUND', `No existe el aeropuerto ${code}.`);
    return toAirportDto(airport);
  }

  async create(code: string, input: AirportInput, actor: string) {
    const created = await this.repository.changeAirports((airports) => {
      if (airports.some((airport) => airport.code === code)) {
        throw problem(409, 'AIRPORT_ALREADY_EXISTS', `Ya existe el aeropuerto ${code}.`, 'El código es único y no se puede reutilizar.', [{ name: 'code', reason: 'ya existe' }]);
      }
      const now = new Date().toISOString();
      const record: AirportRecord = { code, ...clean(input), active: input.active ?? true, createdAt: now, updatedAt: now, updatedBy: actor };
      return { changes: { saveAirports: [record] }, result: record };
    });
    registerAirports([toCatalog(created)]);
    return toAirportDto(created);
  }

  async update(code: string, input: AirportInput, actor: string) {
    const updated = await this.repository.changeAirports((airports, state) => {
      const current = airports.find((airport) => airport.code === code);
      if (!current) throw problem(404, 'AIRPORT_NOT_FOUND', `No existe el aeropuerto ${code}.`);
      const { province: _province, ...rest } = current;
      const next: AirportRecord = { ...rest, ...clean(input), active: input.active ?? current.active, updatedAt: new Date().toISOString(), updatedBy: actor };
      const changed = GEOGRAPHY.filter((field) => next[field] !== current[field]);
      const use = usage(code, state);
      if (changed.length && (use.routes.length || use.aircraft.length)) {
        throw problem(
          409,
          'AIRPORT_IN_USE',
          `${code} está en uso: no se cambian su país, coordenadas ni huso horario.`,
          `Lo usan ${usageText(use)}. Cambiarlos movería distancias y horas de vuelos ya publicados; el nombre, la ciudad, la provincia y si está activo sí se pueden cambiar.`,
          changed.map((field) => ({ name: field, reason: 'no se cambia con rutas o aviones' })),
        );
      }
      return { changes: { saveAirports: [next] }, result: next };
    });
    registerAirports([toCatalog(updated)]);
    return toAirportDto(updated);
  }

  async delete(code: string) {
    await this.repository.changeAirports((airports, state) => {
      if (!airports.some((airport) => airport.code === code)) throw problem(404, 'AIRPORT_NOT_FOUND', `No existe el aeropuerto ${code}.`);
      const use = usage(code, state);
      if (use.routes.length || use.aircraft.length) {
        throw problem(409, 'AIRPORT_IN_USE', `${code} está en uso: no se puede borrar.`, `Lo usan ${usageText(use)}. Desactívalo: deja de ofrecerse para rutas nuevas y lo existente sigue igual.`);
      }
      return { changes: { deleteAirports: [code] }, result: undefined };
    });
    removeAirport(code);
  }
}

function clean(input: AirportInput): Omit<Airport, 'code' | 'active'> {
  return {
    city: input.city.trim(),
    name: input.name.trim(),
    country: input.country,
    ...(input.province?.trim() ? { province: input.province.trim() } : {}),
    lat: input.lat,
    lon: input.lon,
    utcOffsetMinutes: input.utcOffsetMinutes,
  };
}

const toCatalog = (airport: AirportRecord): Airport => ({
  code: airport.code,
  city: airport.city,
  name: airport.name,
  country: airport.country,
  ...(airport.province ? { province: airport.province } : {}),
  lat: airport.lat,
  lon: airport.lon,
  utcOffsetMinutes: airport.utcOffsetMinutes,
  active: airport.active,
});
