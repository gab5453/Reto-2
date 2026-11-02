import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { getBooking } from '../api/operations';
import type { BookingDetail, PassengerItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ItinerarySummary } from '../components/ItinerarySummary';
import { ProblemAlert } from '../components/ProblemAlert';
import { PASSENGER_LABELS, STATUS_LABELS, formatDateTime, formatMoney } from '../lib/format';
import { AssistancePanel } from './booking/AssistancePanel';
import { BaggagePanel } from './booking/BaggagePanel';
import { CancelPanel } from './booking/CancelPanel';
import { CheckInPanel } from './booking/CheckInPanel';
import { DateChangePanel } from './booking/DateChangePanel';
import { SeatChangePanel } from './booking/SeatChangePanel';

type Panel = 'CHECK_IN' | 'SEAT' | 'BAGGAGE' | 'ASSISTANCE' | 'DATE_CHANGE' | 'CANCEL';
const PANELS: { id: Panel; label: string }[] = [
  { id: 'CHECK_IN', label: 'Check-in y pases' },
  { id: 'SEAT', label: 'Cambiar asientos' },
  { id: 'BAGGAGE', label: 'Maletas' },
  { id: 'ASSISTANCE', label: 'Asistencia' },
  { id: 'DATE_CHANGE', label: 'Cambiar fecha' },
  { id: 'CANCEL', label: 'Cancelar' },
];
const IN_PROGRESS = ['PENDING', 'PENDING_PAYMENT', 'TICKET_ISSUING', 'CHANGE_PENDING', 'CANCELLATION_PENDING'];

