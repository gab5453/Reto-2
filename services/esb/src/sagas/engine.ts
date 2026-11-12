import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { currentCorrelation, newCorrelationId, newRequestId, type ProblemDetails, ProblemDetailsException, runWithCorrelation } from '@ecoairlines/shared';
import { countSagaFinished } from '@ecoairlines/shared/telemetry/metrics.js';
import { isUnavailable } from '../clients/circuit-breaker.js';
import { ESB_STORE, type EsbStore, SAGA_LEASE_MS, type SagaFilter, type SagaRecord } from '../repositories/esb.store.js';

/**
 * Motor de sagas del orquestador (PLAN.md §4.2, V2.10). Una saga es una secuencia de pasos en varios MS.G:
 * - Cada paso hecho se guarda en `saga_log` con su resultado. Si la réplica se cae, el trabajador de recuperación vuelve a
 *   ejecutar la saga con el MISMO `sagaId`: los pasos ya hechos devuelven su resultado guardado y no se repiten (y los MS.G
 *   son idempotentes por `sagaId`, por si el paso se hizo pero no alcanzó a guardarse).
 * - Si un paso falla ANTES del punto sin retorno, se compensan los pasos hechos en orden inverso (LIFO) y la saga queda
 *   `COMPENSATED` con el error. Si una compensación no puede hacerse (un MS.G caído), la saga queda `COMPENSATING` y se
 *   reintenta; si la rechaza por una regla de negocio, queda `FAILED` (revisión manual: nunca se oculta).
 * - DESPUÉS del punto sin retorno (p. ej. "Cancelar", que no se deshace) un fallo de disponibilidad no compensa: la saga sigue
 *   `RUNNING` y se reintenta hacia adelante con espera creciente. Un error de NEGOCIO ahí no se arregla reintentando: la saga
 *   queda `FAILED` (revisión) y el error vuelve al llamador.
 */
export const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000, 600_000, 1_800_000];

export interface SagaMeta {
  ownerId?: string;
  actorId?: string;
  parentSagaId?: string;
  /** Un `sagaId` fijo (sagas hijas o disparadas por un evento): repetir con el mismo no ejecuta otra saga. */
  sagaId?: string;
}

export interface SagaDefinition<I = unknown, R = unknown> {
  readonly type: string;
  run(saga: SagaContext, input: I): Promise<R>;
}

export type SagaOutcome<R> = { status: 'COMPLETED'; sagaId: string; result: R } | { status: 'PENDING'; sagaId: string; error?: ProblemDetails };

/** Al reanudar una compensación: se reconstruye la pila hasta el primer paso no hecho y ahí se detiene. */
class ReplayStop extends Error {}

type Compensation = { name: string; undo: () => Promise<void> };

/** Lo que ve cada saga mientras corre: sus pasos y datos (`sagaId`, dueño, administrador). */
export class SagaContext {
  readonly compensations: Compensation[] = [];
  private noReturn = false;

  constructor(
    readonly record: SagaRecord,
    private readonly mode: 'run' | 'replay',
    private readonly persist: (record: SagaRecord) => Promise<void>,
  ) {}

  get sagaId(): string {
    return this.record.sagaId;
  }
  get ownerId(): string | undefined {
    return this.record.ownerId ?? undefined;
  }
  get actorId(): string | undefined {
    return this.record.actorId ?? undefined;
  }
  get pastPointOfNoReturn(): boolean {
    return this.noReturn;
  }

  /** Desde aquí un fallo ya no se compensa: se reintenta (los pasos que siguen deben poder repetirse). */
  pointOfNoReturn(): void {
    this.noReturn = true;
  }

