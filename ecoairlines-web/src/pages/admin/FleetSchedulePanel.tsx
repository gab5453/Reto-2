import { useEffect, useState } from 'react';
import { getFleetSchedule, type FleetLeg, type FleetSchedule } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { ProblemAlert } from '../../components/ProblemAlert';
import { cityOf } from '../../data/airports';
import { lastSaleDate, localDate, localTime, todayIso } from '../../lib/format';
import { AirportOptions } from '../../components/AirportOptions';

type Direction = 'ARRIVALS' | 'DEPARTURES' | 'BOTH';
const DIRECTIONS: [Direction, string][] = [
  ['ARRIVALS', 'Llegadas (destino)'],
  ['DEPARTURES', 'Salidas (origen)'],
  ['BOTH', 'Llegadas y salidas'],
];

interface BoardRow {
  kind: 'Llegada' | 'Salida';
  /** Hora local del aeropuerto filtrado (ISO con desfase). */
  at: string;
  flight: FleetLeg;
  registration: string;
  aircraftType: string;
}

/**
 * Horario de la flota (extensión `GET /admin/fleet-schedule`): qué vuelos opera cada avión en una fecha. El plan de
 * flota del GDS encadena los vuelos de cada avión (sale de donde aterrizó, después de su tiempo en tierra), así que
 * ningún avión aparece en dos vuelos a la vez. El horario se publica para las próximas 13 semanas.
 *
 * Con el filtro por aeropuerto, el administrador ve un punto en concreto: sus llegadas (vuelos con ese destino), sus
 * salidas o ambas, en orden de hora, y solo los aviones que pasan por ahí.
 */