export function BookingDetailPage() {
  const { bookingId = '' } = useParams();
  const { token } = useAuth();
  const location = useLocation();
  const justBooked = (location.state as { justBooked?: number } | null)?.justBooked;
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [panel, setPanel] = useState<Panel>(
    (location.state as { panel?: Panel } | null)?.panel ?? 'CHECK_IN',
  );

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setBooking(await getBooking(token, bookingId));
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [token, bookingId]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    getBooking(token, bookingId)
      .then((data) => active && setBooking(data))
      .catch((caught: unknown) => active && setError(caught));
    return () => {
      active = false;
    };
  }, [token, bookingId]);

  // Operaciones asíncronas del contrato (202): se consulta hasta que terminen.
  useEffect(() => {
    if (!booking || !IN_PROGRESS.includes(booking.status)) return;
    const timer = window.setTimeout(() => void refresh(), 2000);
    return () => window.clearTimeout(timer);
  }, [booking, refresh]);

  if (error && !booking) {
    return (
      <div className="container section narrow">
        <ProblemAlert error={error} />
        <Link to="/mis-viajes" className="btn btn-ghost">Volver a mis viajes</Link>
      </div>
    );
  }
  if (!booking) return <p className="container section muted">Cargando reserva…</p>;

  const confirmed = booking.status === 'CONFIRMED';

  return (
    <div className="container section booking-detail">
      {justBooked === 201 && (
        <div className="alert alert-success" role="status">
          <p className="alert-title">¡Reserva confirmada! Tus boletos ya fueron emitidos.</p>
          <p>Te esperamos a bordo. Las emisiones de tu vuelo quedan compensadas. 🌱</p>
        </div>
      )}
      {justBooked === 202 && IN_PROGRESS.includes(booking.status) && (
        <div className="alert alert-info" role="status">
          <p className="alert-title">Estamos confirmando tu pago.</p>
          <p>Tu reserva está creada; emitiremos los boletos en cuanto la pasarela confirme el pago. Esta página se actualiza sola.</p>
        </div>
      )}

      <header className="booking-head card">
        <div>
          <p className="muted small">Código de reserva</p>
          <p className="pnr">{booking.pnr}</p>
        </div>
        <div>
          <p className="muted small">Estado</p>
          <span className={`status status-${booking.status.toLowerCase()}`}>{STATUS_LABELS[booking.status] ?? booking.status}</span>
        </div>
        <div>
          <p className="muted small">Total pagado</p>
          <p className="booking-total">{formatMoney(booking.grandTotal)}</p>
        </div>
      </header>

      <section className="card" aria-labelledby="itin-title">
        <h2 id="itin-title">Itinerario</h2>
        {booking.itineraries?.map((itinerary, index) => (
          <div key={itinerary.itineraryId} className="checkout-itinerary">
            <ItinerarySummary itinerary={itinerary} cabinClass={itinerary.pricingOptions[0]?.cabinClass} label={`Vuelo ${index + 1}`} />
            <p className="small">
              Tarifa <strong>{itinerary.pricingOptions[0]?.fareBrand}</strong>
              {itinerary.pricingOptions[0] && (
                <> · {itinerary.pricingOptions[0].fareRules.isChangeable ? 'Admite cambios' : 'Sin cambios'} ·{' '}
                  {itinerary.pricingOptions[0].fareRules.isRefundable ? 'Reembolsable' : 'No reembolsable'}</>
              )}
            </p>
          </div>
        ))}
      </section>

      <section className="card" aria-labelledby="pax-title">
        <h2 id="pax-title">Pasajeros y boletos</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Pasajero</th>
                <th scope="col">Asientos</th>
                <th scope="col" title="Maletas de bodega en todos los vuelos: total (las extra pagadas)">Maletas (Extra)</th>
                <th scope="col">Boleto</th>
              </tr>
            </thead>
            <tbody>
              {booking.passengers?.map((passenger) => {
                const ticket = booking.tickets?.find((candidate) => candidate.passengerId === passenger.passengerId);
                return (
                  <tr key={passenger.passengerId}>
                    <td>
                      {passenger.firstName} {passenger.lastName}
                      <span className="muted small"> · {PASSENGER_LABELS[passenger.passengerType]}</span>
                    </td>
                    <td>{passenger.assignedSeats?.map((seat) => seat.seatNumber).join(', ') || '—'}</td>
                    <td>{baggageSummary(booking, passenger)}</td>
                    <td>
                      {ticket?.eTicketNumber ?? '—'}
                      {ticket && <span className="muted small"> · {STATUS_LABELS[ticket.status] ?? ticket.status}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {(booking.tickets?.length ?? 0) > 0 && (
        <section className="card" aria-labelledby="tickets-title">
          <h2 id="tickets-title">Estado de los boletos</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Boleto</th>
                  <th scope="col">Pasajero</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Tramos</th>
                </tr>
              </thead>
              <tbody>
                {booking.tickets?.map((ticket) => (
                  <tr key={ticket.ticketId}>
                    <td>{ticket.eTicketNumber ?? '—'}</td>
                    <td>{ticket.passengerName ?? passengerName(booking, ticket.passengerId)}</td>
                    <td>
                      <span className={`status status-${ticket.status.toLowerCase()}`}>{STATUS_LABELS[ticket.status] ?? ticket.status}</span>
                      {ticket.failureReason && <span className="muted small"> · {ticket.failureReason}</span>}
                    </td>
                    <td className="small">
                      {ticket.segments?.map((segment) => (
                        <div key={segment.segmentId}>
                          {segment.flightNumber ?? segment.segmentId}
                          {segment.departureIataCode && ` ${segment.departureIataCode} → ${segment.arrivalIataCode}`}
                          {segment.seatNumber && ` · asiento ${segment.seatNumber}`} · {STATUS_LABELS[segment.status] ?? segment.status}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {confirmed && (
        <section className="card" aria-label="Gestionar reserva">
          <div className="tabs" role="tablist" aria-label="Gestionar reserva">
            {PANELS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`panel-tab-${item.id}`}
                aria-selected={panel === item.id}
                aria-controls={`panel-${item.id}`}
                className={`tab ${panel === item.id ? 'is-active' : ''}`}
                onClick={() => setPanel(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div id={`panel-${panel}`} role="tabpanel" aria-labelledby={`panel-tab-${panel}`} className="tab-panel">
            {panel === 'CHECK_IN' && <CheckInPanel booking={booking} onChanged={refresh} />}
            {panel === 'SEAT' && <SeatChangePanel booking={booking} onChanged={refresh} />}
            {panel === 'BAGGAGE' && <BaggagePanel booking={booking} onChanged={refresh} />}
            {panel === 'ASSISTANCE' && <AssistancePanel booking={booking} />}
            {panel === 'DATE_CHANGE' && <DateChangePanel booking={booking} onChanged={refresh} />}
            {panel === 'CANCEL' && <CancelPanel booking={booking} onChanged={refresh} />}
          </div>
        </section>
      )}

      {(booking.changes?.length ?? 0) > 0 && (
        <section className="card" aria-labelledby="hist-title">
          <h2 id="hist-title">Historial</h2>
          <ol className="timeline">
            {[...(booking.changes ?? [])].reverse().map((change, index) => (
              <li key={index}>
                <span className="muted small">{formatDateTime(change.changedAt)}</span>
                <p>{change.description}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function passengerName(booking: BookingDetail, passengerId: string): string {
  const passenger = booking.passengers?.find((candidate) => candidate.passengerId === passengerId);
  return passenger ? `${passenger.firstName} ${passenger.lastName}` : passengerId;
}

/**
 * Maletas de bodega del pasajero en todos los vuelos, como "total (extra)": las incluidas en la tarifa comprada de cada
 * itinerario más las extra pagadas. Los infantes no tienen franquicia propia.
 */
function baggageSummary(booking: BookingDetail, passenger: PassengerItem): string {
  if (passenger.passengerType === 'INFANT') return '—';
  const extra = passenger.extraBaggage?.reduce((sum, bag) => sum + bag.quantity, 0) ?? 0;
  const included = (booking.itineraries ?? []).reduce(
    (sum, itinerary) => sum + (itinerary.pricingOptions[0]?.baggageAllowance.checkedBaggageIncluded ?? 0),
    0,
  );
  return `${included + extra} (${extra})`;
}
