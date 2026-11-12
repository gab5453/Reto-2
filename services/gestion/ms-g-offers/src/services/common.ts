import { createCloudEvent, currentCorrelation, ProblemDetailsException } from '@ecoairlines/shared';
import { isValidConnection, parseItineraryId, parseOfferId, toItinerary, type Itinerary } from '../domain/catalog.js';
import { available, type CabinClass, type FlightRecord, type InventoryRecord } from '../domain/model.js';
import type { OffersTx } from '../repositories/offers.store.js';

/** Errores con la forma de ProblemDetails; la capa gRPC los traduce a código de estado + trailer `x-problem-details-bin`. */
export const problem = (
  status: number,
  code: string,
  title: string,
  extra: { detail?: string; invalidParams?: { name: string; reason: string }[] } = {},
) => new ProblemDetailsException({ status, code, title, ...extra });

export const validation = (title: string, name: string, reason: string) => problem(400, 'VALIDATION_FAILED', title, { invalidParams: [{ name, reason }] });
export const offerGone = () => problem(410, 'OFFER_NO_LONGER_AVAILABLE', 'La oferta ya no está disponible.');
export const noCupos = () => problem(409, 'OFFER_NO_LONGER_AVAILABLE', 'La oferta ya no tiene cupos suficientes.');

/** Canal de venta según el dueño (D29): `partner:…` → BOOKING; si no → WEB. */
export const channelOf = (ownerId: string) => (ownerId.startsWith('partner:') ? ('BOOKING' as const) : ('WEB' as const));

/**
 * Deja pendiente, en la misma transacción, el stock ABSOLUTO de las cabinas de un vuelo para Booking (D33). Un vuelo con la
 * venta cerrada se informa con 0.
 */
export async function markStock(tx: OffersTx, segmentId: string, cabins?: CabinClass[]): Promise<void> {
  const flight = await tx.flight(segmentId);
  if (!flight) return;
  for (const row of await tx.inventory(segmentId)) {
    if (cabins && !cabins.includes(row.cabinClass)) continue;
    await tx.markStock({
      segmentId,
      cabinClass: row.cabinClass,
      flightNumber: flight.flightNumber,
      date: flight.date,
      timeSlot: flight.departureAt.slice(11, 16),
      units: flight.onSale ? available(row) : 0,
      correlationId: currentCorrelation()?.correlationId ?? null,
    });
  }
}

/** Evento público al outbox (CloudEvents; el relé al bus llega en V2.11). */
export async function addEvent(tx: OffersTx, name: 'hold.created' | 'hold.expired', subject: string, data: Record<string, unknown>, ownerId: string): Promise<void> {
  const event = createCloudEvent({ name, visibility: 'public', subject, data });
  await tx.addOutbox({ id: event.id, type: event.type, event, ownerId, createdAt: event.time });
}

/** Lecturas de una transacción con caché (una búsqueda pide los mismos vuelos e inventarios varias veces). */
export class TxReader {
  private readonly flights = new Map<string, Promise<FlightRecord | undefined>>();
  private readonly days = new Map<string, Promise<FlightRecord[]>>();
  private readonly inventories = new Map<string, Promise<InventoryRecord[]>>();

  constructor(readonly tx: OffersTx) {}

  flight(segmentId: string) {
    if (!this.flights.has(segmentId)) this.flights.set(segmentId, this.tx.flight(segmentId));
    return this.flights.get(segmentId)!;
  }
  flightsOn(date: string) {
    if (!this.days.has(date)) this.days.set(date, this.tx.flightsOn(date));
    return this.days.get(date)!;
  }
  inventory(segmentId: string) {
    if (!this.inventories.has(segmentId)) this.inventories.set(segmentId, this.tx.inventory(segmentId));
    return this.inventories.get(segmentId)!;
  }

  /** Cupos AVAILABLE de una cabina en un itinerario: el mínimo de sus vuelos (0 si un vuelo no tiene esa cabina). */
  async availableSeats(itinerary: Itinerary, cabinClass: CabinClass): Promise<number> {
    const perFlight = await Promise.all(
      itinerary.flights.map(async (flight) => {
        const row = (await this.inventory(flight.segmentId)).find((candidate) => candidate.cabinClass === cabinClass);
        return row && flight.onSale ? available(row) : 0;
      }),
    );
    return Math.min(...perFlight);
  }

  /** Reconstruye un itinerario desde su id (1 o 2 vuelos publicados y una conexión válida); `undefined` si no existe. */
  async itinerary(itineraryId: string): Promise<Itinerary | undefined> {
    const segmentIds = parseItineraryId(itineraryId);
    if (segmentIds.length < 1 || segmentIds.length > 2) return undefined;
    const flights = await Promise.all(segmentIds.map((segmentId) => this.flight(segmentId)));
    if (flights.some((flight) => !flight)) return undefined;
    const resolved = flights as FlightRecord[];
    if (resolved.length === 2 && !isValidConnection(resolved[0], resolved[1])) return undefined;
    return toItinerary(resolved);
  }

  async offer(offerId: string): Promise<Itinerary[] | undefined> {
    const ids = parseOfferId(offerId);
    if (ids.length < 1 || ids.length > 6) return undefined;
    const itineraries = await Promise.all(ids.map((id) => this.itinerary(id)));
    return itineraries.some((itinerary) => !itinerary) ? undefined : (itineraries as Itinerary[]);
  }
}
