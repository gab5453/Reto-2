import { useEffect, useRef, useState } from 'react';
import { openSubscription } from '../api/client';

/**
 * Suscripciones GraphQL por WebSocket (PLAN_Telemetria_Asientos T-5, D-T13) con el protocolo `graphql-transport-ws` del gateway.
 * Cliente mínimo propio (sin dependencias): `connection_init` con el token → `connection_ack` → `subscribe` → `next`… Si la
 * conexión no se abre, se rechaza o se corta, el estado pasa a `fallback` (el componente vuelve al refresco cada 15 s y lo avisa)
 * y se reintenta conectar cada 30 s.
 */
export type LiveStatus = 'connecting' | 'live' | 'fallback' | 'off';

const RETRY_MS = 30_000;

/**
 * Hook: mantiene una suscripción mientras el componente está montado y hay token. `onData` recibe cada envío del servidor.
 * Devuelve el estado de la conexión para que el componente decida si usa el refresco de respaldo.
 */
export function useLiveSubscription<T>(token: string | null | undefined, query: string, variables: Record<string, unknown>, onData: (data: T) => void, enabled = true): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const handler = useRef(onData);
  useEffect(() => {
    handler.current = onData;
  });
  const key = JSON.stringify(variables);

  useEffect(() => {
    if (!token || !enabled) return;
    let stopped = false;
    let close: () => void = () => undefined;
    let retry: number | undefined;
    const connect = () => {
      close = openSubscription<T>(
        token,
        query,
        JSON.parse(key) as Record<string, unknown>,
        {
          next: (data) => handler.current(data),
          error: () => !stopped && setStatus('fallback'),
          close: () => {
            if (stopped) return;
            setStatus('fallback');
            retry = window.setTimeout(connect, RETRY_MS);
          },
        },
        () => !stopped && setStatus('live'),
      );
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      close();
    };
  }, [token, query, key, enabled]);

  if (!enabled) return 'off';
  return token ? status : 'fallback';
}
