import { Link, useLocation } from 'react-router-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useOnline } from '../lib/use-online';

/**
 * Avisos de la web progresiva. La versión nueva se instala solo si el cliente lo pide (`registerType: 'prompt'`): actualizar
 * recarga la página y eso cerraría la sesión, que vive en memoria, quizá en plena compra.
 */
export function PwaStatus() {
  const online = useOnline();
  const { pathname } = useLocation();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  return (
    <>
      {!online && (
        <div className="alert alert-info pwa-banner" role="status">
          <span>Sin conexión. {pathname !== '/sin-conexion' && <Link to="/sin-conexion">Ver mis viajes y pases guardados</Link>}</span>
        </div>
      )}
      {needRefresh && (
        <div className="alert alert-info pwa-banner" role="status">
          <span>Hay una versión nueva de EcoAirlines. Al actualizar se cerrará tu sesión.</span>
          <span className="row-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void updateServiceWorker(true)}>Actualizar</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNeedRefresh(false)}>Más tarde</button>
          </span>
        </div>
      )}
    </>
  );
}
