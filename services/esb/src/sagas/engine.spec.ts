import { currentCorrelation, ProblemDetailsException, runWithCorrelation } from '@ecoairlines/shared';
import type { EsbStore, SagaRecord } from '../repositories/esb.store.js';
import { RETRY_DELAYS_MS, SagaEngine, type SagaContext, type SagaDefinition } from './engine.js';

/**
 * PU-3 (Informacion_General/Pruebas.md §5.1.3): el motor de sagas del ESB, solo, con un repositorio *fake* (un Map en memoria
 * con las mismas reglas de plazos) y sagas inventadas cuyos pasos son *spies*. Las 11 sagas reales ya se prueban integradas
 * en `test/sagas.spec.ts`; aquí se prueba el mecanismo: orden, compensación LIFO, punto sin retorno, reintentos y reanudación.
 */

/** Fake del repositorio de sagas: guarda copias (como la base) y aplica el mismo criterio de plazos para retomar. */
function fakeStore() {
  const sagas = new Map<string, SagaRecord>();
  /** Copia de cada guardado EN ESE MOMENTO: un spy guarda la referencia y el motor sigue modificando el mismo objeto. */
  const snapshots: SagaRecord[] = [];
  const store = {
    sagas,
    snapshots,
    insertSaga: vi.fn(async (r: SagaRecord) => (sagas.has(r.sagaId) ? false : (sagas.set(r.sagaId, structuredClone(r)), true))),
    saga: vi.fn(async (id: string) => (sagas.has(id) ? structuredClone(sagas.get(id)!) : undefined)),
    saveSaga: vi.fn(async (r: SagaRecord) => {
      snapshots.push(structuredClone(r));
      sagas.set(r.sagaId, structuredClone(r));
    }),
    claimStaleSagas: vi.fn(async (now: string) => {
      const ready = [...sagas.values()].filter((s) => (s.status === 'RUNNING' || s.status === 'COMPENSATING') && s.leaseUntil <= now && s.nextAttemptAt <= now);
      for (const s of ready) s.attempts += 1;
      return ready.map((s) => structuredClone(s));
    }),
    claimSaga: vi.fn(async (id: string, now: string) => {
      const s = sagas.get(id);
      if (!s || !(s.status === 'RUNNING' || s.status === 'COMPENSATING') || s.leaseUntil > now || s.nextAttemptAt > now) return undefined;
      s.attempts += 1;
      return structuredClone(s);
    }),
    listSagas: vi.fn(),
  };
  return store;
}

let store: ReturnType<typeof fakeStore>;
let engine: SagaEngine;
let retries: { sagaId: string; delay: number }[];
beforeEach(() => {
  store = fakeStore();
  engine = new SagaEngine(store as unknown as EsbStore);
  retries = [];
  engine.onRetryScheduled = async (record, delay) => void retries.push({ sagaId: record.sagaId, delay });
});

const caido = () => new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title: 'MS.G caído' });
const negocio = () => new ProblemDetailsException({ status: 409, code: 'SEAT_TAKEN', title: 'Asiento tomado' });
const guardada = (sagaId: string) => store.sagas.get(sagaId)!;
/** Hace que una saga guardada ya "toque" retomarse (plazo vencido). */
const vencer = (sagaId: string) => Object.assign(guardada(sagaId), { leaseUntil: '2000-01-01T00:00:00.000Z', nextAttemptAt: '2000-01-01T00:00:00.000Z' });

/** Saga de 3 pasos A → B → C; cada uno con su compensación. `falla` decide qué paso lanza y con qué error. */
function sagaDePrueba(opciones: { falla?: { en: 'A' | 'B' | 'C'; error: () => Error }; puntoSinRetornoTras?: 'A' | 'B'; type?: string } = {}) {
  const orden: string[] = [];
  const paso = (nombre: 'A' | 'B' | 'C') => vi.fn(async () => {
    orden.push(nombre);
    if (opciones.falla?.en === nombre) throw opciones.falla.error();
    return { hecho: nombre, cuando: new Date('2026-12-01T00:00:00Z') };
  });
  const deshacer = (nombre: string) => vi.fn(async (resultado: unknown) => void orden.push(`deshacer ${nombre}${resultado === undefined ? ' (sin resultado)' : ''}`));
  const pasos = { A: paso('A'), B: paso('B'), C: paso('C') };
  const compensaciones = { A: deshacer('A'), B: deshacer('B'), C: deshacer('C') };
  const definition: SagaDefinition<{ bookingId: string }, string> = {
    type: opciones.type ?? 'PRUEBA',
    async run(saga: SagaContext) {
      await saga.step('A', pasos.A, compensaciones.A);
      if (opciones.puntoSinRetornoTras === 'A') saga.pointOfNoReturn();
      await saga.step('B', pasos.B, compensaciones.B);
      if (opciones.puntoSinRetornoTras === 'B') saga.pointOfNoReturn();
      await saga.step('C', pasos.C, compensaciones.C);
      return 'listo';
    },
  };
  engine.register(definition as SagaDefinition<never, unknown>);
  return { definition, orden, pasos, compensaciones };
}

