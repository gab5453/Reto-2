import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { createHold, searchFlights } from '../api/operations';
import type { CabinPricing, FlightOffer, PassengerBreakdown, SearchResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useBookingFlow, type FareChoice } from '../booking/BookingFlowContext';
import { ItinerarySummary } from '../components/ItinerarySummary';
import { ProblemAlert } from '../components/ProblemAlert';
import { cityOf } from '../data/airports';
import { FARE_DESCRIPTIONS, formatMoney, localDate } from '../lib/format';
import { deviceFingerprint, useIdempotencyKey } from '../lib/request-ids';
import { fromQuery } from '../lib/search-params';

type Sort = 'PRICE' | 'DURATION';

export function ResultsPage() {
  const [params] = useSearchParams();
  const parsed = useMemo(() => fromQuery(params), [params]);
  const [sort, setSort] = useState<Sort>('PRICE');
  const [directOnly, setDirectOnly] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${params.toString()}#${attempt}`;
  const [loaded, setLoaded] = useState<{ key: string; result?: SearchResponse; error?: unknown }>({ key: '' });

  useEffect(() => {
    if (!parsed) return;
    let active = true;
    searchFlights(parsed.request, deviceFingerprint())
      .then((result) => active && setLoaded({ key: requestKey, result }))
      .catch((error: unknown) => active && setLoaded({ key: requestKey, error }));
    return () => {
      active = false;
    };
  }, [parsed, requestKey]);

  const { result, error } = loaded.key === requestKey ? loaded : { result: undefined, error: undefined };

  if (!parsed) {
    return (
      <div className="container section">
        <p>La búsqueda no es válida.</p>
        <Link to="/" className="btn btn-primary">Nueva búsqueda</Link>
      </div>
    );
  }

  const { request } = parsed;
  const passengers = request.passengers as Required<PassengerBreakdown>;
  const offers = (result?.offers ?? [])
    .filter((offer) => !directOnly || offer.itineraries.every((itinerary) => itinerary.stopsCount === 0))
    .sort((a, b) =>
      sort === 'PRICE'
        ? Number(a.grandTotal.total) - Number(b.grandTotal.total)
        : totalDuration(a) - totalDuration(b),
    );

  return (
    <div className="container section">
      <header className="results-head">
        <div>
          <h1>
            {request.itineraries.map((leg) => `${cityOf(leg.origin)} → ${cityOf(leg.destination)}`).join(' · ')}
          </h1>
          <p className="muted">
            {request.itineraries.map((leg) => localDate(leg.departureDate)).join(' · ')} · {paxSummary(passengers)}
          </p>
        </div>
        <Link to="/" className="btn btn-ghost btn-sm">Modificar búsqueda</Link>
      </header>

      <div className="results-tools">
        <label className="inline-field">
          Ordenar por
          <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
            <option value="PRICE">Menor precio</option>
            <option value="DURATION">Menor duración</option>
          </select>
        </label>
        <label className="inline-field">
          <input type="checkbox" checked={directOnly} onChange={(event) => setDirectOnly(event.target.checked)} />
          Solo vuelos directos
        </label>
      </div>

      {error ? <ProblemAlert error={error} onRetry={() => setAttempt((value) => value + 1)} /> : null}
      {!result && !error && <p className="muted" aria-live="polite">Buscando los mejores vuelos…</p>}
      {result && offers.length === 0 && (
        <div className="empty">
          <p>No encontramos vuelos para esta búsqueda.</p>
          <p className="muted small">Prueba con otra fecha o sin el filtro de directos.</p>
        </div>
      )}

      <div className="offers" aria-live="polite">
        {offers.map((offer) => (
          <OfferCard key={offer.offerId} offer={offer} passengers={passengers} />
        ))}
      </div>
    </div>
  );
}

