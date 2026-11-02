import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemDetailsException } from '@ecoairlines/shared';
import { ESB_STORE, type EsbStore, type StoredResponse } from '../repositories/esb.store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IdempotentResult extends StoredResponse {
  replayed: boolean;
}

/**
 * Idempotencia del contrato v2 (D6: se resuelve en el ESB). Con `Idempotency-Key` (UUID):
 * - primera vez: se reserva la clave, se ejecuta y se guarda la respuesta 24 h junto con el `request_hash`;
 * - misma clave y mismo `request_hash`: se devuelve la respuesta guardada (`Idempotent-Replayed: true`) sin ejecutar nada;
 * - misma clave y otro cuerpo: `409 IDEMPOTENCY_KEY_REUSED`;
 * - misma clave mientras la primera sigue en curso: se espera un poco y se repite su respuesta; si no termina, `409` con
 *   `Retry-After` (nunca se ejecuta dos veces a la vez).
 * Un 5xx no se guarda (la clave se libera): el reintento con la misma clave vuelve a intentarlo, que es lo que espera Booking.
 * El alcance (`scope`) es el dueño: la clave de un cliente nunca devuelve la respuesta de otro.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(ESB_STORE) private readonly store: EsbStore) {}

  static hash(...parts: (string | Buffer)[]): string {
    const hash = createHash('sha256');
    for (const part of parts) hash.update(part).update('\u0000');
    return hash.digest('hex');
  }

  async run(key: string | undefined, scope: string, requestHash: string, execute: () => Promise<StoredResponse>): Promise<IdempotentResult> {
    if (key === undefined) return { ...(await execute()), replayed: false };
    if (!UUID.test(key)) {
      throw new ProblemDetailsException({
        status: 400,
        code: 'VALIDATION_FAILED',
        title: 'Idempotency-Key debe ser un UUID.',
        invalidParams: [{ name: 'Idempotency-Key', reason: 'debe ser un UUID v4' }],
      });
    }
    const normalized = key.toLowerCase();
    const deadline = Date.now() + 3_000;
    for (;;) {
      const claim = await this.store.claim(scope, normalized, requestHash, Date.now());
      if (claim.kind === 'replay') return { ...claim.response, replayed: true };
      if (claim.kind === 'mismatch') {
        throw new ProblemDetailsException({
          status: 409,
          code: 'IDEMPOTENCY_KEY_REUSED',
          title: 'La Idempotency-Key ya se usó con otra petición.',
          detail: 'Use una clave nueva para una operación distinta; un reintento debe enviar exactamente el mismo cuerpo.',
        });
      }
      if (claim.kind === 'new') break;
      if (Date.now() >= deadline) {
        throw new ProblemDetailsException({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED', title: 'Hay una petición en curso con esta Idempotency-Key.', retryAfterSeconds: 1 });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let response: StoredResponse;
    try {
      response = await execute();
    } catch (error) {
      await this.store.release(scope, normalized);
      throw error;
    }
    if (response.status >= 500) await this.store.release(scope, normalized);
    else await this.store.complete(scope, normalized, response);
    return { ...response, replayed: false };
  }
}