export function FleetSchedulePanel() {
  const { token } = useAuth();
  const [date, setDate] = useState(todayIso());
  const [airport, setAirport] = useState('');
  const [direction, setDirection] = useState<Direction>('ARRIVALS');
  const [filter, setFilter] = useState('');
  const [loaded, setLoaded] = useState<{ date: string; schedule?: FleetSchedule; error?: unknown }>({ date: '' });

  useEffect(() => {
    if (!token) return;
    let active = true;
    getFleetSchedule(token, date)
      .then((schedule) => active && setLoaded({ date, schedule }))
      .catch((error: unknown) => active && setLoaded({ date, error }));
    return () => {
      active = false;
    };
  }, [token, date]);

  const current = loaded.date === date ? loaded : undefined;
  const schedule = current?.schedule;

  /** ¿El vuelo toca el aeropuerto filtrado en el sentido elegido? */
  const touches = (flight: FleetLeg) =>
    !airport ||
    (direction !== 'DEPARTURES' && flight.destination === airport) ||
    (direction !== 'ARRIVALS' && flight.origin === airport);

  const query = filter.trim().toUpperCase();
  const aircraft = (schedule?.aircraft ?? [])
    .map((plane) => ({ ...plane, flights: plane.flights.filter(touches) }))
    .filter((plane) => !airport || plane.flights.length > 0)
    .filter(
      (plane) =>
        !query ||
        plane.registration.includes(query) ||
        plane.aircraftType.toUpperCase().includes(query) ||
        plane.flights.some((flight) => `${flight.flightNumber} ${flight.origin} ${flight.destination}`.includes(query)),
    );

  const board: BoardRow[] = airport
    ? aircraft
        .flatMap((plane) =>
          plane.flights.flatMap((flight): BoardRow[] => [
            ...(flight.destination === airport && direction !== 'DEPARTURES'
              ? [{ kind: 'Llegada' as const, at: flight.arrival, flight, registration: plane.registration, aircraftType: plane.aircraftType }]
              : []),
            ...(flight.origin === airport && direction !== 'ARRIVALS'
              ? [{ kind: 'Salida' as const, at: flight.departure, flight, registration: plane.registration, aircraftType: plane.aircraftType }]
              : []),
          ]),
        )
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    : [];

  const allFlights = schedule?.aircraft.flatMap((plane) => plane.flights) ?? [];
  const byType = (schedule?.aircraft ?? []).reduce<Record<string, number>>((acc, plane) => {
    acc[plane.aircraftType] = (acc[plane.aircraftType] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <section className="card" aria-labelledby="fleet-title">
      <h2 id="fleet-title">Horario de la flota</h2>
      <p className="muted small">
        Vuelos que opera cada avión en el día elegido (horas locales de cada aeropuerto). Cada avión tiene un horario semanal fijo: el mismo día de la semana hace siempre los mismos vuelos, y vuelve a su base al cerrar la semana;
        hay vuelos publicados hasta el {schedule ? localDate(schedule.salesWindow.to) : '…'} ({schedule?.salesWindow.days ?? 91} días).
      </p>
      <div className="search-row">
        <label className="field">
          Fecha
          <input type="date" value={date} min={todayIso()} max={lastSaleDate()} onChange={(event) => event.target.value && setDate(event.target.value)} />
        </label>
        <label className="field">
          Aeropuerto
          <select value={airport} onChange={(event) => setAirport(event.target.value)}>
            <option value="">Todos</option>
            <AirportOptions />
          </select>
        </label>
        <label className="field">
          Ver
          <select value={direction} disabled={!airport} onChange={(event) => setDirection(event.target.value as Direction)}>
            {DIRECTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Buscar avión o vuelo
          <input value={filter} placeholder="HC-J01, EA104…" onChange={(event) => setFilter(event.target.value)} />
        </label>
      </div>

      {current?.error ? <ProblemAlert error={current.error} /> : null}
      {!current && <p className="muted">Cargando horario…</p>}

      {schedule && (
        <>
          {airport ? (
            <div className="stats-grid" aria-label={`Resumen de ${cityOf(airport)}`}>
              <div className="stat-card"><p className="muted small">Llegadas a {airport}</p><p className="stat-value">{allFlights.filter((flight) => flight.destination === airport).length}</p></div>
              <div className="stat-card"><p className="muted small">Salidas de {airport}</p><p className="stat-value">{allFlights.filter((flight) => flight.origin === airport).length}</p></div>
              <div className="stat-card"><p className="muted small">Aviones que pasan</p><p className="stat-value">{schedule.aircraft.filter((plane) => plane.flights.some((flight) => flight.origin === airport || flight.destination === airport)).length}</p></div>
            </div>
          ) : (
            <div className="stats-grid" aria-label="Resumen de la flota">
              <div className="stat-card"><p className="muted small">Vuelos del día</p><p className="stat-value">{schedule.totalFlights}</p></div>
              <div className="stat-card"><p className="muted small">Aviones</p><p className="stat-value">{schedule.aircraft.length}</p></div>
              {Object.entries(byType).map(([type, count]) => (
                <div className="stat-card" key={type}><p className="muted small">{type}</p><p className="stat-value">{count}</p></div>
              ))}
            </div>
          )}

          {airport && (
            <div className="table-wrap">
              <table>
                <caption>
                  {DIRECTIONS.find(([value]) => value === direction)![1]} · {cityOf(airport)} ({airport}) · {localDate(schedule.date)} · {board.length} vuelos
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Hora local</th>
                    <th scope="col">Movimiento</th>
                    <th scope="col">Vuelo</th>
                    <th scope="col">Desde / hacia</th>
                    <th scope="col">Avión</th>
                  </tr>
                </thead>
                <tbody>
                  {board.length === 0 ? (
                    <tr><td colSpan={5} className="muted">Sin vuelos para este filtro.</td></tr>
                  ) : (
                    board.map((row) => (
                      <tr key={`${row.kind}-${row.flight.segmentId}`}>
                        <td><strong>{localTime(row.at)}</strong>{row.at.slice(0, 10) !== schedule.date && <span className="muted small"> ({localDate(row.at)})</span>}</td>
                        <td>{row.kind}</td>
                        <td>{row.flight.flightNumber}</td>
                        <td>
                          {row.kind === 'Llegada'
                            ? `desde ${cityOf(row.flight.origin)} (${row.flight.origin}), salió ${localTime(row.flight.departure)}`
                            : `hacia ${cityOf(row.flight.destination)} (${row.flight.destination}), llega ${localTime(row.flight.arrival)}`}
                        </td>
                        <td>{row.registration} <span className="muted small">· {row.aircraftType}</span></td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          <div className="table-wrap">
            <table>
              <caption>
                {aircraft.length} de {schedule.aircraft.length} aviones · {localDate(schedule.date)}
                {airport && ` · solo vuelos que ${direction === 'ARRIVALS' ? 'llegan a' : direction === 'DEPARTURES' ? 'salen de' : 'pasan por'} ${airport}`}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Avión</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Vuelos del día (salida → llegada)</th>
                </tr>
              </thead>
              <tbody>
                {aircraft.map((plane) => (
                  <tr key={plane.registration}>
                    <td><strong>{plane.registration}</strong><span className="muted small"> · base {plane.base}</span></td>
                    <td className="small">{plane.aircraftType}</td>
                    <td>
                      {plane.flights.length === 0 ? (
                        <span className="muted small">Sin vuelos este día (en tránsito o en tierra)</span>
                      ) : (
                        <ol className="fleet-legs">
                          {plane.flights.map((flight) => (
                            <li key={flight.segmentId} title={`${flight.departure} → ${flight.arrival}`}>
                              <strong>{flight.flightNumber}</strong> {flight.origin} {localTime(flight.departure)} → {flight.destination}{' '}
                              {localTime(flight.arrival)}
                              {flight.arrival.slice(0, 10) !== flight.departure.slice(0, 10) && <span className="muted small"> (+1)</span>}
                            </li>
                          ))}
                        </ol>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
