import { useState, type FormEvent } from 'react';
import { getFlightAssistance, markAssistanceReady, type FlightAssistanceItem } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { ProblemAlert } from '../../components/ProblemAlert';
import { ASSISTANCE_LABELS, STATUS_LABELS, lastSaleDate, todayIso } from '../../lib/format';

/**
 * Pasajeros con asistencia de un vuelo y fecha (`flightAssistance`; dato de salud: solo con el scope de administrador) y
 * «Lista» (`markAssistanceReady`, saga que avisa a Check-in y a Bookings). No se guarda nada en el navegador.
 */
export function AdminAssistancePage() {
  const { token } = useAuth();
  const [flightNumber, setFlightNumber] = useState('');
  const [date, setDate] = useState(todayIso());
  const [items, setItems] = useState<FlightAssistanceItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = async () => {
    if (!token) return;
    setItems(await getFlightAssistance(token, flightNumber.trim().toUpperCase(), date));
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const search = (event: FormEvent) => {
    event.preventDefault();
    setItems(null);
    void run(load);
  };

  const mark = (item: FlightAssistanceItem) => {
    if (!token) return;
    const ready = item.assistance.status !== 'READY';
    void run(async () => {
      await markAssistanceReady(token, item.bookingId, { passengerId: item.passengerId, segmentId: item.segmentId, ready });
      await load();
    });
  };

  return (
    <div className="container section admin">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Portal administrativo</p>
          <h1>Asistencia por vuelo</h1>
          <p className="muted small">Datos de salud: úsalos solo para atender al pasajero.</p>
        </div>
      </header>

      <form className="filters" onSubmit={search}>
        <label className="inline-field">
          Vuelo
          <input value={flightNumber} required placeholder="EA100" maxLength={6} onChange={(event) => setFlightNumber(event.target.value)} />
        </label>
        <label className="inline-field">
          Fecha
          <input type="date" value={date} max={lastSaleDate()} onChange={(event) => setDate(event.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !flightNumber.trim()}>{busy && !items ? 'Buscando…' : 'Buscar'}</button>
      </form>

      {error ? <ProblemAlert error={error} /> : null}

      {items && (
        <section className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Pasajero</th>
                  <th scope="col">Reserva</th>
                  <th scope="col">Asiento</th>
                  <th scope="col">Asistencia</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acción</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr><td colSpan={6} className="muted">Nadie pidió asistencia en este vuelo.</td></tr>
                ) : (
                  items.map((item) => (
                    <tr key={`${item.bookingId}-${item.passengerId}-${item.segmentId}`}>
                      <td>{item.passengerName}</td>
                      <td>{item.pnr}</td>
                      <td>{item.seatNumber ?? '—'}</td>
                      <td className="small">
                        {ASSISTANCE_LABELS[item.assistance.type] ?? item.assistance.type}
                        {item.assistance.needsCompanion ? ' · con acompañante' : ''}
                        {item.assistance.notes ? <span className="muted"> · {item.assistance.notes}</span> : null}
                      </td>
                      <td>{STATUS_LABELS[item.assistance.status] ?? item.assistance.status}</td>
                      <td>
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => mark(item)}>
                          {item.assistance.status === 'READY' ? 'Quitar «Lista»' : 'Marcar lista'}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
