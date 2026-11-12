import type { AircraftTypeSpec } from '@ecoairlines/shared';
import type { Airport } from '@ecoairlines/shared';
import type { CloudEvent } from '@ecoairlines/shared';
import type {
  BookingSeatRecord,
  CabinClass,
  FarePriceRecord,
  FlightRecord,
  HoldRecord,
  HoldStatus,
  InventoryRecord,
  OutboxRecord,
  PricingSettingsRecord,
  PromotionRuleRecord,
  StockSyncRecord,
} from '../domain/model.js';
import { available, DEFAULT_PRICING_SETTINGS } from '../domain/model.js';
import { type CupoState, type OffersStore, type OffersTx, SeatTakenError } from './offers.store.js';

const clone = <T>(value: T): T => structuredClone(value);
const cupoKey = (segmentId: string, cabinClass: string) => `${segmentId}|${cabinClass}`;

/**
 * Implementación en memoria. Las transacciones se ejecutan una tras otra (cola) y cada cambio guarda cómo deshacerse: si
 * `work` lanza, se revierte todo, igual que un ROLLBACK.
 */
export class InMemoryOffersStore implements OffersStore {
  readonly kind = 'memory' as const;
  private readonly flights = new Map<string, FlightRecord>();
  private readonly inventories = new Map<string, InventoryRecord>();
  private readonly seats = new Map<string, BookingSeatRecord>();
  private readonly holds = new Map<string, HoldRecord>();
  private prices: FarePriceRecord[] = [];
  private pricing: PricingSettingsRecord = clone(DEFAULT_PRICING_SETTINGS);
  private airports: Airport[] = [];
  private aircraftTypes: AircraftTypeSpec[] = [];
  private rules: PromotionRuleRecord[] = [];
  private readonly sagas = new Map<string, unknown>();
  private readonly outboxRecords: OutboxRecord[] = [];
  private readonly stock = new Map<string, StockSyncRecord>();
  private queue: Promise<unknown> = Promise.resolve();

  async init(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}

