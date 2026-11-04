/**
 * Importes del contrato (`MoneyAmount`): strings decimales con 2 decimales. Internamente se opera en centavos enteros para
 * evitar errores de redondeo de punto flotante. Copiado del monolito del Reto 1 (`EcoAirlines.DataAccess/src/common/money.ts`, retirado en V2.21).
 */
export interface MoneyAmount {
  currency: string;
  baseFare?: string;
  taxes?: string;
  total: string;
}

export const DEFAULT_CURRENCY = 'USD';

export function toCents(amount: string | undefined): number {
  return Math.round(Number(amount ?? 0) * 100);
}

export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function moneyFromCents(baseCents: number, taxesCents: number, currency = DEFAULT_CURRENCY): MoneyAmount {
  return { currency, baseFare: formatCents(baseCents), taxes: formatCents(taxesCents), total: formatCents(baseCents + taxesCents) };
}

export function sumMoney(amounts: MoneyAmount[], currency = DEFAULT_CURRENCY): MoneyAmount {
  const base = amounts.reduce((acc, amount) => acc + toCents(amount.baseFare), 0);
  const taxes = amounts.reduce((acc, amount) => acc + toCents(amount.taxes), 0);
  return moneyFromCents(base, taxes, currency);
}

export function scaleMoney(amount: MoneyAmount, factor: number): MoneyAmount {
  return moneyFromCents(Math.round(toCents(amount.baseFare) * factor), Math.round(toCents(amount.taxes) * factor), amount.currency);
}

/** Aplica un descuento porcentual al total (D35 y BKG-08: monto esperado = lockedPrice × (1 − descuento)). */
export function applyDiscount(amount: MoneyAmount, percentage: number): MoneyAmount {
  if (percentage < 0 || percentage > 100) throw new RangeError(`Descuento fuera de rango: ${percentage}`);
  return scaleMoney(amount, 1 - percentage / 100);
}

/** Dos importes son iguales si coinciden la moneda y el total al centavo (AMOUNT_MISMATCH si no). */
export function sameAmount(a: Pick<MoneyAmount, 'currency' | 'total'>, b: Pick<MoneyAmount, 'currency' | 'total'>): boolean {
  return a.currency === b.currency && toCents(a.total) === toCents(b.total);
}
