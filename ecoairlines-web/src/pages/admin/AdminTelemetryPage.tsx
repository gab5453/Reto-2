import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { JourneyView } from '../../components/journey/JourneyView';
import { LiveSystemMap } from '../../components/journey/LiveSystemMap';
import { useSearchParams } from 'react-router-dom';
import {
  getAlerts,
  getBookingIntegration,
  getCorrelationTrace,
  getLatency,
  getQueues,
  getServicesHealth,
  type Alert,
  type BookingIntegration,
  type CorrelationTrace,
  type QueueStats,
  type ServiceHealth,
  type ServiceLatency,
} from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { DataTable, Stat } from '../../components/AdminUi';
import { ProblemAlert } from '../../components/ProblemAlert';
import { formatDateTime } from '../../lib/format';

/** Una parte de la telemetría: su dato o su error. Cada una depende de un backend distinto y puede fallar sola. */
type Part<T> = { value?: T; error?: unknown };
const settled = <T,>(result: PromiseSettledResult<T>): Part<T> => (result.status === 'fulfilled' ? { value: result.value } : { error: result.reason });

const loadAll = (token: string) =>
  Promise.allSettled([getServicesHealth(token), getLatency(token), getQueues(token), getAlerts(token), getBookingIntegration(token)]);

const when = (iso: string | null) => (iso ? formatDateTime(iso) : 'Nunca');

/** Refresco automático (panel O-4): cada 15 s, solo con la pestaña visible; al volver a la pestaña se refresca enseguida. */
const REFRESH_MS = 15_000;

/** De dónde salió la ventana de Loki de una traza (T-2). */
const WINDOW_SOURCE = {
  RECORDS: 'según sus sagas y eventos (±10 min)',
  RANGE: 'el rango pedido',
  DEFAULT: 'sin sagas ni eventos: las últimas 3 horas',
} as const;

/**
 * Telemetría (V2.16, `telemetry` del GraphQL): salud, latencia y errores (Prometheus), colas (RabbitMQ), alertas (Alertmanager),
 * integración con Booking y **búsqueda por correlation ID** (Loki, sagas y eventos). Si la plataforma de observabilidad está
 * apagada, cada sección lo dice y el resto se sigue viendo.
 */
