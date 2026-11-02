import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

/** Redirige a /ingresar conservando la página de destino; sin conexión no se puede ingresar: lleva a lo guardado. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const location = useLocation();
  if (!token) {
    if (!navigator.onLine) return <Navigate to="/sin-conexion" replace />;
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/ingresar?next=${next}`} replace />;
  }
  return <>{children}</>;
}
