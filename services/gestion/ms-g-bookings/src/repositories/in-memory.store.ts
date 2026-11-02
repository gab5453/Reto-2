import type { AssistanceRecord, BookingRecord, DocumentClaim, PaymentRecord } from '../domain/model.js';
import { segmentsOf } from '../domain/rules.js';
import { type BookingsStore, type BookingsTx, type InsertResult, matches } from './bookings.store.js';

const clone = <T>(value: T): T => structuredClone(value);
const claimKey = (claim: Pick<DocumentClaim, 'segmentId' | 'identityKey'>) => `${claim.segmentId}|${claim.identityKey}`;

/** En memoria: transacciones en fila y con deshacer (como un ROLLBACK) si `work` lanza. */
export class InMemoryBookingsStore implements BookingsStore {
  readonly kind = 'memory' as const;
  private readonly bookings = new Map<string, BookingRecord>();
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly documents = new Map<string, DocumentClaim>();
  private readonly assistanceRecords = new Map<string, AssistanceRecord>();
  private queue: Promise<unknown> = Promise.resolve();

  async init(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}

  transaction<T>(work: (tx: BookingsTx) => Promise<T>): Promise<T> {
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

  private set<K, V>(map: Map<K, V>, key: K, value: V | undefined, undo: (() => void)[]): void {
    const had = map.has(key);
    const previous = map.get(key);
    undo.push(() => (had ? map.set(key, previous!) : map.delete(key)));
    if (value === undefined) map.delete(key);
    else map.set(key, clone(value));
  }

  private tx(undo: (() => void)[]): BookingsTx {
    const all = () => [...this.bookings.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.bookingId.localeCompare(b.bookingId));
    return {
      booking: async (id) => clone(this.bookings.get(id)),
      bookingByHold: async (holdId) => clone([...this.bookings.values()].find((booking) => booking.holdId === holdId)),
      insertBooking: async (booking): Promise<InsertResult> => {
        if (this.bookings.has(booking.bookingId)) return 'id-exists';
        if ([...this.bookings.values()].some((other) => other.holdId === booking.holdId)) return 'hold-taken';
        if ([...this.bookings.values()].some((other) => other.pnr === booking.pnr)) return 'pnr-taken';
        this.set(this.bookings, booking.bookingId, booking, undo);
        return 'ok';
      },
      saveBooking: async (booking) => this.set(this.bookings, booking.bookingId, booking, undo),
      listBookings: async (filter, limit, offset) => {
        const found = all().filter((booking) => matches(booking, filter));
        return { items: clone(found.slice(offset, offset + limit)), hasMore: found.length > offset + limit };
      },
      flightBookings: async (segmentId) => clone(all().filter((booking) => segmentsOf(booking).some((segment) => segment.segmentId === segmentId))),
      bookingsCreatedBetween: async (from, to) => clone(all().filter((booking) => matches(booking, { createdFrom: from, createdTo: to }))),

      payment: async (reference) => clone(this.payments.get(reference)),
      insertPayment: async (record) => {
        if (this.payments.has(record.paymentReference)) return false;
        this.set(this.payments, record.paymentReference, record, undo);
        return true;
      },
      savePayment: async (record) => this.set(this.payments, record.paymentReference, record, undo),
      deletePayment: async (reference) => this.set(this.payments, reference, undefined, undo),

      documentHolders: async (claims) => clone(claims.map((claim) => this.documents.get(claimKey(claim))).filter((held): held is DocumentClaim => !!held)),
      claimDocuments: async (claims) => {
        const conflicts = claims.map((claim) => this.documents.get(claimKey(claim))).filter((held): held is DocumentClaim => !!held && claims.every((claim) => claim.bookingId !== held.bookingId));
        if (conflicts.length) return clone(conflicts);
        for (const claim of claims) this.set(this.documents, claimKey(claim), claim, undo);
        return [];
      },
      releaseDocuments: async (bookingId, segmentIds) => {
        for (const [key, claim] of this.documents) {
          if (claim.bookingId === bookingId && (!segmentIds || segmentIds.includes(claim.segmentId))) this.set(this.documents, key, undefined, undo);
        }
      },

      assistance: async (bookingId) => clone([...this.assistanceRecords.values()].filter((record) => record.bookingId === bookingId)),
      saveAssistance: async (record) => this.set(this.assistanceRecords, `${record.bookingId}|${record.passengerId}`, record, undo),
      deleteAssistance: async (bookingId, passengerId) => this.set(this.assistanceRecords, `${bookingId}|${passengerId}`, undefined, undo),
    };
  }
}
