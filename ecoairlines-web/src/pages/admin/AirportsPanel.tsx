import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { createAirport, deleteAirport, listAircraft, listCatalogAirports, listRoutes, updateAirport, type AirportInput, type CatalogAirport } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { ProblemAlert } from '../../components/ProblemAlert';
import { loadAirports } from '../../data/airports';

const EMPTY: AirportInput & { code: string } = { code: '', city: '', name: '', country: 'EC', province: '', lat: 0, lon: 0, utcOffsetMinutes: -300, active: true };
/** Husos de hora entera de UTC−12 a UTC+14 (el contrato admite múltiplos de 15 min). */
const OFFSETS = Array.from({ length: 27 }, (_, index) => (index - 12) * 60);
const utc = (minutes: number) => {
  const sign = minutes < 0 ? '−' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
};
const COUNTRIES = ['EC', 'CO', 'PE', 'CL', 'AR', 'BR', 'PA', 'MX', 'US', 'ES'];
const countryName = (() => {
  try {
    const names = new Intl.DisplayNames(['es'], { type: 'region' });
    return (code: string) => names.of(code) ?? code;
  } catch {
    return (code: string) => code;
  }
})();

type Usage = Record<string, { routes: number; aircraft: number }>;

/** El catálogo y cuántas rutas y aviones usan cada aeropuerto (para saber cuáles se pueden borrar). */
async function fetchCatalog(token: string): Promise<{ airports: CatalogAirport[]; usage: Usage }> {
  const [airports, routes, fleet] = await Promise.all([listCatalogAirports(token), listRoutes(token), listAircraft(token)]);
  const usage: Usage = {};
  const entry = (code: string) => (usage[code] ??= { routes: 0, aircraft: 0 });
  for (const route of routes) {
    entry(route.origin).routes++;
    entry(route.destination).routes++;
  }
  for (const plane of fleet) entry(plane.base).aircraft++;
  return { airports, usage };
}
type Editing = { mode: 'CREATE' } | { mode: 'EDIT'; code: string } | null;

/**
 * Catálogo de aeropuertos (PLAN_Telemetria_Asientos M-1). Su dueño es MS.G.Schedule; antes era una lista fija del código.
 * - El **código** (3 letras) es la clave: no se edita (D-T6).
 * - Con rutas o aviones con base ahí, no se borra ni cambian su país, coordenadas ni huso horario (moverían horas y distancias de
 *   vuelos ya publicados): se **desactiva**, y deja de ofrecerse para rutas nuevas.
 * Los buscadores de la web y de Booking lo toman de aquí.
 */
