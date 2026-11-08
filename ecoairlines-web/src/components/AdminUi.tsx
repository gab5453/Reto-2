import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';

const SECTIONS = [
  { to: '/admin', label: 'Panel', end: true },
  { to: '/admin/reservas', label: 'Reservas' },
  { to: '/admin/reportes', label: 'Reportes' },
  { to: '/admin/operaciones', label: 'Operaciones' },
  { to: '/admin/usuarios', label: 'Usuarios' },
  { to: '/admin/partners', label: 'Partners' },
  { to: '/admin/precios', label: 'Precios y promociones' },
  { to: '/admin/asistencia', label: 'Asistencia' },
  { to: '/admin/telemetria', label: 'Telemetría' },
  { to: '/admin/observabilidad', label: 'Observabilidad' },
];

/** Secciones del portal administrativo. Solo decide qué se muestra: el gateway verifica el scope en cada operación. */
export function AdminNav() {
  return (
    <nav className="container admin-nav" aria-label="Portal administrativo">
      {SECTIONS.map((section) => (
        <NavLink key={section.to} to={section.to} end={section.end}>{section.label}</NavLink>
      ))}
    </nav>
  );
}

/** Un indicador. Con `to`, la tarjeta entera es un enlace a su listado (panel O-3); `hint`, un detalle debajo del valor. */
export function Stat({ label, value, to, hint }: { label: string; value: ReactNode; to?: string; hint?: ReactNode }) {
  const body = (
    <>
      <p className="muted small">{label}</p>
      <p className="stat-value">{value}</p>
      {hint ? <p className="muted small">{hint}</p> : null}
    </>
  );
  return to ? <Link to={to} className="stat-card stat-link">{body}</Link> : <div className="stat-card">{body}</div>;
}

export function DataTable({ caption, headers, rows, empty }: { caption: string; headers: string[]; rows: ReactNode[][]; empty: string }) {
  return (
    <section className="card">
      <div className="table-wrap">
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>{headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={headers.length} className="muted">{empty}</td></tr>
            ) : (
              rows.map((row, index) => <tr key={index}>{row.map((cell, position) => <td key={position}>{cell}</td>)}</tr>)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Canal de una venta: «Booking» con su orden debajo, o «Web» (panel O-1). */
export function ChannelCell({ channel, order }: { channel: 'WEB' | 'BOOKING'; order: string | null }) {
  return channel === 'BOOKING' ? (
    <>
      <span className="status status-channel-booking">Booking</span>
      {order ? <span className="muted small block">{order}</span> : null}
    </>
  ) : (
    <span className="status">Web</span>
  );
}
