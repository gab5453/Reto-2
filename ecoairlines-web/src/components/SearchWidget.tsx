import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { PassengerBreakdown } from '../api/types';
import { lastSaleDate, todayIso } from '../lib/format';
import { toQuery, type TripType } from '../lib/search-params';
import { AirportOptions } from './AirportOptions';

interface Leg {
  origin: string;
  destination: string;
  date: string;
}

type Tab = 'BOOK' | 'CHECK_IN' | 'TRIPS' | 'STATUS';
const MAX_LEGS = 6;

const TABS: { id: Tab; label: string }[] = [
  { id: 'BOOK', label: 'Reservar vuelo' },
  { id: 'CHECK_IN', label: 'Check-in' },
  { id: 'TRIPS', label: 'Mis viajes' },
  { id: 'STATUS', label: 'Estado de vuelo' },
];

export function SearchWidget({ initialDestination }: { initialDestination?: string }) {
  const [tab, setTab] = useState<Tab>('BOOK');
  const baseId = useId();

  return (
    <section className="search-card" aria-label="Buscador">
      <div className="tabs" role="tablist" aria-label="¿Qué quieres hacer?">
        {TABS.map((item) => (
          <button
            key={item.id}
            id={`${baseId}-tab-${item.id}`}
            role="tab"
            type="button"
            aria-selected={tab === item.id}
            aria-controls={`${baseId}-panel-${item.id}`}
            className={`tab ${tab === item.id ? 'is-active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div id={`${baseId}-panel-${tab}`} role="tabpanel" aria-labelledby={`${baseId}-tab-${tab}`} className="tab-panel">
        {tab === 'BOOK' && <BookingForm key={initialDestination} initialDestination={initialDestination} />}
        {tab === 'CHECK_IN' && (
          <div className="tab-message">
            <p>El check-in abre <strong>48 horas</strong> antes de tu vuelo y cierra 60 minutos antes de la salida.</p>
            <Link className="btn btn-primary" to="/check-in">Hacer check-in</Link>
          </div>
        )}
        {tab === 'TRIPS' && (
          <div className="tab-message">
            <p>Consulta tus reservas, agrega maletas, cambia la fecha o cancela.</p>
            <Link className="btn btn-primary" to="/mis-viajes">Ver mis viajes</Link>
          </div>
        )}
        {tab === 'STATUS' && <StatusForm />}
      </div>
    </section>
  );
}

function BookingForm({ initialDestination }: { initialDestination?: string }) {
  const navigate = useNavigate();
  const id = useId();
  const [tripType, setTripType] = useState<TripType>('ROUND_TRIP');
  const [legs, setLegs] = useState<Leg[]>([{ origin: 'UIO', destination: initialDestination ?? 'BOG', date: todayIso() }]);
  // Por defecto se viaja hoy (quien tiene prisa no necesita elegir la fecha) y se vuelve en una semana.
  const [returnDate, setReturnDate] = useState(todayIso(7));
  const [passengers, setPassengers] = useState<Required<PassengerBreakdown>>({ adults: 1, youths: 0, children: 0, infants: 0 });
  const [error, setError] = useState<string>();

  const updateLeg = (index: number, patch: Partial<Leg>) => {
    setLegs((current) => current.map((leg, position) => (position === index ? { ...leg, ...patch } : leg)));
    // Si la ida pasa a ser posterior a la vuelta, la vuelta se mueve al mismo día.
    if (index === 0 && patch.date && patch.date > returnDate) setReturnDate(patch.date);
  };

  const changeTripType = (type: TripType) => {
    setTripType(type);
    if (type !== 'MULTI_CITY') setLegs((current) => current.slice(0, 1));
    else if (legs.length === 1) setLegs((current) => [...current, { origin: current[0]!.destination, destination: 'LIM', date: todayIso(7) }]);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const itineraries = legs.map((leg) => ({ origin: leg.origin, destination: leg.destination, departureDate: leg.date }));
    if (tripType === 'ROUND_TRIP') {
      itineraries.push({ origin: legs[0]!.destination, destination: legs[0]!.origin, departureDate: returnDate });
    }

    if (itineraries.some((leg) => leg.origin === leg.destination)) return setError('El origen y el destino deben ser distintos.');
    if (itineraries.some((leg) => !leg.departureDate || leg.departureDate < todayIso())) return setError('Las fechas no pueden estar en el pasado.');
    if (itineraries.some((leg) => leg.departureDate > lastSaleDate())) {
      return setError(`Tenemos vuelos publicados hasta el ${lastSaleDate()} (las próximas 13 semanas).`);
    }
    if (itineraries.some((leg, index) => index > 0 && leg.departureDate < itineraries[index - 1]!.departureDate)) {
      return setError('Cada tramo debe salir en la misma fecha o después del anterior.');
    }
    if (passengers.infants > passengers.adults) return setError('Cada infante debe viajar con un adulto.');

    setError(undefined);
    navigate(`/vuelos?${toQuery({ itineraries, passengers }, tripType)}`);
  };

  return (
    <form onSubmit={submit} noValidate>
      <fieldset className="trip-types">
        <legend className="visually-hidden">Tipo de viaje</legend>
        {(
          [
            ['ROUND_TRIP', 'Ida y vuelta'],
            ['ONE_WAY', 'Solo ida'],
            ['MULTI_CITY', 'Multidestino'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className={`chip ${tripType === value ? 'is-active' : ''}`}>
            <input type="radio" name={`${id}-trip`} value={value} checked={tripType === value} onChange={() => changeTripType(value)} />
            {label}
          </label>
        ))}
      </fieldset>

      {legs.map((leg, index) => (
        <div className="search-row" key={index}>
          {tripType === 'MULTI_CITY' && <p className="leg-label">Tramo {index + 1}</p>}
          <AirportSelect id={`${id}-o${index}`} label="Origen" value={leg.origin} onChange={(origin) => updateLeg(index, { origin })} />
          <button
            type="button"
            className="swap"
            aria-label="Intercambiar origen y destino"
            onClick={() => updateLeg(index, { origin: leg.destination, destination: leg.origin })}
          >
            ⇄
          </button>
          <AirportSelect id={`${id}-d${index}`} label="Destino" value={leg.destination} onChange={(destination) => updateLeg(index, { destination })} />
          <div className="field">
            <label htmlFor={`${id}-date${index}`}>{tripType === 'ROUND_TRIP' ? 'Ida' : 'Fecha'}</label>
            <input id={`${id}-date${index}`} type="date" min={todayIso()} max={lastSaleDate()} value={leg.date} required onChange={(event) => updateLeg(index, { date: event.target.value })} />
          </div>
          {tripType === 'ROUND_TRIP' && (
            <div className="field">
              <label htmlFor={`${id}-return`}>Vuelta</label>
              <input id={`${id}-return`} type="date" min={leg.date} max={lastSaleDate()} value={returnDate} required onChange={(event) => setReturnDate(event.target.value)} />
            </div>
          )}
          {tripType === 'MULTI_CITY' && legs.length > 2 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLegs((current) => current.filter((_, position) => position !== index))}>
              Quitar
            </button>
          )}
        </div>
      ))}

      {tripType === 'MULTI_CITY' && legs.length < MAX_LEGS && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setLegs((current) => [...current, { origin: current.at(-1)!.destination, destination: 'UIO', date: current.at(-1)!.date }])}
        >
          + Agregar tramo
        </button>
      )}

      <div className="search-footer">
        <PassengerPicker value={passengers} onChange={setPassengers} />
        <button type="submit" className="btn btn-primary btn-lg">Buscar vuelos</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  );
}

function AirportSelect({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <AirportOptions />
      </select>
    </div>
  );
}

const PAX: { key: keyof PassengerBreakdown; label: string; hint: string; min: number }[] = [
  { key: 'adults', label: 'Adultos', hint: '15 años o más', min: 1 },
  { key: 'youths', label: 'Jóvenes', hint: '12 a 14 años', min: 0 },
  { key: 'children', label: 'Niños', hint: '2 a 11 años', min: 0 },
  { key: 'infants', label: 'Infantes', hint: 'Menores de 2, en brazos', min: 0 },
];

function PassengerPicker({ value, onChange }: { value: Required<PassengerBreakdown>; onChange: (value: Required<PassengerBreakdown>) => void }) {
  const total = value.adults + value.youths + value.children + value.infants;
  return (
    <details className="pax-picker">
      <summary>
        {total} pasajero{total > 1 ? 's' : ''}
      </summary>
      <div className="pax-panel">
        {PAX.map((item) => {
          const current = value[item.key]!;
          const max = item.key === 'infants' ? value.adults : 9;
          return (
            <div className="pax-row" key={item.key}>
              <div>
                <strong>{item.label}</strong>
                <span className="muted small"> {item.hint}</span>
              </div>
              <div className="stepper">
                <button type="button" aria-label={`Quitar ${item.label.toLowerCase()}`} disabled={current <= item.min}
                  onClick={() => onChange({ ...value, [item.key]: current - 1, ...(item.key === 'adults' && value.infants > current - 1 ? { infants: current - 1 } : {}) })}>
                  −
                </button>
                <output aria-live="polite">{current}</output>
                <button type="button" aria-label={`Agregar ${item.label.toLowerCase()}`} disabled={current >= max || total >= 9}
                  onClick={() => onChange({ ...value, [item.key]: current + 1 })}>
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function StatusForm() {
  const navigate = useNavigate();
  const id = useId();
  const [flightNumber, setFlightNumber] = useState('');
  const [date, setDate] = useState(todayIso());
  return (
    <form
      className="search-row"
      onSubmit={(event) => {
        event.preventDefault();
        navigate(`/estado-de-vuelo?vuelo=${encodeURIComponent(flightNumber.trim().toUpperCase())}&fecha=${date}`);
      }}
    >
      <div className="field">
        <label htmlFor={`${id}-flight`}>Número de vuelo</label>
        <input id={`${id}-flight`} placeholder="EA104" value={flightNumber} required maxLength={8} onChange={(event) => setFlightNumber(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-date`}>Fecha</label>
        <input id={`${id}-date`} type="date" value={date} required onChange={(event) => setDate(event.target.value)} />
      </div>
      <button type="submit" className="btn btn-primary">Consultar</button>
    </form>
  );
}
