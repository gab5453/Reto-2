/**
 * Vista «Recorrido» (PLAN_Telemetria_Asientos T-4): de los spans de Tempo de un proceso (todas las trazas con su `correlation_id`)
 * a un grafo por capas y los **saltos** en orden de tiempo, para que el panel dibuje el punto viajando de nodo en nodo.
 *
 * Un salto es una llamada de un servicio a otro: el span CLIENTE de quien llama y el span SERVIDOR que provocó en el otro (su
 * hijo). Una petición que entra desde fuera (sin padre en la traza) sale del nodo «cliente». Una llamada sin span servidor del
 * otro lado (un servicio sin trazas) va a un nodo con el nombre del host.
 *
 * **Nunca sale un dato personal:** solo nombres de servicio, la operación (método y ruta, sin query; o el método gRPC), el estado
 * y los tiempos. Los atributos de los spans (IP del cliente, agente, cuerpo…) no se copian.
 */

/** Span de Tempo ya aplanado (OTLP JSON de `GET /api/v2/traces/{id}`). */
export interface RawSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string;
  name: string;
  kind: string;
  startNs: bigint;
  endNs: bigint;
  error: boolean;
  attributes: Record<string, string>;
}

export type JourneyLayer = 'CLIENT' | 'GATEWAY' | 'RESPONSE' | 'ESB' | 'MANAGEMENT' | 'EXTERNAL';

export interface JourneyHop {
  /** Orden de inicio. */
  sequence: number;
  from: string;
  to: string;
  operation: string;
  /** Milisegundos desde el inicio del proceso. */
  startMs: number;
  durationMs: number;
  status: 'OK' | 'ERROR';
  /** Código HTTP del servidor, si lo hay. */
  httpStatus?: number;
  traceId: string;
}

export interface Journey {
  correlationId: string;
  startedAt: string | null;
  durationMs: number;
  traces: number;
  nodes: { id: string; layer: JourneyLayer }[];
  hops: JourneyHop[];
  /** Hubo más spans de los que se dibujan (se cortó en `MAX_HOPS`). */
  truncated: boolean;
}

export const CLIENT_NODE = 'cliente';
const MAX_HOPS = 300;
const RESPONSE_SERVICES = new Set(['ms-vuelos', 'ms-reservas', 'ms-postventa', 'ms-clientes', 'ms-admin']);

export function layerOf(service: string): JourneyLayer {
  if (service === CLIENT_NODE) return 'CLIENT';
  if (service === 'gateway') return 'GATEWAY';
  if (RESPONSE_SERVICES.has(service)) return 'RESPONSE';
  if (service === 'esb') return 'ESB';
  if (service.startsWith('ms-g-')) return 'MANAGEMENT';
  return 'EXTERNAL';
}

/**
 * Los segmentos de la ruta que son identificadores (UUID de una reserva, la referencia de un pago, un código con dígitos) se
 * cambian por `{id}`: el recorrido muestra QUÉ se llamó, nunca A QUÉ registro (la referencia de pago no sale nunca, T-4).
 */
export function maskIds(path: string): string {
  return path
    .split('/')
    .map((segment) => (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) || (segment.length >= 6 && /\d/.test(segment) && !/^v\d+$/.test(segment)) || /^(pay|pm|re|tok|corr|req)_/.test(segment) ? '{id}' : segment))
    .join('/');
}

/** Método y ruta sin query ni identificadores (o el método gRPC); nunca la URL completa con sus parámetros. */
function operationOf(span: RawSpan): string {
  const a = span.attributes;
  const method = a['http.request.method'];
  const route = a['http.route'] ?? a['url.path'] ?? (a['url.full'] ? safePath(a['url.full']) : undefined);
  if (method && route) return `${method} ${maskIds(route)}`.slice(0, 120);
  if (a['rpc.method']) return `${a['rpc.service'] ? `${a['rpc.service'].split('.').at(-1)}/` : ''}${a['rpc.method']}`.slice(0, 120);
  return span.name.slice(0, 120);
}

