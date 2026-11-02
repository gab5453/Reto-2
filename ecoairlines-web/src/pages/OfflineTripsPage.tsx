import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BoardingPassCard } from '../components/BoardingPassCard';
import { cityOf } from '../data/airports';
import { STATUS_LABELS, formatDateTime, localDate } from '../lib/format';
import { loadOfflineData } from '../lib/offline-trips';
import { useOnline } from '../lib/use-online';

/** Tus viajes y pases guardados en este dispositivo. No llama a ningún servicio ni pide sesión: tiene que abrir en modo avión. */
export function OfflineTripsPage() {
  const [data] = useState(() => loadOfflineData());
  const online = useOnline();
  const trips = data?.trips ?? [];
  const passes = data?.passes ?? [];

  return (
    <div className="container section narrow">
      <h1>Viajes guardados</h1>
      {data?.savedAt && <p className="muted small">Guardados en este dispositivo: {formatDateTime(data.savedAt)} · Pueden no reflejar cambios posteriores.</p>}

      {passes.length === 0 && trips.length === 0 ? (
        <div className="empty">
          <p>No hay nada guardado en este dispositivo.</p>
          <p className="muted small">Los pases se guardan cuando los abres en tu reserva, y los viajes cuando visitas «Mis viajes» con conexión.</p>
          {online && <Link to="/mis-viajes" className="btn btn-primary">Ir a Mis viajes</Link>}
        </div>
      ) : (
        <>
          {passes.length > 0 && (
            <section aria-labelledby="saved-passes-title">
              <h2 id="saved-passes-title">Pases de abordar</h2>
              <div className="passes">
                {passes.map((pass) => <BoardingPassCard key={`${pass.bookingId}-${pass.barcode}`} pass={pass} />)}
              </div>
            </section>
          )}
          {trips.length > 0 && (
            <section aria-labelledby="saved-trips-title">
              <h2 id="saved-trips-title">Mis viajes</h2>
              <ul className="trip-list">
                {trips.map((trip) => (
                  <li key={trip.bookingId}>
                    <div className="trip card">
                      <div>
                        <p className="trip-route">{trip.origin ? cityOf(trip.origin) : '—'} → {trip.destination ? cityOf(trip.destination) : '—'}</p>
                        <p className="muted small">{trip.departureDate ? localDate(trip.departureDate) : ''} · Código <strong>{trip.pnr}</strong></p>
                      </div>
                      <div className="trip-side">
                        <span className={`status status-${trip.status.toLowerCase()}`}>{STATUS_LABELS[trip.status] ?? trip.status}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
