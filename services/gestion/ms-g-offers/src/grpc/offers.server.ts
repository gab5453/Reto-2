import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { HealthImplementation } from 'grpc-health-check';
import protobuf from 'protobufjs';
import {
  CORRELATION_KEY,
  INTERNAL_SCOPE,
  isValidId,
  newCorrelationId,
  newRequestId,
  ProblemDetailsException,
  REQUEST_ID_KEY,
  runWithCorrelation,
  scopesOf,
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '@ecoairlines/shared';
import type { CabinClass, PassengerType, SeatStatus } from '../domain/model.js';
import { CatalogService } from '../services/catalog.service.js';
import { HoldsService } from '../services/holds.service.js';
import { InventoryService } from '../services/inventory.service.js';
import { findContractFile, StockSyncService } from '../services/stock-sync.service.js';
import { OffersEvents } from '../services/offers-events.js';
import * as codec from './codec.js';
import { fromEnum, toEnum } from './codec.js';

type Request = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (request: Request, metadata: grpc.Metadata) => Promise<unknown>;

const PROTO_OPTIONS: protoLoader.Options = { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true };
const PROBLEM_TRAILER = 'x-problem-details-bin';

/** Status HTTP del ProblemDetails → código gRPC (tabla de ERRORES de ms-g-offers.proto). */
function grpcCode(problem: { status: number; code: string }): grpc.status {
  if (problem.code === 'SEAT_TAKEN') return grpc.status.ALREADY_EXISTS;
  if (problem.code === 'OFFER_NO_LONGER_AVAILABLE' && problem.status === 409) return grpc.status.RESOURCE_EXHAUSTED;
  if (problem.status === 400 || problem.status === 422) return grpc.status.INVALID_ARGUMENT;
  if (problem.status === 401) return grpc.status.UNAUTHENTICATED;
  if (problem.status === 403) return grpc.status.PERMISSION_DENIED;
  if (problem.status === 404 || (problem.status === 410 && problem.code !== 'HOLD_EXPIRED')) return grpc.status.NOT_FOUND;
  if (problem.status === 409 || problem.status === 410) return grpc.status.FAILED_PRECONDITION;
  if (problem.status === 503) return grpc.status.UNAVAILABLE;
  return grpc.status.INTERNAL;
}

const optional = <T>(value: T | null | undefined | '' | 0): T | undefined => (value === null || value === '' || value === 0 ? undefined : (value ?? undefined));
const cabinOf = (value: unknown) => fromEnum<CabinClass>('CABIN_CLASS', value)!;
const seatStatusOf = (value: unknown) => fromEnum<SeatStatus>('SEAT_STATUS', value)!;

/**
 * Servidor gRPC de MS.G.Offers (`contract/ms-g-offers.proto`, puerto 50061) más `grpc.health.v1.Health`. Cada llamada:
 * 1. toma `x-correlation-id` de la metadata (o lo crea) y lo devuelve junto con su `x-request-id`;
 * 2. exige el token de servicio del ESB en `authorization` (D41);
 * 3. traduce los errores a código gRPC + `ProblemDetails` serializado en el trailer `x-problem-details-bin`;
 * 4. después de una operación, pide el envío del stock a Booking (en segundo plano, D33).
 */
@Injectable()
export class OffersGrpcServer implements OnModuleDestroy {
  private readonly logger = new Logger('OffersGrpc');
  private server?: grpc.Server;
  private readonly problemType: protobuf.Type;
  readonly health = new HealthImplementation({ '': 'NOT_SERVING', 'ecoairlines.offers.v1.CatalogService': 'NOT_SERVING' });

  constructor(
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(HoldsService) private readonly holds: HoldsService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(StockSyncService) private readonly stock: StockSyncService,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(OffersEvents) private readonly events: OffersEvents,
  ) {
    this.problemType = protobuf.loadSync(findContractFile('ms-g-offers.proto')).lookupType('ecoairlines.offers.v1.ProblemDetails');
  }

  /** Arranca en `port` (0 = uno libre, para las pruebas) y devuelve el puerto real. */
  async start(port: number): Promise<number> {
    const definition = protoLoader.loadSync(findContractFile('ms-g-offers.proto'), PROTO_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(definition) as unknown as { ecoairlines: { offers: { v1: Record<string, { service: grpc.ServiceDefinition }> } } }).ecoairlines.offers.v1;
    const server = new grpc.Server();
    const handlers = this.handlers();
    for (const service of ['CatalogService', 'HoldService', 'InventoryService', 'PublishingService']) {
      const definitionOf = pkg[service]!.service;
      server.addService(
        definitionOf,
        Object.fromEntries(Object.keys(definitionOf).map((rpc) => [rpc, this.unary(`${service}/${rpc}`, handlers[rpc]!)])) as grpc.UntypedServiceImplementation,
      );
    }
    this.health.addToServer(server);
    const bound = await new Promise<number>((resolve, reject) =>
      server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (error, actual) => (error ? reject(error) : resolve(actual))),
    );
    this.server = server;
    this.health.setStatus('', 'SERVING');
    this.health.setStatus('ecoairlines.offers.v1.CatalogService', 'SERVING');
    this.logger.log(`gRPC escuchando en el puerto ${bound}`);
    return bound;
  }

  async onModuleDestroy(): Promise<void> {
    this.health.setStatus('', 'NOT_SERVING');
    if (this.server) await new Promise<void>((resolve) => this.server!.tryShutdown(() => resolve()));
  }

  isServing = () => this.server !== undefined;

  private unary(name: string, handler: Handler) {
    return (call: grpc.ServerUnaryCall<Request, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      const incoming = call.metadata.get(CORRELATION_KEY)[0]?.toString();
      const context = { correlationId: isValidId(incoming) ? incoming : newCorrelationId(), requestId: newRequestId() };
      const response = new grpc.Metadata();
      response.set(CORRELATION_KEY, context.correlationId);
      response.set(REQUEST_ID_KEY, context.requestId);
      call.sendMetadata(response);
      const started = Date.now();
      void runWithCorrelation(context, async () => {
        try {
          await this.authorize(call.metadata);
          const result = await handler(call.request, call.metadata);
          callback(null, result);
          this.stock.kick();
          this.events.kick();
          this.logger.log(`${name} OK ${Date.now() - started} ms [${context.correlationId}]`);
        } catch (error) {
          const problem = error instanceof ProblemDetailsException ? error.problem : { type: 'about:blank', title: 'Error interno.', status: 500, code: 'INTERNAL_ERROR' };
          if (problem.status >= 500) this.logger.error(`${name} → ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
          else this.logger.log(`${name} ${problem.code} ${Date.now() - started} ms [${context.correlationId}]`);
          const trailer = new grpc.Metadata();
          trailer.set(
            PROBLEM_TRAILER,
            Buffer.from(
              this.problemType
                .encode(
                  this.problemType.fromObject({ ...problem, instance: `/${name}`, correlationId: context.correlationId, timestamp: new Date().toISOString() }),
                )
                .finish(),
            ),
          );
          callback({ code: grpcCode(problem), details: problem.title, metadata: trailer });
        }
      });
    };
  }

  /** Solo el ESB: token de servicio con `ecoairlines:internal` (D41). */
  private async authorize(metadata: grpc.Metadata): Promise<void> {
    const header = metadata.get('authorization')[0]?.toString();
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) throw new ProblemDetailsException({ status: 401, code: 'UNAUTHORIZED', title: 'Se requiere el token de servicio del ESB.' });
    let claims;
    try {
      claims = await this.verifier.verify(token);
    } catch {
      throw new ProblemDetailsException({ status: 401, code: 'UNAUTHORIZED', title: 'El token no es válido o venció.' });
    }
    if (claims.token_use !== 'service' || !scopesOf(claims).includes(INTERNAL_SCOPE)) {
      throw new ProblemDetailsException({ status: 403, code: 'FORBIDDEN', title: 'Solo el ESB puede llamar a este servicio.' });
    }
  }

  private handlers(): Record<string, Handler> {
    const passengers = (breakdown: Request | null) => breakdown ?? undefined;
    const ownerFrom = (request: Request, metadata: grpc.Metadata) => optional<string>(request['ownerId']) ?? optional<string>(metadata.get('x-owner-id')[0]?.toString());
    return {
      // ---------------------------------------------------------------- CatalogService
      Search: async (r) => {
        const result = await this.catalog.search(r['itineraries'], passengers(r['passengers']));
        return { totalOffers: result.totalOffers, offers: result.offers.map(codec.offer) };
      },
      GetSeatMap: async (r) => {
        const map = await this.catalog.seatMap(r['offerId'], r['segmentId']);
        return {
          seatMap: {
            segmentId: map.segmentId,
            cabins: map.cabins.map((c) => ({
              cabinClass: codec.cabin(c.cabinClass),
              rows: c.rows.map((row) => ({
                rowNumber: row.rowNumber,
                seats: row.seats.map((seat) => ({ ...seat, status: toEnum('SEAT_STATUS', seat.status), characteristics: seat.characteristics.map((value) => toEnum('SEAT_CHARACTERISTIC', value)) })),
              })),
            })),
          },
        };
      },
      FindAlternatives: async (r) => {
        const result = await this.catalog.alternatives({
          currentItineraries: (r['currentItineraries'] as Request[]).map((itinerary) => ({
            itineraryId: itinerary['itineraryId'],
            origin: itinerary['segments'][0]?.departure?.iataCode,
            destination: itinerary['segments'].at(-1)?.arrival?.iataCode,
          })),
          purchasedFares: (r['purchasedFares'] as Request[]).map((fare) => ({ itineraryId: fare['itineraryId'], cabinClass: cabinOf(fare['cabinClass']), fareBrand: fare['fareBrand'] })),
          changes: r['changes'],
          passengers: passengers(r['passengers']),
        });
        return { alternatives: result.alternatives.map((a) => ({ ...a, itinerary: codec.itinerary(a.itinerary) })) };
      },

      // ---------------------------------------------------------------- HoldService
      CreateHold: async (r, m) => {
        const created = await this.holds.create({
          offerId: r['offerId'],
          selections: (r['itinerarySelections'] as Request[]).map((s) => ({ itineraryId: s['itineraryId'], cabinClass: cabinOf(s['cabinClass']), fareBrand: s['fareBrand'] })),
          passengers: passengers(r['passengersBreakdown']),
          ttlMinutes: optional<number>(r['ttlMinutes']),
          ownerId: ownerFrom(r, m) ?? '',
        });
        return { hold: codec.hold(created) };
      },
      GetHold: async (r, m) => ({ hold: codec.hold(await this.holds.get(r['holdId'], ownerFrom(r, m))) }),
      ReleaseHold: async (r, m) => ({ hold: codec.hold(await this.holds.release(r['holdId'], ownerFrom(r, m))) }),
      ValidateHold: async (r, m) => {
        const promotion = r['promotion'] ? { partnerId: r['promotion']['partnerId'], discountPercentage: Number(r['promotion']['discountPercentage']) } : undefined;
        const requested = ((r['requestedSeats'] ?? []) as Request[]).map((seat) => ({ segmentId: seat['segmentId'], seatNumber: seat['seatNumber'] }));
        const result = await this.holds.validate(r['holdId'], ownerFrom(r, m) ?? '', promotion, requested);
        return { hold: codec.hold(result.hold), expectedAmount: result.expectedAmount };
      },
      ConsumeHold: async (r, m) => {
        const result = await this.holds.consume({
          holdId: r['holdId'],
          bookingId: r['bookingId'],
          ownerId: ownerFrom(r, m) ?? '',
          passengers: (r['passengers'] as Request[]).map((p) => ({
            passengerId: p['passengerId'],
            passengerType: fromEnum<PassengerType>('PASSENGER_TYPE', p['passengerType']) ?? 'ADULT',
            requestedSeats: (p['requestedSeats'] as Request[]).map((seat) => ({ segmentId: seat['segmentId'], seatNumber: seat['seatNumber'] })),
          })),
        });
        return { hold: codec.hold(result.hold), seats: result.seats.map(codec.assignedSeat) };
      },

      // ---------------------------------------------------------------- InventoryService
      ReserveSeats: async (r) => ({
        result: codec.seatResult(
          await this.inventory.reserveSeats({
            bookingId: r['bookingId'],
            sagaId: r['sagaId'],
            seats: (r['seats'] as Request[]).map((s) => ({ passengerId: s['passengerId'], segmentId: s['segmentId'], seatNumber: s['seatNumber'] })),
            purchasedCabins: (r['purchasedCabins'] as Request[]).map((c) => ({ passengerId: c['passengerId'], segmentId: c['segmentId'], cabinClass: cabinOf(c['cabinClass']) })),
            targetStatus: seatStatusOf(r['targetStatus']),
          }),
        ),
      }),
      AutoAssignSeats: async (r) => ({
        result: codec.seatResult(
          await this.inventory.autoAssignSeats({
            bookingId: r['bookingId'],
            sagaId: r['sagaId'],
            passengers: (r['passengers'] as Request[]).map((c) => ({ passengerId: c['passengerId'], segmentId: c['segmentId'], cabinClass: cabinOf(c['cabinClass']) })),
            targetStatus: seatStatusOf(r['targetStatus']),
          }),
        ),
      }),
      TransitionBookingSeats: async (r) => ({
        result: codec.seatResult(
          await this.inventory.transition({
            bookingId: r['bookingId'],
            sagaId: r['sagaId'],
            from: seatStatusOf(r['fromStatus']),
            to: seatStatusOf(r['toStatus']),
            segmentIds: r['segmentIds'],
            passengerIds: r['passengerIds'],
          }),
        ),
      }),
      ReserveInventory: async (r) => ({
        result: codec.seatResult(
          await this.inventory.reserveInventory({
            bookingId: r['bookingId'],
            sagaId: r['sagaId'],
            segments: (r['segments'] as Request[]).map((s) => ({ segmentId: s['segmentId'], cabinClass: cabinOf(s['cabinClass']), count: s['count'] })),
            targetStatus: seatStatusOf(r['targetStatus']),
          }),
        ),
      }),
      ReleaseBookingInventory: async (r) => {
        const result = await this.inventory.release({ bookingId: r['bookingId'], sagaId: r['sagaId'], segmentIds: r['segmentIds'], reason: r['reason'] });
        return { seatsReleased: result.seatsReleased, newSeatStatus: toEnum('SEAT_STATUS', result.newSeatStatus) };
      },
      CloseFlightSales: async (r) => ({ state: await this.inventory.setSales({ ...r['flight'] }, false) }),
      ReopenFlightSales: async (r) => ({ state: await this.inventory.setSales({ ...r['flight'] }, true) }),
      CountSoldSeats: async (r) => ({ soldSeats: await this.inventory.countSoldSeats(r['flightNumbers'], r['fromDate']) }),
      GetOccupancy: async (r) => {
        const result = await this.inventory.occupancy(r['date'], optional<string>(r['origin']), optional<string>(r['destination']));
        return { ...result, flights: result.flights.map((f) => ({ ...f, cabins: f.cabins.map((c) => ({ ...c, cabinClass: codec.cabin(c.cabinClass) })) })) };
      },
      GetStats: async () => ({ stats: await this.inventory.stats() }),

      // ---------------------------------------------------------------- PublishingService
      PublishTimetable: async (r) => ({
        result: await this.inventory.publishTimetable({
          publishId: r['publishId'],
          from: r['from'],
          to: r['to'],
          routeId: optional<string>(r['routeId']),
          flights: (r['flights'] as Request[]).map((f) => ({
            flightNumber: f['flightNumber'],
            date: f['date'],
            routeId: f['routeId'],
            origin: f['origin'],
            destination: f['destination'],
            departureAt: f['departureAt'],
            arrivalAt: f['arrivalAt'],
            aircraftType: f['aircraftType'],
            registration: f['registration'],
          })),
          airports: ((r['airports'] as Request[] | undefined) ?? []).map((a) => ({
            code: a['code'],
            city: a['city'],
            name: a['city'],
            country: a['country'],
            lat: Number(a['lat']),
            lon: Number(a['lon']),
            utcOffsetMinutes: Number(a['utcOffsetMinutes']),
          })),
          aircraftTypes: ((r['aircraftTypes'] as Request[] | undefined) ?? []).map((t) => ({
            name: t['name'],
            // Prefijo y alcance son cosa de Schedule; Offers solo necesita el mapa de asientos y el tiempo en tierra.
            registrationPrefix: '',
            maxRouteKm: null,
            turnaroundMinutes: Number(t['turnaroundMinutes']),
            cabins: (t['cabins'] as Request[]).map((c) => ({
              cabinClass: c['cabinClass'],
              firstRow: Number(c['firstRow']),
              lastRow: Number(c['lastRow']),
              layout: c['layout'],
              exitRows: ((c['exitRows'] as unknown[] | undefined) ?? []).map(Number),
              extraLegroomRows: ((c['extraLegroomRows'] as unknown[] | undefined) ?? []).map(Number),
            })),
          })),
        }),
      }),
      PublishFarePrices: async (r) => ({
        result: await this.inventory.publishFarePrices({
          publishId: r['publishId'],
          prices: (r['prices'] as Request[]).map((p) => ({ cabinClass: cabinOf(p['cabinClass']), fareBrand: p['fareBrand'], multiplier: Number(p['multiplier']) })),
          promotions: (r['promotions'] as Request[]).map((p) => ({
            partnerId: p['partnerId'],
            allowsPromotions: Boolean(p['allowsPromotions']),
            maxDiscountPercentage: Number(p['maxDiscountPercentage']),
            routes: p['routes'],
            cabins: (p['cabins'] as unknown[]).map(cabinOf),
            validUntil: optional<string>(p['validUntil']) ?? null,
          })),
          ...(r['pricing']
            ? {
                pricing: {
                  fixedCharge: Number(r['pricing']['fixedCharge']),
                  perKm: Number(r['pricing']['perKm']),
                  routePrices: ((r['routePrices'] ?? []) as Request[]).reduce<Record<string, Record<string, number>>>((all, price) => {
                    (all[price['routeId']] ??= {})[price['fareBrand']] = Number(price['amount']);
                    return all;
                  }, {}),
                },
              }
            : {}),
        }),
      }),
    };
  }
}
