import { useEffect, useState, type FormEvent } from 'react';
import { getPriceHistory, getPrices, getReferencePrices, savePrices, type PriceChange, type PricesView, type PromotionAgreement } from '../../api/admin';
import type { CabinClass } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ProblemAlert } from '../../components/ProblemAlert';
import { formatDateTime, todayIso } from '../../lib/format';

/** El partner del contrato (D35): hoy Booking es el único con acuerdo de promociones. */
const PARTNER_ID = 'BOOKING_PROTOTIPO';
const CABINS: { value: CabinClass; label: string }[] = [
  { value: 'ECONOMY', label: 'Economy' },
  { value: 'BUSINESS', label: 'Business' },
];
const MAX_DISCOUNT = 50;

const keyOf = (price: { cabinClass: string; fareBrand: string }) => `${price.cabinClass}|${price.fareBrand}`;
const list = (value: string) => value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);

interface PromotionForm {
  allowsPromotions: boolean;
  maxDiscountPercentage: string;
  enabledCabins: CabinClass[];
  enabledRoutes: string;
  enabledDestinations: string;
  validUntil: string;
  comboConditions: string;
}

const promotionForm = (agreement?: PromotionAgreement): PromotionForm => ({
  allowsPromotions: agreement?.allowsPromotions ?? false,
  maxDiscountPercentage: String(agreement?.maxDiscountPercentage ?? 0),
  enabledCabins: agreement?.enabledCabins ?? [],
  enabledRoutes: agreement?.enabledRoutes.join(', ') ?? '',
  enabledDestinations: agreement?.enabledDestinations.join(', ') ?? '',
  validUntil: agreement?.validUntil ?? '',
  comboConditions: agreement?.comboConditions ?? '',
});

/**
 * Precios por cabina y familia, y promociones con Booking (`prices`, `referencePrices`, `priceHistory`, `savePrices`). Un solo
 * «Guardar»: la saga cambia los multiplicadores en Schedule, los publica a Offers y guarda el acuerdo (descuento máximo 50 %, D35).
 */
