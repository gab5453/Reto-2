/**
 * Aeropuertos de la red simulada. Los desfases horarios son fijos (sin horario de verano):
 * es una simplificación del mock, no del contrato.
 */
export interface Airport {
  code: string;
  city: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  utcOffsetMinutes: number;
}

export const AIRPORTS: Readonly<Record<string, Airport>> = {
  UIO: { code: 'UIO', city: 'Quito', name: 'Aeropuerto Internacional Mariscal Sucre', country: 'EC', lat: -0.1292, lon: -78.3575, utcOffsetMinutes: -300 },
  GYE: { code: 'GYE', city: 'Guayaquil', name: 'Aeropuerto Internacional José Joaquín de Olmedo', country: 'EC', lat: -2.1574, lon: -79.8836, utcOffsetMinutes: -300 },
  CUE: { code: 'CUE', city: 'Cuenca', name: 'Aeropuerto Mariscal Lamar', country: 'EC', lat: -2.8895, lon: -78.9844, utcOffsetMinutes: -300 },
  BOG: { code: 'BOG', city: 'Bogotá', name: 'Aeropuerto Internacional El Dorado', country: 'CO', lat: 4.7016, lon: -74.1469, utcOffsetMinutes: -300 },
  MDE: { code: 'MDE', city: 'Medellín', name: 'Aeropuerto Internacional José María Córdova', country: 'CO', lat: 6.1645, lon: -75.4231, utcOffsetMinutes: -300 },
  LIM: { code: 'LIM', city: 'Lima', name: 'Aeropuerto Internacional Jorge Chávez', country: 'PE', lat: -12.0219, lon: -77.1143, utcOffsetMinutes: -300 },
  SCL: { code: 'SCL', city: 'Santiago', name: 'Aeropuerto Internacional Arturo Merino Benítez', country: 'CL', lat: -33.393, lon: -70.7858, utcOffsetMinutes: -240 },
  MIA: { code: 'MIA', city: 'Miami', name: 'Miami International Airport', country: 'US', lat: 25.7959, lon: -80.287, utcOffsetMinutes: -300 },
  MEX: { code: 'MEX', city: 'Ciudad de México', name: 'Aeropuerto Internacional Benito Juárez', country: 'MX', lat: 19.4361, lon: -99.0719, utcOffsetMinutes: -360 },
  MAD: { code: 'MAD', city: 'Madrid', name: 'Aeropuerto Adolfo Suárez Madrid-Barajas', country: 'ES', lat: 40.4983, lon: -3.5676, utcOffsetMinutes: 60 },
};

/** Distancia ortodrómica (haversine) en kilómetros. */
export function distanceKm(from: Airport, to: Airport): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
