import { type ProblemDetails, ProblemDetailsException } from '../problem-details/problem-details.js';
import type { OperationContext } from './app.js';
import { EsbProblem, type EsbResponse } from './esb-client.js';

/**
 * Sagas que no terminan en el plazo del ESB (4,5 s: menos que el timeout de 5 s de Booking). El ESB responde `202` con el
 * `sagaId` y la saga sigue (V2.10). Como el ESB guarda ese `202` para la `Idempotency-Key`, un reintento con la misma clave lo
 * repite: aquí se consulta el estado real de la saga (`GET /sagas/{sagaId}`, solo su dueño o un administrador).
 * - `COMPLETED` → su resultado, como si hubiera terminado a tiempo;
 * - `FAILED` / `COMPENSATED` → su error (el mismo ProblemDetails del paso que falló);
 * - en curso → `pending`, y cada operación responde lo que su contrato permite.
 */
export type SagaOutcome = { done: true; status: number; body: unknown; replayed: boolean } | { done: false; sagaId: string; bookingId?: string };

interface SagaView {
  sagaId: string;
  status: 'RUNNING' | 'COMPLETED' | 'COMPENSATING' | 'COMPENSATED' | 'FAILED';
  result: unknown;
  error: (Partial<ProblemDetails> & { status?: number }) | null;
}

export async function sagaOutcome(context: OperationContext, response: EsbResponse, as: { ownerId?: string; actorId?: string }): Promise<SagaOutcome> {
  const body = response.body as { sagaId?: string; bookingId?: string; status?: string } | undefined;
  if (response.status !== 202 || !body?.sagaId) return { done: true, status: response.status, body: response.body, replayed: response.replayed };
  const saga = (await context.esb<SagaView>({ method: 'GET', path: `/sagas/${body.sagaId}`, ...as })).body;
  if (saga.status === 'COMPLETED') return { done: true, status: 200, body: saga.result, replayed: response.replayed };
  if ((saga.status === 'FAILED' || saga.status === 'COMPENSATED') && saga.error) {
    const status = typeof saga.error.status === 'number' && saga.error.status >= 400 ? saga.error.status : 409;
    throw new EsbProblem({ status, headers: new Headers(), body: saga.error, replayed: response.replayed }, saga.error);
  }
  return { done: false, sagaId: body.sagaId, ...(body.bookingId ? { bookingId: body.bookingId } : {}) };
}

/**
 * Para las operaciones cuyo contrato no documenta `202`: `503` con `Retry-After`. La saga sigue; el cliente reintenta con la
 * MISMA `Idempotency-Key` y recibe el resultado cuando termina (no se ejecuta dos veces).
 */
export function stillRunning(sagaId: string): ProblemDetailsException {
  return new ProblemDetailsException({
    status: 503,
    code: 'PROVIDER_UNAVAILABLE',
    title: 'La operación sigue en curso.',
    detail: `Reintente con la misma Idempotency-Key para obtener el resultado (saga ${sagaId}).`,
    retryAfterSeconds: 5,
  });
}

/** `Idempotent-Replayed: true` si el ESB devolvió una respuesta guardada. */
export const replayHeaders = (replayed: boolean): Record<string, string> => (replayed ? { 'Idempotent-Replayed': 'true' } : {});
