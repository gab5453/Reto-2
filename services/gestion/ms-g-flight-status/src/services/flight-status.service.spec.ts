import { createCloudEvent, type ProblemDetailsException } from '@ecoairlines/shared';
import { INITIAL_STATE, type ScheduledFlightRecord, type StatusChangeRecord } from '../domain/status.js';
import type { FlightStatusStore, FlightStatusTx } from '../repositories/flight-status.store.js';
import { FlightStatusService, type SchedulePublishedData } from './flight-status.service.js';

/** PU-2 (Informacion_General/Pruebas.md §5.1.2): FlightStatusService — proyección del horario, cambios, impacto de un retraso y reversión. */

const AHORA = new Date('2026-12-10T12:00:00Z');
const problemOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem;
  }
};

const vuelo = (over: Partial<ScheduledFlightRecord> = {}): ScheduledFlightRecord => ({
  flightNumber: 'EA100',
  date: '2026-12-10',
  routeId: 'EA100-EA101',
  origin: 'UIO',
  destination: 'GYE',
  departureAt: '2026-12-10T08:00:00-05:00',
  arrivalAt: '2026-12-10T08:50:00-05:00',
  aircraftType: 'Airbus A220-300',
  registration: 'HC-J01',
  turnaroundMinutes: 35,
  ...over,
});

let tx: { [K in keyof FlightStatusTx]: ReturnType<typeof vi.fn> };
let service: FlightStatusService;
beforeEach(() => {
  tx = {
    flight: vi.fn(async (n: string) => (n === 'EA100' ? vuelo() : undefined)),
    flightsOn: vi.fn().mockResolvedValue([]),
    replaceFlights: vi.fn(),
    state: vi.fn().mockResolvedValue(undefined),
    saveState: vi.fn(),
    changes: vi.fn().mockResolvedValue([]),
    change: vi.fn(),
    saveChange: vi.fn(),
    markEventApplied: vi.fn().mockResolvedValue(true),
  };
  service = new FlightStatusService({ transaction: vi.fn((work: (t: FlightStatusTx) => unknown) => work(tx as unknown as FlightStatusTx)) } as unknown as FlightStatusStore);
  service.now = () => AHORA;
});

describe('proyección de schedule.published (D4)', () => {
  const evento = (data: SchedulePublishedData) => createCloudEvent({ name: 'schedule.published', visibility: 'internal', subject: 'x', data, correlationId: 'c' });
  it('reemplaza los vuelos del rango, solo los que caen dentro', async () => {
    await service.applySchedulePublished(evento({ publishId: 'p', from: '2026-12-10', to: '2026-12-11', flights: [vuelo(), vuelo({ date: '2026-12-12' })] }));
    expect(tx.replaceFlights).toHaveBeenCalledWith('2026-12-10', '2026-12-11', undefined, [vuelo()]);
  });
  it('con routeId, solo los de esa ruta', async () => {
    await service.applySchedulePublished(evento({ publishId: 'p', from: '2026-12-10', to: '2026-12-10', routeId: 'OTRA', flights: [vuelo()] }));
    expect(tx.replaceFlights).toHaveBeenCalledWith('2026-12-10', '2026-12-10', 'OTRA', []);
  });
  it('el mismo evento dos veces no se aplica de nuevo', async () => {
    tx.markEventApplied.mockResolvedValue(false);
    expect(await service.applySchedulePublished(evento({ publishId: 'p', from: '2026-12-10', to: '2026-12-10', flights: [vuelo()] }))).toBe(false);
    expect(tx.replaceFlights).not.toHaveBeenCalled();
  });
});

describe('cambiar el estado', () => {
  it('guarda el estado nuevo y el historial con el anterior (para poder revertir)', async () => {
    const result = await service.update('EA100', '2026-12-10', { status: 'BOARDING', departureGate: 'A3', reason: '  ' }, 'admin-1');
    expect(result.previousStatus).toBe('SCHEDULED');
    expect(tx.saveState).toHaveBeenCalledWith('EA100', '2026-12-10', expect.objectContaining({ status: 'BOARDING', departureGate: 'A3' }));
    expect(tx.saveChange).toHaveBeenCalledWith(expect.objectContaining({ previous: INITIAL_STATE, reason: null, changedBy: 'admin-1', reverted: false }));
  });
  it('un vuelo que no opera ese día → 404', async () => expect((await problemOf(service.update('EA999', '2026-12-10', { status: 'BOARDING' }, 'a')))?.status).toBe(404));
  it('una transición inválida no guarda nada', async () => {
    expect((await problemOf(service.update('EA100', '2026-12-10', { status: 'ARRIVED' }, 'a')))?.code).toBe('INVALID_STATUS_TRANSITION');
    expect(tx.saveState).not.toHaveBeenCalled();
    expect(tx.saveChange).not.toHaveBeenCalled();
  });
  it('list filtra por estado', async () => {
    tx.flightsOn.mockResolvedValue([vuelo(), vuelo({ flightNumber: 'EA102' })]);
    tx.state.mockImplementation(async (n: string) => (n === 'EA102' ? { ...INITIAL_STATE, status: 'BOARDING' } : undefined));
    expect((await service.list('2026-12-10', { status: 'BOARDING' })).items.map((i) => i.flightNumber)).toEqual(['EA102']);
  });
});

