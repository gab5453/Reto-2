/**
 * Traducción entre el mapeo JSON de proto3 que usa el enrutador del ESB para MS.G.Offers (D43: enums por nombre,
 * `CABIN_CLASS_ECONOMY`) y los valores del contrato v2 (`ECONOMY`). Los `*_UNSPECIFIED` (el 0 de proto3) no existen en el
 * contrato: se quitan (o quedan `null` donde el contrato lo admite).
 */
const PREFIXES: Record<string, string> = {
  cabinClass: 'CABIN_CLASS_',
  passengerType: 'PASSENGER_TYPE_',
  characteristics: 'SEAT_CHARACTERISTIC_',
  channel: 'SALES_CHANNEL_',
};
/** `status` es SeatStatus, HoldStatus o FlightOperationalStatus según el mensaje. */
const STATUS_PREFIXES = ['SEAT_STATUS_', 'HOLD_STATUS_', 'FLIGHT_OPERATIONAL_STATUS_'];

function strip(value: unknown, prefixes: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => strip(item, prefixes)).filter((item) => item !== null);
  if (typeof value !== 'string') return value;
  const prefix = prefixes.find((p) => value.startsWith(p));
  if (!prefix) return value;
  const name = value.slice(prefix.length);
  return name === 'UNSPECIFIED' ? null : name;
}

/** Respuesta de Offers (proto3 JSON) → valores del contrato v2, en todo el árbol. */
export function fromProto<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) return value.map((item) => fromProto(item)) as T;
  if (!value || typeof value !== 'object') return value as T;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key in PREFIXES) result[key] = strip(item, [PREFIXES[key]]);
    else if (key === 'status') result[key] = strip(item, STATUS_PREFIXES);
    else result[key] = fromProto(item);
    if (result[key] === null && item !== null) delete result[key];
  }
  return result as T;
}

/** `ECONOMY` → `CABIN_CLASS_ECONOMY` (petición hacia Offers). */
export const cabinToProto = (cabinClass: string) => `CABIN_CLASS_${cabinClass}`;
