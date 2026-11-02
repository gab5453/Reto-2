import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

const SECTIONS = [
  { to: '/admin', label: 'Panel', end: true },
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

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat-card">
      <p className="muted small">{label}</p>
      <p className="stat-value">{value}</p>
    </div>
  );
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
