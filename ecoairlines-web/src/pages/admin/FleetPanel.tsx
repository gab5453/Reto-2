import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  listAircraft,
  listAircraftTypes,
  moveAircraft,
  registerAircraft,
  retireAircraft,
  type Aircraft,
  type AircraftTypeInfo,
  type AircraftTypeName,
} from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { ProblemAlert } from '../../components/ProblemAlert';
import { AirportOptions } from '../../components/AirportOptions';

const CABIN_LABELS: Record<string, string> = { ECONOMY: 'Economy', BUSINESS: 'Business' };

/**
 * CRUD de la **flota** (extensión `/admin/aircraft`). Los tipos de avión se muestran como referencia (no se editan: definen el
 * mapa de asientos). Los aviones se registran con tipo y base; la matrícula se asigna sola. Un avión libre se puede mover de
 * base o retirar; si opera rutas, primero hay que quitárselas. Para usarlo, se elige en el formulario de "Rutas programadas".
 */
export function FleetPanel() {
  const { token } = useAuth();
  const [types, setTypes] = useState<AircraftTypeInfo[]>([]);
  const [aircraft, setAircraft] = useState<Aircraft[] | null>(null);
  const [base, setBase] = useState('');
  const [type, setType] = useState('');
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [form, setForm] = useState<{ aircraftType: AircraftTypeName; base: string }>({ aircraftType: 'Airbus A320neo', base: 'UIO' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string>();

  const reload = useCallback(async () => {
    if (!token) return;
    const [nextTypes, nextAircraft] = await Promise.all([
      listAircraftTypes(token),
      listAircraft(token, { base: base || undefined, aircraftType: type || undefined }),
    ]);
    setTypes(nextTypes);
    setAircraft(nextAircraft);
  }, [token, base, type]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    Promise.all([listAircraftTypes(token), listAircraft(token, { base: base || undefined, aircraftType: type || undefined })])
      .then(([nextTypes, nextAircraft]) => {
        if (!active) return;
        setTypes(nextTypes);
        setAircraft(nextAircraft);
      })
      .catch((caught: unknown) => active && setError(caught));
    return () => {
      active = false;
    };
  }, [token, base, type]);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setMessage(undefined);
    try {
      setMessage(await action());
      await reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    void run(async () => {
      const plane = await registerAircraft(token, form);
      return `Avión registrado: ${plane.registration} (${plane.aircraftType}), base ${plane.base}. Ya puedes asignarlo en "Rutas programadas".`;
    });
  };

  const move = (plane: Aircraft, nextBase: string) =>
    token && void run(async () => {
      await moveAircraft(token, plane.registration, nextBase);
      return `${plane.registration} ahora tiene base en ${nextBase}.`;
    });

  const retire = (plane: Aircraft) => {
    if (!token || !window.confirm(`¿Retirar ${plane.registration} de la flota?`)) return;
    void run(async () => {
      await retireAircraft(token, plane.registration);
      return `${plane.registration} fue retirado de la flota.`;
    });
  };

  const visible = (aircraft ?? []).filter((plane) => !onlyAvailable || plane.status === 'AVAILABLE');
  const available = (aircraft ?? []).filter((plane) => plane.status === 'AVAILABLE').length;

  return (
    <div className="fleet-panel">
      <div className="stats-grid" aria-label="Tipos de avión">
        {types.map((info) => (
          <div className="stat-card" key={info.aircraftType}>
            <p className="muted small">{info.aircraftType} · {info.registrationPrefix}…</p>
            <p className="stat-value">{info.inFleet}</p>
            <p className="small">
              {info.totalSeats} asientos ({info.seats.map((cabin) => `${cabin.seats} ${CABIN_LABELS[cabin.cabinClass] ?? cabin.cabinClass}`).join(' + ')})
              <br />
              <span className="muted">
                {info.maxRouteKm ? `Rutas de hasta ${info.maxRouteKm.toLocaleString('es')} km` : 'Sin límite de distancia'} · {info.turnaroundMinutes} min en tierra
              </span>
            </p>
          </div>
        ))}
      </div>

      <form className="card route-form" onSubmit={submit} aria-label="Registrar avión">
        <h3>Registrar avión</h3>
        <div className="search-row">
          <label className="field">
            Tipo
            <select value={form.aircraftType} onChange={(event) => setForm({ ...form, aircraftType: event.target.value as AircraftTypeName })}>
              {types.map((info) => (
                <option key={info.aircraftType} value={info.aircraftType}>{info.aircraftType}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Base (donde empieza y termina su semana)
            <select value={form.base} onChange={(event) => setForm({ ...form, base: event.target.value })}>
              <AirportOptions />
            </select>
          </label>
          <div className="field field-end">
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Guardando…' : 'Registrar'}</button>
          </div>
        </div>
        <p className="muted small">La matrícula se asigna sola (la siguiente libre del tipo). El avión queda disponible hasta que lo asignes a una ruta.</p>
      </form>

      {message && <p className="alert alert-success" role="status">{message}</p>}
      {error ? <ProblemAlert error={error} /> : null}

      <div className="search-row">
        <label className="field">
          Base
          <select value={base} onChange={(event) => setBase(event.target.value)}>
            <option value="">Todas</option>
            <AirportOptions />
          </select>
        </label>
        <label className="field">
          Tipo
          <select value={type} onChange={(event) => setType(event.target.value)}>
            <option value="">Todos</option>
            {types.map((info) => (
              <option key={info.aircraftType} value={info.aircraftType}>{info.aircraftType}</option>
            ))}
          </select>
        </label>
        <label className="inline-check field-end">
          <input type="checkbox" checked={onlyAvailable} onChange={(event) => setOnlyAvailable(event.target.checked)} />
          Solo disponibles ({available})
        </label>
      </div>

      {!aircraft ? (
        <p className="muted">Cargando flota…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption>{visible.length} aviones</caption>
            <thead>
              <tr>
                <th scope="col">Matrícula</th>
                <th scope="col">Tipo</th>
                <th scope="col">Base</th>
                <th scope="col">Estado</th>
                <th scope="col">Rutas que opera</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((plane) => {
                const free = plane.status === 'AVAILABLE';
                return (
                  <tr key={plane.registration} className={plane.source === 'ADMIN' ? 'row-highlight' : undefined}>
                    <td><strong>{plane.registration}</strong>{plane.source === 'ADMIN' && <span className="muted small"> · nuevo</span>}</td>
                    <td className="small">{plane.aircraftType}<br /><span className="muted">{plane.totalSeats} asientos</span></td>
                    <td>
                      <select
                        aria-label={`Base de ${plane.registration}`}
                        value={plane.base}
                        disabled={!free || busy}
                        title={free ? undefined : 'Opera rutas: primero quítale sus rutas'}
                        onChange={(event) => move(plane, event.target.value)}
                      >
                        <AirportOptions short />
                      </select>
                    </td>
                    <td>{free ? 'Disponible' : 'En servicio'}</td>
                    <td className="small">{plane.routes.length ? plane.routes.join(', ') : '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={!free || busy}
                        title={free ? undefined : 'Opera rutas: primero quítale sus rutas'}
                        onClick={() => retire(plane)}
                      >
                        Retirar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
