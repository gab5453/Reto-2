import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadAirports } from './data/airports';
import './index.css';
import { initObservability } from './lib/observability';

// Observabilidad del navegador (solo localStorage); el administrador la consulta en /admin/observabilidad.
initObservability();

// M-1: el catálogo de aeropuertos viene de la API. Se espera un momento para que los selectores nazcan completos; si tarda, la
// página arranca con la lista de respaldo y los selectores se actualizan solos cuando llegue.
const airports = loadAirports().catch(() => undefined);
void Promise.race([airports, new Promise((resolve) => setTimeout(resolve, 1_500))]).then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
