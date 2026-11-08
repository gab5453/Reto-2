import type { AssistanceInput, MoneyAmount } from '../api/types';

export function formatMoney(amount: MoneyAmount | string | undefined, currency = 'USD'): string {
  if (amount === undefined) return '—';
  const value = typeof amount === 'string' ? amount : amount.total;
  const code = typeof amount === 'string' ? currency : amount.currency;
  return new Intl.NumberFormat('es-EC', { style: 'currency', currency: code }).format(Number(value));
}

/** Hora local del aeropuerto, tal como viene en el ISO con desfase del contrato (`2026-12-01T07:00:00-05:00`). */
export function localTime(iso: string | null | undefined): string {
  return iso ? iso.slice(11, 16) : '—';
}

export function localDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('es-EC', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function formatDuration(minutes: number | null | undefined): string {
  if (!minutes && minutes !== 0) return '—';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} h ${String(rest).padStart(2, '0')} min` : `${rest} min`;
}

export function formatDateTime(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString('es-EC', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

/** Días con vuelos publicados, contando hoy: 13 semanas exactas (igual que el horario del GDS). */
export const SALES_WINDOW_DAYS = 91;

/** Último día con vuelos a la venta (hoy + 90). */
export function lastSaleDate(): string {
  return todayIso(SALES_WINDOW_DAYS - 1);
}

/** Fecha local de hoy (YYYY-MM-DD) en la zona del navegador, para los mínimos de los date pickers. */
export function todayIso(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export const PASSENGER_LABELS: Record<string, string> = {
  ADULT: 'Adulto',
  YOUTH: 'Joven',
  CHILD: 'Niño',
  INFANT: 'Infante',
};

export const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pendiente',
  PENDING_PAYMENT: 'Pago en proceso',
  TICKET_ISSUING: 'Emitiendo boletos',
  CONFIRMED: 'Confirmada',
  FAILED: 'Fallida',
  CHANGE_PENDING: 'Cambio en proceso',
  CANCELLATION_PENDING: 'Cancelación en proceso',
  CANCELLED: 'Cancelada',
  SCHEDULED: 'Programado',
  BOARDING: 'Embarcando',
  DEPARTED: 'En vuelo',
  DELAYED: 'Retrasado',
  ARRIVED: 'Aterrizó',
  DIVERTED: 'Desviado',
  ISSUED: 'Emitido',
  ISSUING: 'Emitiendo',
  VOIDED: 'Anulado',
  REFUNDED: 'Reembolsado',
  ACTIVE: 'Activa',
  BLOCKED: 'Bloqueada',
  REQUESTED: 'Solicitada',
  READY: 'Lista',
};

export const EMPTY_ASSISTANCE: AssistanceInput = { type: 'WCHR', needsCompanion: false, notes: '' };

/** Quita las notas vacías: el contrato las admite opcionales y un texto en blanco no aporta nada. */
export function cleanAssistance(assistance: AssistanceInput): AssistanceInput {
  const notes = assistance.notes?.trim();
  return { type: assistance.type, needsCompanion: assistance.needsCompanion, ...(notes ? { notes } : {}) };
}

/** Códigos IATA de asistencia (`AssistanceType` de gateway.graphql). */
export const ASSISTANCE_LABELS: Record<string, string> = {
  WCHR: 'Silla de ruedas hasta la puerta del avión',
  WCHS: 'No puede subir escaleras',
  WCHC: 'Movilidad reducida: ayuda hasta el asiento',
  BLND: 'Discapacidad visual',
  DEAF: 'Discapacidad auditiva',
  DPNA: 'Discapacidad intelectual o del desarrollo',
  MEDA: 'Caso médico',
};

/**
 * Estado de un tramo del boleto para mostrar. El cupón del contrato solo conoce PENDING, ISSUED y FAILED: si el boleto se
 * anuló o se reembolsó, el tramo también (no se puede volar con él).
 */
export const couponStatus = (ticketStatus: string, segmentStatus: string) =>
  ticketStatus === 'VOIDED' || ticketStatus === 'REFUNDED' ? ticketStatus : segmentStatus;

/** Estado del reembolso en palabras del cliente. */
export const REFUND_STATUS_LABELS: Record<string, string> = {
  SETTLED: 'Acreditado a tu tarjeta',
  CALCULATED: 'Lo acredita Booking, donde compraste',
  NOT_REFUNDABLE: 'Tarifa no reembolsable',
};

export const FARE_DESCRIPTIONS: Record<string, string> = {
  SEMILLA: 'Lo esencial: artículo personal. Sin cambios; si cancelas, solo se devuelven los impuestos.',
  BROTE: 'Equipaje de mano + 1 maleta. Cambios con cargo.',
  BOSQUE: 'Equipaje de mano + 2 maletas. Cambios sin cargo y reembolsable.',
  DOSEL: 'Cabina Business, 2 maletas, flexibilidad total.',
};
