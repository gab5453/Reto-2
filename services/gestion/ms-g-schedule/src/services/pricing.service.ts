import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemDetailsException } from '@ecoairlines/shared';
import {
  type CabinClass,
  type FareBrand,
  FARE_BRANDS,
  type FarePriceRecord,
  type PriceChangeRecord,
  type PricingChangeRecord,
  type PricingSettings,
  REFERENCE_FARE_PRICES,
} from '../domain/model.js';
import { assertMultipliers } from '../domain/rules.js';
import { decodeCursor, SCHEDULE_REPOSITORY, type ScheduleRepository } from '../repositories/schedule.repository.js';

/** Estado completo de la tarifa base y los precios por ruta (P-1): la saga manda siempre el estado entero (también al compensar). */
export interface PricingInput {
  fixedCharge: number;
  perKm: number;
  routePrices: { routeId: string; prices: { fareBrand: FareBrand; amount: number }[] }[];
}

const cents = (value: number) => Math.round(value * 100) / 100;

export interface FarePriceInput {
  cabinClass: CabinClass;
  fareBrand: FareBrand;
  multiplier: number;
}

/**
 * Precios por clase (contrato: Precios). Guardar es un paso de la saga "Guardar precios y descuento máximo": aquí se valida,
 * se guarda y queda el historial; el ESB publica la tabla a Offers (`PublishFarePrices`).
 */
@Injectable()
export class PricingService {
  constructor(@Inject(SCHEDULE_REPOSITORY) private readonly repository: ScheduleRepository) {}

  async table() {
    return toTable(await this.repository.listPrices());
  }

  /** «Rellenar»: los valores de referencia, sin guardar nada. */
  reference() {
    return REFERENCE_FARE_PRICES.map((price) => ({ ...price }));
  }

