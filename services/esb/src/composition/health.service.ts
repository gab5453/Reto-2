import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { recordDependency, recordNodeStatus } from '@ecoairlines/shared/telemetry/metrics.js';
import type { HealthReport } from '@ecoairlines/shared';
import type { CircuitState } from '../clients/circuit-breaker.js';
import { SERVICE_NAMES, UPSTREAMS, type Upstreams } from '../clients/upstreams.js';
import { ESB_CONFIG, type EsbConfig, REST_SERVICES } from '../config/config.js';
import { ESB_STORE, type EsbStore } from '../repositories/esb.store.js';
import { localDate } from './dates.js';

export type DependencyState = 'UP' | 'DEGRADED' | 'DOWN';

export interface DependencyHealth {
  nombre: string;
  status: DependencyState;
  latencia_ms: number;
  version?: string;
}

/** `VuelosHealthResponse` del contrato v2 (`GET /vuelos/health`). */
export interface VuelosHealth {
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  nodo_id: string;
  nombre_proveedor: string;
  vertical: 'VUELOS';
  version: string;
  uptime_seconds: number;
  latencia_ms: number;
  circuit_breaker_estado: CircuitState;
  holds_activos_count: number;
  vuelos_programados_hoy: number;
  dependencias: { nombre: string; status: DependencyState; latencia_ms: number }[];
  timestamp: string;
}

export interface Snapshot {
  health: VuelosHealth;
  dependencies: DependencyHealth[];
  checkedAt: string;
}

/** Sin estos el nodo no puede vender a Booking (token, búsqueda/hold, reserva): si caen, el nodo está DOWN. */
const CRITICAL = new Set(['esb-postgres', 'ms-g-identity', 'ms-g-offers', 'ms-g-bookings']);
const NODE = { nodo_id: 'NODE_VUE_ECOAIRLINES', nombre_proveedor: 'EcoAirlines', vertical: 'VUELOS' as const, version: '2.0.0' };
const startedAt = Date.now();

/** Pings del propio ESB (su base, el bus interno y el de Booking): los registra el módulo. */
export interface OwnChecks {
  bus?: () => Promise<boolean>;
  bookingBus?: () => Promise<boolean>;
}
export const OWN_CHECKS = Symbol('OWN_CHECKS');

/**
 * Composición "Health del nodo" (PLAN.md §4.2; contrato v2 `getHealth`: debe responder en < 1 s). Se calcula en SEGUNDO PLANO
 * cada `healthRefreshMs` consultando en paralelo el `/health` de los 9 MS.G (y de la Payment API si está configurada), la
 * base y el bus del ESB, los holds activos (Offers) y los vuelos de hoy (FlightStatus); la petición solo lee la caché.
 * - `DOWN` (503) si cae una pieza sin la que no se puede vender a Booking (base del ESB, Identity, Offers o Bookings).
 * - `DEGRADED` si cae o se degrada cualquier otra.
 * - `circuit_breaker_estado`: el peor de los circuitos del ESB hacia los MS.G.
 */
