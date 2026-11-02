import type {
  AircraftRecord,
  FarePriceRecord,
  PriceChangeRecord,
  PromotionAgreementRecord,
  RouteRecord,
  ScheduleState,
} from '../domain/model.js';
import { encodeCursor, type Page, type PriceWork, type ScheduleRepository, type ScheduleWork } from './schedule.repository.js';

const clone = <T>(value: T): T => structuredClone(value);

/** Implementación en memoria (pruebas y local sin DATABASE_URL). `work` es síncrona: cada cambio ya es atómico. */
export class InMemoryScheduleRepository implements ScheduleRepository {
  readonly kind = 'memory' as const;
  private routes = new Map<string, RouteRecord>();
  private fleet = new Map<string, AircraftRecord>();
  private prices = new Map<string, FarePriceRecord>();
  private changes: PriceChangeRecord[] = [];
  private agreements = new Map<string, PromotionAgreementRecord>();
  private counter = 0;

  async init(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}

  async loadState(): Promise<ScheduleState> {
    return this.state();
  }
  async version(): Promise<number> {
    return this.counter;
  }

  async changeSchedule<T>(work: ScheduleWork<T>): Promise<T> {
    const { changes, result } = work(this.state());
    for (const id of changes.deleteRoutes ?? []) this.routes.delete(id);
    for (const plane of changes.saveAircraft ?? []) this.fleet.set(plane.registration, clone(plane));
    for (const route of changes.saveRoutes ?? []) this.routes.set(route.routeId, clone(route));
    for (const registration of changes.deleteAircraft ?? []) this.fleet.delete(registration);
    if (Object.values(changes).some((list) => list?.length)) this.counter++;
    return result;
  }

  async seedSchedule(state: ScheduleState): Promise<boolean> {
    if (this.routes.size || this.fleet.size) return false;
    await this.changeSchedule(() => ({ changes: { saveAircraft: state.fleet, saveRoutes: state.routes }, result: undefined }));
    return true;
  }

  async listPrices(): Promise<FarePriceRecord[]> {
    return clone([...this.prices.values()]);
  }
  async seedPrices(prices: FarePriceRecord[]): Promise<void> {
    for (const price of prices) {
      const key = `${price.cabinClass}/${price.fareBrand}`;
      if (!this.prices.has(key)) this.prices.set(key, clone(price));
    }
  }
  async changePrices(work: PriceWork): Promise<FarePriceRecord[]> {
    const { updated, history } = work(await this.listPrices());
    for (const price of updated) this.prices.set(`${price.cabinClass}/${price.fareBrand}`, clone(price));
    this.changes.push(...clone(history));
    return this.listPrices();
  }
  async listPriceChanges(limit: number, offset: number): Promise<Page<PriceChangeRecord>> {
    const sorted = [...this.changes].sort((a, b) => b.changedAt.localeCompare(a.changedAt) || a.id.localeCompare(b.id));
    const items = clone(sorted.slice(offset, offset + limit));
    return offset + limit < sorted.length ? { items, nextCursor: encodeCursor(offset + limit) } : { items };
  }

  async getAgreement(partnerId: string) {
    const agreement = this.agreements.get(partnerId);
    return agreement && clone(agreement);
  }
  async saveAgreement(agreement: PromotionAgreementRecord): Promise<void> {
    this.agreements.set(agreement.partnerId, clone(agreement));
  }

  private state(): ScheduleState {
    return { routes: clone([...this.routes.values()]), fleet: clone([...this.fleet.values()]) };
  }
}
