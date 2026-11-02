/** Fechas y horas locales con desfase fijo (copiado de `gds-ids.ts` del monolito). */
/** Instante UTC (ms) de una fecha y hora locales con un desfase fijo. */
export function localToUtcMs(localDate: string, localTime: string, utcOffsetMinutes: number): number {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  const [hours, minutes] = localTime.split(':').map(Number) as [number, number];
  return Date.UTC(year, month - 1, day, hours, minutes) - utcOffsetMinutes * 60_000;
}

/** ISO 8601 en hora local con desfase, p. ej. `2026-12-01T07:00:00-05:00`. */
export function formatLocalIso(utcMs: number, utcOffsetMinutes: number): string {
  const local = new Date(utcMs + utcOffsetMinutes * 60_000).toISOString().slice(0, 19);
  const sign = utcOffsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(utcOffsetMinutes);
  const offset = `${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  return `${local}${sign}${offset}`;
}

export function localDateOf(utcMs: number, utcOffsetMinutes: number): string {
  return new Date(utcMs + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function addDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
