/**
 * Tipos de avión de EcoAirlines (datos maestros, copiados de `seed/network.ts` y `seed/timetable.ts` del monolito). Los usan
 * MS.G.Schedule (asientos por cabina, alcance, rotaciones) y MS.G.Offers (mapa de asientos): por eso viven en `shared`.
 */
export type CabinClass = 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';
export type AircraftType = 'Airbus A220-300' | 'Airbus A320neo' | 'Boeing 787-9';

/** Del más chico al más grande (el orden importa: un tipo "mayor" puede operar la ruta de uno menor). */
export const AIRCRAFT_TYPES: readonly AircraftType[] = ['Airbus A220-300', 'Airbus A320neo', 'Boeing 787-9'];

export interface CabinLayout {
  cabinClass: CabinClass;
  firstRow: number;
  lastRow: number;
  /** Letras de asiento por fila; `-` marca un pasillo. */
  layout: string;
  exitRows?: number[];
  extraLegroomRows?: number[];
}

export const AIRCRAFT_LAYOUTS: Readonly<Record<AircraftType, CabinLayout[]>> = {
  'Airbus A220-300': [
    { cabinClass: 'BUSINESS', firstRow: 1, lastRow: 3, layout: 'AC-DF' },
    { cabinClass: 'ECONOMY', firstRow: 4, lastRow: 25, layout: 'AC-DEF', exitRows: [13], extraLegroomRows: [4, 13] },
  ],
  'Airbus A320neo': [
    { cabinClass: 'BUSINESS', firstRow: 1, lastRow: 3, layout: 'AC-DF' },
    { cabinClass: 'ECONOMY', firstRow: 4, lastRow: 30, layout: 'ABC-DEF', exitRows: [12, 13], extraLegroomRows: [4, 12, 13] },
  ],
  'Boeing 787-9': [
    { cabinClass: 'BUSINESS', firstRow: 1, lastRow: 7, layout: 'AC-DG-HK' },
    { cabinClass: 'ECONOMY', firstRow: 10, lastRow: 40, layout: 'ABC-DEF-GHJ', exitRows: [20, 30], extraLegroomRows: [10, 20, 30] },
  ],
};

/** Tiempo mínimo en tierra entre la llegada de un avión y su siguiente salida. */
export const TURNAROUND_MINUTES: Readonly<Record<AircraftType, number>> = {
  'Airbus A220-300': 35,
  'Airbus A320neo': 45,
  'Boeing 787-9': 90,
};

/** Distancia máxima de ruta que opera cada tipo (`null` = sin límite en la red). */
export const AIRCRAFT_MAX_ROUTE_KM: Readonly<Record<AircraftType, number | null>> = {
  'Airbus A220-300': 1_500,
  'Airbus A320neo': 4_500,
  'Boeing 787-9': null,
};

/** Matrículas ficticias con el prefijo HC- de Ecuador: HC-J01 (A220), HC-N01 (A320neo), HC-W01 (787-9). */
export const REGISTRATION_PREFIX: Readonly<Record<AircraftType, string>> = {
  'Airbus A220-300': 'HC-J',
  'Airbus A320neo': 'HC-N',
  'Boeing 787-9': 'HC-W',
};

export const nextRegistration = (aircraftType: AircraftType, sequence: number): string =>
  `${REGISTRATION_PREFIX[aircraftType]}${String(sequence).padStart(2, '0')}`;

/** Asientos por cabina de un tipo de avión, según su mapa. */
export function seatsByCabin(aircraftType: AircraftType): { cabinClass: CabinClass; seats: number }[] {
  return AIRCRAFT_LAYOUTS[aircraftType].map((cabin) => ({
    cabinClass: cabin.cabinClass,
    seats: (cabin.lastRow - cabin.firstRow + 1) * cabin.layout.replace(/-/g, '').length,
  }));
}

export const totalSeats = (aircraftType: AircraftType): number => seatsByCabin(aircraftType).reduce((sum, cabin) => sum + cabin.seats, 0);

/** Avión por distancia de la ruta: el más chico que la alcanza. */
export function aircraftFor(distanceKm: number): AircraftType {
  return AIRCRAFT_TYPES.find((type) => AIRCRAFT_MAX_ROUTE_KM[type] === null || distanceKm < AIRCRAFT_MAX_ROUTE_KM[type]!)!;
}