  /**
   * Ejecuta un paso (o devuelve su resultado guardado si ya se hizo). `name` es único en la saga; el resultado se guarda en
   * JSON (objeto plano). La compensación se registra ANTES de ejecutar: si el paso falla por plazo vencido (no se sabe si el
   * MS.G lo hizo) o la réplica se cae a la mitad, también se compensa. Por eso cada compensación debe ser segura aunque el
   * paso no haya ocurrido; recibe `undefined` si no hay resultado.
   */
  async step<T>(name: string, run: () => Promise<T>, compensate?: (result: T | undefined) => Promise<unknown>): Promise<T> {
    let step = this.record.steps.find((s) => s.name === name);
    if (step && step.status !== 'STARTED') {
      const done = step;
      if (done.status === 'DONE' && compensate) this.compensations.push({ name, undo: async () => void (await compensate(done.result as T)) });
      return done.result as T;
    }
    if (this.mode === 'replay') {
      if (step && compensate) this.compensations.push({ name, undo: async () => void (await compensate(undefined)) });
      throw new ReplayStop(name);
    }
    if (!step) {
      step = { name, status: 'STARTED', at: new Date().toISOString() };
      this.record.steps.push(step);
      await this.persist(this.record);
    }
    const current = step;
    if (compensate) this.compensations.push({ name, undo: async () => void (await compensate(current.result as T | undefined)) });
    const result = await run();
    Object.assign(current, { status: 'DONE', at: new Date().toISOString(), ...(result === undefined ? {} : { result: JSON.parse(JSON.stringify(result)) as unknown }) });
    await this.persist(this.record);
    return result;
  }
}

const problemOf = (error: unknown): ProblemDetails & Record<string, unknown> =>
  error instanceof ProblemDetailsException
    ? { ...error.problem }
    : { type: 'about:blank', status: 500, code: 'INTERNAL_ERROR', title: error instanceof Error ? error.message : String(error) };

const retryable = (error: unknown) => !(error instanceof ProblemDetailsException) || isUnavailable(error) || error.problem.status >= 500;

const delayFor = (attempts: number) => RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)];

@Injectable()
export class SagaEngine implements OnModuleDestroy {
  private readonly logger = new Logger('Sagas');
  private readonly definitions = new Map<string, SagaDefinition<never, unknown>>();
  private timer?: NodeJS.Timeout;
  private recovering?: Promise<number>;
  /** Avisa que una saga quedó para reintentar en `delayMs` (el módulo programa el mensaje diferido de RabbitMQ). */
  onRetryScheduled?: (record: SagaRecord, delayMs: number) => Promise<void>;

  constructor(@Inject(ESB_STORE) private readonly store: EsbStore) {}

  register(definition: SagaDefinition<never, unknown>): void {
    this.definitions.set(definition.type, definition);
  }

