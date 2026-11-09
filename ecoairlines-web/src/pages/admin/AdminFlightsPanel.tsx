import { useEffect, useState, type FormEvent } from 'react';
import { getFlightOperations, updateFlightStatus, type FlightOperation } from '../../api/admin';
import type { FlightOperationalStatus } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ProblemAlert } from '../../components/ProblemAlert';
import { cityOf } from '../../data/airports';
import { STATUS_LABELS, lastSaleDate, localDate, localTime, todayIso } from '../../lib/format';
import { AirportOptions } from '../../components/AirportOptions';

/** Transiciones válidas del contrato (MS.G.FlightStatus las vuelve a validar: `INVALID_STATUS_TRANSITION`). */
const TRANSITIONS: Record<FlightOperationalStatus, FlightOperationalStatus[]> = {
  SCHEDULED: ['DELAYED', 'BOARDING', 'CANCELLED'],
  DELAYED: ['DELAYED', 'BOARDING', 'CANCELLED'],
  BOARDING: ['DEPARTED', 'DELAYED', 'CANCELLED'],
  DEPARTED: ['ARRIVED', 'DIVERTED'],
  DIVERTED: ['ARRIVED'],
  ARRIVED: [],
  CANCELLED: [],
};
const EMPTY_CHANGE = { status: '' as FlightOperationalStatus | '', departureGate: '', estimatedDepartureAt: '', estimatedArrivalAt: '', reason: '' };
/**
 * Vuelos por página. El esquema admite 50, pero cada vuelo con sus cabinas y alertas suma ~29 de complejidad y el gateway
 * rechaza más de 1000 por consulta: con 30 queda en ~870. Un día tiene pocos cientos de vuelos.
 */
const PAGE = 30;
const MAX_PAGES = 20;

/** Asientos de un vuelo por estado (suma de sus cabinas). */
function seats(flight: FlightOperation) {
  return flight.cabins.reduce(
    (acc, cabin) => ({
      available: acc.available + cabin.seatsByStatus.available,
      held: acc.held + cabin.seatsByStatus.held,
      sold: acc.sold + cabin.seatsByStatus.booked + cabin.seatsByStatus.ticketed + cabin.seatsByStatus.checkedIn + cabin.seatsByStatus.boarded,
    }),
    { available: 0, held: 0, sold: 0 },
  );
}

/**
 * Vuelos del panel de administración (`flightOperations` del contrato v2, → MS.Vuelos): ocupación por **fecha** (hoy por
 * defecto), **aeropuerto de origen** o **ruta**, con los asientos por estado, los holds vigentes y las alertas de cada vuelo.
 * El estado operativo se cambia con `updateFlightStatus` (saga "Cambiar estado de vuelo"; al cancelar se reembolsan las reservas).
 */
