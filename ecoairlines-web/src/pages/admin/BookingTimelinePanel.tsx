import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAdminBookingTimeline, type AdminBookingTimeline } from '../../api/admin';
import { ProblemAlert } from '../../components/ProblemAlert';
import { formatDateTime } from '../../lib/format';

const SAGA_LABELS: Record<string, string> = {
  CREATE_BOOKING: 'Crear reserva',
  ISSUE_TICKETS: 'Emitir boletos',
  PAYMENT_FAILED: 'Pago fallido',
  CHANGE_SEATS: 'Cambiar asientos',
  CHECK_IN: 'Check-in',
  CANCEL_BOOKING: 'Cancelar reserva',
  CHANGE_DATE: 'Cambiar fecha',
  ADD_BAGGAGE: 'Agregar maletas',
  ASSISTANCE_READY: 'Asistencia lista',
};
const SAGA_STATUS: Record<string, string> = { RUNNING: 'En curso', COMPLETED: 'Completada', COMPENSATING: 'Compensando', COMPENSATED: 'Compensada', FAILED: 'Fallida' };
const STEP_STATUS: Record<string, string> = { STARTED: 'iniciado', DONE: 'hecho', COMPENSATED: 'deshecho' };
const DELIVERY_STATUS: Record<string, string> = { PENDING: 'Pendiente', DELIVERED: 'Entregado', RETRYING: 'Reintentando', EXHAUSTED: 'Agotado', CANCELLED: 'Cancelado' };

/** Telemetría con el correlation ID de la saga y su ventana de tiempo (±10 min): Loki responde en milisegundos, no en 24 s. */
const traceLink = (saga: { correlationId: string; createdAt: string; updatedAt: string }) => {
  const margin = 10 * 60_000;
  const params = new URLSearchParams({
    correlationId: saga.correlationId,
    desde: new Date(Date.parse(saga.createdAt) - margin).toISOString(),
    hasta: new Date(Date.parse(saga.updatedAt) + margin).toISOString(),
  });
  return `/admin/telemetria?${params.toString()}`;
};

/** `ec.edu.epn.booking.vuelos.booking.cancelled` → `booking.cancelled`. */
const shortType = (type: string) => type.split('.').slice(-2).join('.');

type Entry =
  | { at: string; kind: 'change'; description: string }
  | { at: string; kind: 'saga'; saga: AdminBookingTimeline['sagas'][number] }
  | { at: string; kind: 'event'; event: AdminBookingTimeline['events'][number] };

/**
 * Historial completo de una reserva (panel O-2): los cambios que guarda la reserva, las sagas que la tocaron (con sus pasos y
 * el enlace a su traza) y los eventos que generó, con cada entrega a Booking. Se carga aparte: el detalle no lo espera.
 */
export function BookingTimelinePanel({ token, bookingId, changes }: { token: string; bookingId: string; changes: { changedAt: string; description: string | null }[] }) {
  const [result, setResult] = useState<{ id: string; timeline?: AdminBookingTimeline; error?: unknown } | null>(null);

  useEffect(() => {
    let active = true;
    getAdminBookingTimeline(token, bookingId).then(
      (timeline) => active && setResult({ id: bookingId, timeline }),
      (caught: unknown) => active && setResult({ id: bookingId, error: caught }),
    );
    return () => {
      active = false;
    };
  }, [token, bookingId]);

  const current = result?.id === bookingId ? result : null;
  const entries: Entry[] = [
    ...changes.map((change): Entry => ({ at: change.changedAt, kind: 'change', description: change.description ?? '—' })),
    ...(current?.timeline?.sagas ?? []).map((saga): Entry => ({ at: saga.createdAt, kind: 'saga', saga })),
    ...(current?.timeline?.events ?? []).map((event): Entry => ({ at: event.time, kind: 'event', event })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <section className="card" aria-labelledby="historial">
      <h2 id="historial">Historial</h2>
      <p className="muted small">Cambios de la reserva, sagas que la tocaron (con su traza) y eventos enviados, con su entrega a Booking.</p>
      {current?.error ? <ProblemAlert error={current.error} /> : null}
      {!current ? <p className="muted small">Cargando sagas y eventos…</p> : null}
      <ol className="timeline booking-timeline">
        {entries.map((entry, index) => (
          <li key={`${entry.kind}-${index}`} className={`timeline-${entry.kind}`}>
            <span className="small muted">{formatDateTime(entry.at)}</span>{' '}
            {entry.kind === 'change' && <span>{entry.description}</span>}
            {entry.kind === 'saga' && <SagaEntry saga={entry.saga} />}
            {entry.kind === 'event' && <EventEntry event={entry.event} />}
          </li>
        ))}
      </ol>
    </section>
  );
}

function SagaEntry({ saga }: { saga: AdminBookingTimeline['sagas'][number] }) {
  const tone = saga.status === 'COMPLETED' ? 'confirmed' : saga.status === 'RUNNING' ? 'pending_payment' : 'cancelled';
  return (
    <span>
      <span className="tag-kind">Saga</span> <strong>{SAGA_LABELS[saga.type] ?? saga.type}</strong>{' '}
      <span className={`status status-${tone}`}>{SAGA_STATUS[saga.status] ?? saga.status}</span>
      {saga.errorCode ? <span className="muted small"> · {saga.errorCode}</span> : null}
      {' · '}
      <Link to={traceLink(saga)} className="small">Ver la traza</Link>
      <details className="saga-steps">
        <summary className="small">{saga.steps.length} pasos · <span className="mono">{saga.correlationId}</span></summary>
        <ol className="small">
          {saga.steps.map((step, index) => (
            <li key={index}>
              <code>{step.name}</code> · {STEP_STATUS[step.status] ?? step.status}
            </li>
          ))}
        </ol>
      </details>
    </span>
  );
}

function EventEntry({ event }: { event: AdminBookingTimeline['events'][number] }) {
  return (
    <span>
      <span className="tag-kind">Evento</span> <code>{shortType(event.type)}</code>{' '}
      <span className="muted small">{event.public ? 'sale a Booking' : 'interno'}</span>
      {event.public ? (
        event.deliveries.length ? (
          <span className="small block">
            {event.deliveries.map((delivery) => (
              <span key={delivery.subscriptionId} className="delivery">
                → {delivery.target ?? 'suscriptor'}: <strong>{DELIVERY_STATUS[delivery.outcome] ?? delivery.outcome}</strong>
                {delivery.httpStatus ? ` (HTTP ${delivery.httpStatus})` : ''} · {delivery.attempts} intento(s)
                {delivery.nextRetryAt ? ` · reintento ${formatDateTime(delivery.nextRetryAt)}` : ''}
              </span>
            ))}
          </span>
        ) : (
          <span className="small block muted">Sin suscriptores: Booking aún no registró su webhook (queda en el feed /vuelos/eventos).</span>
        )
      ) : null}
    </span>
  );
}
