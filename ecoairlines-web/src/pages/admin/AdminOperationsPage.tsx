import { AdminFlightsPanel } from './AdminFlightsPanel';

/** Operaciones: ocupación por vuelo y cabina, holds, alertas y cambio de estado de vuelo. */
export function AdminOperationsPage() {
  return (
    <div className="container section admin">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Portal administrativo</p>
          <h1>Operaciones</h1>
        </div>
      </header>
      <section className="card">
        <AdminFlightsPanel />
      </section>
    </div>
  );
}