export function AdminTelemetryPage() {
  const { token } = useAuth();
  const [health, setHealth] = useState<Part<ServiceHealth[]>>({});
  const [latency, setLatency] = useState<Part<ServiceLatency[]>>({});
  const [queues, setQueues] = useState<Part<QueueStats[]>>({});
  const [alerts, setAlerts] = useState<Part<Alert[]>>({});
  const [booking, setBooking] = useState<Part<BookingIntegration>>({});
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  // Evita pedir de nuevo mientras la ronda anterior sigue en curso (la VM puede tardar justo después de un despliegue).
  const busy = useRef(false);
  // El correlation ID buscado vive en la URL (?correlationId=…): «Ver la traza» del detalle de una reserva llega ya buscado.
  const [params, setParams] = useSearchParams();
  const searched = params.get('correlationId')?.trim() ?? '';
  // Rango explícito (opcional, lo manda el historial de una reserva). Sin él, el ESB arma la ventana con las sagas y eventos del
  // proceso (T-2): ya no hace falta elegir cuántas horas buscar.
  const from = params.get('desde') ?? undefined;
  const to = params.get('hasta') ?? undefined;
  const key = `${searched}|${from ?? ''}|${to ?? ''}`;
  const [correlationId, setCorrelationId] = useState(searched);
  const [result, setResult] = useState<{ key: string; trace?: CorrelationTrace | null; error?: unknown } | null>(null);

  const apply = useCallback((results: Awaited<ReturnType<typeof loadAll>>) => {
    setHealth(settled(results[0]));
    setLatency(settled(results[1]));
    setQueues(settled(results[2]));
    setAlerts(settled(results[3]));
    setBooking(settled(results[4]));
    setUpdatedAt(new Date().toISOString());
  }, []);

  const reload = useCallback(
    (isActive: () => boolean = () => true) => {
      if (!token || busy.current) return;
      busy.current = true;
      void loadAll(token)
        .then((results) => isActive() && apply(results))
        .finally(() => {
          busy.current = false;
        });
    },
    [token, apply],
  );

  useEffect(() => {
    let active = true;
    reload(() => active);
    return () => {
      active = false;
    };
  }, [reload]);

  useEffect(() => {
    if (!auto) return;
    let active = true;
    const tick = () => {
      if (document.visibilityState === 'visible') reload(() => active);
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [auto, reload]);

  useEffect(() => {
    if (!token || !searched) return;
    let active = true;
    getCorrelationTrace(token, searched, { ...(from ? { from } : {}), ...(to ? { to } : {}) }).then(
      (value) => active && setResult({ key, trace: value }),
      (caught: unknown) => active && setResult({ key, error: caught }),
    );
    return () => {
      active = false;
    };
  }, [token, searched, from, to, key]);

  const current = searched && result?.key === key ? result : null;
  const trace = current?.trace;
  const traceError = current?.error ?? null;
  const searching = Boolean(searched) && !current;

  const search = (event: FormEvent) => {
    event.preventDefault();
    const value = correlationId.trim();
    if (value) setParams({ correlationId: value });
  };

  const services = health.value ?? [];
  const traces = [...new Set((trace?.steps ?? []).map((step) => step.traceId).filter(Boolean))];

  return (
    <div className="container section admin">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Portal administrativo</p>
          <h1>Telemetría</h1>
          <p className="muted small">El sistema por dentro. El detalle de los tableros está en Grafana.</p>
          <p className="muted small" role="status" aria-live="polite">
            {updatedAt ? `Actualizado: ${localClock(updatedAt)}` : 'Cargando…'}
            {auto ? ' · se actualiza cada 15 s mientras la pestaña está visible' : ' · actualización automática en pausa'}
          </p>
        </div>
        <div className="admin-actions">
          <label className="inline-field small">
            <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} /> Actualizar sola
          </label>
          <button type="button" className="btn btn-primary" onClick={() => reload()}>Actualizar</button>
        </div>
      </header>

      <section className="stats-grid" aria-label="Resumen">
        <Stat label="Servicios arriba" value={`${services.filter((item) => item.status === 'UP').length} / ${services.length}`} />
        <Stat label="Caídos" value={services.filter((item) => item.status === 'DOWN').length} />
        <Stat label="Alertas activas" value={alerts.value?.length ?? '—'} />
        <Stat label="Stock sin enviar a Booking" value={booking.value?.pendingStockPushes ?? '—'} />
      </section>

      <section className="card" aria-labelledby="trace-title">
        <h2 id="trace-title">Buscar un proceso por correlation ID</h2>
        <form className="filters" onSubmit={search}>
          <label className="inline-field">
            X-Correlation-Id
            <input value={correlationId} required maxLength={128} placeholder="corr-…" onChange={(event) => setCorrelationId(event.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary btn-sm" disabled={searching || !correlationId.trim()}>{searching ? 'Buscando…' : 'Buscar'}</button>
        </form>
        {traceError ? <ProblemAlert error={traceError} /> : null}
        {searched && !trace ? (
          <p className="muted small">El rango se arma solo: entre la primera y la última saga o evento del proceso (±10 min); si no hay ninguno, las últimas 3 horas.</p>
        ) : null}
        {trace?.window ? (
          <p className="muted small">
            Pasos buscados entre {formatDateTime(trace.window.from)} y {formatDateTime(trace.window.to)} · {WINDOW_SOURCE[trace.window.source]}
          </p>
        ) : null}
        {trace?.stepsError ? <p className="alert alert-warning" role="status">Faltan los pasos: {trace.stepsError} Las sagas y los eventos sí están.</p> : null}
        {trace === null && <p className="muted">No se encontró nada con ese identificador.</p>}
        {trace && (
          <>
            <p className="small">
              {trace.steps.length} pasos en {new Set(trace.steps.map((step) => step.service)).size} servicios
              {trace.sagas.length ? ` · sagas: ${trace.sagas.map((saga) => `${saga.type} (${saga.status})`).join(', ')}` : ''}
              {trace.events.length ? ` · eventos: ${trace.events.map((item) => item.type).join(', ')}` : ''}
            </p>
            {traces.length > 0 && <p className="muted small">Trazas en Tempo: <code>{traces.join(', ')}</code></p>}
            <DataTable
              caption="Pasos del proceso"
              headers={['Hora', 'Servicio', 'Operación', 'Estado', 'Duración']}
              empty="Sin pasos registrados."
              rows={trace.steps.map((step) => [formatDateTime(step.timestamp), <code key="s">{step.service}</code>, step.operation, step.status, `${step.latencyMs} ms`])}
            />
          </>
        )}
        {searched && current ? (
          <section aria-labelledby="journey-title" id="recorrido">
            <h3 id="journey-title">Recorrido</h3>
            <p className="muted small">Cómo viajó el proceso de servicio en servicio, en el orden real de las llamadas (desde Tempo). Dale a «Reproducir».</p>
            <JourneyView key={key} correlationId={searched} range={{ ...(from ? { from } : {}), ...(to ? { to } : {}) }} />
          </section>
        ) : null}
      </section>

      <section className="card" aria-labelledby="live-map-title">
        <h2 id="live-map-title">Mapa del sistema en vivo</h2>
        <p className="muted small">Quién llama a quién en los últimos 5 minutos, a partir de las trazas. Más gruesa, más tráfico; en rojo, con errores.</p>
        <LiveSystemMap />
      </section>

      <h2>Integración con Booking</h2>
      <Unavailable part={booking} what="El estado de la integración" />
      {booking.value && (
        <section className="stats-grid" aria-label="Integración con Booking">
          <Stat label="Último token de Booking" value={when(booking.value.lastTokenAt)} />
          <Stat label="Último stock enviado" value={when(booking.value.lastStockPushAt)} />
          <Stat label="Último evento recibido" value={when(booking.value.lastInboundEventAt)} />
          <Stat label="Webhooks entregados (24 h)" value={booking.value.webhooks.deliveredLast24h} />
          <Stat label="Webhooks agotados (24 h)" value={booking.value.webhooks.exhaustedLast24h} />
          <Stat label="Webhooks en cola" value={booking.value.webhooks.pending + booking.value.webhooks.retrying} />
        </section>
      )}

      <Unavailable part={health} what="La salud de los servicios" />
      {health.value && (
        <DataTable
          caption="Salud de cada servicio"
          headers={['Servicio', 'Estado', 'Respuesta', 'Versión', 'Revisado']}
          empty="Sin datos de salud."
          rows={health.value.map((item) => [<code key="s">{item.service}</code>, item.status, item.latencyMs === null ? '—' : `${item.latencyMs} ms`, item.version ?? '—', formatDateTime(item.checkedAt)])}
        />
      )}

      <Unavailable part={latency} what="La latencia (Prometheus)" />
      {latency.value && (
        <DataTable
          caption="Latencia y errores por servicio (última hora)"
          headers={['Servicio', 'Peticiones', 'p50', 'p95', 'p99', 'Errores 5xx']}
          empty="Sin peticiones registradas."
          rows={latency.value.map((item) => [<code key="s">{item.service}</code>, item.requests, `${item.p50Ms} ms`, `${item.p95Ms} ms`, `${item.p99Ms} ms`, `${Math.round(item.errorRate * 1000) / 10} %`])}
        />
      )}

      <Unavailable part={queues} what="El estado de las colas (RabbitMQ)" />
      {queues.value && (
        <DataTable
          caption="Colas de RabbitMQ"
          headers={['Cola', 'Mensajes', 'Consumidores', 'Fallidos (DLQ)']}
          empty="Sin colas."
          rows={queues.value.map((item) => [<code key="q">{item.queue}</code>, item.messages, item.consumers, item.deadLetters ?? 0])}
        />
      )}

      <Unavailable part={alerts} what="Las alertas (Alertmanager)" />
      {alerts.value && (
        <DataTable
          caption="Alertas activas"
          headers={['Desde', 'Regla', 'Severidad', 'Servicio', 'Mensaje']}
          empty="Sin alertas activas."
          rows={alerts.value.map((item) => [formatDateTime(item.startedAt), item.rule, item.severity, item.service ?? '—', item.message ?? '—'])}
        />
      )}
    </div>
  );
}

/** Hora con segundos, para ver que el refresco avanza. */
const localClock = (iso: string) => new Date(iso).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Unavailable({ part, what }: { part: Part<unknown>; what: string }) {
  if (!part.error) return null;
  return (
    <div className="alert alert-info" role="status">
      <p className="alert-title">{what} no está disponible.</p>
      <p>Revisa que la plataforma de observabilidad esté encendida.</p>
    </div>
  );
}
