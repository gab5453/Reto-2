import { useCallback, useEffect, useState } from 'react';
import { getIndicators, getSalesReport, getServicesHealth, type AdminIndicators, type SalesReport, type ServiceHealth } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { Stat } from '../../components/AdminUi';
import { ProblemAlert } from '../../components/ProblemAlert';
import { cityOf } from '../../data/airports';
import { formatDateTime, formatMoney, todayIso } from '../../lib/format';
import { FleetPanel } from './FleetPanel';
import { RoutesPanel } from './RoutesPanel';

type Tab = 'SCHEDULE' | 'FLEET' | 'ROUTES';
const TABS: { id: Tab; label: string }[] = [
  { id: 'SCHEDULE', label: 'Rutas programadas' },
  { id: 'FLEET', label: 'Flota' },
  { id: 'ROUTES', label: 'Ventas por ruta' },
];

/**
 * Panel de administración (`adminIndicators` y demás operaciones de MS.Admin por GraphQL): indicadores con las ventas por
 * canal (web y Booking), rutas programadas (crear, editar y dar de baja), flota y ventas por ruta.
 */
export function AdminDashboardPage() {
  const { token } = useAuth();
  const [stats, setStats] = useState<AdminIndicators | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string>();
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>('SCHEDULE');
  // Panel O-3: el mes en curso con Booking y el estado de los servicios. Cada uno puede fallar solo; el resto del panel sigue.
  const [month, setMonth] = useState<SalesReport | null>(null);
  const [services, setServices] = useState<ServiceHealth[] | null>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    const today = todayIso();
    getSalesReport(token, `${today.slice(0, 8)}01`, today).then((report) => active && setMonth(report), () => undefined);
    getServicesHealth(token).then((list) => active && setServices(list), () => undefined);
    return () => {
      active = false;
    };
  }, [token]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setStats(await getIndicators(token));
      setRefreshedAt(new Date().toISOString());
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    getIndicators(token)
      .then((data) => {
        if (!active) return;
        setStats(data);
        setRefreshedAt(new Date().toISOString());
      })
      .catch((caught: unknown) => active && setError(caught));
    return () => {
      active = false;
    };
  }, [token]);

  if (!stats) {
    return (
      <div className="container section">
        {error ? <ProblemAlert error={error} onRetry={() => void load()} /> : <p className="muted">Cargando indicadores…</p>}
      </div>
    );
  }

  return (
    <div className="container section admin">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Portal administrativo</p>
          <h1>Operaciones EcoAirlines</h1>
          <p className="muted small">Actualizado: {formatDateTime(refreshedAt)}</p>
        </div>
        <div className="admin-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>Actualizar</button>
        </div>
      </header>

      {error ? <ProblemAlert error={error} /> : null}

      <section className="stats-grid" aria-label="Indicadores">
        <Stat label="Reservas" value={stats.totalBookings} to="/admin/reservas" />
        <Stat label="Por la web" value={stats.bookingsByChannel.web} to="/admin/reservas?canal=WEB" />
        <Stat label="Por Booking" value={stats.bookingsByChannel.booking} to="/admin/reservas?canal=BOOKING" />
        <Stat label="Pasajeros" value={stats.totalPassengers} />
        <Stat label="Ingresos netos" value={formatMoney(stats.revenue)} hint="Cobrado − reembolsos (incluye penalidades retenidas)" />
        <Stat label="Vuelos hoy" value={stats.flightsToday} />
        <Stat label="Clientes / administradores" value={`${stats.customers} / ${stats.admins}`} to="/admin/usuarios" />
        {month ? (
          <>
            <Stat
              label="Reembolsos pendientes de Booking"
              value={month.bookingSettlement.pendingRefunds.count}
              hint={`${formatMoney(month.bookingSettlement.pendingRefunds.amount, month.currency)} que ejecuta Booking`}
              to={`/admin/reportes?desde=${month.from}&hasta=${month.to}`}
            />
            <Stat
              label="Neto de Booking este mes"
              value={formatMoney(month.bookingSettlement.net, month.currency)}
              hint={`${month.bookingSettlement.bookings} reservas · cobrado ${formatMoney(month.bookingSettlement.charged, month.currency)}`}
              to={`/admin/reportes?desde=${month.from}&hasta=${month.to}`}
            />
          </>
        ) : null}
        {services ? (
          <Stat
            label="Estado del sistema"
            value={`${services.filter((item) => item.status === 'UP').length} / ${services.length} arriba`}
            hint={services.some((item) => item.status !== 'UP') ? `Con problemas: ${services.filter((item) => item.status !== 'UP').map((item) => item.service).join(', ')}` : 'Todo funciona'}
            to="/admin/telemetria"
          />
        ) : null}
      </section>

      <section className="card">
        <div className="tabs" role="tablist" aria-label="Secciones del panel">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`admin-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`admin-panel-${item.id}`}
              className={`tab ${tab === item.id ? 'is-active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div id={`admin-panel-${tab}`} role="tabpanel" aria-labelledby={`admin-tab-${tab}`} className="tab-panel">
          {tab === 'SCHEDULE' && <RoutesPanel onChanged={() => void load()} />}

          {tab === 'FLEET' && <FleetPanel />}

          {tab === 'ROUTES' && (
            stats.byRoute.length === 0 ? (
              <p className="muted">Todavía no hay ventas.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Ruta</th>
                      <th scope="col">Reservas</th>
                      <th scope="col">Ingresos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byRoute.map((route) => (
                      <tr key={`${route.origin}-${route.destination}`}>
                        <td>{cityOf(route.origin)} → {cityOf(route.destination)} <span className="muted small">({route.origin}-{route.destination})</span></td>
                        <td>{route.bookings}</td>
                        <td>{formatMoney(route.revenue, stats.revenue.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>
      </section>
    </div>
  );
}