function OfferCard({ offer, passengers }: { offer: FlightOffer; passengers: Required<PassengerBreakdown> }) {
  const { token } = useAuth();
  const { setFlow } = useBookingFlow();
  const navigate = useNavigate();
  const location = useLocation();
  const seatsNeeded = passengers.adults + passengers.youths + passengers.children;

  const [choices, setChoices] = useState<FareChoice[]>(() =>
    offer.itineraries.map((itinerary) => ({
      itineraryId: itinerary.itineraryId,
      pricing: itinerary.pricingOptions.find((option) => option.availableSeats >= seatsNeeded) ?? itinerary.pricingOptions[0]!,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const idempotency = useIdempotencyKey([JSON.stringify(choices)]);

  const total = choices.reduce((sum, choice) => sum + groupPrice(choice.pricing, passengers), 0);
  const unavailable = choices.some((choice) => choice.pricing.availableSeats < seatsNeeded);

  const reserve = async () => {
    if (!token) {
      navigate(`/ingresar?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const hold = await createHold(token, idempotency.key(), {
        offerId: offer.offerId,
        itinerarySelections: choices.map((choice) => ({
          itineraryId: choice.itineraryId,
          cabinClass: choice.pricing.cabinClass,
          fareBrand: choice.pricing.fareBrand,
        })),
        passengersBreakdown: passengers,
      });
      idempotency.renew();
      setFlow({ offer, choices, passengers, hold });
      navigate('/reserva');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="offer card">
      {offer.itineraries.map((itinerary, index) => {
        const choice = choices[index]!;
        return (
          <div className="offer-itinerary" key={itinerary.itineraryId}>
            <ItinerarySummary
              itinerary={itinerary}
              cabinClass={choice.pricing.cabinClass}
              label={offer.itineraries.length > 1 ? `Vuelo ${index + 1}` : undefined}
            />
            <fieldset className="fares">
              <legend className="visually-hidden">Tarifa del vuelo {index + 1}</legend>
              {itinerary.pricingOptions.map((option) => {
                const soldOut = option.availableSeats < seatsNeeded;
                const selected = choice.pricing.fareBrand === option.fareBrand && choice.pricing.cabinClass === option.cabinClass;
                return (
                  <label key={`${option.cabinClass}-${option.fareBrand}`} className={`fare ${selected ? 'is-selected' : ''} ${soldOut ? 'is-disabled' : ''}`}>
                    <input
                      type="radio"
                      name={`${offer.offerId}-${index}`}
                      checked={selected}
                      disabled={soldOut}
                      onChange={() =>
                        setChoices((current) => current.map((item, position) => (position === index ? { ...item, pricing: option } : item)))
                      }
                    />
                    <span className="fare-name">{titleCase(option.fareBrand)}</span>
                    <span className="fare-cabin muted small">{option.cabinClass === 'BUSINESS' ? 'Business' : 'Economy'}</span>
                    <span className="fare-price">{formatMoney(adultPrice(option))}</span>
                    <span className="fare-desc small">{FARE_DESCRIPTIONS[option.fareBrand] ?? ''}</span>
                    <span className="small muted">
                      {soldOut ? 'Agotado' : option.availableSeats < 10 ? `¡Quedan ${option.availableSeats}!` : `${option.fareRules.isRefundable ? 'Reembolsable' : 'No reembolsable'}`}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          </div>
        );
      })}
      <footer className="offer-footer">
        <div>
          <span className="muted small">Total estimado para {paxSummary(passengers)}</span>
          <strong className="offer-total">{formatMoney(String(total / 100), offer.grandTotal.currency)}</strong>
          <span className="muted small">El precio final se congela al reservar.</span>
        </div>
        <button type="button" className="btn btn-primary" onClick={reserve} disabled={busy || unavailable}>
          {busy ? 'Reservando…' : token ? 'Continuar' : 'Ingresa para continuar'}
        </button>
      </footer>
      {error ? <ProblemAlert error={error} /> : null}
    </article>
  );
}

function adultPrice(option: CabinPricing) {
  return option.pricePerPassengerType.find((entry) => entry.passengerType === 'ADULT')?.price ?? option.pricePerPassengerType[0]?.price;
}

/** Total del grupo en centavos, a partir del precio por tipo de pasajero del contrato. */
function groupPrice(option: CabinPricing, passengers: Required<PassengerBreakdown>): number {
  const counts: Record<string, number> = {
    ADULT: passengers.adults,
    YOUTH: passengers.youths,
    CHILD: passengers.children,
    INFANT: passengers.infants,
  };
  return option.pricePerPassengerType.reduce(
    (sum, entry) => sum + Math.round(Number(entry.price?.total ?? 0) * 100) * (counts[entry.passengerType ?? ''] ?? 0),
    0,
  );
}

function totalDuration(offer: FlightOffer) {
  return offer.itineraries.reduce((sum, itinerary) => sum + itinerary.totalDurationMinutes, 0);
}

function paxSummary(passengers: Required<PassengerBreakdown>) {
  const total = passengers.adults + passengers.youths + passengers.children + passengers.infants;
  return `${total} pasajero${total > 1 ? 's' : ''}`;
}

const titleCase = (value: string) => value.charAt(0) + value.slice(1).toLowerCase();
