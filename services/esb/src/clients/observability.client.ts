import { ProblemDetailsException } from '@ecoairlines/shared';
import { flattenOtlp, type RawSpan } from '../composition/journey.js';

/**
 * Adaptador de la plataforma de observabilidad (V2.16, D50) para la composición del panel: Prometheus (latencia, errores),
 * Loki (pasos de un proceso por su `correlation_id`), la API de administración de RabbitMQ (colas) y Alertmanager (alertas).
 * Solo lectura. Si una pieza no está configurada o no responde: `503 PROVIDER_UNAVAILABLE` (el panel lo muestra así).
 */
export interface ObservabilityUrls {
  prometheus?: string;
  loki?: string;
  alertmanager?: string;
  /** Tempo (T-4): los spans de un proceso para la vista «Recorrido». */
  tempo?: string;
  /** API de administración de RabbitMQ, con usuario y contraseña (los del bus). */
  rabbitmq?: { url: string; user: string; password: string };
}

/** Histograma de la instrumentación HTTP (semántica estable de OpenTelemetry: `http.server.request.duration`, en segundos). */
const HISTOGRAM = 'http_server_request_duration_seconds';

/** Plazo de las consultas a Tempo de la vista «Recorrido» (T-4); MS.Admin espera hasta 12 s al ESB para ella. */
const TEMPO_TIMEOUT_MS = 8_000;

const unavailable = (what: string) => new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title: `${what} no está disponible.`, retryAfterSeconds: 30 });

type Vector = { metric: Record<string, string>; value: [number, string] }[];

export interface TraceStep {
  timestamp: string;
  service: string;
  operation: string;
  status: string;
  latency_ms: number;
  request_id?: string;
  trace_id?: string;
}

export class ObservabilityClient {
  constructor(
    private readonly urls: ObservabilityUrls,
    private readonly timeoutMs = 3_000,
  ) {}

