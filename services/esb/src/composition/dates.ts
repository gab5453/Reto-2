/**
 * Fecha local de la red de EcoAirlines (UIO, GYE y BOG están en UTC−5 todo el año, sin horario de verano): "hoy" del panel y
 * del health es la fecha de Ecuador, no la de UTC.
 */
const OFFSET_MS = -5 * 3_600_000;

export const localDate = (now: Date = new Date()): string => new Date(now.getTime() + OFFSET_MS).toISOString().slice(0, 10);

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const IATA = /^[A-Z]{3}$/;
export const FLIGHT_NUMBER = /^[A-Z0-9]{2}\d{1,4}$/;
