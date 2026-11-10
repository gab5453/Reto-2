import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { createAircraftType, deleteAircraftType, listAircraftTypes, updateAircraftType, type AircraftTypeInfo, type AircraftTypeInput } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { ProblemAlert } from '../../components/ProblemAlert';

/** Configuraciones por fila (las mismas que valida Schedule). */
const CONFIGURATIONS = { business: ['2-2', '1-2-1', '2-2-2'], economy: ['2-3', '3-3', '2-4-2', '3-3-3'] } as const;
const perRow = (configuration: string) => configuration.split('-').reduce((sum, part) => sum + Number(part), 0);
const LETTERS = /^[A-Z]$/;

interface Form {
  aircraftType: string;
  prefixLetter: string;
  unlimited: boolean;
  maxRouteKm: number;
  turnaroundMinutes: number;
  business: { seats: number; configuration: string };
  economy: { seats: number; configuration: string };
}
const EMPTY: Form = { aircraftType: '', prefixLetter: '', unlimited: false, maxRouteKm: 1_000, turnaroundMinutes: 30, business: { seats: 12, configuration: '2-2' }, economy: { seats: 120, configuration: '3-3' } };
type Editing = { mode: 'CREATE' } | { mode: 'EDIT'; aircraftType: string } | null;

const formOf = (type: AircraftTypeInfo): Form => {
  const cabin = (cabinClass: string) => type.cabins.find((item) => item.cabinClass === cabinClass);
  return {
    aircraftType: type.aircraftType,
    prefixLetter: type.registrationPrefix.replace('HC-', ''),
    unlimited: type.maxRouteKm === null,
    maxRouteKm: type.maxRouteKm ?? 5_000,
    turnaroundMinutes: type.turnaroundMinutes,
    business: { seats: cabin('BUSINESS')?.seats ?? 0, configuration: cabin('BUSINESS')?.configuration ?? '2-2' },
    economy: { seats: cabin('ECONOMY')?.seats ?? 0, configuration: cabin('ECONOMY')?.configuration ?? '3-3' },
  };
};

/** Filas que saldrán de una cabina, o el aviso si no son filas completas. */
const rowsText = (cabin: { seats: number; configuration: string }) => {
  const seats = perRow(cabin.configuration);
  return cabin.seats > 0 && cabin.seats % seats === 0 ? `${cabin.seats / seats} filas de ${seats}` : `debe ser múltiplo de ${seats} (filas completas)`;
};

/**
 * Catálogo de tipos de avión (PLAN_Telemetria_Asientos M-2). Su dueño es MS.G.Schedule; antes eran 3 tipos fijos del código.
 * - **Business y Economy siempre** (D-T8): así todo avión vende los 4 paquetes (Semilla, Brote y Bosque en Economy; Dosel en
 *   Business). Con los asientos y la configuración por fila se arma el mapa de asientos.
 * - Un tipo **con aviones o rutas no cambia** (D-T7): sus mapas de asientos están vendidos y sus rotaciones calculadas; se crea otro.
 * - Una ruta sin tipo elegido usa el de **menor alcance** que la cubra.
 */
