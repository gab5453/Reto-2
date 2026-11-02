import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemDetailsException } from '@ecoairlines/shared';
import { type CabinClass, type FareBrand, type FarePriceRecord, type PriceChangeRecord, REFERENCE_FARE_PRICES } from '../domain/model.js';
import { assertMultipliers } from '../domain/rules.js';
import { decodeCursor, SCHEDULE_REPOSITORY, type ScheduleRepository } from '../repositories/schedule.repository.js';

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

function toTable(prices: FarePriceRecord[]) {
  const updatedAt = prices.map((price) => price.updatedAt).sort().at(-1) ?? new Date(0).toISOString();
  return { items: prices, updatedAt };
}