export function AirportsPanel() {
  const { token } = useAuth();
  const [airports, setAirports] = useState<CatalogAirport[] | null>(null);
  const [usage, setUsage] = useState<Usage>({});
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string>();

  const reload = useCallback(async () => {
    if (!token) return;
    const catalog = await fetchCatalog(token);
    setAirports(catalog.airports);
    setUsage(catalog.usage);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    fetchCatalog(token).then(
      (catalog) => {
        if (!active) return;
        setAirports(catalog.airports);
        setUsage(catalog.usage);
      },
      (caught: unknown) => active && setError(caught),
    );
    return () => {
      active = false;
    };
  }, [token]);

  /** Después de un cambio: la tabla y el catálogo de la web (selectores y buscador). */
  const done = async (text: string) => {
    setMessage(text);
    setEditing(null);
    await Promise.all([reload(), loadAirports().catch(() => undefined)]);
  };

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setMessage(undefined);
    try {
      await done(await work());
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const startCreate = () => {
    setForm(EMPTY);
    setEditing({ mode: 'CREATE' });
    setMessage(undefined);
    setError(null);
  };
  const startEdit = (airport: CatalogAirport) => {
    setForm({ ...airport, province: airport.province ?? '' });
    setEditing({ mode: 'EDIT', code: airport.code });
    setMessage(undefined);
    setError(null);
  };

  const input = (): AirportInput => ({
    city: form.city.trim(),
    name: form.name.trim(),
    country: form.country,
    province: form.province?.trim() ? form.province.trim() : null,
    lat: Number(form.lat),
    lon: Number(form.lon),
    utcOffsetMinutes: Number(form.utcOffsetMinutes),
    active: form.active,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!token || !editing) return;
    void run(async () => {
      if (editing.mode === 'CREATE') {
        const created = await createAirport(token, { code: form.code, ...input() });
        return `Aeropuerto ${created.code} (${created.city}) agregado. Ya se puede usar en «Rutas programadas» y «Flota».`;
      }
      const saved = await updateAirport(token, editing.code, input());
      return `Aeropuerto ${saved.code} guardado.`;
    });
  };

  const toggle = (airport: CatalogAirport) => {
    if (!token) return;
    const { code, updatedAt: _updatedAt, ...rest } = airport;
    void run(async () => {
      await updateAirport(token, code, { ...rest, active: !airport.active });
      return airport.active ? `${code} desactivado: ya no se ofrece para rutas nuevas; lo que ya opera sigue igual.` : `${code} activado.`;
    });
  };

  const remove = (airport: CatalogAirport) => {
    if (!token || !window.confirm(`¿Borrar el aeropuerto ${airport.code} (${airport.city})?`)) return;
    void run(async () => {
      await deleteAirport(token, airport.code);
      return `Aeropuerto ${airport.code} borrado.`;
    });
  };

  const inUse = (code: string) => (usage[code]?.routes ?? 0) + (usage[code]?.aircraft ?? 0) > 0;
  const geographyLocked = editing?.mode === 'EDIT' && inUse(editing.code);
  const term = filter.trim().toLowerCase();
  const shown = (airports ?? []).filter((airport) => !term || `${airport.code} ${airport.city} ${airport.province ?? ''} ${countryName(airport.country)}`.toLowerCase().includes(term));
  const provinces = [...new Set((airports ?? []).map((airport) => airport.province).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'es'));

  return (
    <section aria-labelledby="airports-title">
      <div className="admin-head">
        <div>
          <h2 id="airports-title">Aeropuertos</h2>
          <p className="muted small">
            El código no se cambia. Un aeropuerto con rutas o aviones no se borra ni cambia su ubicación u huso horario: se desactiva y
            deja de ofrecerse para rutas nuevas.
          </p>
        </div>
        <div className="admin-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={startCreate} disabled={busy}>Agregar aeropuerto</button>
        </div>
      </div>
      {message && <p className="alert alert-success" role="status">{message}</p>}
      {error ? <ProblemAlert error={error} /> : null}

      {editing && (
        <form className="card route-form" onSubmit={submit} aria-label={editing.mode === 'CREATE' ? 'Nuevo aeropuerto' : `Editar ${editing.code}`}>
          <h3>{editing.mode === 'CREATE' ? 'Nuevo aeropuerto' : `Editar ${editing.code}`}</h3>
          <div className="grid-2">
            <label className="field">
              Código (3 letras)
              <input required pattern="[A-Z]{3}" maxLength={3} disabled={editing.mode === 'EDIT'} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })} />
            </label>
            <label className="field">
              Ciudad
              <input required maxLength={80} value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} />
            </label>
            <label className="field">
              Nombre del aeropuerto
              <input required maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </label>
            <label className="field">
              País
              <select value={form.country} disabled={geographyLocked} onChange={(event) => setForm({ ...form, country: event.target.value })}>
                {[...new Set([form.country, ...COUNTRIES])].map((code) => (
                  <option key={code} value={code}>{countryName(code)} ({code})</option>
                ))}
              </select>
            </label>
            <label className="field">
              Provincia {form.country === 'EC' ? '' : '(opcional)'}
              <input list="airport-provinces" maxLength={80} required={form.country === 'EC'} value={form.province ?? ''} onChange={(event) => setForm({ ...form, province: event.target.value })} />
              <datalist id="airport-provinces">{provinces.map((province) => <option key={province} value={province} />)}</datalist>
            </label>
            <label className="field">
              Latitud
              <input type="number" required min={-90} max={90} step={0.000001} disabled={geographyLocked} value={form.lat} onChange={(event) => setForm({ ...form, lat: Number(event.target.value) })} />
            </label>
            <label className="field">
              Longitud
              <input type="number" required min={-180} max={180} step={0.000001} disabled={geographyLocked} value={form.lon} onChange={(event) => setForm({ ...form, lon: Number(event.target.value) })} />
            </label>
            <label className="field">
              Huso horario
              <select value={form.utcOffsetMinutes} disabled={geographyLocked} onChange={(event) => setForm({ ...form, utcOffsetMinutes: Number(event.target.value) })}>
                {[...new Set([form.utcOffsetMinutes, ...OFFSETS])].sort((a, b) => a - b).map((minutes) => (
                  <option key={minutes} value={minutes}>{utc(minutes)}{minutes === -300 ? ' (Ecuador continental)' : minutes === -360 ? ' (Galápagos)' : ''}</option>
                ))}
              </select>
            </label>
            <label className="inline-field">
              <input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} /> Activo (se ofrece para rutas nuevas)
            </label>
          </div>
          {geographyLocked && <p className="muted small">Tiene rutas o aviones: el país, las coordenadas y el huso horario no se pueden cambiar.</p>}
          <div className="admin-actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{editing.mode === 'CREATE' ? 'Agregar' : 'Guardar'}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)} disabled={busy}>Cancelar</button>
          </div>
        </form>
      )}

      <div className="filters">
        <label className="inline-field">
          Buscar
          <input value={filter} placeholder="Código, ciudad, provincia o país" onChange={(event) => setFilter(event.target.value)} />
        </label>
        {airports && <p className="muted small">{shown.length} de {airports.length} aeropuertos · {airports.filter((airport) => !airport.active).length} desactivados</p>}
      </div>

      {!airports ? (
        <p className="muted">Cargando…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Catálogo de aeropuertos</caption>
            <thead>
              <tr>
                <th scope="col">Código</th>
                <th scope="col">Ciudad</th>
                <th scope="col">Provincia / país</th>
                <th scope="col">Huso</th>
                <th scope="col">Uso</th>
                <th scope="col">Estado</th>
                <th scope="col"><span className="visually-hidden">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((airport) => {
                const use = usage[airport.code];
                return (
                  <tr key={airport.code}>
                    <td><code>{airport.code}</code></td>
                    <td>
                      {airport.city}
                      <span className="muted small block">{airport.name}</span>
                    </td>
                    <td>{airport.province ? `${airport.province} · ` : ''}{countryName(airport.country)}</td>
                    <td>{utc(airport.utcOffsetMinutes)}</td>
                    <td className="small">{use ? `${use.routes ? `${use.routes} ${use.routes === 1 ? 'ruta' : 'rutas'}` : ''}${use.routes && use.aircraft ? ' · ' : ''}${use.aircraft ? `${use.aircraft} ${use.aircraft === 1 ? 'avión' : 'aviones'}` : ''}` : '—'}</td>
                    <td>{airport.active ? 'Activo' : <strong className="text-warning">Desactivado</strong>}</td>
                    <td>
                      <div className="admin-actions">
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => startEdit(airport)}>Editar</button>
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => toggle(airport)}>{airport.active ? 'Desactivar' : 'Activar'}</button>
                        {!inUse(airport.code) && (
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => remove(airport)}>Borrar</button>
                        )}
                      </div>
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
