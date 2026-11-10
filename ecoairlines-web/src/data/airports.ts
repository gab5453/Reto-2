import { useSyncExternalStore } from 'react';
import { graphql } from '../api/client';

/**
 * Aeropuertos de la red. Desde M-1 (PLAN_Telemetria_Asientos) el catálogo lo administra el panel («Aeropuertos») y la web lo
 * pide al arrancar (`airports`, consulta pública del GraphQL); esta lista es la de respaldo si la API no responde. Se usa en
 * los selectores y para estimar distancias (CO₂).
 */
export interface AirportInfo {
  code: string;
  city: string;
  country: string;
  /** Provincia (solo Ecuador): los selectores agrupan la red nacional por provincia. */
  province?: string;
  lat: number;
  lon: number;
  /** `false`: desactivado por el administrador; no se ofrece en los selectores. */
  active?: boolean;
}

export const AIRPORTS: AirportInfo[] = [
  { code: 'UIO', city: 'Quito', country: 'Ecuador', province: 'Pichincha', lat: -0.1292, lon: -78.3575 },
  { code: 'GYE', city: 'Guayaquil', country: 'Ecuador', province: 'Guayas', lat: -2.1574, lon: -79.8836 },
  { code: 'CUE', city: 'Cuenca', country: 'Ecuador', province: 'Azuay', lat: -2.8895, lon: -78.9844 },
  { code: 'GDA', city: 'Guaranda', country: 'Ecuador', province: 'Bolívar', lat: -1.5926, lon: -79.001 },
  { code: 'AZG', city: 'Azogues', country: 'Ecuador', province: 'Cañar', lat: -2.7397, lon: -78.8486 },
  { code: 'TUA', city: 'Tulcán', country: 'Ecuador', province: 'Carchi', lat: 0.8095, lon: -77.7081 },
  { code: 'RBA', city: 'Riobamba', country: 'Ecuador', province: 'Chimborazo', lat: -1.6536, lon: -78.6564 },
  { code: 'LTX', city: 'Latacunga', country: 'Ecuador', province: 'Cotopaxi', lat: -0.9068, lon: -78.6158 },
  { code: 'MCH', city: 'Machala', country: 'Ecuador', province: 'El Oro', lat: -3.2689, lon: -79.9616 },
  { code: 'ETR', city: 'Santa Rosa', country: 'Ecuador', province: 'El Oro', lat: -3.4419, lon: -79.997 },
  { code: 'ESM', city: 'Esmeraldas', country: 'Ecuador', province: 'Esmeraldas', lat: 0.9785, lon: -79.6266 },
  { code: 'SCY', city: 'Puerto Baquerizo Moreno', country: 'Ecuador', province: 'Galápagos', lat: -0.9102, lon: -89.6175 },
  { code: 'IBR', city: 'Ibarra', country: 'Ecuador', province: 'Imbabura', lat: 0.3517, lon: -78.1222 },
  { code: 'LOH', city: 'Loja', country: 'Ecuador', province: 'Loja', lat: -3.9959, lon: -79.3719 },
  { code: 'BHO', city: 'Babahoyo', country: 'Ecuador', province: 'Los Ríos', lat: -1.8017, lon: -79.5346 },
  { code: 'PVO', city: 'Portoviejo', country: 'Ecuador', province: 'Manabí', lat: -1.0416, lon: -80.4722 },
  { code: 'MEC', city: 'Manta', country: 'Ecuador', province: 'Manabí', lat: -0.9461, lon: -80.6788 },
  { code: 'XMS', city: 'Macas', country: 'Ecuador', province: 'Morona Santiago', lat: -2.2992, lon: -78.1208 },
  { code: 'TNW', city: 'Tena', country: 'Ecuador', province: 'Napo', lat: -1.0597, lon: -77.5833 },
  { code: 'OCC', city: 'Francisco de Orellana', country: 'Ecuador', province: 'Orellana', lat: -0.4629, lon: -76.9868 },
  { code: 'PTZ', city: 'Puyo', country: 'Ecuador', province: 'Pastaza', lat: -1.5052, lon: -78.0627 },
  { code: 'STE', city: 'Santa Elena', country: 'Ecuador', province: 'Santa Elena', lat: -2.2262, lon: -80.859 },
  { code: 'SNC', city: 'Salinas', country: 'Ecuador', province: 'Santa Elena', lat: -2.205, lon: -80.9889 },
  { code: 'SDT', city: 'Santo Domingo', country: 'Ecuador', province: 'Santo Domingo de los Tsáchilas', lat: -0.253, lon: -79.1754 },
  { code: 'LGQ', city: 'Nueva Loja', country: 'Ecuador', province: 'Sucumbíos', lat: 0.0931, lon: -76.8675 },
  { code: 'ATF', city: 'Ambato', country: 'Ecuador', province: 'Tungurahua', lat: -1.212, lon: -78.5746 },
  { code: 'ZMR', city: 'Zamora', country: 'Ecuador', province: 'Zamora Chinchipe', lat: -4.0692, lon: -78.9567 },
  { code: 'BOG', city: 'Bogotá', country: 'Colombia', lat: 4.7016, lon: -74.1469 },
  { code: 'MDE', city: 'Medellín', country: 'Colombia', lat: 6.1645, lon: -75.4231 },
  { code: 'LIM', city: 'Lima', country: 'Perú', lat: -12.0219, lon: -77.1143 },
  { code: 'SCL', city: 'Santiago', country: 'Chile', lat: -33.393, lon: -70.7858 },
  { code: 'MIA', city: 'Miami', country: 'Estados Unidos', lat: 25.7959, lon: -80.287 },
  { code: 'MEX', city: 'Ciudad de México', country: 'México', lat: 19.4361, lon: -99.0719 },
  { code: 'MAD', city: 'Madrid', country: 'España', lat: 40.4983, lon: -3.5676 },
];

export const airportByCode = (code: string): AirportInfo | undefined => AIRPORTS.find((airport) => airport.code === code);

export const cityOf = (code: string): string => airportByCode(code)?.city ?? code;

// ── Catálogo vivo (M-1) ──

const countryName = (() => {
  try {
    const names = new Intl.DisplayNames(['es'], { type: 'region' });
    return (code: string) => names.of(code) ?? code;
  } catch {
    return (code: string) => code;
  }
})();

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Reemplaza la lista por la de la API. El país llega como código ISO (EC) y se muestra con su nombre (Ecuador). */
export async function loadAirports(): Promise<void> {
  const data = await graphql<{ airports: { code: string; city: string; country: string; province: string | null; lat: number; lon: number; active: boolean }[] }>(
    'query Aeropuertos { airports { code city country province lat lon active } }',
  );
  if (!data.airports.length) return;
  AIRPORTS.splice(
    0,
    AIRPORTS.length,
    ...data.airports.map((airport) => ({
      code: airport.code,
      city: airport.city,
      country: countryName(airport.country),
      ...(airport.province ? { province: airport.province } : {}),
      lat: airport.lat,
      lon: airport.lon,
      active: airport.active,
    })),
  );
  version++;
  // Marca que el catálogo ya es el de la API (no el de respaldo); la usan los recorridos de prueba.
  document.documentElement.dataset['airports'] = 'api';
  for (const listener of listeners) listener();
}

/** Para los componentes que listan aeropuertos: se vuelven a pintar cuando llega o cambia el catálogo. */
export const useAirportsVersion = () => useSyncExternalStore(subscribe, () => version);

