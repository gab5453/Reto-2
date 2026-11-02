import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AdminNav } from '../components/AdminUi';
import { useAuth } from './AuthContext';
import { RequireAuth } from './RequireAuth';

/**
 * Páginas de administración y observabilidad: exige sesión y rol ADMIN. Es solo para la interfaz; la API
 * rechaza igualmente (401/403) cualquier petición sin el scope `ecoairlines:admin`.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  return (
    <RequireAuth>
      {isAdmin ? (
        <>
          <AdminNav />
          {children}
        </>
      ) : (
        <div className="container section narrow">
          <h1>Acceso restringido</h1>
          <p className="muted">Esta sección es solo para administradores de EcoAirlines. Ingresa con una cuenta de administrador.</p>
          <Link to="/" className="btn btn-primary">Volver al inicio</Link>
        </div>
      )}
    </RequireAuth>
  );
}
