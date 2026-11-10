/**
 * Tipos de avión de EcoAirlines. Hasta PLAN_Telemetria_Asientos M-2 eran constantes del código; ahora su dueño es MS.G.Schedule
 * (tabla `aircraft_types`, editable desde el panel) y aquí está la **semilla** (los 3 de siempre, copiados de `seed/network.ts` y
 * `seed/timetable.ts` del monolito) y el **catálogo de cada proceso**: arranca con la semilla y se actualiza con lo que le llega
 * (Schedule de su base; Offers de la publicación del horario). Se lee como siempre: `AIRCRAFT_LAYOUTS[tipo]`,
 * `TURNAROUND_MINUTES[tipo]`…
 */
export type CabinClass = 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';
/** Nombre del tipo («Airbus A320neo»). Desde M-2 es un dato del catálogo, no una lista fija. */
export type AircraftType = string;

export interface CabinLayout {
  cabinClass: CabinClass;
  firstRow: number;
  lastRow: number;
  /** Letras de asiento por fila; `-` marca un pasillo. */
  layout: string;
  exitRows?: number[];
  extraLegroomRows?: number[];
}

/** Ficha de un tipo de avión. */
export interface AircraftTypeSpec {
  name: AircraftType;
  /** `HC-` + una letra (matrículas ficticias de Ecuador): HC-J01, HC-J02… */
  registrationPrefix: string;
  /** Distancia máxima de ruta que opera (`null` = sin límite en la red). */
  maxRouteKm: number | null;
  /** Tiempo mínimo en tierra entre la llegada y la siguiente salida. */
  turnaroundMinutes: number;
  /** Business y Economy, siempre las dos (D-T8: así todo avión vende los 4 paquetes). */
  cabins: CabinLayout[];
}

export const SEED_AIRCRAFT_TYPES: readonly AircraftTypeSpec[] = [
  {
    name: 'Airbus A220-300',
    registrationPrefix: 'HC-J',
    maxRouteKm: 1_500,
    turnaroundMinutes: 35,
    cabins: [
      { cabinClass: 'BUSINESS', firstRow: 1, lastRow: 3, layout: 'AC-DF' },
      { cabinClass: 'ECONOMY', firstRow: 4, lastRow: 25, layout: 'AC-DEF', exitRows: [13], extraLegroomRows: [4, 13] },
    ],
  },
  {
    name: 'Airbus A320neo',
    registrationPrefix: 'HC-N',
    maxRouteKm: 4_500,
    turnaroundMinutes: 45,
    cabins: [
      { cabinClass: 'BUSINESS', firstRow: 1, lastRow: 3, layout: 'AC-DF' },
      { cabinClass: 'ECONOMY', firstRow: 4, lastRow: 30, layout: 'ABC-DEF', exitRows: [12, 13], extraLegroomRows: [4, 12, 13] },
    ],
  },
  {
    name: 'Boeing 787-9',
    registrationPrefix: 'HC-W',
    maxRouteKm: null,
    turnaroundMinutes: 90,
    cabins: [
      { cabinClass: 'BUSINESS', firstRow: 1, lastRow: 7, layout: 'AC-DG-HK' },
      { cabinClass: 'ECONOMY', firstRow: 10, lastRow: 40, layout: 'ABC-DEF-GHJ', exitRows: [20, 30], extraLegroomRows: [10, 20, 30] },
    ],
  },
];

// ── Catálogo de este proceso ──

/** Del de menor alcance al de mayor (sin límite al final): un tipo "mayor" puede operar la ruta de uno menor. */
export const AIRCRAFT_TYPES: AircraftType[] = [];
export const AIRCRAFT_LAYOUTS: Record<AircraftType, CabinLayout[]> = {};
export const TURNAROUND_MINUTES: Record<AircraftType, number> = {};
export const AIRCRAFT_MAX_ROUTE_KM: Record<AircraftType, number | null> = {};
export const REGISTRATION_PREFIX: Record<AircraftType, string> = {};

const reach = (name: AircraftType) => AIRCRAFT_MAX_ROUTE_KM[name] ?? Number.POSITIVE_INFINITY;

function sortTypes(): void {
  AIRCRAFT_TYPES.sort((a, b) => reach(a) - reach(b) || a.localeCompare(b));
}

/** Agrega o reemplaza tipos en el catálogo de este proceso. */
export function registerAircraftTypes(specs: readonly AircraftTypeSpec[]): void {
  for (const spec of specs) {
    if (!AIRCRAFT_TYPES.includes(spec.name)) AIRCRAFT_TYPES.push(spec.name);
    // Un arreglo nuevo cada vez: quien guarde en caché por identidad (el mapa de asientos de Offers) ve el cambio.
    AIRCRAFT_LAYOUTS[spec.name] = spec.cabins.map((cabin) => ({ ...cabin, ...(cabin.exitRows ? { exitRows: [...cabin.exitRows] } : {}), ...(cabin.extraLegroomRows ? { extraLegroomRows: [...cabin.extraLegroomRows] } : {}) }));
    TURNAROUND_MINUTES[spec.name] = spec.turnaroundMinutes;
    AIRCRAFT_MAX_ROUTE_KM[spec.name] = spec.maxRouteKm;
    REGISTRATION_PREFIX[spec.name] = spec.registrationPrefix;
  }
  sortTypes();
}

