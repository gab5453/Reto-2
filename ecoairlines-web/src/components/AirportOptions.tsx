import { AIRPORTS, type AirportInfo } from '../data/airports';

const byCity = (a: AirportInfo, b: AirportInfo) => a.city.localeCompare(b.city, 'es');
const NATIONAL = AIRPORTS.filter((airport) => airport.country === 'Ecuador').sort(byCity);
const INTERNATIONAL = AIRPORTS.filter((airport) => airport.country !== 'Ecuador').sort(byCity);

/**
 * Opciones de un `<select>` de aeropuertos, agrupadas: la red nacional (una ciudad por provincia del Ecuador, PLAN_Provincias)
 * con su provincia, y las ciudades internacionales. `exclude` quita un código (p. ej. el origen en el selector de destino);
 * `short` muestra solo el código.
 */
export function AirportOptions({ exclude, short = false }: { exclude?: string; short?: boolean }) {
  const label = (airport: AirportInfo) =>
    short ? airport.code : `${airport.city} (${airport.code})${airport.province && airport.province !== airport.city ? ` · ${airport.province}` : ''}`;
  const option = (airport: AirportInfo) => (
    <option key={airport.code} value={airport.code}>{label(airport)}</option>
  );
  return (
    <>
      <optgroup label="Ecuador">{NATIONAL.filter((airport) => airport.code !== exclude).map(option)}</optgroup>
      <optgroup label="Internacional">{INTERNATIONAL.filter((airport) => airport.code !== exclude).map(option)}</optgroup>
    </>
  );
}