describe('camino feliz', () => {
  it('ejecuta los pasos en orden, termina COMPLETED y guarda cada resultado como JSON plano', async () => {
    const { definition, orden } = sagaDePrueba();
    const outcome = await engine.run(definition, { bookingId: 'b-1' }, { ownerId: 'cliente-1', actorId: 'admin-1' });
    expect(outcome).toMatchObject({ status: 'COMPLETED', result: 'listo' });
    expect(orden).toEqual(['A', 'B', 'C']);
    const record = guardada(outcome.sagaId);
    expect(record).toMatchObject({ status: 'COMPLETED', result: 'listo', ownerId: 'cliente-1', actorId: 'admin-1', error: null });
    expect(record.steps.map((s) => [s.name, s.status])).toEqual([
      ['A', 'DONE'],
      ['B', 'DONE'],
      ['C', 'DONE'],
    ]);
    expect(record.steps[0]!.result).toEqual({ hecho: 'A', cuando: '2026-12-01T00:00:00.000Z' }); // la fecha queda como texto
  });
  it('cada paso se marca STARTED antes de ejecutarse (si la réplica se cae a la mitad, se sabe dónde iba)', async () => {
    const { definition } = sagaDePrueba();
    await engine.run(definition, { bookingId: 'b-1' });
    const estados = store.snapshots.map((r) => r.steps.map((s) => `${s.name}:${s.status}`).join(','));
    expect(estados[0]).toBe('A:STARTED');
    expect(estados[1]).toBe('A:DONE');
    expect(estados[2]).toBe('A:DONE,B:STARTED');
  });
  it('todos los pasos corren con el correlation ID con el que empezó la saga', async () => {
    const vistos: (string | undefined)[] = [];
    const definition: SagaDefinition<null, null> = {
      type: 'CORRELATION',
      async run(saga) {
        await saga.step('uno', async () => vistos.push(currentCorrelation()?.correlationId));
        return null;
      },
    };
    const outcome = await runWithCorrelation({ correlationId: 'corr-original', requestId: 'r' }, () => engine.run(definition, null));
    expect(vistos).toEqual(['corr-original']);
    expect(guardada(outcome.sagaId).correlationId).toBe('corr-original');
  });
});

