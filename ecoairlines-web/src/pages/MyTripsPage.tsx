import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { listBookings } from '../api/operations';
import type { BookingListResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ProblemAlert } from '../components/ProblemAlert';
import { cityOf } from '../data/airports';
import { STATUS_LABELS, formatMoney, localDate } from '../lib/format';
import { saveTrips } from '../lib/offline-trips';

type Item = NonNullable<BookingListResponse['items']>[number];
const PAGE_SIZE = 10;

export function MyTripsPage({ title = 'Mis viajes', hint }: { title?: string; hint?: string }) {
  const { token, user } = useAuth();
  const [filters, setFilters] = useState({ pnr: '', status: '' });
  const [applied, setApplied] = useState({ pnr: '', status: '' });
  const [reloads, setReloads] = useState(0);
  const requestKey = `${JSON.stringify(applied)}#${reloads}`;
  const [page, setPage] = useState<{ key: string; items: Item[]; cursor?: string; error?: unknown }>({ key: '', items: [] });
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback(
    (cursor?: string) =>
      listBookings(token ?? '', {
        pnr: applied.pnr.trim().toUpperCase() || undefined,
        status: applied.status || undefined,
        limit: PAGE_SIZE,
        cursor,
      }),
    [token, applied],
  );

  useEffect(() => {
    if (!token) return;
    let active = true;
    fetchPage()
      .then((data) => {
        if (!active) return;
        setPage({ key: requestKey, items: data.items ?? [], cursor: data.nextCursor });
        // La lista completa (sin filtros) queda para verla sin conexión (PLAN.md §4.9).
        if (user && !applied.pnr && !applied.status) {
          saveTrips(user.email, (data.items ?? []).flatMap((item) => (item.bookingId && item.pnr && item.status ? [{ ...item, bookingId: item.bookingId, pnr: item.pnr, status: item.status }] : [])));
        }
      })
      .catch((error: unknown) => active && setPage({ key: requestKey, items: [], error }));
    return () => {
      active = false;
    };
  }, [token, user, applied, fetchPage, requestKey]);

  const current = page.key === requestKey ? page : undefined;
  const items = current?.items ?? [];
  const cursor = current?.cursor;
  const error = current?.error;
  const loading = !current || loadingMore;

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(cursor);
      setPage((previous) => ({ ...previous, items: [...previous.items, ...(data.items ?? [])], cursor: data.nextCursor }));
    } catch (caught) {
      setPage((previous) => ({ ...previous, error: caught }));
    } finally {
      setLoadingMore(false);
    }
  };
  const load = () => setReloads((value) => value + 1);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setApplied(filters);
  };

  return (
    <div className="container section">
      <h1>{title}</h1>
      {hint && <p className="muted">{hint}</p>}

      <form className="filters" onSubmit={submit}>
        <label className="inline-field">
          Código de reserva
          <input value={filters.pnr} maxLength={6} placeholder="ABC123" onChange={(event) => setFilters({ ...filters, pnr: event.target.value })} />
        </label>
        <label className="inline-field">
          Estado
          <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
            <option value="">Todos</option>
            {['CONFIRMED', 'PENDING_PAYMENT', 'CHANGE_PENDING', 'CANCELLED'].map((status) => (
              <option key={status} value={status}>{STATUS_LABELS[status]}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-ghost btn-sm">Filtrar</button>
      </form>

      {error ? <ProblemAlert error={error} onRetry={load} /> : null}
      {!loading && items.length === 0 && !error && (
        <div className="empty">
          <p>No encontramos reservas.</p>
          <Link to="/" className="btn btn-primary">Buscar vuelos</Link>
        </div>
      )}

      <ul className="trip-list">
        {items.map((item) => (
          <li key={item.bookingId}>
            <Link to={`/mis-viajes/${item.bookingId}`} className="trip card">
              <div>
                <p className="trip-route">
                  {item.origin ? cityOf(item.origin) : '—'} → {item.destination ? cityOf(item.destination) : '—'}
                </p>
                <p className="muted small">
                  {item.departureDate ? localDate(item.departureDate) : ''} · Código <strong>{item.pnr}</strong>
                </p>
              </div>
              <div className="trip-side">
                <span className={`status status-${(item.status ?? '').toLowerCase()}`}>{STATUS_LABELS[item.status ?? ''] ?? item.status}</span>
                <span className="small">{formatMoney(item.grandTotal)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {loading && <p className="muted" aria-live="polite">Cargando…</p>}
      {cursor && !loading && (
        <button type="button" className="btn btn-ghost" onClick={() => void loadMore()}>Cargar más</button>
      )}
    </div>
  );
}
