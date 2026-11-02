import { useCallback, useEffect, useRef } from 'react';
import { ApiError } from '../api/client';

const DEVICE_KEY = 'eco.deviceFingerprint';
let memoryFingerprint: string | undefined;

/**
 * Identificador del navegador para el header obligatorio `X-Device-Fingerprint` de `POST /search`.
 * No es un secreto ni identifica a la persona: es un UUID aleatorio por navegador.
 * Si el almacenamiento no está disponible (modo privado), se usa uno por sesión en memoria.
 */
export function deviceFingerprint(): string {
  try {
    const stored = window.localStorage.getItem(DEVICE_KEY);
    if (stored) return stored;
    const created = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    memoryFingerprint ??= crypto.randomUUID();
    return memoryFingerprint;
  }
}

/**
 * `Idempotency-Key` por intento de operación: se REUTILIZA en reintentos del mismo envío (error de red,
 * doble clic) y se renueva cuando cambian los datos o la operación termina bien. Así un reintento nunca
 * duplica una reserva y una petición distinta nunca choca con la anterior (409).
 */
export function useIdempotencyKey(dependencies: unknown[]): { key: () => string; renew: () => void } {
  const ref = useRef<string>(crypto.randomUUID());
  const renew = useCallback(() => {
    ref.current = crypto.randomUUID();
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(renew, dependencies);
  return { key: useCallback(() => ref.current, []), renew };
}

/** La operación sigue en curso en el servidor: `PROVIDER_UNAVAILABLE` con `retryAfter` (p. ej. la tarjeta quedó pendiente). */
const stillRunning = (error: unknown) =>
  error instanceof ApiError && error.problem?.code === 'PROVIDER_UNAVAILABLE' && error.retryAfter !== undefined;

/**
 * Reintenta `send` mientras el servidor responda que la operación sigue en curso (la saga continúa y, con la MISMA
 * `Idempotency-Key`, el reintento devuelve el resultado cuando termina, sin ejecutarla dos veces). `onWaiting` avisa a la
 * pantalla en cada espera. Como mucho `maxWaitMs`; después se lanza el último error.
 */
export async function retryWhileRunning<T>(send: () => Promise<T>, onWaiting: () => void, maxWaitMs = 120_000): Promise<T> {
  const until = Date.now() + maxWaitMs;
  for (;;) {
    try {
      return await send();
    } catch (error) {
      if (!stillRunning(error) || Date.now() >= until) throw error;
      onWaiting();
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, (error as ApiError).retryAfter!) * 1000));
    }
  }
}
