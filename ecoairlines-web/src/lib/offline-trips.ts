/**
 * Copia local de «Mis viajes» y de los pases de abordar para verlos sin conexión (PLAN.md §4.9, D52). Hace falta porque el
 * service worker no puede guardarlos: GraphQL va por POST y, sin conexión, tampoco hay sesión (el token vive solo en memoria).
 *
 * Lo que se guarda es lo mínimo para abordar. NUNCA el token, documentos, contacto, asistencia médica ni datos de pago, y nada
 * del administrador (solo escriben aquí las pantallas del cliente). «Salir» lo borra; cerrar la pestaña o que venza la sesión no,
 * porque justo ahí hace falta el pase. Los vuelos que ya pasaron se purgan solos.
 */
const KEY = 'eco.offline.v1';
/** Un vuelo se conserva hasta un día después de su salida (retrasos, conexiones). */
const KEEP_AFTER_DEPARTURE_MS = 86_400_000;

export interface SavedTrip {
  bookingId: string;
  pnr: string;
  status: string;
  origin?: string;
  destination?: string;
  departureDate?: string;
}

export interface SavedPass {
  bookingId: string;
  pnr: string;
  passengerName: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  seat: string;
  boardingGroup?: string | null;
  boardingPosition?: string | null;
  gate?: string | null;
  barcode: string;
}

export interface OfflineData {
  owner: string;
  savedAt: string;
  trips: SavedTrip[];
  passes: SavedPass[];
}

function read(): OfflineData | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as OfflineData) : null;
  } catch {
    return null;
  }
}

function write(data: OfflineData): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Sin almacenamiento (modo privado, cuota llena): la web funciona igual, solo que sin copia para usar sin conexión.
  }
}

/** Vigente: un viaje sin fecha se conserva; uno con fecha, hasta un día después de salir. */
const current = (date: string | undefined, now: number) => !date || Date.parse(date) + KEEP_AFTER_DEPARTURE_MS > now;

/** Los datos del dueño (o vacíos si eran de otra persona: en un equipo compartido nunca se mezclan). */
function dataOf(owner: string): OfflineData {
  const stored = read();
  return stored?.owner === owner ? stored : { owner, savedAt: '', trips: [], passes: [] };
}

function store(data: OfflineData): void {
  write({ ...data, savedAt: new Date().toISOString() });
}

/** Reemplaza la lista de viajes y retira los pases de las reservas que ya no están activas. */
export function saveTrips(owner: string, trips: SavedTrip[]): void {
  const data = dataOf(owner);
  const cancelled = new Set(trips.filter((trip) => trip.status === 'CANCELLED').map((trip) => trip.bookingId));
  store({
    ...data,
    trips: trips.map(({ bookingId, pnr, status, origin, destination, departureDate }) => ({ bookingId, pnr, status, origin, destination, departureDate })),
    passes: data.passes.filter((pass) => !cancelled.has(pass.bookingId)),
  });
}

/**
 * Retira del dispositivo los pases de una reserva que ya no valen (D56, 12/11): se canceló o su check-in se anuló (cambio de
 * fecha). Así no queda un pase «válido» sin conexión de una reserva cancelada.
 */
export function removePasses(owner: string, bookingId: string): void {
  const data = dataOf(owner);
  if (!data.passes.some((pass) => pass.bookingId === bookingId)) return;
  store({ ...data, passes: data.passes.filter((pass) => pass.bookingId !== bookingId) });
}

/** Reemplaza los pases de una reserva con los últimos vistos. */
export function savePasses(owner: string, bookingId: string, passes: SavedPass[]): void {
  const data = dataOf(owner);
  store({
    ...data,
    passes: [
      ...data.passes.filter((pass) => pass.bookingId !== bookingId),
      ...passes.map(({ pnr, passengerName, flightNumber, origin, destination, departureAt, seat, boardingGroup, boardingPosition, gate, barcode }) => ({
        bookingId,
        pnr,
        passengerName,
        flightNumber,
        origin,
        destination,
        departureAt,
        seat,
        boardingGroup,
        boardingPosition,
        gate,
        barcode,
      })),
    ],
  });
}

/** Lo guardado, sin los vuelos que ya pasaron (y los borra del dispositivo). */
export function loadOfflineData(now = Date.now()): OfflineData | null {
  const stored = read();
  if (!stored) return null;
  const data = { ...stored, trips: stored.trips.filter((trip) => current(trip.departureDate, now)), passes: stored.passes.filter((pass) => current(pass.departureAt, now)) };
  if (data.trips.length !== stored.trips.length || data.passes.length !== stored.passes.length) write(data);
  return data;
}

export function clearOfflineData(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Sin almacenamiento no hay nada que borrar.
  }
}