@Injectable()
export class HealthCompositionService implements OnModuleDestroy {
  private readonly logger = new Logger('HealthComposition');
  private snapshot?: Snapshot;
  private refreshing?: Promise<Snapshot>;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(UPSTREAMS) private readonly upstreams: Upstreams,
    @Inject(ESB_CONFIG) private readonly config: EsbConfig,
    @Inject(ESB_STORE) private readonly store: EsbStore,
    @Inject(OWN_CHECKS) private readonly own: OwnChecks,
  ) {}

  start(): void {
    // `refresh` ya registró el error; en segundo plano no se propaga (una promesa rechazada sin manejar tumba el proceso).
    const tick = () => void this.refresh().catch(() => undefined);
    tick();
    this.timer = setInterval(tick, this.config.healthRefreshMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Lo de la caché; solo si todavía no hay (recién arrancado) espera el primer cálculo, que tarda < 1 s. */
  async current(): Promise<Snapshot> {
    return this.snapshot ?? this.refresh();
  }

  refresh(): Promise<Snapshot> {
    this.refreshing ??= this.compute()
      .then((snapshot) => (this.snapshot = snapshot))
      .catch((error: unknown) => {
        this.logger.error(`No se pudo calcular el health: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      })
      .finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async compute(): Promise<Snapshot> {
    const started = Date.now();
    const today = localDate();
    const [dependencies, holds, flightsToday] = await Promise.all([
      this.dependencies(),
      this.upstreams.offers.call<{ stats?: { activeHolds?: number; flightsOnSaleToday?: number } }>('GetStats', {}).catch(() => undefined),
      this.upstreams.rest['flight-status'].json<{ total: number }>('GET', `/flights?date=${today}`).catch(() => undefined),
    ]);
    const states = this.upstreams.breakers().map((breaker) => breaker.state);
    const circuit: CircuitState = states.includes('OPEN') ? 'OPEN' : states.includes('HALF_OPEN') ? 'HALF_OPEN' : 'CLOSED';
    const down = dependencies.filter((d) => d.status === 'DOWN');
    const status = down.some((d) => CRITICAL.has(d.nombre)) ? 'DOWN' : down.length || dependencies.some((d) => d.status === 'DEGRADED') ? 'DEGRADED' : 'HEALTHY';
    // V2.16: el estado del nodo y de cada dependencia, para las alertas "health DOWN" y "servicio caído".
    recordNodeStatus(status);
    for (const d of dependencies) recordDependency('esb', d.nombre, d.status !== 'DOWN');
    const checkedAt = new Date().toISOString();
    return {
      checkedAt,
      dependencies,
      health: {
        status,
        ...NODE,
        uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
        latencia_ms: Date.now() - started,
        circuit_breaker_estado: circuit,
        holds_activos_count: holds?.stats?.activeHolds ?? 0,
        vuelos_programados_hoy: flightsToday?.total ?? holds?.stats?.flightsOnSaleToday ?? 0,
        dependencias: dependencies.map(({ nombre, status, latencia_ms }) => ({ nombre, status, latencia_ms })),
        timestamp: checkedAt,
      },
    };
  }

  private async dependencies(): Promise<DependencyHealth[]> {
    const probes: Promise<DependencyHealth>[] = [
      this.ping('esb-postgres', () => (this.store.kind === 'memory' ? Promise.resolve(true) : this.store.ping())),
      ...(this.own.bus ? [this.ping('esb-rabbitmq', this.own.bus)] : []),
      ...(this.own.bookingBus ? [this.ping('booking-bus', this.own.bookingBus)] : []),
      ...REST_SERVICES.map((service) => this.httpHealth(SERVICE_NAMES[service], this.config.urls[service])),
      this.httpHealth(SERVICE_NAMES.offers, this.config.offersHealthUrl),
      this.httpHealth(SERVICE_NAMES['post-sale'], this.config.postSaleUrl),
      ...(this.config.paymentApiUrl ? [this.httpHealth('payment-api', this.config.paymentApiUrl)] : []),
    ];
    return Promise.all(probes);
  }

  private async ping(nombre: string, check: () => Promise<boolean>): Promise<DependencyHealth> {
    const started = Date.now();
    const ok = await Promise.race([check().catch(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 800).unref())]);
    return { nombre, status: ok ? 'UP' : 'DOWN', latencia_ms: Date.now() - started };
  }

  /** `/health` de un MS.G (público, sin token): 200 `ok` → UP; 503 `degraded` (alguna dependencia caída) → DEGRADED; sin respuesta → DOWN. */
  private async httpHealth(nombre: string, baseUrl: string): Promise<DependencyHealth> {
    const started = Date.now();
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(800) });
      const report = (await response.json().catch(() => undefined)) as Partial<HealthReport> | undefined;
      const status: DependencyState = response.ok && report?.status !== 'degraded' ? 'UP' : report?.status === 'degraded' ? 'DEGRADED' : 'DOWN';
      return { nombre, status, latencia_ms: Date.now() - started, ...(report?.version ? { version: report.version } : {}) };
    } catch {
      return { nombre, status: 'DOWN', latencia_ms: Date.now() - started };
    }
  }
}
