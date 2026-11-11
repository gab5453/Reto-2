import type { ProblemDetailsException } from '@ecoairlines/shared';
import type { CheckInRecord } from '../domain/boarding.js';
import type { CheckInStore, CheckInTx } from '../repositories/check-in.store.js';
import { CheckInService, type RegisterCheckIn } from './check-in.service.js';

/** PU-2 (Informacion_General/Pruebas.md §5.1.2): CheckInService — registro por pasajero y segmento, sin duplicados, y pases. */

const AHORA = Date.parse('2026-12-09T12:00:00Z');
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
};

let tx: { [K in keyof CheckInTx]: ReturnType<typeof vi.fn> };
let service: CheckInService;
beforeEach(() => {
  tx = {
    checkIns: vi.fn().mockResolvedValue([]),
    countOnSegment: vi.fn().mockResolvedValue(0),
    onSegment: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue(true),
    deleteBySaga: vi.fn(),
    lockSegment: vi.fn(),
    assistanceReady: vi.fn().mockResolvedValue([]),
    readyOnSegment: vi.fn().mockResolvedValue(0),
    saveAssistanceReady: vi.fn(),
  };
  service = new CheckInService({ transaction: vi.fn((work: (t: CheckInTx) => unknown) => work(tx as unknown as CheckInTx)) } as unknown as CheckInStore);
  service.now = () => AHORA;
});

const segmento = (over = {}) => ({ segmentId: 'EA100-20261210', flightNumber: 'EA100', origin: 'UIO', destination: 'GYE', departureAt: '2026-12-10T08:00:00-05:00', cabinClass: 'ECONOMY', seat: '22C', ...over });
const pedido = (over: Partial<RegisterCheckIn> = {}): RegisterCheckIn => ({
  sagaId: 's-1',
  pnr: 'ABC234',
  passengers: [
    { passengerId: 'P1', passengerType: 'ADULT', firstName: 'Ana', lastName: 'Pérez', segments: [segmento()] },
    { passengerId: 'I1', passengerType: 'INFANT', firstName: 'Bebé', lastName: 'Pérez', segments: [segmento({ seat: '22C' })] },
  ],
  ...over,
});
const registrado = (over: Partial<CheckInRecord> = {}) => ({ passengerId: 'P1', segmentId: 'EA100-20261210', sagaId: 's-1', seat: '22C', ...over }) as CheckInRecord;

describe('register', () => {
  it('numera la posición de embarque desde los que ya hicieron check-in en ese vuelo', async () => {
    tx.countOnSegment.mockResolvedValue(41);
    await service.register('b-1', pedido());
    expect(tx.insert.mock.calls.map((c) => (c[0] as CheckInRecord).boardingPosition)).toEqual([42, 43]);
    expect(tx.lockSegment).toHaveBeenCalledWith('EA100-20261210');
  });
  it('el infante no tiene asiento; el grupo sale de la fila (22 → B)', async () => {
    await service.register('b-1', pedido());
    const [adulto, infante] = tx.insert.mock.calls.map((c) => c[0] as CheckInRecord);
    expect(adulto).toMatchObject({ seat: '22C', boardingGroup: 'B' });
    expect(infante!.seat).toBeNull();
  });
  it('el reintento de la misma saga devuelve lo ya registrado sin insertar', async () => {
    tx.checkIns.mockResolvedValue([registrado(), registrado({ passengerId: 'I1', seat: null })]);
    expect((await service.register('b-1', pedido())).status).toBe('COMPLETED');
    expect(tx.insert).not.toHaveBeenCalled();
  });
  it('un pasajero con check-in previo de otra saga → CHECK_IN_NOT_AVAILABLE', async () => {
    tx.checkIns.mockResolvedValue([registrado({ sagaId: 'otra' })]);
    expect(await codeOf(service.register('b-1', pedido()))).toBe('CHECK_IN_NOT_AVAILABLE');
  });
  it('un vuelo que ya salió → FLIGHT_ALREADY_DEPARTED', async () => {
    service.now = () => Date.parse('2026-12-10T13:00:00Z');
    expect(await codeOf(service.register('b-1', pedido()))).toBe('FLIGHT_ALREADY_DEPARTED');
  });
  it('si el índice único rechaza la fila (carrera), no queda nada a medias → CHECK_IN_NOT_AVAILABLE', async () => {
    tx.insert.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await codeOf(service.register('b-1', pedido()))).toBe('CHECK_IN_NOT_AVAILABLE');
  });
});

describe('pases y compensación', () => {
  it('sin check-in no hay pase → BOARDING_PASS_NOT_AVAILABLE', async () => expect(await codeOf(service.boardingPasses('b-1'))).toBe('BOARDING_PASS_NOT_AVAILABLE'));
  it('el pase lleva posición de 3 dígitos, INF para el infante y el código IATA', async () => {
    tx.checkIns.mockResolvedValue([
      { ...registrado(), firstName: 'Ana', lastName: 'Pérez', pnr: 'ABC234', origin: 'UIO', destination: 'GYE', flightNumber: 'EA100', departureAt: '2026-12-10T08:00:00-05:00', cabinClass: 'ECONOMY', boardingPosition: 7, boardingGroup: 'B', gate: null },
      { ...registrado({ passengerId: 'I1', seat: null }), firstName: 'B', lastName: 'P', pnr: 'ABC234', origin: 'UIO', destination: 'GYE', flightNumber: 'EA100', departureAt: '2026-12-10T08:00:00-05:00', cabinClass: 'ECONOMY', boardingPosition: 8, boardingGroup: 'B', gate: null },
    ]);
    const { boardingPasses } = await service.boardingPasses('b-1');
    expect(boardingPasses.map((p) => [p.seat, p.boardingPosition, p.barcodeType])).toEqual([
      ['22C', '007', 'PDF417'],
      ['INF', '008', 'PDF417'],
    ]);
    expect(boardingPasses[0]!.barcode).toHaveLength(60);
  });
  it('compensar borra solo lo de esa saga', async () => {
    await service.undo('b-1', 's-1');
    expect(tx.deleteBySaga).toHaveBeenCalledWith('b-1', 's-1');
  });
  it('el estado de una reserva sin check-in → 404', async () => expect(await codeOf(service.state('b-1'))).toBe('NOT_FOUND'));
  it('la asistencia lista se refleja en el estado del pasajero', async () => {
    tx.checkIns.mockResolvedValue([registrado()]);
    tx.assistanceReady.mockResolvedValue([{ passengerId: 'P1', segmentId: 'EA100-20261210', ready: true }]);
    expect((await service.markAssistanceReady('b-1', { passengerId: 'P1', segmentId: 'EA100-20261210', ready: true }, 'admin-1')).items[0]!.assistanceReady).toBe(true);
    expect(tx.saveAssistanceReady).toHaveBeenCalledWith(expect.objectContaining({ updatedBy: 'admin-1', ready: true }));
  });
});