  private async get<T>(what: string, url: string | undefined, path: string, headers: Record<string, string> = {}, timeoutMs = this.timeoutMs): Promise<T> {
    if (!url) throw unavailable(what);
    let response: Response;
    try {
      response = await fetch(`${url}${path}`, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      // Plazo vencido: la pieza está arriba pero la consulta fue muy pesada (T-2). Se dice así, no «no disponible».
      if (error instanceof Error && error.name === 'TimeoutError') throw new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title: `${what} tardó demasiado en responder.`, detail: 'La búsqueda tardó demasiado: prueba con un rango más corto.', retryAfterSeconds: 5 });
      throw unavailable(what);
    }
    if (!response.ok) throw unavailable(what);
    return (await response.json()) as T;
  }

  private async promql(query: string, time: Date): Promise<Vector> {
    const params = new URLSearchParams({ query, time: String(time.getTime() / 1000) });
    const body = await this.get<{ data: { result: Vector } }>('Prometheus', this.urls.prometheus, `/api/v1/query?${params}`);
    return body.data.result;
  }

  /** Latencia p50/p95/p99, peticiones y tasa de error (5xx) de cada servicio entre `from` y `to` (por defecto, la última hora). */
  async latency(from?: string, to?: string) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 3_600_000);
    const seconds = Math.max(60, Math.round((end.getTime() - start.getTime()) / 1000));
    const window = `${seconds}s`;
    const quantile = (q: number) => this.promql(`histogram_quantile(${q}, sum by (service_name, le) (rate(${HISTOGRAM}_bucket[${window}])))`, end);
    const [p50, p95, p99, requests, errors] = await Promise.all([
      quantile(0.5),
      quantile(0.95),
      quantile(0.99),
      this.promql(`sum by (service_name) (increase(${HISTOGRAM}_count[${window}]))`, end),
      this.promql(`sum by (service_name) (increase(${HISTOGRAM}_count{http_response_status_code=~"5.."}[${window}]))`, end),
    ]);
    const byService = (vector: Vector) => new Map(vector.map((row) => [row.metric['service_name'] ?? 'desconocido', Number(row.value[1])]));
    const [m50, m95, m99, mReq, mErr] = [p50, p95, p99, requests, errors].map(byService) as [Map<string, number>, Map<string, number>, Map<string, number>, Map<string, number>, Map<string, number>];
    const ms = (value: number | undefined) => (value === undefined || Number.isNaN(value) ? 0 : Math.round(value * 1000 * 10) / 10);
    return [...mReq.keys()].sort().map((service) => {
      const total = Math.round(mReq.get(service) ?? 0);
      return { service, p50_ms: ms(m50.get(service)), p95_ms: ms(m95.get(service)), p99_ms: ms(m99.get(service)), requests: total, errorRate: total ? Math.round(((mErr.get(service) ?? 0) / total) * 10_000) / 10_000 : 0 };
    });
  }

  /**
   * Los pasos (una línea `api_request` por salto) de un proceso, por su X-Correlation-Id: en el rango pedido o, sin él, en los
   * últimos 7 días. Con una semana de logs, 7 días tardan ~24 s en la VM (más que el plazo de 3 s); una ventana de minutos, 0,2 s.
   */
  async correlationSteps(correlationId: string, window: { from: Date; to: Date }): Promise<TraceStep[]> {
    // Loki no indexa el correlation ID: filtra línea por línea todo el rango (1 día ~7 s, 7 días ~24 s en la VM). Por eso la
    // ventana la calcula la composición, lo más corta posible (T-2).
    const params = new URLSearchParams({
      // El valor va entre backticks (cadena cruda de LogQL): se quitan del id para que no rompa la consulta.
      query: `{service_name=~".+"} | correlation_id=\`${correlationId.replace(/`/g, '')}\` | type=\`api_request\``,
      start: String(window.from.getTime() * 1_000_000),
      end: String(window.to.getTime() * 1_000_000),
      limit: '500',
      direction: 'forward',
    });
    const body = await this.get<{ data: { result: { values: [string, string][] }[] } }>('Loki', this.urls.loki, `/loki/api/v1/query_range?${params}`);
    const steps: TraceStep[] = [];
    for (const stream of body.data.result) {
      for (const [, line] of stream.values) {
        try {
          const log = JSON.parse(line) as Record<string, unknown>;
          steps.push({
            timestamp: String(log['timestamp']),
            service: String(log['service']),
            operation: String(log['operation']),
            status: String(log['status']),
            latency_ms: Number(log['latency_ms'] ?? 0),
            ...(typeof log['request_id'] === 'string' ? { request_id: log['request_id'] } : {}),
            ...(typeof log['trace_id'] === 'string' ? { trace_id: log['trace_id'] } : {}),
          });
        } catch {
          // Una línea que no es JSON no es un paso.
        }
      }
    }
    return steps.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Spans de todas las trazas de un correlation ID (T-4), aplanados. Busca en Tempo con TraceQL dentro de la ventana y trae hasta
   * 20 trazas. Tempo sí indexa los atributos de los spans: es rápido aunque la ventana sea larga.
   */
  async journeySpans(correlationId: string, window: { from: Date; to: Date }): Promise<RawSpan[]> {
    const query = `{ span.correlation_id = "${correlationId.replace(/["\\]/g, '')}" }`;
    const params = new URLSearchParams({ q: query, start: String(Math.floor(window.from.getTime() / 1000)), end: String(Math.ceil(window.to.getTime() / 1000)), limit: '20' });
    // Solo el panel, y de vez en cuando: más plazo que el resto (Tempo tarda más con la VM cargada).
    const found = await this.get<{ traces?: { traceID: string }[] }>('Tempo', this.urls.tempo, `/api/search?${params}`, {}, TEMPO_TIMEOUT_MS);
    const ids = [...new Set((found.traces ?? []).map((trace) => trace.traceID))].slice(0, 20);
    const traces = await Promise.all(ids.map((id) => this.get<unknown>('Tempo', this.urls.tempo, `/api/v2/traces/${encodeURIComponent(id)}`, {}, TEMPO_TIMEOUT_MS)));
    return traces.flatMap(flattenOtlp);
  }

  /**
   * Mapa del sistema en vivo (T-4): aristas cliente → servidor de los últimos 5 minutos, de las métricas que el metrics-generator
   * de Tempo escribe en Prometheus (T-3): peticiones y errores por minuto y p95.
   */
  async systemMap() {
    const now = new Date();
    const [requests, failed, p95] = await Promise.all([
      this.promql('sum by (client, server) (rate(traces_service_graph_request_total[5m])) * 60', now),
      this.promql('sum by (client, server) (rate(traces_service_graph_request_failed_total[5m])) * 60', now),
      this.promql('1000 * histogram_quantile(0.95, sum by (le, client, server) (rate(traces_service_graph_request_server_seconds_bucket[5m])))', now),
    ]);
    const key = (row: Vector[number]) => `${row.metric['client']}→${row.metric['server']}`;
    const value = (vector: Vector) => new Map(vector.map((row) => [key(row), Number(row.value[1])]));
    const [failedBy, p95By] = [value(failed), value(p95)];
    const round = (number: number | undefined) => (number === undefined || !Number.isFinite(number) ? null : Math.round(number * 100) / 100);
    const edges = requests
      .filter((row) => row.metric['client'] && row.metric['server'] && Number(row.value[1]) > 0)
      .map((row) => ({
        from: row.metric['client']!,
        to: row.metric['server']!,
        requestsPerMinute: round(Number(row.value[1])) ?? 0,
        errorsPerMinute: round(failedBy.get(key(row))) ?? 0,
        p95Ms: round(p95By.get(key(row))),
      }))
      .sort((a, b) => b.requestsPerMinute - a.requestsPerMinute);
    return { generatedAt: now.toISOString(), windowMinutes: 5, edges };
  }

  /** Colas de RabbitMQ con su cola de fallidos (`<cola>.dlq`); las de espera de reintentos se omiten. */
  async queues() {
    const rabbit = this.urls.rabbitmq;
    const all = await this.get<{ name: string; messages?: number; consumers?: number }[]>('RabbitMQ', rabbit?.url, '/api/queues', rabbit ? { authorization: `Basic ${Buffer.from(`${rabbit.user}:${rabbit.password}`).toString('base64')}` } : {});
    const byName = new Map(all.map((q) => [q.name, q]));
    return all
      .filter((q) => !q.name.endsWith('.dlq') && !q.name.includes('.retry.') && !q.name.includes('.wait.'))
      .map((q) => ({ queue: q.name, messages: q.messages ?? 0, consumers: q.consumers ?? 0, deadLetters: byName.get(`${q.name}.dlq`)?.messages ?? 0 }))
      .sort((a, b) => a.queue.localeCompare(b.queue));
  }

  /** Alertas activas de Alertmanager con la forma `Alert` de ms-admin. */
  async alerts() {
    const active = await this.get<{ fingerprint: string; labels: Record<string, string>; annotations?: Record<string, string>; startsAt: string; status?: { state?: string } }[]>('Alertmanager', this.urls.alertmanager, '/api/v2/alerts?active=true&silenced=false&inhibited=false');
    const severity = (value: string | undefined) => (value === 'critical' ? 'CRITICAL' : value === 'warning' ? 'WARNING' : 'INFO');
    return active.map((alert) => ({
      id: alert.fingerprint,
      rule: alert.labels['alertname'] ?? 'desconocida',
      severity: severity(alert.labels['severity']),
      ...(alert.labels['service_name'] ?? alert.labels['dependency'] ?? alert.labels['queue'] ? { service: alert.labels['service_name'] ?? alert.labels['dependency'] ?? alert.labels['queue'] } : {}),
      ...(alert.annotations?.['summary'] ? { message: alert.annotations['summary'] } : {}),
      startedAt: alert.startsAt,
    }));
  }
}
