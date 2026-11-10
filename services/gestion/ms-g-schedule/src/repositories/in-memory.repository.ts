import {
  type AircraftRecord,
  type AircraftTypeRecord,
  type AirportRecord,
  DEFAULT_PRICING,
  type FarePriceRecord,
  type PriceChangeRecord,
  type PricingChangeRecord,
  type PricingSettings,
  type PromotionAgreementRecord,
  type RouteRecord,
  type ScheduleState,
} from '../domain/model.js';
import { type AircraftTypeWork, type AirportWork, encodeCursor, type Page, type PriceWork, type PricingWork, type ScheduleRepository, type ScheduleWork } from './schedule.repository.js';

const clone = <T>(value: T): T => structuredClone(value);

/** Implementación en memoria (pruebas y local sin DATABASE_URL). `work` es síncrona: cada cambio ya es atómico. */
export class InMemoryScheduleRepository implements ScheduleRepository {
  readonly kind = 'memory' as const;
  private routes = new Map<string, RouteRecord>();
  private fleet = new Map<string, AircraftRecord>();
  private prices = new Map<string, FarePriceRecord>();
  private changes: PriceChangeRecord[] = [];
  private agreements = new Map<string, PromotionAgreementRecord>();
  private pricing: PricingSettings = { ...DEFAULT_PRICING, routePrices: {}, updatedAt: null, updatedBy: null };
  private pricingChanges: PricingChangeRecord[] = [];
  private airports = new Map<string, AirportRecord>();
  private aircraftTypes = new Map<string, AircraftTypeRecord>();
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

  async getPricing(): Promise<PricingSettings> {
    return clone(this.pricing);
  }
  async changePricing(work: PricingWork): Promise<PricingSettings> {
    const { next, history } = work(clone(this.pricing));
    this.pricing = clone(next);
    this.pricingChanges.push(...clone(history));
    return this.getPricing();
  }
  async listPricingChanges(limit: number): Promise<PricingChangeRecord[]> {
    return clone([...this.pricingChanges].sort((a, b) => b.changedAt.localeCompare(a.changedAt) || a.id.localeCompare(b.id)).slice(0, limit));
  }

  async listAirports(): Promise<AirportRecord[]> {
    return clone([...this.airports.values()].sort((a, b) => a.code.localeCompare(b.code)));
  }
  async seedAirports(airports: AirportRecord[]): Promise<boolean> {
    if (this.airports.size) return false;
    for (const airport of airports) this.airports.set(airport.code, clone(airport));
    return true;
  }
  async changeAirports<T>(work: AirportWork<T>): Promise<T> {
    const { changes, result } = work(await this.listAirports(), this.state());
    for (const airport of changes.saveAirports ?? []) this.airports.set(airport.code, clone(airport));
    for (const code of changes.deleteAirports ?? []) this.airports.delete(code);
    return result;
  }

  async listAircraftTypes(): Promise<AircraftTypeRecord[]> {
    return clone([...this.aircraftTypes.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }
  async seedAircraftTypes(types: AircraftTypeRecord[]): Promise<boolean> {
    if (this.aircraftTypes.size) return false;
    for (const type of types) this.aircraftTypes.set(type.name, clone(type));
    return true;
  }
  async changeAircraftTypes<T>(work: AircraftTypeWork<T>): Promise<T> {
    const { changes, result } = work(await this.listAircraftTypes(), this.state());
    for (const type of changes.saveAircraftTypes ?? []) this.aircraftTypes.set(type.name, clone(type));
    for (const name of changes.deleteAircraftTypes ?? []) this.aircraftTypes.delete(name);
    return result;
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
