import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { getRecentEvents, type DomainEvent, type EventFilter } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { ChannelCell } from '../../components/AdminUi';
import { ProblemAlert } from '../../components/ProblemAlert';
import { formatDateTime } from '../../lib/format';

const OUTCOME_LABELS: Record<string, string> = {
  PENDING: 'Pendiente',
  DELIVERED: 'Entregado',
  RETRYING: 'Reintentando',
  EXHAUSTED: 'Agotado',
};

/** Tipos que se pueden escribir en el filtro (los públicos de Webhooks y los internos más comunes). */
const EVENT_TYPES = [
  'booking.confirmed', 'booking.failed', 'booking.changed', 'booking.cancelled', 'booking.checked_in', 'booking.baggage_added',
  'booking.seat_changed', 'booking.ticket_issued', 'booking.ticket_failed', 'booking.assistance_requested', 'hold.created', 'hold.expired',
  'flight.status_changed', 'flight.schedule_changed', 'flight.cancelled', 'user.created', 'user.role_changed', 'user.blocked',
  'partner.created', 'partner.blocked',
];

/** Día de Ecuador (UTC−5, sin horario de verano) → instante ISO de su inicio o de su fin. */
const dayStart = (date: string) => new Date(`${date}T00:00:00-05:00`).toISOString();
const dayEnd = (date: string) => new Date(`${date}T23:59:59.999-05:00`).toISOString();

interface Draft {
  type: string;
  correlationId: string;
  from: string;
  to: string;
}
const EMPTY: Draft = { type: '', correlationId: '', from: '', to: '' };

const toFilter = (draft: Draft): EventFilter => ({
  ...(draft.type.trim() ? { type: draft.type.trim() } : {}),
  ...(draft.correlationId.trim() ? { correlationId: draft.correlationId.trim() } : {}),
  ...(draft.from ? { from: dayStart(draft.from) } : {}),
  ...(draft.to ? { to: dayEnd(draft.to) } : {}),
});

/** La reserva del evento: los eventos de reserva llevan su `bookingId` en los datos y como sujeto. */
const bookingOf = (event: DomainEvent) => {
  const id = typeof event.data.bookingId === 'string' ? event.data.bookingId : event.eventType.startsWith('booking.') ? event.subject : undefined;
  if (!id) return null;
  const order = typeof event.data.partnerOrderId === 'string' ? event.data.partnerOrderId : null;
  // Sin PNR en los datos (p. ej. la asistencia, que no muestra su contenido) no se sabe el canal.
  const pnr = typeof event.data.pnr === 'string' ? event.data.pnr : null;
  return { id, pnr: pnr ?? id.slice(0, 8), channel: pnr ? (order ? ('BOOKING' as const) : ('WEB' as const)) : null, order };
};

/** Resumen de los eventos que no son de una reserva: el vuelo, la ruta, la fecha o el motivo. */
function summary(event: DomainEvent): string {
  const data = event.data;
  const parts = [data.flightNumber, data.routeId, data.date, data.status, data.reason, data.email && 'usuario', data.clientId];
  return parts.filter(Boolean).map(String).join(' · ') || '—';
}

/** Telemetría ya buscada con el correlation ID, en una ventana de ±10 min alrededor del evento (Loki es lento en rangos largos). */
const traceLink = (correlationId: string, time: string) => {
  const margin = 10 * 60_000;
  const params = new URLSearchParams({
    correlationId,
    desde: new Date(Date.parse(time) - margin).toISOString(),
    hasta: new Date(Date.parse(time) + margin).toISOString(),
  });
  return `/admin/telemetria?${params.toString()}`;
};

/**
 * Bitácora de eventos de dominio (`eventHistory` del GraphQL, panel O-4): lo que publicaron los servicios en el bus, a qué
 * reserva pertenece (enlace a su detalle), por qué canal, su correlation ID (enlace a la traza) y cómo se entregó a cada
 * suscriptor de webhooks (Booking). Filtros por tipo, días y correlation ID.
 */
