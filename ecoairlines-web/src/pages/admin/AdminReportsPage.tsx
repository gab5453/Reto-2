import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getSalesReport, type SalesReport } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { Stat } from '../../components/AdminUi';
import { ProblemAlert } from '../../components/ProblemAlert';
import { settlementCsv } from '../../lib/admin-bookings';
import { STATUS_LABELS, formatDateTime, formatMoney, localDate, todayIso } from '../../lib/format';

/**
 * Reportes del panel (O-3): ventas por día, canal y ruta, y la liquidación con Booking reserva por reserva, exportable a CSV
 * para cuadrar con ellos. El período vive en la URL. Días en hora de Ecuador; lo cobrado es lo que se cobró de verdad (sin
 * reservas fallidas ni pendientes de pago) y el neto, cobrado − reembolsado.
 */
export function AdminReportsPage() {
  const { token } = useAuth();
  const [params, setParams] = useSearchParams();
  const from = params.get('desde') ?? todayIso(-30);
  const to = params.get('hasta') ?? todayIso();
  const key = `${from}|${to}`;
  const [draft, setDraft] = useState({ from, to });
  const [result, setResult] = useState<{ key: string; report?: SalesReport; error?: unknown } | null>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    getSalesReport(token, from, to).then(
      (report) => active && setResult({ key, report }),
      (caught: unknown) => active && setResult({ key, error: caught }),
    );
    return () => {
      active = false;
    };
  }, [token, from, to, key]);

  const current = result?.key === key ? result : null;
  const report = current?.report;

  const apply = (event: FormEvent) => {
    event.preventDefault();
    setParams({ desde: draft.from, hasta: draft.to });
  };

  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([settlementCsv(report)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `liquidacion-booking-${report.from}-a-${report.to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="container section admin">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Portal administrativo</p>
          <h1>Reportes</h1>
          <p className="muted small">Ventas y liquidación con Booking. Días en hora de Ecuador; neto = cobrado − reembolsado.</p>
        </div>
      </header>

      <form className="filters" onSubmit={apply} aria-label="Período del reporte">
        <label className="inline-field">
          Desde
          <input type="date" value={draft.from} max={draft.to} required onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
        </label>
        <label className="inline-field">
          Hasta
          <input type="date" value={draft.to} min={draft.from} required onChange={(event) => setDraft({ ...draft, to: event.target.value })} />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!current}>Ver</button>
      </form>

      {current?.error ? <ProblemAlert error={current.error} /> : null}
      {!current ? <p className="muted">Calculando el reporte…</p> : null}

      {report && (
        <>
          <section className="stats-grid" aria-label="Totales del período">
            <Stat label="Reservas vendidas" value={report.totals.bookings} hint={`${report.totals.cancelled} canceladas · ${report.totals.passengers} pasajeros`} />
            <Stat label="Cobrado" value={formatMoney(report.totals.charged, report.currency)} />
            <Stat label="Reembolsado" value={formatMoney(report.totals.refunded, report.currency)} />
            <Stat label="Neto" value={formatMoney(report.totals.net, report.currency)} />
            {report.byChannel.map((channel) => (
              <Stat
                key={channel.channel}
                label={channel.channel === 'BOOKING' ? 'Por Booking' : 'Por la web'}
                value={formatMoney(channel.net, report.currency)}
                hint={`${channel.bookings} reservas · cobrado ${formatMoney(channel.charged, report.currency)}`}
                to={`/admin/reservas?canal=${channel.channel}&desde=${report.from}&hasta=${report.to}`}
              />
            ))}
          </section>

          <SalesByDay report={report} />

          <section className="card" aria-labelledby="liquidacion-booking">
            <div className="admin-section-head">
              <h2 id="liquidacion-booking">Liquidación con Booking</h2>
              <button type="button" className="btn btn-primary btn-sm" disabled={!report.bookingSettlement.items.length} onClick={download}>
                Exportar CSV
              </button>
            </div>
            <p className="muted small">
              Booking cobra al cliente y ejecuta los reembolsos que calculamos; EcoAirlines recibe el neto. Reembolsos pendientes de ejecutar:{' '}
              <strong>{report.bookingSettlement.pendingRefunds.count}</strong> por {formatMoney(report.bookingSettlement.pendingRefunds.amount, report.currency)}.
            </p>
            <div className="table-wrap">
              <table>
                <caption className="visually-hidden">Liquidación con Booking, reserva por reserva</caption>
                <thead>
                  <tr>
                    <th scope="col">Reserva</th>
                    <th scope="col">Referencia de pago</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Creada</th>
                    <th scope="col" className="num">Cobrado</th>
                    <th scope="col" className="num">Reembolsado</th>
                    <th scope="col" className="num">Neto</th>
                  </tr>
                </thead>
                <tbody>
                  {report.bookingSettlement.items.length === 0 ? (
                    <tr><td colSpan={7} className="muted">Booking no vendió en este período.</td></tr>
                  ) : (
                    report.bookingSettlement.items.map((item) => (
                      <tr key={item.bookingId}>
                        <td>
                          <Link to={`/admin/reservas/${item.bookingId}`} className="strong-link">{item.pnr}</Link>
                          {item.partnerOrderId ? <span className="muted small block">{item.partnerOrderId}</span> : null}
                        </td>
                        <td className="mono">{item.paymentReference}</td>
                        <td>{STATUS_LABELS[item.status] ?? item.status}</td>
                        <td className="small">{formatDateTime(item.createdAt)}</td>
                        <td className="num">{formatMoney(item.charged, report.currency)}</td>
                        <td className="num">{item.refunded === '0.00' ? '—' : `−${formatMoney(item.refunded, report.currency)}`}</td>
                        <td className="num">{formatMoney(item.net, report.currency)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
                {report.bookingSettlement.items.length ? (
                  <tfoot>
                    <tr className="strong">
                      <th scope="row" colSpan={4}>Total ({report.bookingSettlement.bookings} reservas)</th>
                      <td className="num">{formatMoney(report.bookingSettlement.charged, report.currency)}</td>
                      <td className="num">−{formatMoney(report.bookingSettlement.refunded, report.currency)}</td>
                      <td className="num">{formatMoney(report.bookingSettlement.net, report.currency)}</td>
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          </section>

          <section className="card" aria-labelledby="por-ruta">
            <h2 id="por-ruta">Ventas por ruta</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th scope="col">Ruta</th><th scope="col" className="num">Reservas</th><th scope="col" className="num">Pasajeros</th><th scope="col" className="num">Cobrado</th></tr>
                </thead>
                <tbody>
                  {report.byRoute.length === 0 ? (
                    <tr><td colSpan={4} className="muted">Sin ventas en el período.</td></tr>
                  ) : (
                    report.byRoute.map((route) => (
                      <tr key={`${route.origin}-${route.destination}`}>
                        <td>{route.origin} → {route.destination}</td>
                        <td className="num">{route.bookings}</td>
                        <td className="num">{route.passengers}</td>
                        <td className="num">{formatMoney(route.charged, report.currency)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <p className="muted small">Generado: {formatDateTime(report.generatedAt)}</p>
        </>
      )}
    </div>
  );
}

/** Barras por día: la web y Booking lado a lado, escaladas al día de mayor venta. */
function SalesByDay({ report }: { report: SalesReport }) {
  const days = [...new Set(report.byDay.map((row) => row.date))].sort().reverse();
  const amount = (date: string, channel: 'WEB' | 'BOOKING') => Number(report.byDay.find((row) => row.date === date && row.channel === channel)?.charged ?? 0);
  const max = Math.max(1, ...days.map((date) => amount(date, 'WEB') + amount(date, 'BOOKING')));
  return (
    <section className="card" aria-labelledby="por-dia">
      <h2 id="por-dia">Ventas por día</h2>
      <p className="muted small">
        <span className="legend legend-web" /> Web <span className="legend legend-booking" /> Booking
      </p>
      {days.length === 0 ? (
        <p className="muted">Sin ventas en el período.</p>
      ) : (
        <ul className="day-bars">
          {days.map((date) => {
            const web = amount(date, 'WEB');
            const booking = amount(date, 'BOOKING');
            return (
              <li key={date}>
                <span className="small">{localDate(date)}</span>
                <span className="day-bar" aria-hidden="true">
                  <span className="day-bar-web" style={{ width: `${(web / max) * 100}%` }} />
                  <span className="day-bar-booking" style={{ width: `${(booking / max) * 100}%` }} />
                </span>
                <span className="num small">{formatMoney(String(web + booking), report.currency)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
