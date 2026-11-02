import { useCallback, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { authorizeCard, listTestCards, type TestCard } from '../api/payments';
import type { MoneyAmount } from '../api/types';

/** Datos de la tarjeta tal como los escribe el cliente. Viven solo en memoria y se borran al terminar el pago. */
export interface CardForm {
  holderName: string;
  number: string;
  /** MM/AA */
  expiry: string;
  cvv: string;
}

const EMPTY_CARD: CardForm = { holderName: '', number: '', expiry: '', cvv: '' };

/** Errores de pago que vienen del GraphQL: la autorización ya no sirve y la próxima vez hay que autorizar de nuevo. */
const PAYMENT_CODES = new Set(['PAYMENT_NOT_AUTHORIZED', 'PAYMENT_REFERENCE_INVALID', 'AMOUNT_MISMATCH']);

const DECLINE_MESSAGES: Record<string, string> = {
  card_declined: 'Tu tarjeta fue rechazada. Usa otra tarjeta.',
  insufficient_funds: 'La tarjeta no tiene fondos suficientes. Usa otra tarjeta.',
};

const cardError = (message: string, code = 'CARD_DECLINED') =>
  new ApiError(402, message, { type: 'about:blank', title: message, status: 402, code });

const digits = (value: string) => value.replace(/\D/g, '');

function parseExpiry(expiry: string): { expMonth: number; expYear: number } | undefined {
  const match = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(expiry.trim());
  if (!match) return undefined;
  const expMonth = Number(match[1]);
  const expYear = match[2]!.length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
  return expMonth >= 1 && expMonth <= 12 ? { expMonth, expYear } : undefined;
}

/** Revisión previa en el navegador (la pasarela valida igualmente Luhn, marca, vencimiento y CVV). */
function cardIssue(card: CardForm): string | undefined {
  if (card.holderName.trim().length < 2) return 'Escribe el nombre del titular como aparece en la tarjeta.';
  if (!/^\d{13,19}$/.test(digits(card.number))) return 'El número de tarjeta debe tener entre 13 y 19 dígitos.';
  if (!parseExpiry(card.expiry)) return 'Escribe el vencimiento como MM/AA.';
  if (!/^\d{3,4}$/.test(card.cvv)) return 'El código de seguridad tiene 3 dígitos (4 en American Express).';
  return undefined;
}

/**
 * Pago con tarjeta del canal web (PLAN.md §4.8). `pay(amount)` tokeniza y autoriza en la Payment API y devuelve el
 * `paymentReference` que se envía por GraphQL. Si la operación falla por otro motivo (p. ej. un dato del pasajero), el
 * reintento REUTILIZA la misma autorización: así la petición GraphQL es idéntica y su `idempotencyKey` no choca.
 */
// eslint-disable-next-line react/only-export-components
export function useCardPayment() {
  const [card, setCardState] = useState<CardForm>(EMPTY_CARD);
  const authorized = useRef<{ reference: string; amount: string } | null>(null);

  const setCard = useCallback((next: CardForm) => {
    authorized.current = null;
    setCardState(next);
  }, []);

  const pay = useCallback(
    async (amount: MoneyAmount, description: string): Promise<string> => {
      const key = `${amount.currency} ${amount.total}`;
      if (authorized.current?.amount === key) return authorized.current.reference;
      const issue = cardIssue(card);
      if (issue) throw cardError(issue, 'VALIDATION_FAILED');
      const payment = await authorizeCard({ holderName: card.holderName.trim(), number: digits(card.number), ...parseExpiry(card.expiry)!, cvv: card.cvv }, amount, description);
      if (payment.status === 'DECLINED') throw cardError(DECLINE_MESSAGES[payment.declineCode ?? ''] ?? 'El pago fue rechazado. Usa otra tarjeta.');
      authorized.current = { reference: payment.paymentReference, amount: key };
      return payment.paymentReference;
    },
    [card],
  );

  /** La operación terminó bien: se olvidan la tarjeta y la autorización. */
  const done = useCallback(() => {
    authorized.current = null;
    setCardState(EMPTY_CARD);
  }, []);

  /** La operación falló: si fue por el pago, la próxima vez se autoriza de nuevo. */
  const failed = useCallback((error: unknown) => {
    if (error instanceof ApiError && PAYMENT_CODES.has(error.problem?.code ?? '')) authorized.current = null;
  }, []);

  return { card, setCard, pay, done, failed };
}

/** Campos de la tarjeta con el botón «Usar tarjeta de prueba» (tarjetas de `GET /test-cards` de la pasarela). */
export function CardFields({ card, onChange, disabled = false }: { card: CardForm; onChange: (card: CardForm) => void; disabled?: boolean }) {
  const id = useId();
  const [testCards, setTestCards] = useState<TestCard[] | null>(null);
  const [testError, setTestError] = useState<string>();

  const loadTestCards = async () => {
    setTestError(undefined);
    try {
      setTestCards(await listTestCards());
    } catch {
      setTestError('No se pudieron cargar las tarjetas de prueba.');
    }
  };

  const fillTestCard = (number: string) => {
    const test = testCards?.find((candidate) => candidate.number === number);
    if (!test) return;
    const year = String(test.expYear ?? new Date().getFullYear() + 3).slice(-2);
    onChange({ holderName: 'PRUEBA ECOAIRLINES', number: test.number.replace(/(\d{4})(?=\d)/g, '$1 '), expiry: `${String(test.expMonth ?? 12).padStart(2, '0')}/${year}`, cvv: test.cvv ?? '123' });
  };

  return (
    <fieldset className="card-fields" disabled={disabled}>
      <legend className="visually-hidden">Datos de la tarjeta</legend>
      <div className="grid-2">
        <label className="field" htmlFor={`${id}-holder`}>
          Titular
          <input id={`${id}-holder`} value={card.holderName} autoComplete="cc-name" maxLength={60} onChange={(event) => onChange({ ...card, holderName: event.target.value })} />
        </label>
        <label className="field" htmlFor={`${id}-number`}>
          Número de tarjeta
          <input
            id={`${id}-number`}
            value={card.number}
            inputMode="numeric"
            autoComplete="cc-number"
            maxLength={23}
            placeholder="4242 4242 4242 4242"
            onChange={(event) => onChange({ ...card, number: event.target.value.replace(/[^\d ]/g, '') })}
          />
        </label>
        <label className="field" htmlFor={`${id}-expiry`}>
          Vencimiento (MM/AA)
          <input id={`${id}-expiry`} value={card.expiry} inputMode="numeric" autoComplete="cc-exp" maxLength={7} placeholder="12/30" onChange={(event) => onChange({ ...card, expiry: event.target.value })} />
        </label>
        <label className="field" htmlFor={`${id}-cvv`}>
          Código de seguridad (CVV)
          <input
            id={`${id}-cvv`}
            type="password"
            value={card.cvv}
            inputMode="numeric"
            autoComplete="cc-csc"
            maxLength={4}
            onChange={(event) => onChange({ ...card, cvv: digits(event.target.value) })}
          />
        </label>
      </div>
      <div className="input-row">
        {testCards ? (
          <label className="inline-field">
            Tarjeta de prueba
            <select defaultValue="" onChange={(event) => fillTestCard(event.target.value)}>
              <option value="" disabled>Elige una…</option>
              {testCards.map((test) => (
                <option key={test.number} value={test.number}>{test.label}</option>
              ))}
            </select>
          </label>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadTestCards()}>
            Usar tarjeta de prueba
          </button>
        )}
      </div>
      {testError && <p className="form-error small">{testError}</p>}
      <p className="muted small">
        Entorno de pruebas: ninguna tarjeta es real. Los datos van directo a la pasarela de pagos; EcoAirlines solo recibe la referencia
        del pago aprobado.
      </p>
    </fieldset>
  );
}