export function EventsPanel() {
  const { token } = useAuth();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [applied, setApplied] = useState<{ filter: EventFilter; nonce: number }>({ filter: {}, nonce: 0 });
  const key = `${JSON.stringify(applied.filter)}|${applied.nonce}`;
  const [result, setResult] = useState<{ key: string; events?: DomainEvent[]; error?: unknown } | null>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    getRecentEvents(token, applied.filter).then(
      (events) => active && setResult({ key, events }),
      (caught: unknown) => active && setResult({ key, error: caught }),
    );
    return () => {
      active = false;
    };
  }, [token, applied, key]);

  const current = result?.key === key ? result : null;
  // Mientras llega la búsqueda nueva se siguen viendo los eventos anteriores.
  const events = current?.events ?? (current ? undefined : result?.events);
  const filtered = Object.keys(applied.filter).length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setApplied({ filter: toFilter(draft), nonce: applied.nonce + 1 });
  };
  const clear = () => {
    setDraft(EMPTY);
    setApplied({ filter: {}, nonce: applied.nonce + 1 });
  };

  return (
    <section className="card" aria-labelledby="events-title">
      <div className="admin-head">
        <h2 id="events-title">Bitácora de eventos y webhooks</h2>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!current} onClick={() => setApplied({ ...applied, nonce: applied.nonce + 1 })}>
          {current ? 'Actualizar' : 'Cargando…'}
        </button>
      </div>
      <p className="muted small">
        Cada reserva, cambio, cancelación o check-in publica un evento en el bus interno; los suscriptores de webhooks (Booking) lo
        reciben por HTTP POST firmado. Se muestran los últimos 50 que cumplen el filtro; los que llevan datos de salud no muestran su
        contenido. Días en hora de Ecuador.
      </p>

      <form className="filters" onSubmit={submit} aria-label="Filtros de la bitácora">
        <label className="inline-field">
          Tipo
          <input list="event-types" value={draft.type} maxLength={60} placeholder="Todos" onChange={(event) => setDraft({ ...draft, type: event.target.value })} />
          <datalist id="event-types">
            {EVENT_TYPES.map((type) => <option key={type} value={type} />)}
          </datalist>
        </label>
        <label className="inline-field">
          Desde
          <input type="date" value={draft.from} max={draft.to || undefined} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
        </label>
        <label className="inline-field">
          Hasta
          <input type="date" value={draft.to} min={draft.from || undefined} onChange={(event) => setDraft({ ...draft, to: event.target.value })} />
        </label>
        <label className="inline-field">
          Correlation ID
          <input value={draft.correlationId} maxLength={100} placeholder="corr-…" onChange={(event) => setDraft({ ...draft, correlationId: event.target.value })} />
        </label>
        <button type="submit" className="btn btn-primary btn-sm">Filtrar</button>
        {filtered ? <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>Quitar filtros</button> : null}
      </form>

      {current?.error ? <ProblemAlert error={current.error} /> : null}
      {!events ? (
        !current?.error && <p className="muted">Cargando eventos…</p>
      ) : events.length === 0 ? (
        <p className="muted">{filtered ? 'Ningún evento cumple el filtro.' : 'Todavía no hay eventos. Haz una reserva o cambia el estado de un vuelo para verlos aquí.'}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Eventos de dominio, del más reciente al más antiguo</caption>
            <thead>
              <tr>
                <th scope="col">Momento</th>
                <th scope="col">Evento</th>
                <th scope="col">Reserva</th>
                <th scope="col">Canal</th>
                <th scope="col">Correlation ID</th>
                <th scope="col">Entrega a suscriptores</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const booking = bookingOf(event);
                return (
                  <tr key={event.eventId}>
                    <td className="small">{formatDateTime(event.occurredAt)}</td>
                    <td><code>{event.eventType}</code></td>
                    <td className="small">
                      {booking ? <Link to={`/admin/reservas/${booking.id}`} className="strong-link">{booking.pnr}</Link> : <span className="muted">{summary(event)}</span>}
                    </td>
                    <td className="small">{booking?.channel ? <ChannelCell channel={booking.channel} order={booking.order} /> : <span className="muted">—</span>}</td>
                    <td className="small">
                      {event.correlationId ? (
                        <Link to={traceLink(event.correlationId, event.occurredAt)} className="mono" title="Ver la traza en Telemetría">{event.correlationId}</Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="small">
                      {event.deliveries.length === 0
                        ? <span className="muted">Sin suscriptores</span>
                        : event.deliveries.map((delivery, index) => (
                            <div key={index}>
                              <span className={delivery.outcome === 'EXHAUSTED' ? 'text-danger' : undefined}>{OUTCOME_LABELS[delivery.outcome] ?? delivery.outcome}</span>
                              {delivery.httpStatus ? ` (HTTP ${delivery.httpStatus})` : ''}
                              {delivery.attempts ? ` · ${delivery.attempts} intento${delivery.attempts > 1 ? 's' : ''}` : ''}
                              <span className="muted block">{delivery.target}</span>
                            </div>
                          ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
