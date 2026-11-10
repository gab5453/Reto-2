import { useCallback, useEffect, useRef, useState } from 'react';
import { getSystemMap, type SystemMap } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { useLiveSubscription } from '../../lib/live';
import { ProblemAlert } from '../ProblemAlert';
import { JourneyGraph } from './JourneyGraph';
import { layerOf, nodeLabel, type GraphEdge } from './layout';

const REFRESH_MS = 15_000;

const SUBSCRIPTION = 'subscription MapaEnVivo { liveSystemMap { generatedAt windowMinutes edges { from to requestsPerMinute errorsPerMinute p95Ms } } }';

/**
 * Mapa del sistema en vivo (PLAN_Telemetria_Asientos T-4): quién llama a quién en los últimos 5 minutos, del grafo de servicios
 * que Tempo calcula a partir de las trazas (T-3). El grosor de cada flecha crece con las peticiones por minuto; en rojo, las que
 * tuvieron errores. T-5: el servidor lo empuja por WebSocket cada vez que cambia; si no hay conexión en vivo, se pide cada 15 s
 * con la pestaña visible (y se avisa).
 */
export function LiveSystemMap() {
  const { token } = useAuth();
  const [map, setMap] = useState<SystemMap | null>(null);
  const [error, setError] = useState<unknown>(null);
  const busy = useRef(false);
  const status = useLiveSubscription<{ liveSystemMap: SystemMap }>(token, SUBSCRIPTION, {}, (data) => {
    setMap(data.liveSystemMap);
    setError(null);
  });
  const fallback = status === 'fallback';

  const load = useCallback(
    (isActive: () => boolean = () => true) => {
      if (!token || busy.current) return;
      busy.current = true;
      getSystemMap(token)
        .then(
          (data) => {
            if (!isActive()) return;
            setMap(data);
            setError(null);
          },
          (caught: unknown) => isActive() && setError(caught),
        )
        .finally(() => {
          busy.current = false;
        });
    },
    [token],
  );

  // Lo primero siempre por consulta (el envío en vivo puede tardar unos segundos en llegar).
  useEffect(() => {
    let active = true;
    load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  // Respaldo: sin conexión en vivo, cada 15 s con la pestaña visible.
  useEffect(() => {
    if (!fallback) return;
    let active = true;
    const tick = () => {
      if (document.visibilityState === 'visible') load(() => active);
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load, fallback]);

  if (error && !map) return <ProblemAlert error={error} />;
  if (!map) return <p className="muted small" role="status">Cargando el mapa…</p>;
  const names = [...new Set(map.edges.flatMap((edge) => [edge.from, edge.to]))];
  const nodes = names.map((id) => ({ id, layer: layerOf(id) }));
  const edges: GraphEdge[] = map.edges.map((edge) => ({
    key: `${edge.from}→${edge.to}`,
    from: edge.from,
    to: edge.to,
    tone: edge.errorsPerMinute > 0 ? 'error' : 'normal',
    width: 1 + Math.min(6, Math.log2(1 + edge.requestsPerMinute)),
    label: `${edge.requestsPerMinute.toLocaleString('es-EC', { maximumFractionDigits: 1 })}/min`,
    title: `${nodeLabel(edge.from)} → ${nodeLabel(edge.to)}: ${edge.requestsPerMinute.toLocaleString('es-EC', { maximumFractionDigits: 2 })} peticiones/min, ${edge.errorsPerMinute.toLocaleString('es-EC', { maximumFractionDigits: 2 })} errores/min${edge.p95Ms === null ? '' : `, p95 ${Math.round(edge.p95Ms)} ms`}`,
  }));
  return (
    <div className="journey">
      <p className="muted small" role="status" aria-live="polite">
        Últimos {map.windowMinutes} minutos · actualizado {new Date(map.generatedAt).toLocaleTimeString('es-EC')} ·{' '}
        <LiveBadge status={status} />
        {error ? ' · la última actualización falló, se reintenta' : ''}
      </p>
      {edges.length ? (
        <JourneyGraph nodes={nodes} edges={edges} label={`Mapa del sistema: ${edges.length} conexiones activas entre ${nodes.length} servicios`} />
      ) : (
        <p className="muted">Sin tráfico en los últimos {map.windowMinutes} minutos.</p>
      )}
      {edges.length ? (
        <details>
          <summary className="small">Ver como tabla</summary>
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">Conexiones activas</caption>
              <thead>
                <tr><th scope="col">Desde</th><th scope="col">Hacia</th><th scope="col" className="num">Peticiones/min</th><th scope="col" className="num">Errores/min</th><th scope="col" className="num">p95</th></tr>
              </thead>
              <tbody>
                {map.edges.map((edge) => (
                  <tr key={`${edge.from}→${edge.to}`}>
                    <td>{nodeLabel(edge.from)}</td>
                    <td>{nodeLabel(edge.to)}</td>
                    <td className="num">{edge.requestsPerMinute.toLocaleString('es-EC', { maximumFractionDigits: 2 })}</td>
                    <td className="num">{edge.errorsPerMinute ? <strong className="text-danger">{edge.errorsPerMinute.toLocaleString('es-EC', { maximumFractionDigits: 2 })}</strong> : 0}</td>
                    <td className="num">{edge.p95Ms === null ? '—' : `${Math.round(edge.p95Ms)} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** «En vivo» (WebSocket) o el aviso del respaldo. */
export function LiveBadge({ status }: { status: 'connecting' | 'live' | 'fallback' }) {
  if (status === 'live') return <span className="live-badge is-live">● En vivo: el servidor envía cada cambio</span>;
  if (status === 'connecting') return <span className="live-badge">Conectando en vivo…</span>;
  return <span className="live-badge is-fallback">Actualización cada 15 s: sin conexión en vivo</span>;
}