  transaction<T>(work: (tx: OffersTx) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const undo: (() => void)[] = [];
      try {
        return await work(this.tx(undo));
      } catch (error) {
        for (const step of undo.reverse()) step();
        throw error;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async dueHolds(now: string, limit: number): Promise<string[]> {
    return [...this.holds.values()].filter((hold) => hold.status === 'HELD' && hold.expiresAt <= now).slice(0, limit).map((hold) => hold.holdId);
  }

  async pendingStock(now: string, limit: number): Promise<StockSyncRecord[]> {
    return clone([...this.stock.values()].filter((row) => row.pending && row.nextAttemptAt <= now).slice(0, limit));
  }

  async markStockPushed(segmentId: string, cabinClass: CabinClass, version: number, at: string): Promise<void> {
    const row = this.stock.get(cupoKey(segmentId, cabinClass));
    if (row && row.version === version) Object.assign(row, { pending: false, attempts: 0, pushedUnits: row.units, pushedAt: at, lastError: null });
  }

  async markStockFailed(segmentId: string, cabinClass: CabinClass, version: number, error: string, nextAttemptAt: string): Promise<void> {
    const row = this.stock.get(cupoKey(segmentId, cabinClass));
    if (row && row.version === version) Object.assign(row, { attempts: row.attempts + 1, lastError: error, nextAttemptAt });
  }

  async stats(today: string) {
    const pushed = [...this.stock.values()].map((row) => row.pushedAt).filter((at): at is string => !!at).sort();
    return {
      activeHolds: [...this.holds.values()].filter((hold) => hold.status === 'HELD').length,
      flightsOnSaleToday: [...this.flights.values()].filter((flight) => flight.date === today && flight.onSale).length,
      ...(pushed.length ? { lastStockPushAt: pushed.at(-1)! } : {}),
      pendingStockPushes: [...this.stock.values()].filter((row) => row.pending).length,
    };
  }

  async outbox(): Promise<OutboxRecord[]> {
    return clone(this.outboxRecords);
  }

  private readonly outboxLeases = new Map<string, number>();

  async claimOutbox(limit: number, leaseMs: number) {
    const now = Date.now();
    const ready = this.outboxRecords.filter((r) => !r.publishedAt && (this.outboxLeases.get(r.id) ?? 0) <= now).slice(0, limit);
    for (const r of ready) this.outboxLeases.set(r.id, now + leaseMs);
    return ready.map((r) => ({ id: r.id, event: clone(r.event) as CloudEvent, ownerId: r.ownerId ?? null }));
  }

  async markOutboxPublished(id: string, publishedAt: string) {
    const record = this.outboxRecords.find((r) => r.id === id);
    if (record) record.publishedAt = publishedAt;
    this.outboxLeases.delete(id);
  }

  /** Guarda el valor anterior de una entrada de un Map para poder deshacer. */
  private setIn<K, V>(map: Map<K, V>, key: K, value: V | undefined, undo: (() => void)[]): void {
    const had = map.has(key);
    const previous = map.get(key);
    undo.push(() => (had ? map.set(key, previous!) : map.delete(key)));
    if (value === undefined) map.delete(key);
    else map.set(key, value);
  }

  private tx(undo: (() => void)[]): OffersTx {
    const bySegment = (segmentId: string) => [...this.seats.values()].filter((seat) => seat.segmentId === segmentId);
    const seatOwner = (segmentId: string, seatNumber: string) => bySegment(segmentId).find((seat) => seat.seatNumber === seatNumber);
    const sortFlights = (flights: FlightRecord[]) => clone(flights.sort((a, b) => a.departureAt.localeCompare(b.departureAt) || a.flightNumber.localeCompare(b.flightNumber)));
    return {
      flight: async (segmentId) => clone(this.flights.get(segmentId)),
      flightsOn: async (date) => sortFlights([...this.flights.values()].filter((flight) => flight.date === date)),
      flightsInRange: async (from, to, routeId) =>
        sortFlights([...this.flights.values()].filter((flight) => flight.date >= from && flight.date <= to && (!routeId || flight.routeId === routeId))),
      flightsByNumbers: async (numbers, fromDate) => sortFlights([...this.flights.values()].filter((flight) => numbers.includes(flight.flightNumber) && flight.date >= fromDate)),
      saveFlight: async (flight) => this.setIn(this.flights, flight.segmentId, clone(flight), undo),
      deleteFlight: async (segmentId) => {
        this.setIn(this.flights, segmentId, undefined, undo);
        for (const key of [...this.inventories.keys()].filter((key) => key.startsWith(`${segmentId}|`))) this.setIn(this.inventories, key, undefined, undo);
      },

      inventory: async (segmentId) => clone([...this.inventories.values()].filter((row) => row.segmentId === segmentId)),
      saveInventory: async (row) => this.setIn(this.inventories, cupoKey(row.segmentId, row.cabinClass), clone(row), undo),
      moveCupos: async (segmentId, cabinClass, from: CupoState, to: CupoState, count) => {
        const row = this.inventories.get(cupoKey(segmentId, cabinClass));
        if (!row) return false;
        const enough = from === 'AVAILABLE' ? available(row) >= count : row.counts[from] >= count;
        if (!enough) return false;
        const next = clone(row);
        if (from !== 'AVAILABLE') next.counts[from] -= count;
        if (to !== 'AVAILABLE') next.counts[to] += count;
        this.setIn(this.inventories, cupoKey(segmentId, cabinClass), next, undo);
        return true;
      },

      bookingSeats: async (bookingId) => clone([...this.seats.values()].filter((seat) => seat.bookingId === bookingId)),
      assignedSeats: async (segmentId) => clone(bySegment(segmentId).filter((seat) => seat.seatNumber)),
      insertBookingSeat: async (seat) => {
        if (seat.seatNumber && seatOwner(seat.segmentId, seat.seatNumber)) return false;
        this.setIn(this.seats, seat.id, clone(seat), undo);
        return true;
      },
      updateBookingSeat: async (seat) => {
        const owner = seat.seatNumber ? seatOwner(seat.segmentId, seat.seatNumber) : undefined;
        if (owner && owner.id !== seat.id) throw new SeatTakenError(seat.segmentId, seat.seatNumber!);
        this.setIn(this.seats, seat.id, clone(seat), undo);
      },
      deleteBookingSeats: async (ids) => {
        for (const id of ids) this.setIn(this.seats, id, undefined, undo);
      },

      hold: async (holdId) => clone(this.holds.get(holdId)),
      insertHold: async (hold) => this.setIn(this.holds, hold.holdId, clone(hold), undo),
      updateHoldIf: async (holdId, expected: HoldStatus, patch) => {
        const hold = this.holds.get(holdId);
        if (!hold || hold.status !== expected) return false;
        this.setIn(this.holds, holdId, { ...clone(hold), ...patch }, undo);
        return true;
      },
      activeHoldsOn: async (segmentId) =>
        clone([...this.holds.values()].filter((hold) => hold.status === 'HELD' && hold.selections.some((selection) => selection.segmentIds.includes(segmentId)))),

      farePrices: async () => clone(this.prices),
      replaceFarePrices: async (prices) => {
        const previous = this.prices;
        undo.push(() => (this.prices = previous));
        this.prices = clone(prices);
      },
      pricingSettings: async () => clone(this.pricing),
      replacePricingSettings: async (settings) => {
        const previous = this.pricing;
        undo.push(() => (this.pricing = previous));
        this.pricing = clone(settings);
      },
      airportCatalog: async () => clone(this.airports),
      replaceAirportCatalog: async (airports) => {
        const previous = this.airports;
        undo.push(() => (this.airports = previous));
        this.airports = clone(airports);
      },
      aircraftTypeCatalog: async () => clone(this.aircraftTypes),
      saveAircraftTypeCatalog: async (types) => {
        const previous = this.aircraftTypes;
        undo.push(() => (this.aircraftTypes = previous));
        const names = new Set(types.map((type) => type.name));
        this.aircraftTypes = [...previous.filter((type) => !names.has(type.name)), ...clone(types)];
      },
      promotionRule: async (partnerId) => clone(this.rules.find((rule) => rule.partnerId === partnerId)),
      replacePromotionRules: async (rules) => {
        const previous = this.rules;
        undo.push(() => (this.rules = previous));
        this.rules = clone(rules);
      },

      sagaResult: async <T>(key: string) => clone(this.sagas.get(key) as T | undefined),
      saveSagaResult: async (key, result) => this.setIn(this.sagas, key, clone(result), undo),
      addOutbox: async (record) => {
        const copy = clone(record);
        this.outboxRecords.push(copy);
        undo.push(() => this.outboxRecords.splice(this.outboxRecords.indexOf(copy), 1));
      },
      markStock: async (record) => {
        const key = cupoKey(record.segmentId, record.cabinClass);
        const current = this.stock.get(key);
        this.setIn(
          this.stock,
          key,
          { ...current, ...record, version: (current?.version ?? 0) + 1, pending: true, attempts: 0, nextAttemptAt: new Date(0).toISOString() },
          undo,
        );
      },
    };
  }
}