  /** Todo o nada: si una fila es inválida no se guarda ninguna. Un valor igual al actual no deja historial. */
  async save(items: FarePriceInput[], actor: string) {
    const keys = items.map((item) => `${item.cabinClass}/${item.fareBrand}`);
    if (new Set(keys).size !== keys.length) {
      throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'Una combinación de cabina y familia está repetida.' });
    }
    assertMultipliers(items);
    const updated = await this.repository.changePrices((current) => {
      const now = new Date().toISOString();
      const byKey = new Map(current.map((price) => [`${price.cabinClass}/${price.fareBrand}`, price]));
      const missing = keys.filter((key) => !byKey.has(key));
      if (missing.length) {
        throw new ProblemDetailsException({
          status: 404,
          code: 'NOT_FOUND',
          title: 'Combinación de cabina y familia inexistente.',
          invalidParams: missing.map((key) => ({ name: 'items', reason: `${key} no existe` })),
        });
      }
      const changed: FarePriceRecord[] = [];
      const history: PriceChangeRecord[] = [];
      for (const item of items) {
        const price = byKey.get(`${item.cabinClass}/${item.fareBrand}`)!;
        const multiplier = Math.round(item.multiplier * 1000) / 1000;
        if (multiplier === price.multiplier) continue;
        changed.push({ ...price, multiplier, updatedAt: now, updatedBy: actor });
        history.push({ id: randomUUID(), cabinClass: price.cabinClass, fareBrand: price.fareBrand, oldMultiplier: price.multiplier, newMultiplier: multiplier, changedBy: actor, changedAt: now });
      }
      return { updated: changed, history };
    });
    return toTable(updated);
  }

  /** Tarifa base y precios exactos por ruta (P-1), con los últimos 20 cambios. */
  async pricing() {
    const [settings, history] = await Promise.all([this.repository.getPricing(), this.repository.listPricingChanges(20)]);
    return toPricingView(settings, history);
  }

  /**
   * Reemplaza la tarifa base y los precios por ruta (P-1, D-T12). Todo o nada; cada diferencia queda en el historial. Una ruta
   * con precio exacto lleva los 4 paquetes. Una ruta que se agrega o cambia debe existir en el horario (una que se dio de baja
   * puede quedar con su precio anterior: no molesta).
   */
  async savePricing(input: PricingInput, actor: string) {
    const invalid = (title: string, name: string, reason: string) => new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title, invalidParams: [{ name, reason }] });
    const routeIds = input.routePrices.map((route) => route.routeId);
    if (new Set(routeIds).size !== routeIds.length) throw invalid('Una ruta está repetida.', 'routePrices', 'routeId repetido');
    const wanted: PricingSettings['routePrices'] = {};
    for (const route of input.routePrices) {
      const brands = route.prices.map((price) => price.fareBrand);
      if (brands.length !== FARE_BRANDS.length || FARE_BRANDS.some((brand) => !brands.includes(brand))) {
        throw invalid('El precio exacto de una ruta lleva los 4 paquetes (Semilla, Brote, Bosque y Dosel).', 'routePrices', route.routeId);
      }
      wanted[route.routeId] = Object.fromEntries(route.prices.map((price) => [price.fareBrand, cents(price.amount)]));
    }
    const known = new Set((await this.repository.loadState()).routes.map((route) => route.routeId));
    const saved = await this.repository.changePricing((current) => {
      const now = new Date().toISOString();
      const history: PricingChangeRecord[] = [];
      const change = (field: PricingChangeRecord['field'], oldValue: number | null, newValue: number | null, routeId: string | null = null, fareBrand: FareBrand | null = null) => {
        if (oldValue !== newValue) history.push({ id: randomUUID(), field, routeId, fareBrand, oldValue, newValue, changedBy: actor, changedAt: now });
      };
      change('FIXED_CHARGE', current.fixedCharge, cents(input.fixedCharge));
      change('PER_KM', current.perKm, Math.round(input.perKm * 10_000) / 10_000);
      for (const routeId of new Set([...Object.keys(current.routePrices), ...Object.keys(wanted)])) {
        for (const brand of FARE_BRANDS) {
          const before = current.routePrices[routeId]?.[brand] ?? null;
          const after = wanted[routeId]?.[brand] ?? null;
          if (before !== after && after !== null && !known.has(routeId)) {
            throw new ProblemDetailsException({ status: 404, code: 'NOT_FOUND', title: `La ruta ${routeId} no existe en el horario.`, invalidParams: [{ name: 'routePrices', reason: routeId }] });
          }
          change('ROUTE_PRICE', before, after, routeId, brand);
        }
      }
      const changed = history.length > 0;
      return {
        next: {
          fixedCharge: cents(input.fixedCharge),
          perKm: Math.round(input.perKm * 10_000) / 10_000,
          routePrices: wanted,
          updatedAt: changed ? now : current.updatedAt,
          updatedBy: changed ? actor : current.updatedBy,
        },
        history,
      };
    });
    return toPricingView(saved, await this.repository.listPricingChanges(20));
  }

  async history(limit: number, cursor?: string) {
    const page = await this.repository.listPriceChanges(limit, decodeCursor(cursor));
    return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  /** Semilla: las combinaciones con su valor de referencia (las que ya existen no se tocan). */
  async seed(): Promise<void> {
    const now = new Date().toISOString();
    await this.repository.seedPrices(
      REFERENCE_FARE_PRICES.map((price) => ({ ...price, referenceMultiplier: price.multiplier, updatedAt: now, updatedBy: null })),
    );
  }
}

function toPricingView(settings: PricingSettings, history: PricingChangeRecord[]) {
  return {
    fixedCharge: settings.fixedCharge,
    perKm: settings.perKm,
    routePrices: Object.entries(settings.routePrices)
      .map(([routeId, prices]) => ({ routeId, prices: FARE_BRANDS.filter((brand) => prices[brand] !== undefined).map((fareBrand) => ({ fareBrand, amount: prices[fareBrand]! })) }))
      .sort((a, b) => a.routeId.localeCompare(b.routeId)),
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
    history,
  };
}

function toTable(prices: FarePriceRecord[]) {
  const updatedAt = prices.map((price) => price.updatedAt).sort().at(-1) ?? new Date(0).toISOString();
  return { items: prices, updatedAt };
}
