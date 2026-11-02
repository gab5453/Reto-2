import { useCallback, useEffect, useState } from 'react';
import { getRecentEvents, type DomainEvent } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { ProblemAlert } from '../../components/ProblemAlert';
import { formatDateTime } from '../../lib/format';

const OUTCOME_LABELS: Record<string, string> = {
  PENDING: 'Pendiente',
  DELIVERED: 'Entregado',
  RETRYING: 'Reintentando',
  EXHAUSTED: 'Agotado',
};

/** Resumen legible del `data` del evento: lo que identifica a la reserva, el vuelo o la ruta. */
function summary(event: DomainEvent): string {
  const data = event.data;
  const parts = [data.pnr, data.flightNumber, data.routeId, data.date, data.status, data.reason, data.refundAmount && `reembolso ${String(data.refundAmount)}`];
  return parts.filter(Boolean).map(String).join(' · ') || '—';
}

/**
 * Eventos de dominio recientes (`eventHistory` del GraphQL, MS.Admin): lo que publicaron los servicios en el bus
 * (`booking.confirmed`, `flight.cancelled`…) y cómo se entregó cada uno a los suscriptores de webhooks.
 */
export function EventsPanel() {
  const { token } = useAuth();
  const [events, setEvents] = useState<DomainEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setEvents(await getRecentEvents(token));
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    getRecentEvents(token)
      .then((data) => active && setEvents(data))
      .catch((caught: unknown) => active && setError(caught));
    return () => {
      active = false;
    };
  }, [token]);

  return (
    <section className="card" aria-labelledby="events-title">
      <div className="admin-head">
        <h2 id="events-title">Eventos de dominio y webhooks</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()}>Actualizar</button>
      </div>
      <p className="muted small">
        Cada reserva, cambio, cancelación o check-in publica un evento en el bus interno; los suscriptores de webhooks lo reciben
        por HTTP POST firmado con su secreto. Se muestran los últimos 50; los que llevan datos de salud no muestran su contenido.
      </p>
      {error ? <ProblemAlert error={error} /> : null}
      {!events ? (
        !error && <p className="muted">Cargando eventos…</p>
      ) : events.length === 0 ? (
        <p className="muted">Todavía no hay eventos. Haz una reserva o cambia el estado de un vuelo para verlos aquí.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Momento</th>
                <th scope="col">Evento</th>
                <th scope="col">Datos</th>
                <th scope="col">Entregas</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.eventId}>
                  <td className="small">{formatDateTime(event.occurredAt)}</td>
                  <td><code>{event.eventType}</code></td>
                  <td className="small">{summary(event)}</td>
                  <td className="small">
                    {event.deliveries.length === 0
                      ? <span className="muted">Sin suscriptores</span>
                      : event.deliveries.map((delivery, index) => (
                          <div key={index}>
                            {OUTCOME_LABELS[delivery.outcome] ?? delivery.outcome}
                            {delivery.httpStatus ? ` (HTTP ${delivery.httpStatus})` : ''}
                            {delivery.attempts ? ` · ${delivery.attempts} intento${delivery.attempts > 1 ? 's' : ''}` : ''}
                            <span className="muted"> · {delivery.target}</span>
                          </div>
                        ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
