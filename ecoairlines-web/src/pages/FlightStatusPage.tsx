import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getFlightStatus } from '../api/operations';
import type { FlightStatus } from '../api/types';
import { ProblemAlert } from '../components/ProblemAlert';
import { cityOf } from '../data/airports';
import { STATUS_LABELS, localDate, localTime, todayIso } from '../lib/format';

const FLIGHT_NUMBER = /^[A-Z0-9]{2}\d{1,4}$/;

export function FlightStatusPage() {
  const [params, setParams] = useSearchParams();
  const [flightNumber, setFlightNumber] = useState(params.get('vuelo') ?? '');
  const [date, setDate] = useState(params.get('fecha') ?? todayIso());
  const [formError, setFormError] = useState<string>();
  const query = params.get('vuelo');
  const queryDate = params.get('fecha');
  const requestKey = `${query}|${queryDate}`;
  const [loaded, setLoaded] = useState<{ key: string; status?: FlightStatus; error?: unknown }>({ key: '' });

  useEffect(() => {
    if (!query || !queryDate) return;
    let active = true;
    getFlightStatus(query, queryDate)
      .then((status) => active && setLoaded({ key: requestKey, status }))
      .catch((error: unknown) => active && setLoaded({ key: requestKey, error }));
    return () => {
      active = false;
    };
  }, [query, queryDate, requestKey]);

  const current = loaded.key === requestKey ? loaded : undefined;
  const status = current?.status;
  const error = current?.error;
  const loading = Boolean(query && queryDate) && !current;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = flightNumber.trim().toUpperCase();
    if (!FLIGHT_NUMBER.test(normalized)) return setFormError('Ingresa un número de vuelo válido, por ejemplo EA104.');
    setFormError(undefined);
    setParams({ vuelo: normalized, fecha: date });
  };

  return (
    <div className="container section narrow">
      <h1>Estado de vuelo</h1>
      <form className="search-row" onSubmit={submit}>
        <label className="field">
          Número de vuelo
          <input value={flightNumber} maxLength={8} placeholder="EA104" onChange={(event) => setFlightNumber(event.target.value)} required />
        </label>
        <label className="field">
          Fecha
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
        </label>
        <button type="submit" className="btn btn-primary">Consultar</button>
      </form>
      {formError && <p className="form-error" role="alert">{formError}</p>}
      {loading && <p className="muted" aria-live="polite">Consultando…</p>}
      {error ? <ProblemAlert error={error} /> : null}

      {status && (
        <article className="card status-card" aria-live="polite">
          <header className="status-card-head">
            <div>
              <p className="muted small">{localDate(status.date)} · {status.aircraft}</p>
              <h2>{status.flightNumber}</h2>
            </div>
            <span className={`status status-${status.status.toLowerCase()}`}>{STATUS_LABELS[status.status] ?? status.status}</span>
          </header>
          <div className="status-grid">
            <Endpoint title="Salida" endpoint={status.departure} />
            <Endpoint title="Llegada" endpoint={status.arrival} />
          </div>
        </article>
      )}
    </div>
  );
}

function Endpoint({ title, endpoint }: { title: string; endpoint: FlightStatus['departure'] }) {
  const delayed = endpoint.estimatedAt && endpoint.estimatedAt !== endpoint.scheduledAt;
  return (
    <div>
      <p className="muted small">{title}</p>
      <p className="route-code">{endpoint.iataCode}</p>
      <p>{cityOf(endpoint.iataCode)}{endpoint.terminal ? ` · Terminal ${endpoint.terminal}` : ''}</p>
      <p>
        Programado <strong className={delayed ? 'strike' : ''}>{localTime(endpoint.scheduledAt)}</strong>
        {delayed && <> · Estimado <strong className="text-warn">{localTime(endpoint.estimatedAt)}</strong></>}
      </p>
      {endpoint.actualAt && <p className="small">Real: {localTime(endpoint.actualAt)}</p>}
    </div>
  );
}
