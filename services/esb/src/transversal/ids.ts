import { createHash } from 'node:crypto';

/**
 * UUID estable a partir de un texto (formato de la versión 5): el mismo evento o la misma saga dan siempre el mismo `sagaId`,
 * así un reintento no se duplica en los MS.G (Offers, Bookings y PostSale son idempotentes por `sagaId`).
 */
export function stableUuid(text: string): string {
  return uuidFromHash(text, '5');
}

/**
 * `id` de un CloudEvent que publica una saga: igual de ESTABLE que `stableUuid` (un reintento de la saga produce el mismo `id`,
 * y el consumidor lo descarta como duplicado), pero con el formato de un UUID versión 4. Booking valida que el `id` de sus
 * webhooks sea un UUID v4 y rechazaba los v5 con HTTP 400 (BKG-16, 12/11). El contrato del grupo admite cualquier texto como `id`.
 * Los `sagaId` y las claves de idempotencia siguen con `stableUuid` (cambiarlos rompería la idempotencia de las sagas en curso).
 */
export function stableEventId(text: string): string {
  return uuidFromHash(`evento:${text}`, '4');
}

function uuidFromHash(text: string, version: '4' | '5'): string {
  const hex = createHash('sha256').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