export function AdminPricesPage() {
  const { token } = useAuth();
  const [view, setView] = useState<PricesView | null>(null);
  /** multipliers[cabina|familia]: lo que está escrito en los campos. */
  const [multipliers, setMultipliers] = useState<Record<string, string>>({});
  const [promotion, setPromotion] = useState<PromotionForm>(promotionForm());
  const [history, setHistory] = useState<PriceChange[]>([]);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [formError, setFormError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const show = (data: PricesView) => {
    setView(data);
    setMultipliers(Object.fromEntries(data.prices.map((price) => [keyOf(price), String(price.multiplier)])));
    setPromotion(promotionForm(data.promotions.find((agreement) => agreement.partnerId === PARTNER_ID)));
  };

  useEffect(() => {
    if (!token) return;
    let active = true;
    Promise.all([getPrices(token), getPriceHistory(token)])
      .then(([data, changes]) => {
        if (!active) return;
        show(data);
        setHistory(changes);
      })
      .catch((caught: unknown) => active && setError(caught));
    return () => {
      active = false;
    };
  }, [token]);

  const changed = (view?.prices ?? [])
    .map((price) => ({ ...price, next: Number(multipliers[keyOf(price)]) }))
    .filter((price) => price.next !== price.multiplier);

  const fill = async () => {
    if (!token) return;
    setError(null);
    try {
      const reference = await getReferencePrices(token);
      setMultipliers((current) => ({ ...current, ...Object.fromEntries(reference.map((price) => [keyOf(price), String(price.multiplier)])) }));
      setPreview(true);
    } catch (caught) {
      setError(caught);
    }
  };

  const toggleCabin = (cabin: CabinClass, on: boolean) =>
    setPromotion((current) => ({ ...current, enabledCabins: on ? [...current.enabledCabins, cabin] : current.enabledCabins.filter((item) => item !== cabin) }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    const discount = Number(promotion.maxDiscountPercentage);
    if (changed.some((price) => !(price.next >= 0.5 && price.next <= 10))) return setFormError('Cada multiplicador debe estar entre 0,5 y 10.');
    if (!(discount >= 0 && discount <= MAX_DISCOUNT)) return setFormError(`El descuento máximo debe estar entre 0 y ${MAX_DISCOUNT} %.`);
    setFormError(undefined);
    setBusy(true);
    setError(null);
    setMessage(undefined);
    try {
      const saved = await savePrices(token, {
        ...(changed.length ? { prices: changed.map(({ cabinClass, fareBrand, next }) => ({ cabinClass, fareBrand, multiplier: next })) } : {}),
        promotion: {
          partnerId: PARTNER_ID,
          allowsPromotions: promotion.allowsPromotions,
          maxDiscountPercentage: discount,
          enabledCabins: promotion.enabledCabins,
          enabledRoutes: list(promotion.enabledRoutes),
          enabledDestinations: list(promotion.enabledDestinations),
          ...(promotion.validUntil ? { validUntil: promotion.validUntil } : {}),
          ...(promotion.comboConditions.trim() ? { comboConditions: promotion.comboConditions.trim() } : {}),
        },
      });
      show(saved);
      setHistory(await getPriceHistory(token));
      setPreview(false);
      setMessage(`Guardado: ${changed.length} precio${changed.length === 1 ? '' : 's'} y el acuerdo de promociones. Las ventas nuevas ya usan estos valores.`);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  if (!view) return <div className="container section">{error ? <ProblemAlert error={error} /> : <p className="muted">Cargando precios…</p>}</div>;

  return (
    <form className="container section admin" onSubmit={submit} noValidate>
      <header className="admin-head">
        <div>
          <p className="eyebrow">Portal administrativo</p>
          <h1>Precios y promociones</h1>
          <p className="muted small">Actualizado: {formatDateTime(view.updatedAt)} · Cada multiplicador se aplica sobre la tarifa base de la ruta; las reservas ya hechas no cambian.</p>
        </div>
      </header>

      <section className="card" aria-labelledby="fares-title">
        <div className="admin-head">
          <h2 id="fares-title">Precios por cabina y familia</h2>
          <div className="admin-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void fill()}>Rellenar con los de referencia</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreview((value) => !value)}>{preview ? 'Ocultar vista previa' : 'Vista previa'}</button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Cabina</th>
                <th scope="col">Familia</th>
                <th scope="col">Referencia</th>
                <th scope="col">Multiplicador</th>
              </tr>
            </thead>
            <tbody>
              {view.prices.map((price) => (
                <tr key={keyOf(price)}>
                  <td>{price.cabinClass}</td>
                  <td>{price.fareBrand}</td>
                  <td>{price.referenceMultiplier}</td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      min="0.5"
                      max="10"
                      aria-label={`Multiplicador de ${price.fareBrand}`}
                      value={multipliers[keyOf(price)] ?? ''}
                      onChange={(event) => setMultipliers((current) => ({ ...current, [keyOf(price)]: event.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {preview && (
          <div className="alert alert-info" role="status">
            <p className="alert-title">Vista previa (aún no se guardó)</p>
            {changed.length === 0 ? (
              <p>No hay cambios de precio.</p>
            ) : (
              <ul className="alert-list">
                {changed.map((price) => (
                  <li key={keyOf(price)}>
                    {price.fareBrand}: {price.multiplier} → {price.next} ({price.next >= price.multiplier ? '+' : ''}{Math.round((price.next / price.multiplier - 1) * 1000) / 10} %)
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="promo-title">
        <h2 id="promo-title">Promociones con Booking</h2>
        <p className="muted small">Booking consulta este acuerdo por la API de vuelos. Sin rutas o destinos, aplica a toda la red.</p>
        <label className="inline-field">
          <input type="checkbox" checked={promotion.allowsPromotions} onChange={(event) => setPromotion({ ...promotion, allowsPromotions: event.target.checked })} />
          Permitir promociones
        </label>
        <div className="grid-2">
          <label className="field">
            Descuento máximo (0–{MAX_DISCOUNT} %)
            <input type="number" min="0" max={MAX_DISCOUNT} value={promotion.maxDiscountPercentage} onChange={(event) => setPromotion({ ...promotion, maxDiscountPercentage: event.target.value })} />
          </label>
          <label className="field">
            Vigente hasta (opcional)
            <input type="date" min={todayIso()} value={promotion.validUntil} onChange={(event) => setPromotion({ ...promotion, validUntil: event.target.value })} />
          </label>
          <label className="field">
            Rutas habilitadas (separadas por coma)
            <input value={promotion.enabledRoutes} placeholder="UIO-GYE, UIO-CUE" onChange={(event) => setPromotion({ ...promotion, enabledRoutes: event.target.value })} />
          </label>
          <label className="field">
            Destinos habilitados (separados por coma)
            <input value={promotion.enabledDestinations} placeholder="GYE, CUE" onChange={(event) => setPromotion({ ...promotion, enabledDestinations: event.target.value })} />
          </label>
          <label className="field">
            Condiciones del combo (opcional)
            <input value={promotion.comboConditions} maxLength={500} onChange={(event) => setPromotion({ ...promotion, comboConditions: event.target.value })} />
          </label>
        </div>
        <fieldset className="assistance-box">
          <legend>Cabinas habilitadas</legend>
          <div className="check-grid">
            {CABINS.map((cabin) => (
              <label key={cabin.value} className="inline-field">
                <input type="checkbox" checked={promotion.enabledCabins.includes(cabin.value)} onChange={(event) => toggleCabin(cabin.value, event.target.checked)} />
                {cabin.label}
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      {formError && <p className="form-error" role="alert">{formError}</p>}
      {error ? <ProblemAlert error={error} /> : null}
      {message && <p className="alert alert-success" role="status">{message}</p>}
      <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>

      <section className="card" aria-labelledby="history-title">
        <h2 id="history-title">Historial de cambios</h2>
        {history.length === 0 ? (
          <p className="muted">Todavía no hay cambios de precio.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Familia</th>
                  <th scope="col">Antes</th>
                  <th scope="col">Después</th>
                </tr>
              </thead>
              <tbody>
                {history.map((change) => (
                  <tr key={change.id}>
                    <td className="small">{formatDateTime(change.changedAt)}</td>
                    <td>{change.cabinClass} · {change.fareBrand}</td>
                    <td>{change.oldMultiplier}</td>
                    <td>{change.newMultiplier}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </form>
  );
}