  /** Trabajador de recuperación: retoma sagas abandonadas (réplica caída) o pendientes de reintento. */
  startRecovery(intervalMs: number): void {
    // Un error de la ronda (la base no respondió) se registra; la siguiente lo reintenta. Nunca tumba el proceso.
    this.timer = setInterval(() => void this.recover().catch((error: unknown) => this.logger.error(`Recuperación de sagas: ${error instanceof Error ? error.message : String(error)}`)), intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * Inicia una saga y devuelve su `sagaId` y la promesa del resultado (para responder `202` si no termina a tiempo, sin
   * cortarla). Con un `sagaId` fijo que ya existe, no se crea otra: se espera o se devuelve la existente.
   */
  async start<I, R>(definition: SagaDefinition<I, R>, input: I, meta: SagaMeta = {}): Promise<{ sagaId: string; done: Promise<SagaOutcome<R>> }> {
    const now = new Date().toISOString();
    const record: SagaRecord = {
      sagaId: meta.sagaId ?? randomUUID(),
      type: definition.type,
      status: 'RUNNING',
      input,
      steps: [],
      result: null,
      error: null,
      ownerId: meta.ownerId ?? null,
      actorId: meta.actorId ?? null,
      correlationId: currentCorrelation()?.correlationId ?? newCorrelationId(),
      parentSagaId: meta.parentSagaId ?? null,
      attempts: 1,
      leaseUntil: new Date(Date.now() + SAGA_LEASE_MS).toISOString(),
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    if (!(await this.store.insertSaga(record))) {
      const existing = (await this.store.saga(record.sagaId))!;
      return { sagaId: existing.sagaId, done: this.settled<R>(existing) };
    }
    return { sagaId: record.sagaId, done: this.execute(definition, record) };
  }

  /** Inicia y espera el final (sagas hijas, eventos de Booking, pruebas). */
  async run<I, R>(definition: SagaDefinition<I, R>, input: I, meta: SagaMeta = {}): Promise<SagaOutcome<R>> {
    return (await this.start(definition, input, meta)).done;
  }

  /** Una saga que ya existía: si terminó, su resultado (o su error); si sigue en curso, se reporta pendiente. */
  private async settled<R>(record: SagaRecord): Promise<SagaOutcome<R>> {
    if (record.status === 'COMPLETED') return { status: 'COMPLETED', sagaId: record.sagaId, result: record.result as R };
    if (record.status === 'COMPENSATED' || record.status === 'FAILED') throw this.storedError(record);
    if (record.leaseUntil <= new Date().toISOString() && record.nextAttemptAt <= new Date().toISOString()) {
      const definition = this.definitions.get(record.type);
      if (definition) {
        const [claimed] = (await this.store.claimStaleSagas(new Date().toISOString(), 50)).filter((s) => s.sagaId === record.sagaId);
        if (claimed) return this.execute(definition as SagaDefinition<unknown, R>, claimed);
      }
    }
    return { status: 'PENDING', sagaId: record.sagaId, ...(record.error ? { error: record.error as unknown as ProblemDetails } : {}) };
  }

  private storedError(record: SagaRecord): ProblemDetailsException {
    const problem = (record.error ?? { status: 500, code: 'INTERNAL_ERROR', title: 'La saga falló.' }) as unknown as ProblemDetails;
    return new ProblemDetailsException({ status: problem.status, code: problem.code, title: problem.title, ...(problem.detail ? { detail: problem.detail } : {}), ...(problem.invalidParams ? { invalidParams: problem.invalidParams } : {}) });
  }

  private persist = async (record: SagaRecord): Promise<void> => {
    const now = Date.now();
    record.updatedAt = new Date(now).toISOString();
    record.leaseUntil = new Date(now + SAGA_LEASE_MS).toISOString();
    await this.store.saveSaga(record);
  };

  /** Ejecuta (o reanuda) una saga con el correlation id con el que empezó. */
  private execute<R>(definition: SagaDefinition<unknown, R>, record: SagaRecord): Promise<SagaOutcome<R>> {
    return runWithCorrelation({ correlationId: record.correlationId, requestId: newRequestId() }, async () => {
      const context = new SagaContext(record, record.status === 'COMPENSATING' ? 'replay' : 'run', this.persist);
      try {
        const result = await definition.run(context, record.input);
        if (record.status === 'COMPENSATING') return this.compensate(context, new ProblemDetailsException({ status: 500, code: 'INTERNAL_ERROR', title: 'Compensación reanudada.' }));
        Object.assign(record, { status: 'COMPLETED', result: result === undefined ? null : JSON.parse(JSON.stringify(result)), error: null });
        await this.persist(record);
        this.logger.log(`${record.type} ${record.sagaId} COMPLETED (${record.steps.length} pasos) [${record.correlationId}]`);
        countSagaFinished(record.type, 'COMPLETED');
        return { status: 'COMPLETED' as const, sagaId: record.sagaId, result };
      } catch (error) {
        if (error instanceof ReplayStop || record.status === 'COMPENSATING' || !context.pastPointOfNoReturn) {
          const original = error instanceof ReplayStop ? this.storedError(record) : error;
          return this.compensate(context, original);
        }
        // Después del punto sin retorno: no se deshace. Un error de negocio no se arregla reintentando → FAILED (revisión).
        const problem = problemOf(error);
        if (!retryable(error)) {
          Object.assign(record, { status: 'FAILED', error: problem });
          await this.persist(record);
          this.logger.error(`${record.type} ${record.sagaId} FAILED después del punto sin retorno (${problem.code}) — requiere revisión [${record.correlationId}]`);
          countSagaFinished(record.type, 'FAILED');
          throw error;
        }
        const delay = delayFor(record.attempts);
        Object.assign(record, { error: problem, nextAttemptAt: new Date(Date.now() + delay).toISOString() });
        await this.persist(record);
        record.leaseUntil = record.nextAttemptAt;
        await this.store.saveSaga(record);
        await this.onRetryScheduled?.(record, delay).catch(() => undefined);
        this.logger.warn(`${record.type} ${record.sagaId} pendiente (${problem.code}); reintento ${record.attempts} en ${delay / 1000} s [${record.correlationId}]`);
        return { status: 'PENDING' as const, sagaId: record.sagaId, error: problem };
      }
    });
  }

  /** Compensa en orden inverso los pasos hechos. Lanza el error original si terminó; si una compensación no pudo, queda pendiente. */
  private async compensate<R>(context: SagaContext, original: unknown): Promise<SagaOutcome<R>> {
    const record = context.record;
    if (record.status !== 'COMPENSATING') {
      Object.assign(record, { status: 'COMPENSATING', error: problemOf(original) });
      await this.persist(record);
    }
    for (const compensation of [...context.compensations].reverse()) {
      const step = record.steps.find((s) => s.name === compensation.name)!;
      if (step.status === 'COMPENSATED') continue;
      try {
        await compensation.undo();
        step.status = 'COMPENSATED';
        step.at = new Date().toISOString();
        await this.persist(record);
      } catch (error) {
        if (retryable(error)) {
          const delay = delayFor(record.attempts);
          record.nextAttemptAt = new Date(Date.now() + delay).toISOString();
          await this.persist(record);
          record.leaseUntil = record.nextAttemptAt;
          await this.store.saveSaga(record);
          await this.onRetryScheduled?.(record, delay).catch(() => undefined);
          this.logger.warn(`${record.type} ${record.sagaId}: la compensación "${compensation.name}" se reintentará en ${delay / 1000} s [${record.correlationId}]`);
          throw original;
        }
        Object.assign(record, { status: 'FAILED', error: { ...problemOf(original), compensationFailed: { step: compensation.name, problem: problemOf(error) } } });
        await this.persist(record);
        this.logger.error(`${record.type} ${record.sagaId} FAILED: la compensación "${compensation.name}" fue rechazada (${problemOf(error).code}) — requiere revisión [${record.correlationId}]`);
        countSagaFinished(record.type, 'FAILED');
        throw original;
      }
    }
    record.status = 'COMPENSATED';
    await this.persist(record);
    this.logger.warn(`${record.type} ${record.sagaId} COMPENSATED (${(record.error as { code?: string })?.code}) [${record.correlationId}]`);
    countSagaFinished(record.type, 'COMPENSATED');
    throw original;
  }

  /** Una ronda de recuperación (para las pruebas devuelve cuántas tomó). */
  recover(): Promise<number> {
    this.recovering ??= (async () => {
      const stale = await this.store.claimStaleSagas(new Date().toISOString(), 20);
      for (const record of stale) {
        const definition = this.definitions.get(record.type);
        if (!definition) continue;
        this.logger.log(`Retomando ${record.type} ${record.sagaId} (${record.status}, intento ${record.attempts}) [${record.correlationId}]`);
        await this.execute(definition, record).catch(() => undefined);
      }
      return stale.length;
    })().finally(() => (this.recovering = undefined));
    return this.recovering;
  }

  /** Reintento diferido que llegó por RabbitMQ: retoma esa saga si ya le toca (si no, o si otra réplica la tiene, no hace nada). */
  async resume(sagaId: string): Promise<boolean> {
    const record = await this.store.claimSaga(sagaId, new Date().toISOString());
    const definition = record && this.definitions.get(record.type);
    if (!record || !definition) return false;
    this.logger.log(`Retomando ${record.type} ${record.sagaId} por el reintento diferido (intento ${record.attempts}) [${record.correlationId}]`);
    await this.execute(definition, record).catch(() => undefined);
    return true;
  }

  saga(sagaId: string): Promise<SagaRecord | undefined> {
    return this.store.saga(sagaId);
  }

  listSagas(filter: SagaFilter): Promise<SagaRecord[]> {
    return this.store.listSagas(filter);
  }
}
