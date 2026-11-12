import { useState } from 'react';
import { cancelBooking, getCancellationQuote } from '../../api/operations';
import type { BookingDetail, CancellationQuoteResponse } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Countdown } from '../../components/Countdown';
import { ProblemAlert } from '../../components/ProblemAlert';
import { formatMoney } from '../../lib/format';
import { useIdempotencyKey } from '../../lib/request-ids';

/** Cotiza primero (monto a reembolsar y penalidad) y pide confirmación explícita antes de cancelar. */
export function CancelPanel({ booking, checkedIn = false, onChanged }: { booking: BookingDetail; checkedIn?: boolean; onChanged: () => Promise<void> }) {
  const { token } = useAuth();
  const [quote, setQuote] = useState<CancellationQuoteResponse | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const idempotency = useIdempotencyKey([quote?.quoteId, reason]);

  const requestQuote = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setQuote(await getCancellationQuote(token, booking.bookingId));
      setConfirmed(false);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!token || !quote) return;
    setBusy(true);
    setError(null);
    try {
      await cancelBooking(token, idempotency.key(), booking.bookingId, { quoteId: quote.quoteId, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      idempotency.renew();
      await onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-form">
      {checkedIn && (
        <p className="alert alert-warning" role="note">
          Ya hiciste check-in: si cancelas, tus pases de abordar dejan de ser válidos (también los guardados en este dispositivo).
        </p>
      )}
      {!quote && (
        <>
          <p className="muted">Primero te mostramos cuánto se reembolsa según tu tarifa. Nada se cancela hasta que lo confirmes.</p>
          <button type="button" className="btn btn-ghost" onClick={requestQuote} disabled={busy}>
            {busy ? 'Cotizando…' : 'Ver cotización de cancelación'}
          </button>
        </>
      )}
      {quote && (
        <div className="quote">
          <dl className="price-list">
            <div><dt>Reembolso</dt><dd>{formatMoney(quote.refundAmount, quote.currency)}</dd></div>
            <div><dt>Penalidad</dt><dd>{formatMoney(quote.penaltyAmount, quote.currency)}</dd></div>
          </dl>
          <p className="small muted">
            {quote.isRefundable ? 'Tu tarifa es reembolsable.' : 'Tu tarifa no es reembolsable: se devuelven los impuestos.'} Cotización válida por{' '}
            <Countdown expiresAt={quote.expiresAt} onExpire={() => setQuote(null)} />.
          </p>
          <label className="field">
            Motivo (opcional)
            <input value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} />
          </label>
          <label className="inline-field">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            Entiendo que la cancelación no se puede deshacer.
          </label>
          <button type="button" className="btn btn-danger" onClick={cancel} disabled={busy || !confirmed}>
            {busy ? 'Cancelando…' : 'Cancelar reserva'}
          </button>
        </div>
      )}
      {error ? <ProblemAlert error={error} /> : null}
    </div>
  );
}