describe('impacto de un retraso (R-1)', () => {
  const siguiente = (departureAt: string, over: Partial<ScheduledFlightRecord> = {}) => vuelo({ flightNumber: 'EA101', origin: 'GYE', destination: 'UIO', departureAt, arrivalAt: departureAt, ...over });

  it('sin conflicto: el avión llega a tiempo al siguiente vuelo', async () => {
    tx.flightsOn.mockImplementation(async (date: string) => (date === '2026-12-10' ? [vuelo(), siguiente('2026-12-10T11:00:00-05:00')] : []));
    const impact = await service.delayImpact('EA100', '2026-12-10', 30);
    expect(impact).toMatchObject({ estimatedDepartureAt: '2026-12-10T08:30:00-05:00', estimatedArrivalAt: '2026-12-10T09:20:00-05:00', nextFlight: { flightNumber: 'EA101', conflict: false, suggestedDelayMinutes: null } });
    expect(impact.nextFlight!.readyAt).toBe('2026-12-10T09:55:00-05:00'); // llegada + 35 min en tierra
  });
  it('con conflicto: sugiere el retraso mínimo, en múltiplos de 5 min', async () => {
    tx.flightsOn.mockImplementation(async (date: string) => (date === '2026-12-10' ? [siguiente('2026-12-10T09:30:00-05:00')] : []));
    expect((await service.delayImpact('EA100', '2026-12-10', 30)).nextFlight).toMatchObject({ conflict: true, suggestedDelayMinutes: 25 }); // listo 09:55 → 25 min
  });
  it('solo cuenta los vuelos del MISMO avión', async () => {
    tx.flightsOn.mockImplementation(async (date: string) => (date === '2026-12-10' ? [siguiente('2026-12-10T09:30:00-05:00', { registration: 'HC-J02' })] : []));
    expect((await service.delayImpact('EA100', '2026-12-10', 30)).nextFlight).toBeNull();
  });
  it('busca el siguiente vuelo del avión hasta 2 días después (un 787 a Madrid)', async () => {
    tx.flightsOn.mockImplementation(async (date: string) => (date === '2026-12-12' ? [siguiente('2026-12-12T13:00:00-05:00', { date: '2026-12-12' })] : []));
    expect((await service.delayImpact('EA100', '2026-12-10', 30)).nextFlight?.date).toBe('2026-12-12');
  });
  it('si el siguiente ya tiene su propio retraso, compara con su hora estimada', async () => {
    tx.flightsOn.mockImplementation(async (date: string) => (date === '2026-12-10' ? [siguiente('2026-12-10T09:30:00-05:00')] : []));
    tx.state.mockImplementation(async (n: string) => (n === 'EA101' ? { ...INITIAL_STATE, status: 'DELAYED', estimatedDepartureAt: '2026-12-10T15:30:00.000Z' } : undefined));
    expect((await service.delayImpact('EA100', '2026-12-10', 30)).nextFlight).toMatchObject({ conflict: false, status: 'DELAYED', departureAt: '2026-12-10T10:30:00-05:00' });
  });
  it('un vuelo publicado antes de M-2 (sin tiempo en tierra) usa el de su tipo', async () => {
    tx.flight.mockResolvedValue(vuelo({ turnaroundMinutes: undefined }));
    expect((await service.delayImpact('EA100', '2026-12-10', 0)).aircraft.turnaroundMinutes).toBe(35);
  });
  it('consultar el impacto no cambia nada', async () => {
    await service.delayImpact('EA100', '2026-12-10', 30);
    expect(tx.saveState).not.toHaveBeenCalled();
  });
});

describe('revertir un cambio (compensación)', () => {
  const cambio = (over: Partial<StatusChangeRecord> = {}): StatusChangeRecord => ({
    changeId: 'ch-1',
    flightNumber: 'EA100',
    date: '2026-12-10',
    previous: INITIAL_STATE,
    next: { ...INITIAL_STATE, status: 'CANCELLED' },
    reason: 'Clima',
    changedBy: 'admin-1',
    changedAt: '2026-12-10T11:00:00.000Z',
    reverted: false,
    ...over,
  });
  it('vuelve exactamente al estado anterior y marca el cambio revertido', async () => {
    tx.change.mockResolvedValue(cambio());
    tx.changes.mockResolvedValue([cambio()]);
    await service.revert('ch-1', 'esb');
    expect(tx.saveState).toHaveBeenCalledWith('EA100', '2026-12-10', expect.objectContaining({ status: 'SCHEDULED', updatedBy: 'esb' }));
    expect(tx.saveChange).toHaveBeenCalledWith(expect.objectContaining({ reverted: true }));
  });
  it('si hubo un cambio posterior → CHANGE_NOT_LATEST', async () => {
    tx.change.mockResolvedValue(cambio());
    tx.changes.mockResolvedValue([cambio(), cambio({ changeId: 'ch-2', changedAt: '2026-12-10T11:30:00.000Z' })]);
    expect((await problemOf(service.revert('ch-1', 'esb')))?.code).toBe('CHANGE_NOT_LATEST');
  });
  it('revertir uno ya revertido no vuelve a guardar (idempotente)', async () => {
    tx.change.mockResolvedValue(cambio({ reverted: true }));
    await service.revert('ch-1', 'esb');
    expect(tx.saveState).not.toHaveBeenCalled();
  });
  it('un cambio que no existe → 404', async () => expect((await problemOf(service.revert('nada', 'esb')))?.status).toBe(404));
});
