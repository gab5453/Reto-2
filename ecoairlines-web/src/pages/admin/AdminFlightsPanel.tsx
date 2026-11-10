import { useEffect, useState, type FormEvent } from 'react';
import { getFlightDelayImpact, getFlightOperations, updateFlightStatus, type FlightDelayImpact, type FlightOperation } from '../../api/admin';
import { getFlightStatus } from '../../api/operations';
import type { FlightOperationalStatus, FlightStatus } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ProblemAlert } from '../../components/ProblemAlert';
import { cityOf } from '../../data/airports';
import { STATUS_LABELS, lastSaleDate, localDate, localTime, todayIso } from '../../lib/format';
import { AirportOptions } from '../../components/AirportOptions';

/** Transiciones válidas del contrato (MS.G.FlightStatus las vuelve a validar: `INVALID_STATUS_TRANSITION`). */
const TRANSITIONS: Record<FlightOperationalStatus, FlightOperationalStatus[]> = {
  SCHEDULED: ['DELAYED', 'BOARDING', 'CANCELLED'],
  // DELAYED → SCHEDULED: quitar el retraso (R-1).
  DELAYED: ['DELAYED', 'SCHEDULED', 'BOARDING', 'CANCELLED'],
  BOARDING: ['DEPARTED', 'DELAYED', 'CANCELLED'],
  DEPARTED: ['ARRIVED', 'DIVERTED'],
  DIVERTED: ['ARRIVED'],
  ARRIVED: [],
  CANCELLED: [],
};
/** Minutos sugeridos para un retraso (R-1, D-T9); también se puede escribir otro. */
const DELAY_PRESETS = [15, 30, 45, 60, 90, 120];
const EMPTY_CHANGE = { status: '' as FlightOperationalStatus | '', departureGate: '', delayMinutes: '30', alsoNext: false, reason: '' };
const statusOption = (from: FlightOperationalStatus, to: FlightOperationalStatus) =>
  from === 'DELAYED' && to === 'SCHEDULED' ? 'A tiempo (quitar el retraso)' : from === 'DELAYED' && to === 'DELAYED' ? 'Cambiar el retraso' : (STATUS_LABELS[to] ?? to);