export function AircraftTypesPanel() {
  const { token } = useAuth();
  const [types, setTypes] = useState<AircraftTypeInfo[] | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string>();

  const reload = useCallback(async () => {
    if (!token) return;
    setTypes(await listAircraftTypes(token));
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    listAircraftTypes(token).then(
      (data) => active && setTypes(data),
      (caught: unknown) => active && setError(caught),
    );
    return () => {
      active = false;
    };
  }, [token]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setMessage(undefined);
    try {
      setMessage(await work());
      setEditing(null);
      await reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const start = (next: Editing, values: Form) => {
    setForm(values);
    setEditing(next);
    setMessage(undefined);
    setError(null);
  };

  const input = (): AircraftTypeInput => ({
    registrationPrefix: `HC-${form.prefixLetter}`,
    maxRouteKm: form.unlimited ? null : Number(form.maxRouteKm),
    turnaroundMinutes: Number(form.turnaroundMinutes),
    business: { seats: Number(form.business.seats), configuration: form.business.configuration },
    economy: { seats: Number(form.economy.seats), configuration: form.economy.configuration },
  });

  const complete = (cabin: { seats: number; configuration: string }) => cabin.seats > 0 && cabin.seats % perRow(cabin.configuration) === 0;
  const valid = LETTERS.test(form.prefixLetter) && complete(form.business) && complete(form.economy) && (editing?.mode === 'EDIT' || form.aircraftType.trim().length >= 3);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!token || !editing || !valid) return;
    void run(async () => {
      if (editing.mode === 'CREATE') {
        const created = await createAircraftType(token, { aircraftType: form.aircraftType.trim(), ...input() });
        return `Tipo «${created.aircraftType}» agregado (${created.totalSeats} asientos). Ya se puede registrar en «Flota» y elegir en «Rutas programadas».`;
      }
      const saved = await updateAircraftType(token, editing.aircraftType, input());
      return `Tipo «${saved.aircraftType}» guardado.`;
    });
  };

  const remove = (type: AircraftTypeInfo) => {
    if (!token || !window.confirm(`¿Borrar el tipo «${type.aircraftType}»?`)) return;
    void run(async () => {
      await deleteAircraftType(token, type.aircraftType);
      return `Tipo «${type.aircraftType}» borrado.`;
    });
  };

  const cabinFields = (field: 'business' | 'economy', label: string) => (
    <fieldset className="card">
      <legend>{label}</legend>
      <label className="field">
        Asientos
        <input type="number" min={1} max={600} required value={form[field].seats} onChange={(event) => setForm({ ...form, [field]: { ...form[field], seats: Number(event.target.value) } })} />
      </label>
      <label className="field">
        Asientos por fila
        <select value={form[field].configuration} onChange={(event) => setForm({ ...form, [field]: { ...form[field], configuration: event.target.value } })}>
          {CONFIGURATIONS[field].map((configuration) => <option key={configuration} value={configuration}>{configuration}</option>)}
        </select>
      </label>
      <p className={`small ${complete(form[field]) ? 'muted' : 'text-warning'}`}>{rowsText(form[field])}</p>
    </fieldset>
  );

  return (
    <section aria-labelledby="types-title">
      <div className="admin-head">
        <div>
          <h2 id="types-title">Tipos de avión</h2>
          <p className="muted small">
            Cada tipo tiene Business (paquete Dosel) y Economy (Semilla, Brote y Bosque). Uno con aviones o rutas no se cambia: crea un tipo
            nuevo. Una ruta sin tipo elegido usa el de menor alcance que la cubra.
          </p>
        </div>
        <div className="admin-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => start({ mode: 'CREATE' }, EMPTY)}>Agregar tipo</button>
        </div>
      </div>
      {message && <p className="alert alert-success" role="status">{message}</p>}
      {error ? <ProblemAlert error={error} /> : null}

      {editing && (
        <form className="card route-form" onSubmit={submit} aria-label={editing.mode === 'CREATE' ? 'Nuevo tipo de avión' : `Editar ${editing.aircraftType}`}>
          <h3>{editing.mode === 'CREATE' ? 'Nuevo tipo de avión' : `Editar ${editing.aircraftType}`}</h3>
          <div className="grid-2">
            <label className="field">
              Nombre
              <input required maxLength={60} disabled={editing.mode === 'EDIT'} placeholder="Embraer E195-E2" value={form.aircraftType} onChange={(event) => setForm({ ...form, aircraftType: event.target.value })} />
            </label>
            <label className="field">
              Letra de matrícula (HC-…)
              <input required maxLength={1} pattern="[A-Z]" value={form.prefixLetter} onChange={(event) => setForm({ ...form, prefixLetter: event.target.value.toUpperCase() })} />
              <span className="muted small">{LETTERS.test(form.prefixLetter) ? `Matrículas HC-${form.prefixLetter}01, HC-${form.prefixLetter}02…` : 'Una letra'}</span>
            </label>
            <label className="field">
              Alcance (km)
              <input type="number" min={100} max={20000} step={50} disabled={form.unlimited} value={form.maxRouteKm} onChange={(event) => setForm({ ...form, maxRouteKm: Number(event.target.value) })} />
              <span className="inline-field small">
                <input type="checkbox" checked={form.unlimited} onChange={(event) => setForm({ ...form, unlimited: event.target.checked })} /> Sin límite
              </span>
            </label>
            <label className="field">
              Tiempo en tierra (min)
              <input type="number" min={15} max={300} required value={form.turnaroundMinutes} onChange={(event) => setForm({ ...form, turnaroundMinutes: Number(event.target.value) })} />
            </label>
          </div>
          <div className="grid-2">
            {cabinFields('business', 'Business (Dosel)')}
            {cabinFields('economy', 'Economy (Semilla, Brote y Bosque)')}
          </div>
          <p className="small">Total: <strong>{Number(form.business.seats) + Number(form.economy.seats)} asientos</strong></p>
          <div className="admin-actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !valid}>{editing.mode === 'CREATE' ? 'Agregar' : 'Guardar'}</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditing(null)}>Cancelar</button>
          </div>
        </form>
      )}

      {!types ? (
        <p className="muted">Cargando…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Tipos de avión</caption>
            <thead>
              <tr>
                <th scope="col">Tipo</th>
                <th scope="col">Business</th>
                <th scope="col">Economy</th>
                <th scope="col" className="num">Alcance</th>
                <th scope="col" className="num">En tierra</th>
                <th scope="col" className="num">Aviones</th>
                <th scope="col"><span className="visually-hidden">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              {types.map((type) => {
                const cabin = (cabinClass: string) => type.cabins.find((item) => item.cabinClass === cabinClass);
                const describe = (cabinClass: string) => {
                  const item = cabin(cabinClass);
                  return item ? `${item.seats} · ${item.configuration} · filas ${item.firstRow}–${item.lastRow}` : '—';
                };
                const free = type.inFleet === 0;
                return (
                  <tr key={type.aircraftType}>
                    <td>
                      <strong>{type.aircraftType}</strong>
                      <span className="muted small block">matrículas {type.registrationPrefix}01… · {type.totalSeats} asientos{type.source === 'ADMIN' ? ' · creado en el panel' : ''}</span>
                    </td>
                    <td className="small">{describe('BUSINESS')}</td>
                    <td className="small">{describe('ECONOMY')}</td>
                    <td className="num">{type.maxRouteKm === null ? 'Sin límite' : `${type.maxRouteKm.toLocaleString('es')} km`}</td>
                    <td className="num">{type.turnaroundMinutes} min</td>
                    <td className="num">{type.inFleet}</td>
                    <td>
                      {free ? (
                        <div className="admin-actions">
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => start({ mode: 'EDIT', aircraftType: type.aircraftType }, formOf(type))}>Editar</button>
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => remove(type)}>Borrar</button>
                        </div>
                      ) : (
                        <span className="muted small">Con aviones: no se cambia</span>
                      )}
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
