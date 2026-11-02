import { ProblemDetailsException } from '../problem-details/problem-details.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Circuit breaker por MS.G (contrato v2 §7: cada llamada con timeout y circuit breaker; el health lo informa en
 * `circuit_breaker_estado`). Tras `threshold` fallas seguidas de red o de plazo, el circuito se ABRE y las llamadas fallan al
 * instante con 503 durante `openMs`; luego pasa a HALF_OPEN y deja pasar UNA llamada de prueba: si responde, se cierra.
 * Un error de negocio (4xx) no cuenta como falla: el servicio respondió.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(
    readonly name: string,
    private readonly threshold = 5,
    private readonly openMs = 10_000,
  ) {}

  get state(): CircuitState {
    if (this.openedAt === 0) return 'CLOSED';
    return Date.now() - this.openedAt >= this.openMs ? 'HALF_OPEN' : 'OPEN';
  }

  async run<T>(call: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'OPEN' || (state === 'HALF_OPEN' && this.probing)) {
      throw new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title: `${this.name} no está disponible (circuito abierto).`, retryAfterSeconds: Math.ceil(this.openMs / 1000) });
    }
    if (state === 'HALF_OPEN') this.probing = true;
    try {
      const result = await call();
      this.failures = 0;
      this.openedAt = 0;
      return result;
    } catch (error) {
      if (isUnavailable(error)) {
        this.failures++;
        if (state === 'HALF_OPEN' || this.failures >= this.threshold) this.openedAt = Date.now();
      } else {
        this.failures = 0;
        this.openedAt = 0;
      }
      throw error;
    } finally {
      if (state === 'HALF_OPEN') this.probing = false;
    }
  }
}

export const isUnavailable = (error: unknown): boolean => error instanceof ProblemDetailsException && error.problem.code === 'PROVIDER_UNAVAILABLE';
