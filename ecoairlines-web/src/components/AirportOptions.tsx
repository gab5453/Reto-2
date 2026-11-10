import { AIRPORTS, type AirportInfo, useAirportsVersion } from '../data/airports';

const byCity = (a: AirportInfo, b: AirportInfo) => a.city.localeCompare(b.city, 'es');

/**
 * Opciones de un `<select>` de aeropuertos, agrupadas: la red nacional (una ciudad por provincia del Ecuador, PLAN_Provincias)
 * con su provincia, y las ciudades internacionales. Solo los activos (M-1); `exclude` quita un código (p. ej. el origen en el
 * selector de destino); `short` muestra solo el código; `keep` mantiene un código aunque esté desactivado (el valor actual).
 */
export function AirportOptions({ exclude, short = false, keep }: { exclude?: string; short?: boolean; keep?: string }) {
  useAirportsVersion();
  const shown = AIRPORTS.filter((airport) => (airport.active !== false || airport.code === keep) && airport.code !== exclude);
  const national = shown.filter((airport) => airport.country === 'Ecuador').sort(byCity);
  const international = shown.filter((airport) => airport.country !== 'Ecuador').sort(byCity);
  const label = (airport: AirportInfo) =>
    short ? airport.code : `${airport.city} (${airport.code})${airport.province && airport.province !== airport.city ? ` · ${airport.province}` : ''}`;
  const option = (airport: AirportInfo) => (
    <option key={airport.code} value={airport.code}>{label(airport)}</option>
  );
  return (
    <>
      <optgroup label="Ecuador">{national.map(option)}</optgroup>
      <optgroup label="Internacional">{international.map(option)}</optgroup>
    </>
  );
}
