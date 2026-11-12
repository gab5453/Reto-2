import { createHash } from 'node:crypto';

/**
 * UUID estable a partir de un texto (formato de la versión 5): el mismo evento o la misma saga dan siempre el mismo `sagaId`,
 * así un reintento no se duplica en los MS.G (Offers, Bookings y PostSale son idempotentes por `sagaId`).
 */
export function stableUuid(text: string): string {
  const hex = createHash('sha256').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
