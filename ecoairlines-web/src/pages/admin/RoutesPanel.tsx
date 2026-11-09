import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  createRoute,
  deleteRoute,
  listAircraft,
  listRoutes,
  updateRoute,
  type Aircraft,
  type AircraftTypeName,
  type ScheduledRoute,
  type ScheduledRouteRequest,
  type WeekdayCode,
} from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { ProblemAlert } from '../../components/ProblemAlert';
import { distanceKm } from '../../lib/co2';
import { AirportOptions } from '../../components/AirportOptions';

const WEEKDAYS: [WeekdayCode, string][] = [
  ['MON', 'Lun'],
  ['TUE', 'Mar'],
  ['WED', 'Mié'],
  ['THU', 'Jue'],
  ['FRI', 'Vie'],
  ['SAT', 'Sáb'],
  ['SUN', 'Dom'],
];
const AIRCRAFT: AircraftTypeName[] = ['Airbus A220-300', 'Airbus A320neo', 'Boeing 787-9'];

/** Tipo que la API asigna por distancia (mismos límites que `GET /admin/aircraft-types`: 1 500 y 4 500 km). */
function autoType(origin: string, destination: string): AircraftTypeName {
  const distance = distanceKm(origin, destination);
  if (distance < 1_500) return 'Airbus A220-300';
  if (distance < 4_500) return 'Airbus A320neo';
  return 'Boeing 787-9';
}

const EMPTY_FORM: ScheduledRouteRequest = {
  origin: 'UIO',
  destination: 'CUE',
  outboundDepartureLocal: '07:00',
  inboundDepartureLocal: '12:00',
  weekdays: ['MON', 'WED', 'FRI'],
};

type Editing = { mode: 'CREATE' } | { mode: 'EDIT'; routeId: string };

const daysLabel = (weekdays: WeekdayCode[]) =>
  weekdays.length === 7 ? 'Todos los días' : WEEKDAYS.filter(([code]) => weekdays.includes(code)).map(([, label]) => label).join(' · ');

const plusDays = (offset: number) => (offset > 0 ? ` (+${offset})` : '');