function safePath(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

function hostOf(span: RawSpan): string {
  const a = span.attributes;
  const host = a['server.address'] ?? (a['url.full'] ? safeHost(a['url.full']) : undefined) ?? a['net.peer.name'];
  return host ? host.replace(/:\d+$/, '') : 'externo';
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function buildJourney(correlationId: string, spans: RawSpan[]): Journey {
  const empty: Journey = { correlationId, startedAt: null, durationMs: 0, traces: 0, nodes: [], hops: [], truncated: false };
  if (!spans.length) return empty;
  const byId = new Map(spans.map((span) => [`${span.traceId}:${span.spanId}`, span]));
  const childrenOf = new Map<string, RawSpan[]>();
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    const key = `${span.traceId}:${span.parentSpanId}`;
    childrenOf.set(key, [...(childrenOf.get(key) ?? []), span]);
  }
  const origin = spans.reduce((min, span) => (span.startNs < min ? span.startNs : min), spans[0]!.startNs);
  const end = spans.reduce((max, span) => (span.endNs > max ? span.endNs : max), spans[0]!.endNs);
  const ms = (ns: bigint) => Number(ns - origin) / 1e6;
  const raw: Omit<JourneyHop, 'sequence'>[] = [];
  const httpStatus = (span: RawSpan) => {
    const code = Number(span.attributes['http.response.status_code']);
    return Number.isInteger(code) && code > 0 ? { httpStatus: code } : {};
  };

  for (const span of spans) {
    if (span.kind === 'SPAN_KIND_SERVER') {
      const parent = span.parentSpanId ? byId.get(`${span.traceId}:${span.parentSpanId}`) : undefined;
      // Entra desde fuera de EcoAirlines (la web, Booking o un script): sale del nodo «cliente».
      if (!parent) {
        raw.push({ from: CLIENT_NODE, to: span.service, operation: operationOf(span), startMs: ms(span.startNs), durationMs: Number(span.endNs - span.startNs) / 1e6, status: span.error ? 'ERROR' : 'OK', ...httpStatus(span), traceId: span.traceId });
      }
      continue;
    }
    if (span.kind !== 'SPAN_KIND_CLIENT') continue;
    const server = (childrenOf.get(`${span.traceId}:${span.spanId}`) ?? []).find((child) => child.kind === 'SPAN_KIND_SERVER' && child.service !== span.service);
    const to = server?.service ?? hostOf(span);
    if (to === span.service) continue;
    raw.push({
      from: span.service,
      to,
      operation: operationOf(server ?? span),
      startMs: ms(span.startNs),
      durationMs: Number(span.endNs - span.startNs) / 1e6,
      status: span.error || server?.error ? 'ERROR' : 'OK',
      ...httpStatus(server ?? span),
      traceId: span.traceId,
    });
  }

  raw.sort((a, b) => a.startMs - b.startMs || a.from.localeCompare(b.from));
  const kept = raw.slice(0, MAX_HOPS);
  const round = (value: number) => Math.round(value * 10) / 10;
  const hops = kept.map((hop, index) => ({ ...hop, sequence: index + 1, startMs: round(hop.startMs), durationMs: round(hop.durationMs) }));
  const ids = [...new Set(hops.flatMap((hop) => [hop.from, hop.to]))];
  const order: JourneyLayer[] = ['CLIENT', 'GATEWAY', 'RESPONSE', 'ESB', 'MANAGEMENT', 'EXTERNAL'];
  const nodes = ids.map((id) => ({ id, layer: layerOf(id) })).sort((a, b) => order.indexOf(a.layer) - order.indexOf(b.layer) || a.id.localeCompare(b.id));
  return {
    correlationId,
    startedAt: new Date(Number(origin / 1_000_000n)).toISOString(),
    durationMs: round(Number(end - origin) / 1e6),
    traces: new Set(spans.map((span) => span.traceId)).size,
    nodes,
    hops,
    truncated: raw.length > kept.length,
  };
}

/** Aplana el OTLP JSON de Tempo (`{ trace: { resourceSpans } }`); los atributos quedan como texto. */
export function flattenOtlp(body: unknown): RawSpan[] {
  const trace = (body as { trace?: { resourceSpans?: unknown[] } } | undefined)?.trace;
  const out: RawSpan[] = [];
  for (const resource of (trace?.resourceSpans ?? []) as Record<string, any>[]) {
    const service = attributes(resource['resource']?.['attributes'])['service.name'] ?? 'desconocido';
    for (const scope of (resource['scopeSpans'] ?? []) as Record<string, any>[]) {
      for (const span of (scope['spans'] ?? []) as Record<string, any>[]) {
        out.push({
          traceId: String(span['traceId']),
          spanId: String(span['spanId']),
          ...(span['parentSpanId'] ? { parentSpanId: String(span['parentSpanId']) } : {}),
          service,
          name: String(span['name'] ?? ''),
          kind: String(span['kind'] ?? ''),
          startNs: BigInt(span['startTimeUnixNano'] ?? 0),
          endNs: BigInt(span['endTimeUnixNano'] ?? 0),
          error: span['status']?.['code'] === 'STATUS_CODE_ERROR',
          attributes: attributes(span['attributes']),
        });
      }
    }
  }
  return out;
}

function attributes(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (Array.isArray(list) ? list : []) as { key: string; value: Record<string, unknown> }[]) {
    const value = item.value ? Object.values(item.value)[0] : undefined;
    if (value !== undefined && value !== null && typeof value !== 'object') out[item.key] = String(value);
  }
  return out;
}