describe('falla antes del punto sin retorno: se compensa en orden inverso (LIFO)', () => {
  it('deshace C (que falló), B y A, en ese orden; queda COMPENSATED y el error vuelve al llamador', async () => {
    const { definition, orden } = sagaDePrueba({ falla: { en: 'C', error: negocio } });
    await expect(engine.run(definition, { bookingId: 'b-1' })).rejects.toMatchObject({ problem: { code: 'SEAT_TAKEN' } });
    expect(orden).toEqual(['A', 'B', 'C', 'deshacer C (sin resultado)', 'deshacer B', 'deshacer A']);
    const record = [...store.sagas.values()][0]!;
    expect(record.status).toBe('COMPENSATED');
    expect(record.error).toMatchObject({ code: 'SEAT_TAKEN' });
    expect(record.steps.map((s) => s.status)).toEqual(['COMPENSATED', 'COMPENSATED', 'COMPENSATED']);
  });
  it('la compensación de un paso fallido recibe undefined: debe ser segura aunque el paso no ocurrió', async () => {
    const { definition, compensaciones } = sagaDePrueba({ falla: { en: 'B', error: caido } });
    await expect(engine.run(definition, { bookingId: 'b-1' })).rejects.toThrow();
    expect(compensaciones.B).toHaveBeenCalledWith(undefined);
    expect(compensaciones.A).toHaveBeenCalledWith({ hecho: 'A', cuando: '2026-12-01T00:00:00.000Z' });
    expect(compensaciones.C).not.toHaveBeenCalled();
  });
  it('un error que no es ProblemDetails se guarda como INTERNAL_ERROR', async () => {
    const { definition } = sagaDePrueba({ falla: { en: 'A', error: () => new Error('se rompió') } });
    await expect(engine.run(definition, { bookingId: 'b-1' })).rejects.toThrow('se rompió');
    expect([...store.sagas.values()][0]!.error).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', title: 'se rompió' });
  });
  it('si una compensación no puede hacerse (MS.G caído), queda COMPENSATING y se programa el reintento', async () => {
    const { definition, compensaciones } = sagaDePrueba({ falla: { en: 'C', error: negocio } });
    compensaciones.A.mockRejectedValueOnce(caido());
    await expect(engine.run(definition, { bookingId: 'b-1' })).rejects.toMatchObject({ problem: { code: 'SEAT_TAKEN' } });
    const record = [...store.sagas.values()][0]!;
    expect(record.status).toBe('COMPENSATING');
    expect(record.steps.map((s) => s.status)).toEqual(['DONE', 'COMPENSATED', 'COMPENSATED']);
    expect(retries).toEqual([{ sagaId: record.sagaId, delay: RETRY_DELAYS_MS[0] }]);
  });
  it('si una compensación se rechaza por una regla de negocio, queda FAILED con el detalle (revisión manual)', async () => {
    const { definition, compensaciones } = sagaDePrueba({ falla: { en: 'C', error: negocio } });
    compensaciones.B.mockRejectedValueOnce(new ProblemDetailsException({ status: 409, code: 'BOOKING_NOT_CANCELLABLE', title: 'no' }));
    await expect(engine.run(definition, { bookingId: 'b-1' })).rejects.toThrow();
    const record = [...store.sagas.values()][0]!;
    expect(record.status).toBe('FAILED');
    expect(record.error).toMatchObject({ code: 'SEAT_TAKEN', compensationFailed: { step: 'B', problem: { code: 'BOOKING_NOT_CANCELLABLE' } } });
  });
});

describe('después del punto sin retorno: no se deshace', () => {
  it('un MS.G caído deja la saga RUNNING y PENDING, sin compensar, con reintento en 2 s', async () => {
    const { definition, orden } = sagaDePrueba({ falla: { en: 'C', error: caido }, puntoSinRetornoTras: 'B' });
    const outcome = await engine.run(definition, { bookingId: 'b-1' });
    expect(outcome).toMatchObject({ status: 'PENDING', error: { code: 'PROVIDER_UNAVAILABLE' } });
    expect(orden).toEqual(['A', 'B', 'C']);
    expect(guardada(outcome.sagaId).status).toBe('RUNNING');
    expect(retries).toEqual([{ sagaId: outcome.sagaId, delay: 2_000 }]);
  });
  it('un error de negocio no se arregla reintentando: FAILED y el error vuelve al llamador', async () => {
    const { definition, orden } = sagaDePrueba({ falla: { en: 'C', error: negocio }, puntoSinRetornoTras: 'B' });
    await expect(engine.run(definition, { bookingId: 'b-1' })).rejects.toMatchObject({ problem: { code: 'SEAT_TAKEN' } });
    expect(orden).not.toContain('deshacer A');
    expect([...store.sagas.values()][0]!.status).toBe('FAILED');
    expect(retries).toEqual([]);
  });
  it('al retomarla, los pasos hechos NO se repiten: solo sigue desde el que falló', async () => {
    const { definition, pasos } = sagaDePrueba({ falla: { en: 'C', error: caido }, puntoSinRetornoTras: 'B' });
    const { sagaId } = await engine.run(definition, { bookingId: 'b-1' });
    pasos.C.mockResolvedValueOnce({ hecho: 'C', cuando: new Date(0) });
    vencer(sagaId);
    expect(await engine.resume(sagaId)).toBe(true);
    expect(pasos.A).toHaveBeenCalledTimes(1);
    expect(pasos.B).toHaveBeenCalledTimes(1);
    expect(pasos.C).toHaveBeenCalledTimes(2);
    expect(guardada(sagaId)).toMatchObject({ status: 'COMPLETED', result: 'listo' });
  });
  it('la espera crece con cada intento: 2 s, 10 s, 30 s… y se queda en 30 min', async () => {
    const { definition } = sagaDePrueba({ falla: { en: 'C', error: caido }, puntoSinRetornoTras: 'B' });
    const { sagaId } = await engine.run(definition, { bookingId: 'b-1' });
    for (let i = 0; i < 7; i++) {
      vencer(sagaId);
      await engine.resume(sagaId);
    }
    expect(retries.map((r) => r.delay)).toEqual([2_000, 10_000, 30_000, 120_000, 600_000, 1_800_000, 1_800_000, 1_800_000]);
  });
});