/** «24 h 35 min», «1 h 10 min», «40 min». */
const groundTime = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${rest} min`;
};

/**
 * Cuándo vuelve el avión (PLAN_Correccion C-3). Si la vuelta no cabe el mismo día, el horario la pasa a un día después: hay
 * que decirlo, porque «ida 19:00 → 12:25 (+1) · vuelta 13:00» se lee como 35 minutos en tierra.
 */
function returnSummary(route: ScheduledRoute): string | null {
  if (route.groundMinutes == null) return null;
  const delay = route.returnDelayDays ?? 0;
  const minimum = route.turnaroundMinutes ? ` (mínimo ${route.turnaroundMinutes} min para el ${route.aircraftType})` : '';
  const when = delay > 0 ? `La vuelta sale ${delay} día${delay > 1 ? 's' : ''} después de la ida (${daysLabel(route.inbound.weekdays ?? [])}): ` : 'La vuelta sale el mismo día: ';
  return `${when}el avión queda ${groundTime(route.groundMinutes)} en tierra en ${route.destination}${minimum}.`;
}

/**
 * CRUD de **rutas programadas** (extensión `/admin/routes`). Una ruta es una línea de ida y vuelta con sus días y su tipo
 * de avión; al guardarla, el horario se publica en el GDS y los vuelos quedan a la venta (o dejan de estarlo) al instante.
 * Las rutas con pasajeros no se pueden editar ni dar de baja: para esos vuelos está el estado operativo.
 */
export function RoutesPanel({ onChanged }: { onChanged?: () => void }) {
  const { token } = useAuth();
  const [airport, setAirport] = useState('');
  const [routes, setRoutes] = useState<ScheduledRoute[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [form, setForm] = useState<ScheduledRouteRequest>(EMPTY_FORM);
  /** Aviones con base en el origen elegido, para asignarlos a la ruta. */
  const [fleet, setFleet] = useState<Aircraft[]>([]);
  /** Aviones que ya tenía la ruta en edición. */
  const [currentAircraft, setCurrentAircraft] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string>();

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setRoutes(await listRoutes(token, airport || undefined));
    } catch (caught) {
      setError(caught);
    }
  }, [token, airport]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    listRoutes(token, airport || undefined)
      .then((data) => active && setRoutes(data))
      .catch((caught: unknown) => active && setError(caught));
    return () => {
      active = false;
    };
  }, [token, airport]);

  useEffect(() => {
    if (!token || !editing) return;
    let active = true;
    listAircraft(token, { base: form.origin })
      .then((data) => active && setFleet(data))
      .catch(() => active && setFleet([]));
    return () => {
      active = false;
    };
  }, [token, editing, form.origin]);

  const startCreate = () => {
    setEditing({ mode: 'CREATE' });
    setForm(EMPTY_FORM);
    setCurrentAircraft([]);
    setError(null);
    setMessage(undefined);
  };

  const startEdit = (route: ScheduledRoute) => {
    setEditing({ mode: 'EDIT', routeId: route.routeId });
    setForm({
      origin: route.origin,
      destination: route.destination,
      outboundDepartureLocal: route.outbound.departureLocal,
      inboundDepartureLocal: route.inbound.departureLocal,
      weekdays: route.weekdays,
      aircraftType: route.aircraftType,
    });
    setCurrentAircraft(route.aircraft);
    setError(null);
    setMessage(undefined);
  };

  /** Al cambiar origen, destino o tipo, la selección de aviones deja de valer: vuelve a "automático". */
  const changeRoute = (patch: Partial<ScheduledRouteRequest>) => setForm((current) => ({ ...current, ...patch, aircraft: undefined }));

  const toggleAircraft = (registration: string) =>
    setForm((current) => {
      const chosen = current.aircraft ?? [];
      const next = chosen.includes(registration) ? chosen.filter((item) => item !== registration) : [...chosen, registration];
      return { ...current, aircraft: next.length ? next : undefined };
    });

  const effectiveType = form.aircraftType ?? autoType(form.origin, form.destination);
  const candidates = fleet.filter((plane) => plane.aircraftType === effectiveType && plane.base === form.origin);

  const toggleDay = (code: WeekdayCode) =>
    setForm((current) => ({
      ...current,
      weekdays: current.weekdays.includes(code) ? current.weekdays.filter((day) => day !== code) : [...current.weekdays, code],
    }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || !editing) return;
    setBusy(true);
    setError(null);
    try {
      const saved = editing.mode === 'CREATE' ? await createRoute(token, form) : await updateRoute(token, editing.routeId, form);
      setMessage(
        `${editing.mode === 'CREATE' ? 'Ruta creada' : 'Ruta actualizada'}: ${saved.outbound.flightNumber} ${saved.origin} → ${saved.destination} y ` +
          `${saved.inbound.flightNumber} de vuelta, con ${saved.aircraft.join(', ')}. Ya está publicada para la venta.` +
          (returnSummary(saved) ? ` ${returnSummary(saved)}` : ''),
      );
      setEditing(null);
      await load();
      onChanged?.();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (route: ScheduledRoute) => {
    if (!token) return;
    if (!window.confirm(`¿Dar de baja la ruta ${route.routeId} (${route.origin} ⇄ ${route.destination})? Sus vuelos dejarán de venderse.`)) return;
    setError(null);
    try {
      await deleteRoute(token, route.routeId);
      setMessage(`Ruta ${route.routeId} dada de baja. Sus aviones quedan libres.`);
      if (editing?.mode === 'EDIT' && editing.routeId === route.routeId) setEditing(null);
      await load();
      onChanged?.();
    } catch (caught) {
      setError(caught);
    }
  };

  const adminRoutes = routes?.filter((route) => route.source === 'ADMIN').length ?? 0;
  /** Primero las creadas por administradores (la más reciente arriba), después la red base en su orden. */
  const sorted = [...(routes ?? [])].sort(
    (a, b) => Number(b.source === 'ADMIN') - Number(a.source === 'ADMIN') || (a.source === 'ADMIN' ? b.createdAt.localeCompare(a.createdAt) : 0),
  );

  return (
    <div className="routes-panel">
      <div className="search-row">
        <label className="field">
          Aeropuerto
          <select value={airport} onChange={(event) => setAirport(event.target.value)}>
            <option value="">Todos</option>
            <AirportOptions />
          </select>
        </label>
        <div className="field field-end">
          <button type="button" className="btn btn-primary" onClick={startCreate}>+ Nueva ruta</button>
        </div>
      </div>
      <p className="muted small">
        Cada ruta es una línea de ida y vuelta: la ida sale del origen los días elegidos y la vuelta regresa con el mismo avión.
        El sistema asigna los aviones (con base en el origen) y comprueba que ninguno quede en dos lugares a la vez.
        {routes && ` ${routes.length} rutas${airport ? ` en ${airport}` : ''}, ${adminRoutes} creadas por administradores.`}
      </p>

      {message && <p className="alert alert-success" role="status">{message}</p>}
      {error ? <ProblemAlert error={error} /> : null}

      {editing && (
        <form className="card route-form" onSubmit={submit} aria-label={editing.mode === 'CREATE' ? 'Nueva ruta' : `Editar ruta ${editing.routeId}`}>
          <h3>{editing.mode === 'CREATE' ? 'Nueva ruta' : `Editar ruta ${editing.routeId}`}</h3>
          <div className="grid-2">
            <label className="field">
              Origen (base de los aviones)
              <select value={form.origin} onChange={(event) => changeRoute({ origin: event.target.value })}>
                <AirportOptions />
              </select>
            </label>
            <label className="field">
              Destino
              <select value={form.destination} onChange={(event) => changeRoute({ destination: event.target.value })}>
                <AirportOptions />
              </select>
            </label>
            <label className="field">
              Salida de la ida (hora local del origen)
              <input type="time" required value={form.outboundDepartureLocal} onChange={(event) => setForm({ ...form, outboundDepartureLocal: event.target.value })} />
            </label>
            <label className="field">
              Salida de la vuelta (hora local del destino)
              <input type="time" required value={form.inboundDepartureLocal} onChange={(event) => setForm({ ...form, inboundDepartureLocal: event.target.value })} />
            </label>
            <label className="field">
              Tipo de avión
              <select
                value={form.aircraftType ?? ''}
                onChange={(event) => changeRoute({ aircraftType: (event.target.value || undefined) as AircraftTypeName | undefined })}
              >
                <option value="">Automático según la distancia ({autoType(form.origin, form.destination)})</option>
                {AIRCRAFT.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="weekday-picker">
            <legend>Días en que sale la ida</legend>
            {WEEKDAYS.map(([code, label]) => (
              <label key={code} className={`chip ${form.weekdays.includes(code) ? 'is-active' : ''}`}>
                <input type="checkbox" checked={form.weekdays.includes(code)} onChange={() => toggleDay(code)} />
                {label}
              </label>
            ))}
          </fieldset>
          <fieldset className="weekday-picker">
            <legend>Aviones ({effectiveType} con base en {form.origin})</legend>
            {candidates.length === 0 ? (
              <p className="muted small">
                No hay aviones de ese tipo con base en {form.origin}. Puedes registrar uno en la pestaña "Flota", o dejar que el sistema
                agregue los que hagan falta.
              </p>
            ) : (
              candidates.map((plane) => {
                const chosen = form.aircraft?.includes(plane.registration) ?? false;
                const mine = currentAircraft.includes(plane.registration);
                return (
                  <label key={plane.registration} className={`chip ${chosen ? 'is-active' : ''}`} title={plane.routes.join(', ') || 'Sin rutas'}>
                    <input type="checkbox" checked={chosen} onChange={() => toggleAircraft(plane.registration)} />
                    {plane.registration}
                    <span className="muted small">
                      {mine ? ' · esta ruta' : plane.status === 'AVAILABLE' ? ' · disponible' : ` · ${plane.routes.length} ruta(s)`}
                    </span>
                  </label>
                );
              })
            )}
            <p className="muted small" style={{ flexBasis: '100%', margin: 0 }}>
              {form.aircraft
                ? 'Se usarán solo los aviones elegidos: deben alcanzar para los días y no estar en otro vuelo a esa hora (si no, verás el conflicto).'
                : editing.mode === 'EDIT' && currentAircraft.length
                  ? `Sin elegir: se conservan ${currentAircraft.join(', ')} y se agregan aviones nuevos si hacen falta.`
                  : 'Sin elegir: el sistema agrega a la flota los aviones que hagan falta.'}
            </p>
          </fieldset>
          <p className="muted small">
            {editing.mode === 'EDIT' ? 'Se conservan los números de vuelo. ' : ''}
            El avión necesita un tiempo mínimo en tierra antes de la vuelta (A220-300: 35 min, A320neo: 45 min, 787-9: 90 min). Si la
            hora de la vuelta no lo permite el mismo día, el sistema la programa para un día después; al guardar te decimos qué día sale
            y cuánto tiempo queda el avión en tierra.
          </p>
          <div className="admin-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || form.weekdays.length === 0}>
              {busy ? 'Publicando…' : editing.mode === 'CREATE' ? 'Crear y publicar' : 'Guardar y publicar'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>Cancelar</button>
          </div>
        </form>
      )}

      {!routes ? (
        <p className="muted">Cargando rutas…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Ruta</th>
                <th scope="col">Ida</th>
                <th scope="col">Vuelta</th>
                <th scope="col">Días (ida / vuelta)</th>
                <th scope="col">Avión</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((route) => {
                return (
                  <tr key={route.routeId} className={route.source === 'ADMIN' ? 'row-highlight' : undefined}>
                    <td>
                      <strong>{route.origin} ⇄ {route.destination}</strong>
                      <span className="muted small"> · {route.source === 'ADMIN' ? 'Admin' : 'Red base'} · {route.distanceKm.toLocaleString('es')} km</span>
                    </td>
                    <td className="small">
                      <strong>{route.outbound.flightNumber}</strong> {route.outbound.departureLocal} → {route.outbound.arrivalLocal}
                      {plusDays(route.outbound.arrivalDayOffset)}
                    </td>
                    <td className="small">
                      <strong>{route.inbound.flightNumber}</strong> {route.inbound.departureLocal} → {route.inbound.arrivalLocal}
                      {plusDays(route.inbound.arrivalDayOffset)}
                      {route.groundMinutes != null && (
                        <span className={`block ${route.returnDelayDays ? 'text-warning' : 'muted'}`}>
                          {route.returnDelayDays ? `${route.returnDelayDays} día${route.returnDelayDays > 1 ? 's' : ''} después · ` : ''}
                          en tierra en {route.destination}: {groundTime(route.groundMinutes)}
                        </span>
                      )}
                    </td>
                    <td className="small">
                      Ida: {daysLabel(route.weekdays)}
                      {route.inbound.weekdays && route.returnDelayDays ? <span className="block">Vuelta: {daysLabel(route.inbound.weekdays)}</span> : null}
                    </td>
                    <td className="small">{route.aircraftType}<br /><span className="muted">{route.aircraft.join(', ')}</span></td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => startEdit(route)}>
                          Editar
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove(route)}>
                          Dar de baja
                        </button>
                      </div>
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
