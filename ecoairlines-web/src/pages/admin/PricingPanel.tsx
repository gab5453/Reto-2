import { useEffect, useState } from 'react';
import { listRoutes, savePrices, type PricesView, type ScheduledRoute } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { ProblemAlert } from '../../components/ProblemAlert';
import { cityOf } from '../../data/airports';
import { formatDateTime } from '../../lib/format';

/** Los 4 paquetes y su cabina: Semilla, Brote y Bosque se venden en Economy; Dosel en Business. */
const PACKAGES = [
  { fareBrand: 'SEMILLA', label: 'Semilla', cabin: 'Economy' },
  { fareBrand: 'BROTE', label: 'Brote', cabin: 'Economy' },
  { fareBrand: 'BOSQUE', label: 'Bosque', cabin: 'Economy' },
  { fareBrand: 'DOSEL', label: 'Dosel', cabin: 'Business' },
] as const;
const FIELD_LABELS = { FIXED_CHARGE: 'Cargo fijo', PER_KM: 'Precio por km', ROUTE_PRICE: 'Precio exacto' } as const;
const usd = (value: number | null) => (value === null ? '—' : `US$${value.toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`);

/**
 * Tarifa base y precios por ruta (PLAN_Telemetria_Asientos P-1). La tarifa de un adulto en un vuelo directo, sin impuestos, es
 * (cargo fijo + precio por km × km) × multiplicador del paquete; si la ruta tiene precio exacto para un paquete, se usa ese
 * (D-T12). La misma saga «Guardar precios» guarda en Schedule y publica a Offers; las reservas ya hechas conservan su precio.
 */
