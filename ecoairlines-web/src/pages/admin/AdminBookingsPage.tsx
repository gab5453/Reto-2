import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { listAdminBookings, type AdminBookingFilter, type AdminBookingSummary } from '../../api/admin';
import type { BookingStatus } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ChannelCell } from '../../components/AdminUi';
import { ProblemAlert } from '../../components/ProblemAlert';
import { STATUS_LABELS, formatDateTime, formatMoney, localDate, localTime } from '../../lib/format';

const STATUSES: BookingStatus[] = ['CONFIRMED', 'TICKET_ISSUING', 'PENDING_PAYMENT', 'CHANGE_PENDING', 'CANCELLATION_PENDING', 'CANCELLED', 'FAILED'];

/** Los filtros viven en la URL: el panel puede enlazar a una lista ya filtrada y la búsqueda se puede compartir. */
function filterFrom(params: URLSearchParams): AdminBookingFilter {
  const filter: AdminBookingFilter = {};
  const reference = params.get('ref')?.trim();
  if (reference) filter.reference = reference;
  const status = params.get('estado');
  if (status && (STATUSES as string[]).includes(status)) filter.status = status as BookingStatus;
  const channel = params.get('canal');
  if (channel === 'WEB' || channel === 'BOOKING') filter.channel = channel;
  const from = params.get('desde');
  if (from) filter.createdFrom = from;
  const to = params.get('hasta');
  if (to) filter.createdTo = to;
  return filter;
}

/**
 * Reservas de todos los canales (panel O-1, solo lectura). Buscar por PNR, por la orden de Booking (ORD-BKP-…) o por la
 * referencia del pago (PAY-BKP-… o la de la Payment API): lo que antes obligaba a entrar a Swagger o a la base.
 */
export function AdminBookingsPage() {
  const { token } = useAuth();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState(() => Object.fromEntries(params.entries()) as Record<string, string>);
  const query = params.toString();
  // Cada resultado recuerda para qué filtros es: si cambian, lo anterior deja de mostrarse sin borrarlo en el efecto.
  const [page, setPage] = useState<{ key: string; items: AdminBookingSummary[]; cursor: string | null; error?: unknown } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!token) return;
    let active = true;
    listAdminBookings(token, filterFrom(new URLSearchParams(query))).then(
      (data) => active && setPage({ key: query, items: data.items, cursor: data.nextCursor }),
      (caught: unknown) => active && setPage({ key: query, items: [], cursor: null, error: caught }),
    );
    return () => {
      active = false;
    };
  }, [token, query]);

  const current = page?.key === query ? page : null;
  const items = current?.items ?? null;
  const cursor = current?.cursor ?? null;
  const error = current?.error ?? null;
  const busy = !current || loadingMore;

  const loadMore = useCallback(async () => {
    if (!token || !current?.cursor) return;
    setLoadingMore(true);
    try {
      const data = await listAdminBookings(token, filterFrom(new URLSearchParams(query)), current.cursor);
      setPage({ key: query, items: [...current.items, ...data.items], cursor: data.nextCursor });
    } catch (caught) {
      setPage({ ...current, error: caught });
    } finally {
      setLoadingMore(false);
    }
  }, [token, query, current]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(draft)) if (value.trim()) next.set(key, value.trim());
    setParams(next);
  };

  const field = (name: string) => ({ value: draft[name] ?? '', onChange: (event: { target: { value: string } }) => setDraft({ ...draft, [name]: event.target.value }) });
  const clear = () => {
    setDraft({});
    setParams(new URLSearchParams());
  };

  return (
      <div className="container section admin">
        <header className="admin-head">
          <div>
            <p className="eyebrow">Portal administrativo</p>
            <h1>Reservas</h1>
            <p className="muted small">Todas las ventas, de la web y de Booking. Solo lectura.</p>
          </div>
        </header>

        <form className="filters admin-bookings-filters" onSubmit={search} aria-label="Buscar reservas">
          <label className="inline-field">
            PNR, orden de Booking o referencia de pago
            <input {...field('ref')} placeholder="DHV47T · ORD-BKP-… · PAY-BKP-…" maxLength={80} />
          </label>
          <label className="inline-field">
            Estado
            <select {...field('estado')}>
              <option value="">Todos</option>
              {STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status] ?? status}</option>)}
            </select>
          </label>
          <label className="inline-field">
            Canal
            <select {...field('canal')}>
              <option value="">Todos</option>
              <option value="BOOKING">Booking</option>
              <option value="WEB">Web</option>
            </select>
          </label>
          <label className="inline-field">
            Creada desde
            <input type="date" {...field('desde')} />
          </label>
          <label className="inline-field">
            Creada hasta
            <input type="date" {...field('hasta')} min={draft['desde'] || undefined} />
          </label>
          <div className="admin-actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Buscar</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={clear}>Limpiar</button>
          </div>
        </form>

        {error ? <ProblemAlert error={error} /> : null}

        <section className="card">
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">Reservas</caption>
              <thead>
                <tr>
                  <th scope="col">Reserva</th>
                  <th scope="col">Canal</th>
                  <th scope="col">Vuelo</th>
                  <th scope="col">Pasajeros</th>
                  <th scope="col" className="num">Total</th>
                  <th scope="col" className="num">Reembolso</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Creada</th>
                </tr>
              </thead>
              <tbody>
                {items === null ? (
                  <tr><td colSpan={8} className="muted">Cargando…</td></tr>
                ) : items.length === 0 ? (
                  <tr><td colSpan={8} className="muted">No hay reservas con esos filtros.</td></tr>
                ) : (
                  items.map((item) => (
                    <tr key={item.bookingId}>
                      <td>
                        <Link to={`/admin/reservas/${item.bookingId}`} className="strong-link">{item.pnr}</Link>
                        <span className="muted small block">{item.bookingId.slice(0, 8)}</span>
                      </td>
                      <td><ChannelCell channel={item.channel} order={item.partnerOrderId} /></td>
                      <td>
                        {item.origin ?? '—'} → {item.destination ?? '—'}
                        <span className="muted small block">{item.departureAt ? `${localDate(item.departureAt)} · ${localTime(item.departureAt)}` : '—'}</span>
                      </td>
                      <td>{item.passengerCount}</td>
                      <td className="num">{formatMoney(item.grandTotal)}</td>
                      <td className="num">{item.refundTotal ? formatMoney(item.refundTotal, item.grandTotal.currency) : '—'}</td>
                      <td><span className={`status status-${item.status.toLowerCase()}`}>{STATUS_LABELS[item.status] ?? item.status}</span></td>
                      <td className="small">{formatDateTime(item.createdAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {cursor ? (
            <p className="load-more">
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void loadMore()}>{loadingMore ? 'Cargando…' : 'Ver más'}</button>
            </p>
          ) : null}
        </section>
      </div>
  );
}

