import { ProblemDetailsException } from '@ecoairlines/shared';

/**
 * Reglas de las tarjetas (contract/payment-api.openapi.yaml, "Datos de tarjeta", D7). Funciones puras: reciben el número y el
 * CVV y devuelven lo único que se guarda (marca, últimos 4 y el resultado de prueba). El número y el CVV no salen de aquí.
 */
export type CardBrand = 'VISA' | 'MASTERCARD' | 'AMEX';
/** Lo que hará la tarjeta al autorizar (tabla de tarjetas de prueba; cualquier otra válida se autoriza). */
export type TestOutcome = 'AUTHORIZED' | 'DECLINED_CARD' | 'DECLINED_FUNDS' | 'PENDING';

export interface TestCard {
  label: string;
  number: string;
  brand: CardBrand;
  expectedResult: TestOutcome;
  cvv: string;
  expMonth: number;
  expYear: number;
}

/** `GET /test-cards` y el botón «Usar tarjeta de prueba» de la web (PLAN.md §4.8). */
export const TEST_CARDS: TestCard[] = [
  { label: 'Aprobada (Visa)', number: '4242424242424242', brand: 'VISA', expectedResult: 'AUTHORIZED', cvv: '123', expMonth: 12, expYear: 2030 },
  { label: 'Aprobada (Mastercard)', number: '5555555555554444', brand: 'MASTERCARD', expectedResult: 'AUTHORIZED', cvv: '123', expMonth: 12, expYear: 2030 },
  { label: 'Rechazada', number: '4000000000000002', brand: 'VISA', expectedResult: 'DECLINED_CARD', cvv: '123', expMonth: 12, expYear: 2030 },
  { label: 'Fondos insuficientes', number: '4000000000009995', brand: 'VISA', expectedResult: 'DECLINED_FUNDS', cvv: '123', expMonth: 12, expYear: 2030 },
  { label: 'Pendiente (se autoriza a los ~30 s)', number: '4000000000003220', brand: 'VISA', expectedResult: 'PENDING', cvv: '123', expMonth: 12, expYear: 2030 },
];

const invalid = (code: string, title: string, name: string, reason: string) => new ProblemDetailsException({ status: 422, code, title, invalidParams: [{ name, reason }] });

/** Algoritmo de Luhn: de derecha a izquierda, se duplica uno de cada dos dígitos (restando 9 si pasa de 9). */
export function passesLuhn(number: string): boolean {
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let digit = Number(number[number.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Marca por los primeros dígitos y la longitud: Visa `4` (13, 16 o 19), Mastercard `51–55` y `2221–2720` (16), Amex `34`/`37` (15). */
export function brandOf(number: string): CardBrand | undefined {
  if (number.startsWith('4') && [13, 16, 19].includes(number.length)) return 'VISA';
  const four = Number(number.slice(0, 4));
  if (number.length === 16 && (/^5[1-5]/.test(number) || (four >= 2221 && four <= 2720))) return 'MASTERCARD';
  if (number.length === 15 && /^3[47]/.test(number)) return 'AMEX';
  return undefined;
}

export interface ValidCard {
  brand: CardBrand;
  last4: string;
  outcome: TestOutcome;
}

/** Valida una tarjeta (`CARD_NUMBER_INVALID`, `CARD_BRAND_NOT_SUPPORTED`, `CARD_EXPIRED`, `CVV_INVALID`). */
export function validateCard(card: { number: string; expMonth: number; expYear: number; cvv: string }, now: Date): ValidCard {
  if (!passesLuhn(card.number)) throw invalid('CARD_NUMBER_INVALID', 'El número de tarjeta no es válido.', 'number', 'no cumple el algoritmo de Luhn');
  const brand = brandOf(card.number);
  if (!brand) throw invalid('CARD_BRAND_NOT_SUPPORTED', 'La marca de la tarjeta no se acepta.', 'number', 'solo Visa, Mastercard y American Express');
  // Vence al terminar el mes indicado (en UTC).
  if (Date.UTC(card.expYear, card.expMonth, 1) <= now.getTime()) throw invalid('CARD_EXPIRED', 'La tarjeta está vencida.', 'expYear', 'el vencimiento ya pasó');
  if (card.cvv.length !== (brand === 'AMEX' ? 4 : 3)) throw invalid('CVV_INVALID', 'El código de seguridad no es válido.', 'cvv', brand === 'AMEX' ? '4 dígitos en American Express' : '3 dígitos');
  const outcome = TEST_CARDS.find((test) => test.number === card.number)?.expectedResult ?? 'AUTHORIZED';
  return { brand, last4: card.number.slice(-4), outcome };
}