const hhmm = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`);
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

  // Estado vigente del vuelo abierto (hora estimada si está retrasado).
  const [live, setLive] = useState<{ key: string; status?: FlightStatus }>({ key: '' });
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const key = `${selected.flightNumber}|${selected.date}|${reload}`;
    getFlightStatus(selected.flightNumber, selected.date).then(
      (status) => active && setLive({ key, status }),
      () => active && setLive({ key }),
    );
    return () => {
      active = false;
    };
  }, [selected?.flightNumber, selected?.date, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveStatus = selected && live.key === `${selected.flightNumber}|${selected.date}|${reload}` ? live.status : undefined;

  // Vista previa del retraso (R-1): qué pasa con el avión y con los pasajeros. Solo consulta; no cambia nada.
  const minutes = Number(change.delayMinutes);
  const validMinutes = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
  const impactKey = selected && change.status === 'DELAYED' && validMinutes ? `${selected.flightNumber}|${selected.date}|${minutes}` : '';
  const [impactResult, setImpactResult] = useState<{ key: string; impact?: FlightDelayImpact; error?: unknown }>({ key: '' });
  useEffect(() => {
    if (!token || !impactKey || !selected) return;
    let active = true;
    getFlightDelayImpact(token, selected.flightNumber, selected.date, minutes).then(
      (impact) => active && setImpactResult({ key: impactKey, impact }),
      (error: unknown) => active && setImpactResult({ key: impactKey, error }),
    );
    return () => {
      active = false;
    };
  }, [token, impactKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const impact = impactKey && impactResult.key === impactKey ? impactResult : undefined;

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
    const delay = status === 'DELAYED' ? impact?.impact : undefined;
    if (status === 'DELAYED' && !delay) return;
    setUpdating(selectedKey);
    setNotice(undefined);
    setActionError(null);
    try {
      // Un retraso se indica en minutos: la salida estimada es la programada + minutos; la llegada la corre FlightStatus.
      const result = await updateFlightStatus(token, selected.flightNumber, {
        date: selected.date,
        status,
        ...(change.departureGate.trim() ? { departureGate: change.departureGate.trim().toUpperCase() } : {}),
        ...(delay ? { estimatedDepartureAt: delay.estimatedDepartureAt } : {}),
        ...(change.reason.trim() ? { reason: change.reason.trim() } : {}),
      });
      const affected = status === 'CANCELLED' ? ` Reservas canceladas con reembolso: ${result.affectedBookings}.` : '';
      const what = status === 'DELAYED' && delay ? `Retrasado ${hhmm(delay.delayMinutes)}: sale ${localTime(delay.estimatedDepartureAt)} y llega ${localTime(delay.estimatedArrivalAt)}` : previous === 'DELAYED' && status === 'SCHEDULED' ? 'Se quitó el retraso: vuelve a su hora programada' : `${STATUS_LABELS[previous] ?? previous} → ${STATUS_LABELS[status] ?? status}`;
      let also = '';
      // «Retrasar también» el siguiente vuelo del avión: acción opcional y explícita (D-T10), nunca en cadena automática.
      const next = delay?.nextFlight;
      if (change.alsoNext && next?.conflict && next.suggestedDelayMinutes) {
        await updateFlightStatus(token, next.flightNumber, {
          date: next.date,
          status: 'DELAYED',
          estimatedDepartureAt: new Date(Date.parse(next.scheduledDepartureAt) + next.suggestedDelayMinutes * 60_000).toISOString(),
          reason: `Retraso del vuelo anterior del mismo avión (${selected.flightNumber})`,
        });
        also = ` También se retrasó ${next.flightNumber} ${hhmm(next.suggestedDelayMinutes)}.`;
      }
      setNotice(`${selected.flightNumber} del ${localDate(selected.date)}: ${what}.${affected}${also}`);
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

          {liveStatus?.status === 'DELAYED' && liveStatus.departure?.estimatedAt && (
            <p className="alert alert-info" role="status">
              <strong>Retrasado {hhmm(liveStatus.delayMinutes ?? 0)}:</strong> sale {localTime(liveStatus.departure.estimatedAt)} (era {localTime(liveStatus.departure.scheduledAt)})
              {liveStatus.arrival?.estimatedAt ? ` y llega ${localTime(liveStatus.arrival.estimatedAt)}` : ''}.
            </p>
          )}
          {nextStatuses.length === 0 ? (
            <p className="muted">El vuelo está {STATUS_LABELS[selected.status] ?? selected.status}: es un estado final y ya no cambia.</p>
          ) : (
            <form className="panel-form" onSubmit={submitChange}>
              <div className="grid-2">
                <label className="field">
                  Nuevo estado (ahora: {STATUS_LABELS[selected.status] ?? selected.status})
                  <select value={change.status} onChange={(event) => setChange({ ...change, status: event.target.value as FlightOperationalStatus, alsoNext: false })}>
                    {nextStatuses.map((status) => <option key={status} value={status}>{statusOption(selected.status, status)}</option>)}
                  </select>
                </label>
                <label className="field">
                  Puerta de salida (opcional)
                  <input value={change.departureGate} maxLength={8} placeholder="A12" onChange={(event) => setChange({ ...change, departureGate: event.target.value })} />
                </label>
                {change.status === 'DELAYED' && (
                  <label className="field">
                    Minutos de retraso (desde la hora programada)
                    <input type="number" min={1} max={1440} step={1} required list="delay-presets" value={change.delayMinutes} onChange={(event) => setChange({ ...change, delayMinutes: event.target.value, alsoNext: false })} />
                    <datalist id="delay-presets">{DELAY_PRESETS.map((value) => <option key={value} value={value} />)}</datalist>
                  </label>
                )}
                {(change.status === 'CANCELLED' || change.status === 'DELAYED' || change.status === 'SCHEDULED') && (
                  <label className="field">
                    {change.status === 'CANCELLED' ? 'Motivo de la cancelación' : 'Motivo (opcional)'}
                    <input value={change.reason} required={change.status === 'CANCELLED'} maxLength={200} onChange={(event) => setChange({ ...change, reason: event.target.value })} />
                  </label>
                )}
              </div>
              {change.status === 'DELAYED' && (
                <div className="delay-preview" aria-live="polite">
                  <div className="chips" role="group" aria-label="Minutos sugeridos">
                    {DELAY_PRESETS.map((value) => (
                      <button key={value} type="button" className={`chip ${minutes === value ? 'is-active' : ''}`} onClick={() => setChange({ ...change, delayMinutes: String(value), alsoNext: false })}>
                        {hhmm(value)}
                      </button>
                    ))}
                  </div>
                  {!validMinutes ? (
                    <p className="form-error small">Indica entre 1 y 1440 minutos.</p>
                  ) : !impact ? (
                    <p className="muted small">Calculando el impacto…</p>
                  ) : impact.error ? (
                    <ProblemAlert error={impact.error} />
                  ) : impact.impact ? (
                    <DelayPreview impact={impact.impact} alsoNext={change.alsoNext} onAlsoNext={(alsoNext) => setChange({ ...change, alsoNext })} />
                  ) : null}
                </div>
              )}
              {change.status === 'SCHEDULED' && selected.status === 'DELAYED' && (
                <p className="alert alert-info" role="status">El vuelo vuelve a su hora programada ({localTime(selected.departureAt)}). Los vuelos que se hayan retrasado por este no cambian.</p>
              )}
              {change.status === 'CANCELLED' && (
                <p className="alert alert-error" role="alert">
                  Cancelar es definitivo: se reembolsarán las reservas de los {seats(selected).sold} asientos vendidos y se liberarán {seats(selected).held} retenidos.
                </p>
              )}
              <button type="submit" className={`btn ${change.status === 'CANCELLED' ? 'btn-danger' : 'btn-primary'}`} disabled={updating === selectedKey || (change.status === 'DELAYED' && !impact?.impact)}>
                {updating === selectedKey
                  ? 'Aplicando…'
                  : change.status === 'DELAYED'
                    ? `Retrasar ${validMinutes ? hhmm(minutes) : ''}`
                    : change.status === 'SCHEDULED' && selected.status === 'DELAYED'
                      ? 'Quitar el retraso'
                      : `Cambiar a ${STATUS_LABELS[change.status] ?? change.status}`}
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

/** Vista previa del retraso: horas nuevas, el siguiente vuelo del avión (con «retrasar también» opcional) y los pasajeros. */
function DelayPreview({ impact, alsoNext, onAlsoNext }: { impact: FlightDelayImpact; alsoNext: boolean; onAlsoNext: (value: boolean) => void }) {
  const next = impact.nextFlight;
  // La hora con su día cuando no es el del vuelo (p. ej. llega el jueves o el siguiente vuelo del avión sale el viernes).
  const at = (iso: string) => (iso.slice(0, 10) === impact.date ? localTime(iso) : `${localDate(iso.slice(0, 10))} ${localTime(iso)}`);
  return (
    <div className="delay-impact">
      <p>
        <strong>Nueva salida {at(impact.estimatedDepartureAt)}</strong> (era {at(impact.scheduledDepartureAt)}) · nueva llegada{' '}
        {at(impact.estimatedArrivalAt)} (era {at(impact.scheduledArrivalAt)}).
      </p>
      {!next ? (
        <p className="muted small">El avión {impact.aircraft.registration} no tiene otro vuelo después de este.</p>
      ) : next.conflict ? (
        <div className="alert alert-warning" role="alert">
          <p>
            <strong>{impact.aircraft.registration} no llega a tiempo para {next.flightNumber}</strong> ({next.origin} → {next.destination}, sale {at(next.departureAt)}): con{' '}
            {impact.aircraft.turnaroundMinutes} min en tierra ({impact.aircraft.aircraftType}) estaría listo a las {at(next.readyAt)}.
          </p>
          {next.suggestedDelayMinutes ? (
            <label className="inline-field">
              <input type="checkbox" checked={alsoNext} onChange={(event) => onAlsoNext(event.target.checked)} />
              Retrasar también {next.flightNumber} {hhmm(next.suggestedDelayMinutes)} (opcional)
            </label>
          ) : null}
        </div>
      ) : (
        <p className="small">
          ✔ {impact.aircraft.registration} llega a tiempo a su siguiente vuelo {next.flightNumber} (sale {at(next.departureAt)}; estaría listo a las {at(next.readyAt)}).
        </p>
      )}
      <p className="small">
        Afecta a {impact.bookings} reserva(s), {impact.passengers} pasajero(s).
        {impact.tightConnections.length === 0 ? ' Ninguno queda con poco margen para su siguiente vuelo.' : ''}
      </p>
      {impact.tightConnections.length > 0 && (
        <ul className="small">
          {impact.tightConnections.map((item) => (
            <li key={item.bookingId}>
              <strong>{item.pnr}</strong> ({item.channel === 'BOOKING' ? 'Booking' : 'Web'}): {item.kind === 'CONNECTION' ? 'conexión' : 'vuelta'} {item.nextFlightNumber} a las{' '}
              {at(item.nextDepartureAt)} — le quedarían {item.availableMinutes} min (necesita {item.requiredMinutes}).
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
