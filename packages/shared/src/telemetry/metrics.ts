import { type Attributes, type Counter, type Gauge, metrics } from '@opentelemetry/api';

/**
 * Métricas de negocio de EcoAirlines (V2.16, PLAN.md §4.7): las que necesitan las alertas del plan y que la instrumentación
 * HTTP no da. Llegan a Prometheus por el Collector (`ecoairlines_*`). Sin OTEL_EXPORTER_OTLP_ENDPOINT (pruebas) el API de
 * OpenTelemetry devuelve instrumentos vacíos y nada de esto hace trabajo.
 *
 * Los instrumentos se crean al primer uso: un medidor pedido antes de que arranque el SDK quedaría vacío para siempre.
 * Nunca llevan datos personales: solo tipos, estados y nombres de servicios.
 */
const meter = () => metrics.getMeter('ecoairlines');
let sagas: Counter | undefined;
let deliveries: Counter | undefined;
let dependencies: Gauge | undefined;
let node: Gauge | undefined;

/** Una saga terminó (`COMPLETED`, `FAILED` o `COMPENSATED`): alerta "sagas fallidas". */
export function countSagaFinished(type: string, status: string): void {
  sagas ??= meter().createCounter('ecoairlines.sagas.finished', { description: 'Sagas terminadas por tipo y estado final' });
  sagas.add(1, { saga_type: type, status });
}

/** Una entrega de webhook terminó un intento (`DELIVERED`, `RETRYING`, `EXHAUSTED`): alerta "webhooks agotados". */
export function countWebhookDelivery(outcome: string): void {
  deliveries ??= meter().createCounter('ecoairlines.webhooks.deliveries', { description: 'Intentos de entrega de webhooks por resultado' });
  deliveries.add(1, { outcome });
}

/** Estado de cada dependencia según el `/health` del servicio (1 arriba, 0 caída): alerta "servicio caído". */
export function recordDependency(service: string, dependency: string, up: boolean): void {
  dependencies ??= meter().createGauge('ecoairlines.dependency.up', { description: '1 si la dependencia responde, 0 si no' });
  dependencies.record(up ? 1 : 0, { service, dependency });
}

/** Estado del nodo para Booking (`GET /vuelos/health`): 2 HEALTHY, 1 DEGRADED, 0 DOWN. Alerta "health DOWN". */
export function recordNodeStatus(status: 'HEALTHY' | 'DEGRADED' | 'DOWN'): void {
  node ??= meter().createGauge('ecoairlines.node.status', { description: 'Health del nodo de vuelos: 2 HEALTHY, 1 DEGRADED, 0 DOWN' });
  node.record(status === 'HEALTHY' ? 2 : status === 'DEGRADED' ? 1 : 0);
}

/** Un valor que se lee cuando el SDK exporta (p. ej. el stock pendiente de enviar a Booking: alerta "stock sin enviar"). */
export function observeGauge(name: string, description: string, read: () => Promise<number> | number, attributes: Attributes = {}): void {
  meter()
    .createObservableGauge(name, { description })
    .addCallback(async (result) => {
      try {
        result.observe(await read(), attributes);
      } catch {
        // Sin dato (p. ej. la base no responde): no se informa; la alerta de dependencia caída lo cubre.
      }
    });
}
