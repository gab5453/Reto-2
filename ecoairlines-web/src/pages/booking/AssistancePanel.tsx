import { useCallback, useEffect, useState } from 'react';
import { deletePassengerAssistance, getAssistance, savePassengerAssistance } from '../../api/operations';
import type { AssistanceInput, BookingDetail, PassengerAssistance } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { AssistanceFields } from '../../components/AssistanceFields';
import { ProblemAlert } from '../../components/ProblemAlert';
import { ASSISTANCE_LABELS, EMPTY_ASSISTANCE, STATUS_LABELS, cleanAssistance } from '../../lib/format';

/** Ver, pedir, cambiar o quitar la asistencia médica de cada pasajero (dato de salud: `booking.assistance`). */
export function AssistancePanel({ booking }: { booking: BookingDetail }) {
  const { token } = useAuth();
  const [items, setItems] = useState<PassengerAssistance[] | null>(null);
  const [editing, setEditing] = useState<string>();
  const [form, setForm] = useState<AssistanceInput>(EMPTY_ASSISTANCE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string>();

  const load = useCallback(async () => {
    if (!token) return;
    setItems(await getAssistance(token, booking.bookingId));
  }, [token, booking.bookingId]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    getAssistance(token, booking.bookingId)
      .then((data) => active && setItems(data))
      .catch((caught: unknown) => active && setError(caught));
    return () => {
      active = false;
    };
  }, [token, booking.bookingId]);

  const name = (passengerId: string) => {
    const passenger = booking.passengers?.find((candidate) => candidate.passengerId === passengerId);
    return passenger ? `${passenger.firstName} ${passenger.lastName}` : passengerId;
  };

  const startEdit = (passengerId: string) => {
    const current = items?.find((item) => item.passengerId === passengerId);
    setForm(current ? { type: current.type, needsCompanion: current.needsCompanion, notes: current.notes ?? '' } : EMPTY_ASSISTANCE);
    setEditing(passengerId);
    setMessage(undefined);
    setError(null);
  };

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setMessage(undefined);
    try {
      await action();
      await load();
      setEditing(undefined);
      setMessage(done);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  if (!items) return error ? <ProblemAlert error={error} /> : <p className="muted">Cargando asistencia…</p>;

  return (
    <div className="panel-form">
      <p className="muted">Pide silla de ruedas u otra ayuda para cualquier pasajero, sin costo. El personal del aeropuerto la verá en la lista del vuelo.</p>
      <ul className="assistance-list">
        {(booking.passengers ?? []).map((passenger) => {
          const current = items.find((item) => item.passengerId === passenger.passengerId);
          return (
            <li key={passenger.passengerId} className="assistance-item">
              <div>
                <strong>{name(passenger.passengerId)}</strong>
                {current ? (
                  <p className="small">
                    {ASSISTANCE_LABELS[current.type] ?? current.type}
                    {current.needsCompanion ? ' · con acompañante' : ''} · <span className="muted">{STATUS_LABELS[current.status] ?? current.status}</span>
                    {current.notes ? <span className="muted"> · {current.notes}</span> : null}
                  </p>
                ) : (
                  <p className="small muted">Sin asistencia</p>
                )}
              </div>
              <div className="row-actions">
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => startEdit(passenger.passengerId)}>
                  {current ? 'Cambiar' : 'Pedir asistencia'}
                </button>
                {current && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void run(() => deletePassengerAssistance(token ?? '', booking.bookingId, passenger.passengerId), `Se quitó la asistencia de ${name(passenger.passengerId)}.`)}
                  >
                    Quitar
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {editing && (
        <div className="card">
          <h3>Asistencia de {name(editing)}</h3>
          <AssistanceFields value={form} onChange={setForm} disabled={busy} />
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void run(() => savePassengerAssistance(token ?? '', booking.bookingId, editing, cleanAssistance(form)), `Asistencia guardada para ${name(editing)}.`)}
            >
              {busy ? 'Guardando…' : 'Guardar asistencia'}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEditing(undefined)}>Cerrar</button>
          </div>
        </div>
      )}
      {message && <p className="alert alert-success" role="status">{message}</p>}
      {error ? <ProblemAlert error={error} /> : null}
    </div>
  );
}
