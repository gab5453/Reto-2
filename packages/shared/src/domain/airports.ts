/**
 * Aeropuertos de la red simulada. Los desfases horarios son fijos (sin horario de verano):
 * es una simplificación del mock, no del contrato.
 *
 * Red nacional (PLAN_Provincias): la capital de cada una de las 24 provincias del Ecuador, haya o no aeropuerto real, y los
 * aeropuertos reales que no están en su capital (Manta, Santa Rosa, Salinas). Los que no tienen aeropuerto usan un código
 * propio de 3 letras (no es IATA oficial) y su nombre dice «(simulado)».
 */
export interface Airport {
  code: string;
  city: string;
  name: string;
  country: string;
  /** Provincia (solo Ecuador). */
  province?: string;
  lat: number;
  lon: number;
  utcOffsetMinutes: number;
  /** `false`: desactivado por el administrador (M-1): no se ofrece para rutas nuevas; las que ya tiene siguen. */
  active?: boolean;
}

/** Los 10 aeropuertos con los que nació la red: la red «todos con todos» de las pruebas del motor de horarios usa solo estos. */
export const BASE_NETWORK_AIRPORTS = ['UIO', 'GYE', 'CUE', 'BOG', 'MDE', 'LIM', 'SCL', 'MIA', 'MEX', 'MAD'] as const;