export function PricingPanel({ view, onSaved }: { view: PricesView; onSaved: (view: PricesView) => void }) {
  const { token } = useAuth();
  const pricing = view.pricing;
  const [base, setBase] = useState({ fixedCharge: String(pricing.fixedCharge), perKm: String(pricing.perKm) });
  const [routes, setRoutes] = useState<ScheduledRoute[]>([]);
  const [routeId, setRouteId] = useState('');
  const [exact, setExact] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (!token) return;
    let active = true;
    listRoutes(token).then(
      (data) => active && setRoutes([...data].sort((a, b) => `${a.origin}${a.destination}`.localeCompare(`${b.origin}${b.destination}`))),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [token]);

  const route = routes.find((candidate) => candidate.routeId === routeId);
  const saved = pricing.routePrices.find((candidate) => candidate.routeId === routeId);
  const multiplierOf = (fareBrand: string) => view.prices.find((price) => price.fareBrand === fareBrand)?.multiplier ?? 1;
  const fixedCharge = Number(base.fixedCharge);
  const perKm = Number(base.perKm);
  /** Lo que da la fórmula (aproximado: Offers usa la distancia sin redondear). */
  const formula = (fareBrand: string) => (route ? Math.round((fixedCharge + route.distanceKm * perKm) * multiplierOf(fareBrand)) : null);

  const pickRoute = (id: string) => {
    setRouteId(id);
    const current = pricing.routePrices.find((candidate) => candidate.routeId === id);
    setExact(Object.fromEntries(PACKAGES.map(({ fareBrand }) => [fareBrand, current ? String(current.prices.find((price) => price.fareBrand === fareBrand)?.amount ?? '') : ''])));
    setMessage(undefined);
    setError(null);
  };

  const save = async (input: Parameters<typeof savePrices>[1]['pricing'], done: string) => {
    if (!token) return;
    setBusy(true);
    setError(null);
    setMessage(undefined);
    try {
      const next = await savePrices(token, { pricing: input });
      onSaved(next);
      setMessage(done);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  // La página entera es un <form> (el «Guardar» de los multiplicadores): aquí no puede haber formularios anidados, así que
  // estas acciones son botones normales.
  const baseValid = Number.isFinite(fixedCharge) && fixedCharge >= 0 && fixedCharge <= 500 && Number.isFinite(perKm) && perKm >= 0.001 && perKm <= 5;
  const saveBase = () => {
    if (!baseValid) return;
    void save({ fixedCharge, perKm }, `Tarifa base guardada: US$${fixedCharge} por vuelo + US$${perKm} por km. Las búsquedas ya usan los precios nuevos.`);
  };

  const amounts = PACKAGES.map(({ fareBrand }) => ({ fareBrand, amount: Number(exact[fareBrand]) }));
  const complete = amounts.every((item) => Number.isFinite(item.amount) && item.amount >= 1 && item.amount <= 20_000);
  const saveRoute = () => {
    if (!route || !complete) return;
    void save({ route: { routeId: route.routeId, prices: amounts } }, `Precio exacto guardado para ${route.origin} ⇄ ${route.destination}. Las demás rutas siguen con la fórmula.`);
  };
  const removeRoute = () => {
    if (!route) return;
    void save({ route: { routeId: route.routeId, prices: [] } }, `${route.origin} ⇄ ${route.destination} vuelve a la fórmula.`);
  };

  return (
    <section className="card" aria-labelledby="pricing-title">
      <h2 id="pricing-title">Tarifa base y precio por ruta</h2>
      <p className="muted small">
        Tarifa de un adulto en un vuelo directo, sin impuestos: <strong>(cargo fijo + precio por km × km) × multiplicador del paquete</strong>.
        Si una ruta tiene precio exacto, se usa ese. Los impuestos (15 % + US$12 por tramo) se suman después. Las reservas ya hechas
        conservan su precio.
      </p>
      {message && <p className="alert alert-success" role="status">{message}</p>}
      {error ? <ProblemAlert error={error} /> : null}

      <div className="filters" role="group" aria-label="Tarifa base">
        <label className="inline-field">
          Cargo fijo por vuelo (US$)
          <input type="number" min={0} max={500} step={0.01} required value={base.fixedCharge} onChange={(event) => setBase({ ...base, fixedCharge: event.target.value })} />
        </label>
        <label className="inline-field">
          Precio por km (US$)
          <input type="number" min={0.001} max={5} step={0.0001} required value={base.perKm} onChange={(event) => setBase({ ...base, perKm: event.target.value })} />
        </label>
        <button type="button" className="btn btn-primary btn-sm" onClick={saveBase} disabled={busy || !baseValid || (fixedCharge === pricing.fixedCharge && perKm === pricing.perKm)}>
          Guardar tarifa base
        </button>
      </div>

      <div role="group" aria-label="Precio por ruta">
        <label className="field">
          Ruta para ver cuánto cuesta cada paquete
          <select value={routeId} onChange={(event) => pickRoute(event.target.value)}>
            <option value="">Elige una ruta…</option>
            {routes.map((candidate) => (
              <option key={candidate.routeId} value={candidate.routeId}>
                {cityOf(candidate.origin)} ⇄ {cityOf(candidate.destination)} ({candidate.origin}–{candidate.destination}) · {candidate.distanceKm.toLocaleString('es')} km
                {pricing.routePrices.some((item) => item.routeId === candidate.routeId) ? ' · precio exacto' : ''}
              </option>
            ))}
          </select>
        </label>
        {route && (
          <>
            <div className="table-wrap">
              <table>
                <caption className="visually-hidden">Precio de cada paquete en {route.routeId}</caption>
                <thead>
                  <tr><th scope="col">Paquete</th><th scope="col">Cabina</th><th scope="col" className="num">Por fórmula (aprox.)</th><th scope="col">Precio exacto (US$)</th></tr>
                </thead>
                <tbody>
                  {PACKAGES.map(({ fareBrand, label, cabin }) => {
                    const byFormula = formula(fareBrand);
                    const value = Number(exact[fareBrand]);
                    const far = byFormula && exact[fareBrand] && Number.isFinite(value) && Math.abs(value - byFormula) / byFormula > 0.5;
                    return (
                      <tr key={fareBrand}>
                        <td><strong>{label}</strong> <span className="muted small">× {multiplierOf(fareBrand)}</span></td>
                        <td>{cabin}</td>
                        <td className="num">{usd(byFormula)}</td>
                        <td>
                          <input type="number" min={1} max={20000} step={0.01} aria-label={`Precio exacto de ${label}`} placeholder="Fórmula" value={exact[fareBrand] ?? ''} onChange={(event) => setExact({ ...exact, [fareBrand]: event.target.value })} />
                          {far ? <span className="text-warning small block">Muy distinto de la fórmula: revisa el valor.</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted small">El precio exacto lleva los 4 paquetes. {saved ? 'Esta ruta ya tiene precio exacto.' : 'Hoy esta ruta usa la fórmula.'}</p>
            <div className="admin-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={saveRoute} disabled={busy || !complete}>Guardar precio de esta ruta</button>
              {saved ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={removeRoute}>Quitar precio exacto (volver a la fórmula)</button> : null}
            </div>
          </>
        )}
      </div>

      {pricing.history.length > 0 && (
        <details>
          <summary className="small">Últimos cambios de la tarifa base y los precios por ruta</summary>
          <ul className="small">
            {pricing.history.map((change) => (
              <li key={change.id}>
                {formatDateTime(change.changedAt)} · {FIELD_LABELS[change.field]}
                {change.routeId ? ` ${change.routeId}` : ''}
                {change.fareBrand ? ` ${change.fareBrand}` : ''}: {usd(change.oldValue)} → {usd(change.newValue)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