export function AdminFlightsPanel() {
  const { token } = useAuth();
  const [date, setDate] = useState(todayIso());
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [filter, setFilter] = useState('');
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; flights?: FlightOperation[]; error?: unknown }>({ key: '' });
  const [updating, setUpdating] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [actionError, setActionError] = useState<unknown>(null);
  /** Vuelo abierto en el detalle (por clave: al recargar la lista se ven sus datos nuevos). */
  const [selectedKey, setSelectedKey] = useState<string>();
  const [change, setChange] = useState(EMPTY_CHANGE);

  const requestKey = `${date}|${origin}|${destination}|${reload}`;
  useEffect(() => {
    if (!token) return;
    let active = true;
    (async () => {
      const flights: FlightOperation[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await getFlightOperations(token, { date, origin: origin || undefined, destination: destination || undefined, limit: PAGE, cursor });
        flights.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return flights;
    })()
      .then((flights) => active && setLoaded({ key: requestKey, flights }))
      .catch((error: unknown) => active && setLoaded({ key: requestKey, error }));
    return () => {
      active = false;
    };
  }, [token, date, origin, destination, requestKey]);

  const current = loaded.key === requestKey ? loaded : undefined;
  const query = filter.trim().toUpperCase();
  const flights = (current?.flights ?? []).filter((flight) => !query || `${flight.flightNumber} ${flight.origin}-${flight.destination}`.includes(query));
  const totals = flights.reduce(
    (acc, flight) => {
      const byStatus = seats(flight);
      return { seats: acc.seats + flight.totalSeats, available: acc.available + byStatus.available, held: acc.held + byStatus.held, sold: acc.sold + byStatus.sold };
    },
    { seats: 0, available: 0, held: 0, sold: 0 },
  );

  const selected = flights.find((flight) => `${flight.flightNumber}|${flight.date}` === selectedKey);
  const nextStatuses = selected ? TRANSITIONS[selected.status] : [];

  const open = (flight: FlightOperation) => {
    setSelectedKey(`${flight.flightNumber}|${flight.date}`);
    setChange({ ...EMPTY_CHANGE, status: TRANSITIONS[flight.status][0] ?? '' });
    setNotice(undefined);
    setActionError(null);
  };

  const submitChange = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || !selected || !change.status) return;
    const previous = selected.status;
    const status = change.status;
    setUpdating(selectedKey);
    setNotice(undefined);
    setActionError(null);
    try {
      const result = await updateFlightStatus(token, selected.flightNumber, {
        date: selected.date,
        status,
        ...(change.departureGate.trim() ? { departureGate: change.departureGate.trim().toUpperCase() } : {}),
        ...(change.estimatedDepartureAt ? { estimatedDepartureAt: new Date(change.estimatedDepartureAt).toISOString() } : {}),
        ...(change.estimatedArrivalAt ? { estimatedArrivalAt: new Date(change.estimatedArrivalAt).toISOString() } : {}),
        ...(change.reason.trim() ? { reason: change.reason.trim() } : {}),
      });
      const affected = status === 'CANCELLED' ? ` Reservas canceladas con reembolso: ${result.affectedBookings}.` : '';
      setNotice(`${selected.flightNumber} del ${localDate(selected.date)}: ${STATUS_LABELS[previous] ?? previous} → ${STATUS_LABELS[status] ?? status}.${affected}`);
      setChange(EMPTY_CHANGE);
      setSelectedKey(undefined);
      setReload((value) => value + 1);
    } catch (caught) {
      setActionError(caught);
    } finally {
      setUpdating(undefined);
    }
  };

  const scope = destination
    ? `${origin ? `${cityOf(origin)} → ` : 'Hacia '}${cityOf(destination)}`
    : origin
      ? `Salidas de ${cityOf(origin)}`
      : 'Todos los vuelos';

  return (
    <>
      <div className="search-row">
        <label className="field">
          Fecha
          <input type="date" value={date} max={lastSaleDate()} onChange={(event) => event.target.value && setDate(event.target.value)} />
        </label>
        <label className="field">
          Origen
          <select value={origin} onChange={(event) => setOrigin(event.target.value)}>
            <option value="">Todos</option>
            <AirportOptions />
          </select>
        </label>
        <label className="field">
          Destino (ruta)
          <select value={destination} onChange={(event) => setDestination(event.target.value)}>
            <option value="">Todos</option>
            <AirportOptions exclude={origin} />
          </select>
        </label>
        <label className="field">
          Buscar vuelo
          <input value={filter} placeholder="EA104…" onChange={(event) => setFilter(event.target.value)} />
        </label>
        <button type="button" className="btn btn-ghost field-end" onClick={() => { setDate(todayIso()); setOrigin(''); setDestination(''); setFilter(''); }}>
          Hoy, todos
        </button>
      </div>

      {current?.error ? <ProblemAlert error={current.error} /> : null}
      {actionError ? <ProblemAlert error={actionError} /> : null}
      {notice && <p className="alert alert-success" role="status">{notice}</p>}
      {!current && <p className="muted">Cargando vuelos…</p>}

      {selected && (
        <section className="card" aria-labelledby="flight-detail-title">
          <div className="admin-head">
            <h2 id="flight-detail-title">{selected.flightNumber} · {selected.origin}-{selected.destination} · {localDate(selected.date)} · {localTime(selected.departureAt)}</h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedKey(undefined)}>Cerrar</button>
          </div>
          <div className="table-wrap">
            <table>
              <caption>Asientos por estado</caption>
              <thead>
                <tr>
                  <th scope="col">Cabina</th>
                  <th scope="col">Total</th>
                  <th scope="col">Libres</th>
                  <th scope="col">Retenidos</th>
                  <th scope="col">Reservados</th>
                  <th scope="col">Con boleto</th>
                  <th scope="col">Check-in</th>
                  <th scope="col">A bordo</th>
                </tr>
              </thead>
              <tbody>
                {selected.cabins.map(({ cabinClass, totalSeats, seatsByStatus }) => (
                  <tr key={cabinClass}>
                    <td>{cabinClass}</td>
                    <td>{totalSeats}</td>
                    <td>{seatsByStatus.available}</td>
                    <td>{seatsByStatus.held}</td>
                    <td>{seatsByStatus.booked}</td>
                    <td>{seatsByStatus.ticketed}</td>
                    <td>{seatsByStatus.checkedIn}</td>
                    <td>{seatsByStatus.boarded}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {nextStatuses.length === 0 ? (
            <p className="muted">El vuelo está {STATUS_LABELS[selected.status] ?? selected.status}: es un estado final y ya no cambia.</p>
          ) : (
            <form className="panel-form" onSubmit={submitChange}>
              <div className="grid-2">
                <label className="field">
                  Nuevo estado (ahora: {STATUS_LABELS[selected.status] ?? selected.status})
                  <select value={change.status} onChange={(event) => setChange({ ...change, status: event.target.value as FlightOperationalStatus })}>
                    {nextStatuses.map((status) => <option key={status} value={status}>{STATUS_LABELS[status] ?? status}</option>)}
                  </select>
                </label>
                <label className="field">
                  Puerta de salida (opcional)
                  <input value={change.departureGate} maxLength={8} placeholder="A12" onChange={(event) => setChange({ ...change, departureGate: event.target.value })} />
                </label>
                <label className="field">
                  Salida estimada{change.status === 'DELAYED' ? '' : ' (opcional)'}
                  <input type="datetime-local" required={change.status === 'DELAYED'} value={change.estimatedDepartureAt} onChange={(event) => setChange({ ...change, estimatedDepartureAt: event.target.value })} />
                </label>
                <label className="field">
                  Llegada estimada (opcional)
                  <input type="datetime-local" value={change.estimatedArrivalAt} onChange={(event) => setChange({ ...change, estimatedArrivalAt: event.target.value })} />
                </label>
                {change.status === 'CANCELLED' && (
                  <label className="field">
                    Motivo de la cancelación
                    <input value={change.reason} required maxLength={200} onChange={(event) => setChange({ ...change, reason: event.target.value })} />
                  </label>
                )}
              </div>
              {change.status === 'CANCELLED' && (
                <p className="alert alert-error" role="alert">
                  Cancelar es definitivo: se reembolsarán las reservas de los {seats(selected).sold} asientos vendidos y se liberarán {seats(selected).held} retenidos.
                </p>
              )}
              <button type="submit" className={`btn ${change.status === 'CANCELLED' ? 'btn-danger' : 'btn-primary'}`} disabled={updating === selectedKey}>
                {updating === selectedKey ? 'Aplicando…' : `Cambiar a ${STATUS_LABELS[change.status] ?? change.status}`}
              </button>
            </form>
          )}
        </section>
      )}

      {current?.flights && (
        <>
          <div className="stats-grid" aria-label="Resumen de la selección">
            <div className="stat-card"><p className="muted small">Vuelos</p><p className="stat-value">{flights.length}</p></div>
            <div className="stat-card"><p className="muted small">Vendidos</p><p className="stat-value">{totals.sold}</p></div>
            <div className="stat-card"><p className="muted small">Retenidos (holds)</p><p className="stat-value">{totals.held}</p></div>
            <div className="stat-card"><p className="muted small">Asientos libres</p><p className="stat-value">{totals.available}</p></div>
            <div className="stat-card"><p className="muted small">Ocupación</p><p className="stat-value">{totals.seats ? Math.round(((totals.seats - totals.available) / totals.seats) * 1000) / 10 : 0}%</p></div>
          </div>

          <div className="table-wrap">
            <table>
              <caption>{scope} · {localDate(date)}{date === todayIso() ? ' (hoy)' : ''}</caption>
              <thead>
                <tr>
                  <th scope="col">Vuelo</th>
                  <th scope="col">Ruta</th>
                  <th scope="col">Salida</th>
                  <th scope="col">Ocupación</th>
                  <th scope="col" title="Asientos retenidos por holds vigentes">Holds</th>
                  <th scope="col">Check-in</th>
                  <th scope="col">Alertas</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acción</th>
                </tr>
              </thead>
              <tbody>
                {flights.length === 0 ? (
                  <tr><td colSpan={9} className="muted">No hay vuelos para este filtro.</td></tr>
                ) : (
                  flights.map((flight) => {
                    const byStatus = seats(flight);
                    const key = `${flight.flightNumber}|${flight.date}`;
                    return (
                      <tr key={key} className={byStatus.sold + byStatus.held > 0 ? 'row-highlight' : undefined}>
                        <td><strong>{flight.flightNumber}</strong>{flight.aircraft && <span className="muted small"> · {flight.aircraft}</span>}</td>
                        <td>{flight.origin}-{flight.destination}</td>
                        <td>{localTime(flight.departureAt)}</td>
                        <td>
                          <div className="occupancy" title={`${byStatus.sold} vendidos y ${byStatus.held} retenidos de ${flight.totalSeats}`}>
                            <span className="occupancy-bar"><span style={{ width: `${Math.min(100, flight.loadFactor)}%` }} /></span>
                            <span className="small">{Math.round(flight.loadFactor * 10) / 10}% · {byStatus.available} libres de {flight.totalSeats}</span>
                          </div>
                        </td>
                        <td>{flight.activeHolds}</td>
                        <td>{flight.checkInOpen ? 'Abierto' : 'Cerrado'}</td>
                        <td className="small">{flight.alerts.length ? flight.alerts.map((alert) => alert.message).join(' · ') : '—'}</td>
                        <td>{STATUS_LABELS[flight.status] ?? flight.status}</td>
                        <td><button type="button" className="btn btn-ghost btn-sm" onClick={() => open(flight)}>Gestionar</button></td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
