import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getAdminBooking, type AdminBooking } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { ChannelCell } from '../../components/AdminUi';
import { ProblemAlert } from '../../components/ProblemAlert';
import { maskDocument, settlementOf, summaryText } from '../../lib/admin-bookings';
import { PASSENGER_LABELS, STATUS_LABELS, formatDateTime, formatMoney, localDate, localTime } from '../../lib/format';
import { BookingTimelinePanel } from './BookingTimelinePanel';
import { FlightDelayNotice } from '../../components/FlightDelayNotice';

const OPERATION_LABELS: Record<string, string> = { BOOKING: 'Reserva', SEATS: 'Asientos', BAGGAGE: 'Maletas', DATE_CHANGE: 'Cambio de fecha' };
const PROVIDER_LABELS: Record<string, string> = { BOOKING_PROTOTIPO: 'Booking (cobra Booking)', AIRLINE_DIRECT: 'Payment API (web)' };

/** Detalle de cualquier reserva (panel O-1, solo lectura, D-O4): página propia para poder enlazarla (D-O1). */
export function AdminBookingDetailPage() {
  const { bookingId = '' } = useParams();
  const { token } = useAuth();
  // La respuesta guarda de qué reserva es: si cambia el id, lo anterior no se muestra (sin borrar el estado en el efecto).
  const [result, setResult] = useState<{ id: string; booking?: AdminBooking; error?: unknown } | null>(null);
  const [showDocuments, setShowDocuments] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token) return;
    let active = true;
    getAdminBooking(token, bookingId).then(
      (data) => active && setResult({ id: bookingId, booking: data }),
      (caught: unknown) => active && setResult({ id: bookingId, error: caught }),
    );
    return () => {
      active = false;
    };
  }, [token, bookingId]);

  const current = result?.id === bookingId ? result : null;
  const booking = current?.booking ?? null;
  const error = current?.error ?? null;

  const copy = async () => {
    if (!booking) return;
    await navigator.clipboard.writeText(summaryText(booking));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  };

  if (error) {
    return (
      <div className="container section admin">
        <p><Link to="/admin/reservas">← Reservas</Link></p>
        <ProblemAlert error={error} />
      </div>
    );
  }
  if (!booking) return <div className="container section admin"><p className="muted">Cargando la reserva…</p></div>;

  const s = settlementOf(booking);
  const seatOf = (passengerId: string, segmentId: string) =>
    booking.passengers.find((p) => p.passengerId === passengerId)?.assignedSeats?.find((seat) => seat.segmentId === segmentId)?.seatNumber ?? '—';
  const segments = booking.itineraries.flatMap((itinerary) => itinerary.segments);

  return (
    <div className="container section admin admin-booking">
      <p><Link to="/admin/reservas">← Reservas</Link></p>
      <header className="admin-head">
        <div>
          <p className="eyebrow">Reserva</p>
          <h1>{booking.pnr} <span className={`status status-${booking.status.toLowerCase()}`}>{STATUS_LABELS[booking.status] ?? booking.status}</span></h1>
          <p className="muted small">{booking.bookingId}</p>
        </div>
        <div className="admin-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void copy()}>{copied ? 'Copiado ✓' : 'Copiar resumen para Booking'}</button>
        </div>
      </header>

      {booking.status === 'CONFIRMED' && <FlightDelayNotice segments={segments} />}

      <div className="admin-booking-grid">
        <section className="card" aria-labelledby="resumen">
          <h2 id="resumen">Resumen</h2>
          <dl className="kv">
            <dt>Canal</dt><dd><ChannelCell channel={booking.channel} order={null} /></dd>
            {booking.salesChannel?.partnerId ? <><dt>Partner</dt><dd>{booking.salesChannel.partnerId}</dd></> : null}
            {booking.salesChannel?.partnerOrderId ? <><dt>Orden de Booking</dt><dd className="mono">{booking.salesChannel.partnerOrderId}</dd></> : null}
            {booking.partnerUserId ? <><dt>Usuario de Booking</dt><dd className="mono">{booking.partnerUserId}</dd></> : null}
            {booking.salesChannel?.packageId ? <><dt>Combo</dt><dd className="mono">{booking.salesChannel.packageId}</dd></> : null}
            {booking.salesChannel?.promotionApplied ? <><dt>Promoción</dt><dd>{booking.salesChannel.discountPercentage ?? 0} %</dd></> : null}
            <dt>Referencia de pago</dt><dd className="mono">{booking.paymentReference ?? '—'}</dd>
            <dt>Creada</dt><dd>{formatDateTime(booking.createdAt)}</dd>
            <dt>Actualizada</dt><dd>{formatDateTime(booking.updatedAt ?? undefined)}</dd>
          </dl>
        </section>

        <section className="card" aria-labelledby="liquidacion">
          <h2 id="liquidacion">Liquidación</h2>
          <table className="settlement">
            <caption className="visually-hidden">Liquidación de la reserva</caption>
            <tbody>
              <tr><th scope="row">Tarifa base</th><td className="num">{booking.grandTotal.baseFare ? formatMoney(booking.grandTotal.baseFare, s.currency) : '—'}</td></tr>
              <tr><th scope="row">Impuestos</th><td className="num">{booking.grandTotal.taxes ? formatMoney(booking.grandTotal.taxes, s.currency) : '—'}</td></tr>
              <tr className="strong"><th scope="row">Total cobrado {booking.channel === 'BOOKING' ? '(por Booking)' : '(Payment API)'}</th><td className="num">{formatMoney(s.charged, s.currency)}</td></tr>
              {booking.refunds.map((refund) => (
                <tr key={refund.refundId}>
                  <th scope="row">Reembolso {refund.refundId} · {refund.status === 'CALCULATED' ? 'calculado, lo ejecuta Booking' : refund.status === 'SETTLED' ? 'ejecutado' : 'no reembolsable'}</th>
                  <td className="num">−{formatMoney(refund.amount, refund.currency)}</td>
                </tr>
              ))}
              {booking.refunds.length ? <tr><th scope="row">Penalidad retenida</th><td className="num">{formatMoney(s.penalty, s.currency)}</td></tr> : null}
              <tr className="strong"><th scope="row">Neto a favor de EcoAirlines</th><td className="num">{formatMoney(s.net, s.currency)}</td></tr>
            </tbody>
          </table>
          <p className="muted small">EcoAirlines no emite facturas: la facturación es del sistema de Facturación del ecosistema (contrato v2).</p>
        </section>
      </div>

      <section className="card" aria-labelledby="itinerario">
        <h2 id="itinerario">Itinerario y tarifas</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Vuelo</th><th scope="col">Ruta</th><th scope="col">Salida</th><th scope="col">Cabina y familia</th><th scope="col">Asientos</th></tr></thead>
            <tbody>
              {segments.map((segment) => {
                const fare = booking.fares.find((candidate) => candidate.segmentIds.includes(segment.segmentId));
                return (
                  <tr key={segment.segmentId}>
                    <td>{segment.flightNumber}</td>
                    <td>{segment.departure.iataCode} → {segment.arrival.iataCode}</td>
                    <td>{localDate(segment.departure.at)} · {localTime(segment.departure.at)}</td>
                    <td>{fare ? `${fare.cabinClass} · ${fare.fareBrand}${fare.isRefundable ? ' · reembolsable' : ''}` : '—'}</td>
                    <td className="small">{booking.passengers.map((p) => `${p.firstName}: ${seatOf(p.passengerId, segment.segmentId)}`).join(' · ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="pasajeros">
        <div className="admin-section-head">
          <h2 id="pasajeros">Pasajeros</h2>
          <button type="button" className="btn btn-ghost btn-sm" aria-pressed={showDocuments} onClick={() => setShowDocuments(!showDocuments)}>
            {showDocuments ? 'Ocultar documentos' : 'Mostrar documentos'}
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Pasajero</th><th scope="col">Tipo</th><th scope="col">Documento</th><th scope="col">Asistencia</th></tr></thead>
            <tbody>
              {booking.passengers.map((p) => (
                <tr key={p.passengerId}>
                  <td>{p.firstName} {p.lastName}</td>
                  <td>{PASSENGER_LABELS[p.passengerType] ?? p.passengerType}</td>
                  <td className="mono">{p.documentType} {showDocuments ? p.documentNumber : maskDocument(p.documentNumber)}</td>
                  <td>{booking.passengersWithAssistance.includes(p.passengerId) ? 'Sí' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="boletos">
        <h2 id="boletos">Boletos</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Número</th><th scope="col">Pasajero</th><th scope="col">Estado</th><th scope="col">Emitido</th></tr></thead>
            <tbody>
              {booking.tickets.length === 0 ? <tr><td colSpan={4} className="muted">Sin boletos.</td></tr> : booking.tickets.map((ticket) => (
                <tr key={ticket.ticketId}>
                  <td className="mono">{ticket.eTicketNumber ?? ticket.ticketId}</td>
                  <td>{ticket.passengerName ?? ticket.passengerId}</td>
                  <td>{STATUS_LABELS[ticket.status] ?? ticket.status}{ticket.failureReason ? <span className="muted small"> · {ticket.failureReason}</span> : null}</td>
                  <td className="small">{formatDateTime(ticket.issuedAt ?? undefined)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="pagos">
        <h2 id="pagos">Pagos registrados</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Referencia</th><th scope="col">Operación</th><th scope="col">Proveedor</th><th scope="col" className="num">Monto</th><th scope="col">Registrado</th></tr></thead>
            <tbody>
              {booking.payments.length === 0 ? <tr><td colSpan={5} className="muted">Sin pagos registrados.</td></tr> : booking.payments.map((payment) => (
                <tr key={payment.paymentReference}>
                  <td className="mono">{payment.paymentReference}</td>
                  <td>{OPERATION_LABELS[payment.operation] ?? payment.operation}</td>
                  <td>{PROVIDER_LABELS[payment.provider] ?? payment.provider}</td>
                  <td className="num">{formatMoney(payment.amount)}</td>
                  <td className="small">{formatDateTime(payment.claimedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {token ? <BookingTimelinePanel token={token} bookingId={booking.bookingId} changes={booking.changes} /> : null}
    </div>
  );
}