/** Quita un tipo del catálogo de este proceso (lo borró el administrador). */
export function removeAircraftType(name: AircraftType): void {
  const index = AIRCRAFT_TYPES.indexOf(name);
  if (index >= 0) AIRCRAFT_TYPES.splice(index, 1);
  delete AIRCRAFT_LAYOUTS[name];
  delete TURNAROUND_MINUTES[name];
  delete AIRCRAFT_MAX_ROUTE_KM[name];
  delete REGISTRATION_PREFIX[name];
}

/** La ficha de un tipo del catálogo, o `undefined` si no existe. */
export function aircraftTypeSpec(name: AircraftType): AircraftTypeSpec | undefined {
  if (!AIRCRAFT_LAYOUTS[name]) return undefined;
  return { name, registrationPrefix: REGISTRATION_PREFIX[name]!, maxRouteKm: AIRCRAFT_MAX_ROUTE_KM[name] ?? null, turnaroundMinutes: TURNAROUND_MINUTES[name]!, cabins: AIRCRAFT_LAYOUTS[name]! };
}

registerAircraftTypes(SEED_AIRCRAFT_TYPES);

// ── Distribución de asientos (M-2) ──

/** Configuraciones por fila que puede elegir el administrador (letras estándar; `-` es el pasillo). */
export const SEAT_CONFIGURATIONS: Readonly<Record<'BUSINESS' | 'ECONOMY', Readonly<Record<string, string>>>> = {
  BUSINESS: { '2-2': 'AC-DF', '1-2-1': 'A-DG-K', '2-2-2': 'AC-DG-HK' },
  ECONOMY: { '2-3': 'AC-DEF', '3-3': 'ABC-DEF', '2-4-2': 'AC-DEFG-HK', '3-3-3': 'ABC-DEF-GHJ' },
};

/** «2-2», «3-3-3»… de unas letras por fila. */
export const configurationOf = (layout: string): string => layout.split('-').map((block) => block.length).join('-');

export const seatsPerRow = (layout: string): number => layout.replace(/-/g, '').length;

/**
 * Mapa de un tipo nuevo a partir de los asientos y la configuración de cada cabina: filas = asientos ÷ asientos por fila (exacto).
 * Business desde la fila 1; Economy sigue después. En Economy, la primera fila tiene más espacio y la del medio es de emergencia.
 */
export function buildCabinLayouts(business: { seats: number; configuration: string }, economy: { seats: number; configuration: string }): CabinLayout[] {
  const businessLayout = SEAT_CONFIGURATIONS.BUSINESS[business.configuration]!;
  const economyLayout = SEAT_CONFIGURATIONS.ECONOMY[economy.configuration]!;
  const businessRows = business.seats / seatsPerRow(businessLayout);
  const economyRows = economy.seats / seatsPerRow(economyLayout);
  const firstEconomy = businessRows + 1;
  const exitRow = firstEconomy + Math.floor(economyRows / 2);
  return [
    { cabinClass: 'BUSINESS', firstRow: 1, lastRow: businessRows, layout: businessLayout },
    { cabinClass: 'ECONOMY', firstRow: firstEconomy, lastRow: firstEconomy + economyRows - 1, layout: economyLayout, exitRows: [exitRow], extraLegroomRows: [...new Set([firstEconomy, exitRow])] },
  ];
}

export const nextRegistration = (aircraftType: AircraftType, sequence: number): string =>
  `${REGISTRATION_PREFIX[aircraftType]}${String(sequence).padStart(2, '0')}`;

/** Asientos por cabina de un tipo de avión, según su mapa. */
export function seatsByCabin(aircraftType: AircraftType): { cabinClass: CabinClass; seats: number }[] {
  return (AIRCRAFT_LAYOUTS[aircraftType] ?? []).map((cabin) => ({
    cabinClass: cabin.cabinClass,
    seats: (cabin.lastRow - cabin.firstRow + 1) * seatsPerRow(cabin.layout),
  }));
}

export const totalSeats = (aircraftType: AircraftType): number => seatsByCabin(aircraftType).reduce((sum, cabin) => sum + cabin.seats, 0);

/** Avión por distancia de la ruta: el de menor alcance que la cubre. */
export function aircraftFor(distanceKm: number): AircraftType {
  return AIRCRAFT_TYPES.find((type) => AIRCRAFT_MAX_ROUTE_KM[type] === null || distanceKm < AIRCRAFT_MAX_ROUTE_KM[type]!)!;
}

/** ¿El tipo alcanza esa distancia? */
export const reaches = (aircraftType: AircraftType, distanceKm: number): boolean => AIRCRAFT_MAX_ROUTE_KM[aircraftType] === null || distanceKm < (AIRCRAFT_MAX_ROUTE_KM[aircraftType] ?? 0);
