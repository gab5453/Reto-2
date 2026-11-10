import { useEffect, useState } from 'react';
import { getFlightStatus } from '../api/operations';
import type { FlightStatus } from '../api/types';
import { localDate, localTime } from '../lib/format';

interface SegmentRef {
  flightNumber: string;
  departure: { at: string };
}

const span = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`);

/**
 * Aviso de retraso o cancelación de los tramos que aún no salen (R-1): consulta el estado vigente de cada vuelo (el mismo que
 * ve Booking en `GET /vuelos/flights/{n}/status`) y muestra la hora nueva. No muestra nada si todos van a tiempo.
 */
export function FlightDelayNotice({ segments }: { segments: SegmentRef[] }) {
  // Momento de referencia fijo al montar (no se llama a Date.now en cada render).
  const [since] = useState(() => Date.now() - 24 * 3_600_000);
  // La fecha del vuelo es la local de su salida (los primeros 10 caracteres de la hora con su desfase).
  const upcoming = segments.filter((segment) => Date.parse(segment.departure.at) > since);
  const key = upcoming.map((segment) => `${segment.flightNumber}@${segment.departure.at.slice(0, 10)}`).join(',');
  const [result, setResult] = useState<{ key: string; statuses: FlightStatus[] }>({ key: '', statuses: [] });

  useEffect(() => {
    if (!key) return;
    let active = true;
    Promise.allSettled(key.split(',').map((item) => {
      const [flightNumber, date] = item.split('@') as [string, string];
      return getFlightStatus(flightNumber, date);
    })).then((results) => {
      if (active) setResult({ key, statuses: results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])) });
    });
    return () => {
      active = false;
    };
  }, [key]);

  const notices = (result.key === key ? result.statuses : []).filter((status) => status.status === 'DELAYED' || status.status === 'CANCELLED');
  if (!notices.length) return null;
  return (
    <>
      {notices.map((status) =>
        status.status === 'CANCELLED' ? (
          <div key={status.flightNumber} className="alert alert-error" role="alert">
            <p className="alert-title">Tu vuelo {status.flightNumber} fue cancelado.</p>
          </div>
        ) : (
          <div key={status.flightNumber} className="alert alert-warning" role="status">
            <p className="alert-title">
              Tu vuelo {status.flightNumber} está retrasado{status.delayMinutes ? ` ${span(status.delayMinutes)}` : ''}.
            </p>
            <p>
              Nueva salida <strong>{localTime(status.departure?.estimatedAt ?? status.departure?.scheduledAt)}</strong> (era {localTime(status.departure?.scheduledAt)})
              {status.arrival?.estimatedAt
                ? ` · nueva llegada ${status.arrival.estimatedAt.slice(0, 10) !== (status.departure?.estimatedAt ?? status.date).slice(0, 10) ? `${localDate(status.arrival.estimatedAt.slice(0, 10))} ` : ''}${localTime(status.arrival.estimatedAt)}`
                : ''}
              . El check-in sigue abierto hasta la nueva hora de salida.
            </p>
          </div>
        ),
      )}
    </>
  );
}
