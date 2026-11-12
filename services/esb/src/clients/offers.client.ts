import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import protobuf from 'protobufjs';
import { correlationMetadata, ProblemDetailsException } from '@ecoairlines/shared';
import { CircuitBreaker } from './circuit-breaker.js';
import { findContractFile } from './contract-files.js';
import type { Caller } from './rest.client.js';
import type { TokenSource } from './service-token.js';

/** Mismas opciones que el servidor: campos en camelCase (mapeo JSON de proto3), enums por nombre, int64 como texto. */
const PROTO_OPTIONS: protoLoader.Options = { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true };
const PROBLEM_TRAILER = 'x-problem-details-bin';
const SERVICES = ['CatalogService', 'HoldService', 'InventoryService', 'PublishingService'] as const;

type Message = Record<string, unknown>;
type UnaryMethod = (request: Message, metadata: grpc.Metadata, options: grpc.CallOptions, callback: (error: grpc.ServiceError | null, response?: Message) => void) => void;

/** Código gRPC sin trailer → ProblemDetails (la tabla inversa de ERRORES de ms-g-offers.proto). */
function fromGrpcStatus(code: grpc.status, details: string): ProblemDetailsException {
  switch (code) {
    case grpc.status.UNAVAILABLE:
    case grpc.status.DEADLINE_EXCEEDED:
      return new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title: code === grpc.status.DEADLINE_EXCEEDED ? 'MS.G.Offers no respondió a tiempo.' : 'MS.G.Offers no está disponible.', retryAfterSeconds: 5 });
    case grpc.status.INVALID_ARGUMENT:
      return new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: details || 'Petición inválida.' });
    case grpc.status.NOT_FOUND:
      return new ProblemDetailsException({ status: 404, code: 'NOT_FOUND', title: details || 'No existe.' });
    case grpc.status.ALREADY_EXISTS:
    case grpc.status.FAILED_PRECONDITION:
    case grpc.status.RESOURCE_EXHAUSTED:
      return new ProblemDetailsException({ status: 409, code: 'OFFER_NO_LONGER_AVAILABLE', title: details || 'Conflicto.' });
    default:
      return new ProblemDetailsException({ status: 502, code: 'INTERNAL_ERROR', title: `MS.G.Offers falló: ${details || grpc.status[code]}` });
  }
}

/**
 * Cliente gRPC de MS.G.Offers (`contract/ms-g-offers.proto`). Cada llamada lleva en la metadata el token de servicio,
 * `x-correlation-id` (sin cambios), un `x-request-id` nuevo y `x-owner-id`, con plazo (`deadline`) y circuit breaker. Un error
 * se traduce de vuelta a ProblemDetails desde el trailer `x-problem-details-bin`, así no se pierde el `code` del contrato
 * (p. ej. `SEAT_TAKEN` o `HOLD_EXPIRED`).
 */
export class OffersClient {
  readonly breaker = new CircuitBreaker('MS.G.Offers');
  /** Nombre del RPC → servicio del proto que lo tiene. */
  readonly rpcs: ReadonlyMap<string, string>;
  private readonly clients: Record<string, grpc.Client & Record<string, UnaryMethod>>;
  private readonly problemType: protobuf.Type;

  constructor(
    address: string,
    private readonly tokens: TokenSource,
    private readonly timeoutMs: number,
  ) {
    const file = findContractFile('ms-g-offers.proto');
    const pkg = (grpc.loadPackageDefinition(protoLoader.loadSync(file, PROTO_OPTIONS)) as unknown as {
      ecoairlines: { offers: { v1: Record<string, grpc.ServiceClientConstructor> } };
    }).ecoairlines.offers.v1;
    const rpcs = new Map<string, string>();
    this.clients = {};
    // Un canal para los cuatro servicios (mismo host); grpc-js reconecta solo.
    const channel = new grpc.Channel(address, grpc.credentials.createInsecure(), {});
    for (const service of SERVICES) {
      const Client = pkg[service];
      this.clients[service] = new Client(address, grpc.credentials.createInsecure(), { channelOverride: channel }) as grpc.Client & Record<string, UnaryMethod>;
      for (const rpc of Object.keys(Client.service)) rpcs.set(rpc, service);
    }
    this.rpcs = rpcs;
    this.problemType = protobuf.loadSync(file).lookupType('ecoairlines.offers.v1.ProblemDetails');
  }

  /** Llama a un RPC por su nombre (`Search`, `CreateHold`…). El cuerpo y la respuesta usan el mapeo JSON de proto3. */
  async call<T = Message>(rpc: string, request: Message, caller: Caller = {}): Promise<T> {
    const service = this.rpcs.get(rpc);
    if (!service) throw new ProblemDetailsException({ status: 404, code: 'NOT_FOUND', title: `MS.G.Offers no tiene el RPC ${rpc}.` });
    try {
      return await this.send<T>(service, rpc, request, caller);
    } catch (error) {
      // Token de servicio rechazado (Identity rotó sus claves): uno nuevo y un solo reintento.
      if (error instanceof ProblemDetailsException && error.problem.status === 401 && this.tokens.invalidate) {
        this.tokens.invalidate();
        return this.send<T>(service, rpc, request, caller);
      }
      throw error;
    }
  }

  private send<T>(service: string, rpc: string, request: Message, caller: Caller): Promise<T> {
    return this.breaker.run(async () => {
      const metadata = new grpc.Metadata();
      metadata.set('authorization', `Bearer ${await this.tokens.token()}`);
      for (const [key, value] of correlationMetadata()) metadata.set(key, value);
      if (caller.ownerId) metadata.set('x-owner-id', caller.ownerId);
      if (caller.actorId) metadata.set('x-actor-id', caller.actorId);
      return new Promise<T>((resolve, reject) => {
        this.clients[service][rpc](request, metadata, { deadline: Date.now() + this.timeoutMs }, (error, response) => {
          if (!error) return resolve(response as T);
          reject(this.translate(error));
        });
      });
    });
  }

  private translate(error: grpc.ServiceError): ProblemDetailsException {
    const trailer = error.metadata?.get(PROBLEM_TRAILER)[0];
    if (Buffer.isBuffer(trailer)) {
      try {
        const problem = this.problemType.toObject(this.problemType.decode(trailer)) as { title: string; status: number; code: string; detail?: string; type?: string; invalidParams?: { name: string; reason: string }[] };
        return new ProblemDetailsException({
          status: problem.status,
          code: problem.code,
          title: problem.title,
          ...(problem.detail ? { detail: problem.detail } : {}),
          ...(problem.type ? { type: problem.type } : {}),
          ...(problem.invalidParams?.length ? { invalidParams: problem.invalidParams } : {}),
        });
      } catch {
        // trailer ilegible: se usa el código gRPC
      }
    }
    return fromGrpcStatus(error.code, error.details);
  }

  close(): void {
    for (const client of Object.values(this.clients)) client.close();
  }
}
