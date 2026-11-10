import { useEffect, useRef, useState } from 'react';
import { getJourney, type Journey } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { useLiveSubscription } from '../../lib/live';
import { ProblemAlert } from '../ProblemAlert';
import { JourneyGraph } from './JourneyGraph';
import { LiveBadge } from './LiveSystemMap';
import { nodeLabel, type GraphEdge } from './layout';

const SPEEDS = [0.5, 1, 2, 4] as const;
/** Lo que tarda el punto en recorrer una arista a velocidad 1. */
const HOP_MS = 900;

const SUBSCRIPTION = `subscription RecorridoEnVivo($correlationId: String!) {
  traceProgress(correlationId: $correlationId) {
    newHops { sequence }
    journey {
      correlationId startedAt durationMs traces truncated
      nodes { id layer }
      hops { sequence from to operation startMs durationMs status httpStatus traceId }
    }
  }
}`;
const FALLBACK_MS = 15_000;
/** Un proceso que empezó hace más de esto ya no cambia: no se sigue en vivo (cada consulta pide trazas a Tempo). */
const LIVE_WINDOW_MS = 15 * 60_000;

const duration = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toLocaleString('es-EC', { maximumFractionDigits: 2 })} s` : `${Math.round(ms)} ms`);

/**
 * Vista «Recorrido» (PLAN_Telemetria_Asientos T-4, D-T2): el proceso de un correlation ID dibujado por capas, con un reproductor
 * que lleva el punto de nodo en nodo en el orden real de las llamadas (desde los spans de Tempo). Cada salto dice la operación, cuándo
 * empezó (desde el inicio del proceso), cuánto tardó y si falló. Sin datos personales: solo servicios, operaciones y tiempos.
 */
export function JourneyView({ correlationId, range = {} }: { correlationId: string; range?: { from?: string; to?: string } }) {
  const { token } = useAuth();
  const key = `${correlationId}|${range.from ?? ''}|${range.to ?? ''}`;
  const [result, setResult] = useState<{ key: string; journey?: Journey | null; error?: unknown } | null>(null);
  // T-5: lo que empuja el servidor (el recorrido completo y cuántos saltos son nuevos). Solo mientras el proceso no aparece o es de
  // los últimos 15 minutos: uno viejo ya no cambia, y seguirlo pediría trazas a Tempo cada 5 s sin necesidad.
  const [live, setLive] = useState<{ key: string; journey: Journey; added: number } | null>(null);
  const loaded = result?.key === key ? result : null;
  const [now] = useState(() => Date.now());
  const recent = !loaded?.journey?.startedAt || now - Date.parse(loaded.journey.startedAt) < LIVE_WINDOW_MS;
  const follow = Boolean(loaded) && !loaded?.error && recent;
  const status = useLiveSubscription<{ traceProgress: { journey: Journey; newHops: unknown[] } }>(
    token,
    SUBSCRIPTION,
    { correlationId },
    (data) => setLive({ key, journey: data.traceProgress.journey, added: data.traceProgress.newHops.length }),
    follow,
  );
  const fallback = status === 'fallback';

  // Respaldo sin conexión en vivo: se vuelve a pedir cada 15 s.
  useEffect(() => {
    if (!token || !fallback) return;
    let active = true;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      getJourney(token, correlationId, range).then(
        (journey) => active && journey && setLive({ key, journey, added: 0 }),
        () => undefined,
      );
    }, FALLBACK_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, fallback, correlationId, key]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    getJourney(token, correlationId, range).then(
      (journey) => active && setResult({ key, journey }),
      (error: unknown) => active && setResult({ key, error }),
    );
    return () => {
      active = false;
    };
    // `range` se compara por su clave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, correlationId, key]);

  const current = result?.key === key ? result : null;
  const pushed = live?.key === key ? live : null;
  // Lo más nuevo: lo empujado (o el respaldo) si tiene al menos tantos saltos como la consulta inicial.
  const journey = pushed && (!current?.journey || pushed.journey.hops.length >= current.journey.hops.length) ? pushed.journey : current?.journey;
  const badge = (
    <p className="muted small" role="status" aria-live="polite">
      <LiveBadge status={status} />
      {pushed?.added ? ` · ${pushed.added} ${pushed.added === 1 ? 'salto nuevo' : 'saltos nuevos'}` : ''}
    </p>
  );
  if (!current && !journey) return <p className="muted small" role="status">Armando el recorrido desde las trazas…</p>;
  if (current?.error && !journey) return <ProblemAlert error={current.error} />;
  if (!journey) {
    return (
      <>
        {badge}
        <p className="muted small">
          Todavía no hay trazas de ese proceso. {status === 'live' ? 'Apenas ocurra, sus pasos aparecen aquí solos (unos segundos después).' : 'Si acaba de ocurrir, vuelve a buscarlo en unos segundos.'} Las trazas se guardan 7 días.
        </p>
      </>
    );
  }
  return (
    <>
      {badge}
      <JourneyPlayer key={key} journey={journey} />
    </>
  );
}

function JourneyPlayer({ journey }: { journey: Journey }) {
  const hops = journey.hops;
  const [position, setPosition] = useState({ index: 0, progress: 0 });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const listRef = useRef<HTMLOListElement>(null);
  /** La posición actual para el bucle de animación (sin depender de un estado viejo). */
  const positionRef = useRef(position);
  const move = (next: { index: number; progress: number }) => {
    positionRef.current = next;
    setPosition(next);
  };
  const { index, progress } = position;

  // El punto avanza con requestAnimationFrame; al terminar una arista pasa a la siguiente y, en la última, se detiene en el destino.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last: number | undefined;
    const tick = (now: number) => {
      const elapsed = last === undefined ? 0 : now - last;
      last = now;
      const current = positionRef.current;
      let next = { index: current.index, progress: current.progress + (elapsed * speed) / HOP_MS };
      if (next.progress >= 1) {
        if (current.index >= hops.length - 1) {
          positionRef.current = { index: current.index, progress: 1 };
          setPosition(positionRef.current);
          setPlaying(false);
          return;
        }
        next = { index: current.index + 1, progress: 0 };
      }
      positionRef.current = next;
      setPosition(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, hops.length]);

  // La lista sigue al salto actual.
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const hop = hops[index];
  const finished = !playing && index === hops.length - 1 && progress >= 1;
  const seen = new Set(hops.slice(0, index).map((item) => `${item.from}→${item.to}`));
  const counts = new Map<string, { count: number; error: boolean }>();
  for (const item of hops) {
    const edgeKey = `${item.from}→${item.to}`;
    const previous = counts.get(edgeKey);
    counts.set(edgeKey, { count: (previous?.count ?? 0) + 1, error: Boolean(previous?.error) || item.status === 'ERROR' });
  }
  const currentKey = hop ? `${hop.from}→${hop.to}` : '';
  const edges: GraphEdge[] = [...counts].map(([edgeKey, info]) => {
    const [from, to] = edgeKey.split('→') as [string, string];
    const tone = edgeKey === currentKey ? 'active' : info.error && seen.has(edgeKey) ? 'error' : seen.has(edgeKey) ? 'visited' : 'idle';
    return { key: edgeKey, from, to, tone, label: info.count > 1 ? `×${info.count}` : undefined, title: `${nodeLabel(from)} → ${nodeLabel(to)}: ${info.count} llamada${info.count > 1 ? 's' : ''}` };
  });

  const jump = (to: number) => {
    setPlaying(false);
    move({ index: to, progress: 0 });
  };
  const play = () => {
    if (finished) move({ index: 0, progress: 0 });
    setPlaying(true);
  };

  return (
    <div className="journey">
      <p className="small">
        <strong>{hops.length} saltos</strong> en {journey.traces} {journey.traces === 1 ? 'traza' : 'trazas'} · duración total {duration(journey.durationMs)}
        {journey.startedAt ? ` · empezó ${new Date(journey.startedAt).toLocaleTimeString('es-EC')}` : ''}
        {journey.truncated ? ' · (se muestran los primeros 300)' : ''}
      </p>
      <div className="journey-controls" role="group" aria-label="Reproductor del recorrido">
        {playing ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setPlaying(false)}>⏸ Pausa</button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={play}>▶ {finished ? 'Repetir' : 'Reproducir'}</button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => jump(0)}>⏮ Al inicio</button>
        <label className="inline-field small">
          Paso
          <input type="range" min={1} max={hops.length} value={index + 1} aria-valuetext={`${index + 1} de ${hops.length}`} onChange={(event) => jump(Number(event.target.value) - 1)} />
          {index + 1}/{hops.length}
        </label>
        <label className="inline-field small">
          Velocidad
          <select value={speed} onChange={(event) => setSpeed(Number(event.target.value) as (typeof SPEEDS)[number])}>
            {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
          </select>
        </label>
      </div>
      {hop ? (
        <p className="journey-now small" aria-live="polite">
          <strong>{hop.sequence}.</strong> {nodeLabel(hop.from)} → {nodeLabel(hop.to)} · <code>{hop.operation}</code> · +{duration(hop.startMs)} · tardó {duration(hop.durationMs)}
          {hop.status === 'ERROR' ? <strong className="text-danger"> · falló{hop.httpStatus ? ` (${hop.httpStatus})` : ''}</strong> : hop.httpStatus ? ` · ${hop.httpStatus}` : ''}
        </p>
      ) : null}
      <JourneyGraph
        nodes={journey.nodes}
        edges={edges}
        activeNodes={hop ? [hop.from, hop.to] : []}
        dot={hop ? { from: hop.from, to: hop.to, progress, error: hop.status === 'ERROR' } : undefined}
        label={`Recorrido del proceso ${journey.correlationId}: ${journey.nodes.map((node) => nodeLabel(node.id)).join(', ')}`}
      />
      <details className="journey-steps" open>
        <summary className="small">Saltos en orden</summary>
        <ol ref={listRef} className="small">
          {hops.map((item, at) => (
            <li key={item.sequence} aria-current={at === index ? 'step' : undefined} className={item.status === 'ERROR' ? 'is-error' : undefined}>
              <button type="button" className="link-button" onClick={() => jump(at)}>
                +{duration(item.startMs)} · {nodeLabel(item.from)} → {nodeLabel(item.to)} · <code>{item.operation}</code> · {duration(item.durationMs)}
                {item.status === 'ERROR' ? ' · falló' : ''}
              </button>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
