import type { AdminBooking, SalesReport } from '../api/admin';
import { STATUS_LABELS } from './format';

const cents = (amount: string | null | undefined) => Math.round(Number(amount ?? 0) * 100);
const fromCents = (value: number) => (value / 100).toFixed(2);

/** `P****567`: el documento se ve completo solo si el administrador lo pide (D-O2). */
export const maskDocument = (value: string) => (value.length <= 4 ? '****' : `${value[0]}${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-3)}`);

/**
 * Liquidación de la reserva: lo cobrado (todas las referencias de pago registradas) menos lo reembolsado. En el canal
 * Booking el reembolso lo calculamos y lo ejecuta Booking; en la web lo ejecuta la Payment API.
 */
export function settlementOf(booking: AdminBooking) {
  const currency = booking.grandTotal.currency;
  const charged = booking.payments.length
    ? booking.payments.reduce((sum, payment) => sum + cents(payment.amount.total), 0)
    : booking.status === 'FAILED'
      ? 0
      : cents(booking.grandTotal.total);
  const refunded = booking.refunds.reduce((sum, refund) => sum + cents(refund.amount), 0);
  const penalty = booking.refunds.reduce((sum, refund) => sum + cents(refund.penaltyAmount), 0);
  return { currency, charged: fromCents(charged), refunded: fromCents(refunded), penalty: fromCents(penalty), net: fromCents(charged - refunded) };
}

/** Texto para responderle a Booking (o a quien pregunte) sin abrir Swagger. */
export function summaryText(booking: AdminBooking): string {
  const s = settlementOf(booking);
  const money = (value: string) => `${value} ${s.currency}`;
  const total = booking.grandTotal;
  const parts = [
    `Reserva ${booking.pnr} · canal ${booking.channel === 'BOOKING' ? `BOOKING (${booking.salesChannel?.partnerId ?? 'partner'})` : 'WEB'}`,
    booking.salesChannel?.partnerOrderId ? `orden ${booking.salesChannel.partnerOrderId}` : null,
    booking.paymentReference ? `pago ${booking.paymentReference}` : null,
    `cobrado ${money(s.charged)}${total.baseFare && total.taxes ? ` (${total.baseFare} de tarifa + ${total.taxes} de impuestos)` : ''}`,
    `estado: ${STATUS_LABELS[booking.status] ?? booking.status}`,
    ...booking.refunds.map(
      (refund) => `reembolso ${money(refund.amount)} (${refund.refundId}, ${refund.status === 'CALCULATED' ? 'calculado: lo ejecuta Booking' : 'ejecutado'}), penalidad ${money(refund.penaltyAmount)}`,
    ),
    `neto a favor de EcoAirlines: ${money(s.net)}`,
  ];
  return `${parts.filter(Boolean).join(' · ')}. EcoAirlines no emite facturas: la facturación es del sistema de Facturación del ecosistema (contrato v2).`;
}

/** Marca de orden de bytes UTF-8: Excel la necesita para leer bien los acentos. */
const BOM = String.fromCharCode(0xfeff);

/**
 * CSV de la liquidación con Booking (D-O3): una fila por reserva y una de totales. Coma como separador y punto decimal (lo
 * que entiende cualquier hoja de cálculo al importar); con BOM para que Excel lea bien los acentos.
 */
export function settlementCsv(report: SalesReport): string {
  const cell = (value: string | number | null) => {
    const text = value === null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const s = report.bookingSettlement;
  const rows = [
    ['PNR', 'Orden de Booking', 'Referencia de pago', 'Estado', 'Creada (UTC)', 'Cobrado', 'Reembolsado', 'Penalidad', 'Neto', 'Moneda'],
    ...s.items.map((item) => [item.pnr, item.partnerOrderId, item.paymentReference, item.status, item.createdAt, item.charged, item.refunded, item.penalty, item.net, report.currency]),
    ['TOTAL', '', '', `${s.bookings} reservas`, `${report.from} a ${report.to}`, s.charged, s.refunded, s.penalties, s.net, report.currency],
  ];
  return `${BOM}${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