/** Los 34 aeropuertos con los que nace el catálogo (semilla de la tabla `airports` de MS.G.Schedule, M-1). */
export const SEED_AIRPORTS: Readonly<Record<string, Airport>> = {
  UIO: { code: 'UIO', city: 'Quito', name: 'Aeropuerto Internacional Mariscal Sucre', country: 'EC', province: 'Pichincha', lat: -0.1292, lon: -78.3575, utcOffsetMinutes: -300 },
  GYE: { code: 'GYE', city: 'Guayaquil', name: 'Aeropuerto Internacional José Joaquín de Olmedo', country: 'EC', province: 'Guayas', lat: -2.1574, lon: -79.8836, utcOffsetMinutes: -300 },
  CUE: { code: 'CUE', city: 'Cuenca', name: 'Aeropuerto Mariscal Lamar', country: 'EC', province: 'Azuay', lat: -2.8895, lon: -78.9844, utcOffsetMinutes: -300 },
  GDA: { code: 'GDA', city: 'Guaranda', name: 'Aeródromo de Guaranda (simulado)', country: 'EC', province: 'Bolívar', lat: -1.5926, lon: -79.001, utcOffsetMinutes: -300 },
  AZG: { code: 'AZG', city: 'Azogues', name: 'Aeródromo de Azogues (simulado)', country: 'EC', province: 'Cañar', lat: -2.7397, lon: -78.8486, utcOffsetMinutes: -300 },
  TUA: { code: 'TUA', city: 'Tulcán', name: 'Aeropuerto Teniente Coronel Luis A. Mantilla', country: 'EC', province: 'Carchi', lat: 0.8095, lon: -77.7081, utcOffsetMinutes: -300 },
  RBA: { code: 'RBA', city: 'Riobamba', name: 'Aeródromo de Riobamba (simulado)', country: 'EC', province: 'Chimborazo', lat: -1.6536, lon: -78.6564, utcOffsetMinutes: -300 },
  LTX: { code: 'LTX', city: 'Latacunga', name: 'Aeropuerto Internacional Cotopaxi', country: 'EC', province: 'Cotopaxi', lat: -0.9068, lon: -78.6158, utcOffsetMinutes: -300 },
  MCH: { code: 'MCH', city: 'Machala', name: 'Aeropuerto General Manuel Serrano', country: 'EC', province: 'El Oro', lat: -3.2689, lon: -79.9616, utcOffsetMinutes: -300 },
  ETR: { code: 'ETR', city: 'Santa Rosa', name: 'Aeropuerto Regional de Santa Rosa', country: 'EC', province: 'El Oro', lat: -3.4419, lon: -79.997, utcOffsetMinutes: -300 },
  ESM: { code: 'ESM', city: 'Esmeraldas', name: 'Aeropuerto General Rivadeneira', country: 'EC', province: 'Esmeraldas', lat: 0.9785, lon: -79.6266, utcOffsetMinutes: -300 },
  SCY: { code: 'SCY', city: 'Puerto Baquerizo Moreno', name: 'Aeropuerto San Cristóbal', country: 'EC', province: 'Galápagos', lat: -0.9102, lon: -89.6175, utcOffsetMinutes: -360 },
  IBR: { code: 'IBR', city: 'Ibarra', name: 'Aeródromo de Ibarra (simulado)', country: 'EC', province: 'Imbabura', lat: 0.3517, lon: -78.1222, utcOffsetMinutes: -300 },
  LOH: { code: 'LOH', city: 'Loja', name: 'Aeropuerto Ciudad de Catamayo', country: 'EC', province: 'Loja', lat: -3.9959, lon: -79.3719, utcOffsetMinutes: -300 },
  BHO: { code: 'BHO', city: 'Babahoyo', name: 'Aeródromo de Babahoyo (simulado)', country: 'EC', province: 'Los Ríos', lat: -1.8017, lon: -79.5346, utcOffsetMinutes: -300 },
  PVO: { code: 'PVO', city: 'Portoviejo', name: 'Aeropuerto Reales Tamarindos', country: 'EC', province: 'Manabí', lat: -1.0416, lon: -80.4722, utcOffsetMinutes: -300 },
  MEC: { code: 'MEC', city: 'Manta', name: 'Aeropuerto Internacional Eloy Alfaro', country: 'EC', province: 'Manabí', lat: -0.9461, lon: -80.6788, utcOffsetMinutes: -300 },
  XMS: { code: 'XMS', city: 'Macas', name: 'Aeropuerto Edmundo Carvajal', country: 'EC', province: 'Morona Santiago', lat: -2.2992, lon: -78.1208, utcOffsetMinutes: -300 },
  TNW: { code: 'TNW', city: 'Tena', name: 'Aeropuerto Jumandy', country: 'EC', province: 'Napo', lat: -1.0597, lon: -77.5833, utcOffsetMinutes: -300 },
  OCC: { code: 'OCC', city: 'Francisco de Orellana', name: 'Aeropuerto Francisco de Orellana', country: 'EC', province: 'Orellana', lat: -0.4629, lon: -76.9868, utcOffsetMinutes: -300 },
  PTZ: { code: 'PTZ', city: 'Puyo', name: 'Aeropuerto Río Amazonas (Shell)', country: 'EC', province: 'Pastaza', lat: -1.5052, lon: -78.0627, utcOffsetMinutes: -300 },
  STE: { code: 'STE', city: 'Santa Elena', name: 'Aeródromo de Santa Elena (simulado)', country: 'EC', province: 'Santa Elena', lat: -2.2262, lon: -80.859, utcOffsetMinutes: -300 },
  SNC: { code: 'SNC', city: 'Salinas', name: 'Aeropuerto General Ulpiano Páez', country: 'EC', province: 'Santa Elena', lat: -2.205, lon: -80.9889, utcOffsetMinutes: -300 },
  SDT: { code: 'SDT', city: 'Santo Domingo', name: 'Aeródromo de Santo Domingo (simulado)', country: 'EC', province: 'Santo Domingo de los Tsáchilas', lat: -0.253, lon: -79.1754, utcOffsetMinutes: -300 },
  LGQ: { code: 'LGQ', city: 'Nueva Loja', name: 'Aeropuerto Lago Agrio', country: 'EC', province: 'Sucumbíos', lat: 0.0931, lon: -76.8675, utcOffsetMinutes: -300 },
  ATF: { code: 'ATF', city: 'Ambato', name: 'Aeropuerto Chachoán', country: 'EC', province: 'Tungurahua', lat: -1.212, lon: -78.5746, utcOffsetMinutes: -300 },
  ZMR: { code: 'ZMR', city: 'Zamora', name: 'Aeródromo de Zamora (simulado)', country: 'EC', province: 'Zamora Chinchipe', lat: -4.0692, lon: -78.9567, utcOffsetMinutes: -300 },
  BOG: { code: 'BOG', city: 'Bogotá', name: 'Aeropuerto Internacional El Dorado', country: 'CO', lat: 4.7016, lon: -74.1469, utcOffsetMinutes: -300 },
  MDE: { code: 'MDE', city: 'Medellín', name: 'Aeropuerto Internacional José María Córdova', country: 'CO', lat: 6.1645, lon: -75.4231, utcOffsetMinutes: -300 },
  LIM: { code: 'LIM', city: 'Lima', name: 'Aeropuerto Internacional Jorge Chávez', country: 'PE', lat: -12.0219, lon: -77.1143, utcOffsetMinutes: -300 },
  SCL: { code: 'SCL', city: 'Santiago', name: 'Aeropuerto Internacional Arturo Merino Benítez', country: 'CL', lat: -33.393, lon: -70.7858, utcOffsetMinutes: -240 },
  MIA: { code: 'MIA', city: 'Miami', name: 'Miami International Airport', country: 'US', lat: 25.7959, lon: -80.287, utcOffsetMinutes: -300 },
  MEX: { code: 'MEX', city: 'Ciudad de México', name: 'Aeropuerto Internacional Benito Juárez', country: 'MX', lat: 19.4361, lon: -99.0719, utcOffsetMinutes: -360 },
  MAD: { code: 'MAD', city: 'Madrid', name: 'Aeropuerto Adolfo Suárez Madrid-Barajas', country: 'ES', lat: 40.4983, lon: -3.5676, utcOffsetMinutes: 60 },
};

const catalog: Record<string, Airport> = Object.fromEntries(Object.entries(SEED_AIRPORTS).map(([code, airport]) => [code, { ...airport }]));

/**
 * Catálogo de aeropuertos de ESTE proceso (M-1). Su dueño es MS.G.Schedule (tabla `airports`, editable desde el panel); cada
 * proceso arranca con la semilla y lo actualiza con lo que le llega: Schedule de su base, el ESB de Schedule (con caché) y Offers
 * de la publicación del horario. Se lee como siempre (`AIRPORTS[code]`).
 */
export const AIRPORTS: Readonly<Record<string, Airport>> = catalog;

/** Agrega o reemplaza aeropuertos del catálogo de este proceso. */
export function registerAirports(airports: readonly Airport[]): void {
  for (const airport of airports) catalog[airport.code] = { ...airport };
}

/** Quita un aeropuerto del catálogo de este proceso (lo borró el administrador). */
export function removeAirport(code: string): void {
  delete catalog[code];
}

/** Distancia ortodrómica (haversine) en kilómetros. */
export function distanceKm(from: Airport, to: Airport): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