describe('reanudar una compensación (réplica caída a la mitad)', () => {
  it('reconstruye la pila hasta el primer paso no hecho y compensa solo lo que falta', async () => {
    const { definition, compensaciones } = sagaDePrueba({ falla: { en: 'C', error: negocio } });
    compensaciones.A.mockRejectedValueOnce(caido()); // A quedó sin compensar
    await expect(engine.run(definition, { bookingId: 'b-1' })).rejects.toThrow();
    const sagaId = [...store.sagas.keys()][0]!;
    vencer(sagaId);
    await engine.resume(sagaId);
    expect(compensaciones.B).toHaveBeenCalledTimes(1); // no se deshace dos veces
    expect(compensaciones.A).toHaveBeenCalledTimes(2);
    expect(guardada(sagaId).status).toBe('COMPENSATED');
  });
});

describe('sagaId fijo: no se ejecuta dos veces', () => {
  it('si ya terminó, devuelve su resultado sin volver a correr', async () => {
    const { definition, pasos } = sagaDePrueba();
    await engine.run(definition, { bookingId: 'b-1' }, { sagaId: 'fija' });
    expect(await engine.run(definition, { bookingId: 'b-1' }, { sagaId: 'fija' })).toMatchObject({ status: 'COMPLETED', result: 'listo' });
    expect(pasos.A).toHaveBeenCalledTimes(1);
  });
  it('si terminó compensada, devuelve el mismo error guardado', async () => {
    const { definition } = sagaDePrueba({ falla: { en: 'B', error: negocio } });
    await expect(engine.run(definition, { bookingId: 'b-1' }, { sagaId: 'fija' })).rejects.toThrow();
    await expect(engine.run(definition, { bookingId: 'b-1' }, { sagaId: 'fija' })).rejects.toMatchObject({ problem: { code: 'SEAT_TAKEN' } });
  });
  it('si otra réplica la tiene en curso (plazo vigente), responde PENDING sin ejecutarla', async () => {
    const { definition, pasos } = sagaDePrueba();
    store.sagas.set('fija', { sagaId: 'fija', type: 'PRUEBA', status: 'RUNNING', input: {}, steps: [], result: null, error: null, ownerId: null, actorId: null, correlationId: 'c', parentSagaId: null, attempts: 1, leaseUntil: '2999-01-01T00:00:00.000Z', nextAttemptAt: '2000-01-01T00:00:00.000Z', createdAt: 'x', updatedAt: 'x' });
    expect(await engine.run(definition, { bookingId: 'b-1' }, { sagaId: 'fija' })).toEqual({ status: 'PENDING', sagaId: 'fija' });
    expect(pasos.A).not.toHaveBeenCalled();
  });
});

describe('trabajador de recuperación', () => {
  it('retoma las sagas abandonadas y cuenta cuántas tomó; ignora tipos que no conoce', async () => {
    const { definition } = sagaDePrueba({ falla: { en: 'C', error: caido }, puntoSinRetornoTras: 'B' });
    const { sagaId } = await engine.run(definition, { bookingId: 'b-1' });
    store.sagas.set('desconocida', { ...structuredClone(guardada(sagaId)), sagaId: 'desconocida', type: 'NO_REGISTRADA' });
    vencer(sagaId);
    vencer('desconocida');
    expect(await engine.recover()).toBe(2);
    expect(guardada('desconocida').status).toBe('RUNNING'); // no se tocó
  });
  it('resume: una saga a la que todavía no le toca no se retoma', async () => {
    const { definition } = sagaDePrueba({ falla: { en: 'C', error: caido }, puntoSinRetornoTras: 'B' });
    const { sagaId } = await engine.run(definition, { bookingId: 'b-1' });
    expect(await engine.resume(sagaId)).toBe(false);
    expect(await engine.resume('no-existe')).toBe(false);
  });
});
