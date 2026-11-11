import type { ProblemDetailsException } from '@ecoairlines/shared';
import { applyUpdate, atOffsetOf, INITIAL_STATE, isFinal, toFlightStatus, TRANSITIONS, type FlightState, type ScheduledFlightRecord } from './status.js';

/** PU-1 (Informacion_General/Pruebas.md §5.1.1): estado operativo de un vuelo — transiciones, retrasos (R-1) y forma del contrato. */

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
};

const VUELO: ScheduledFlightRecord = {
  flightNumber: 'EA100',
  date: '2026-12-10',
  routeId: 'EA100-EA101',
  origin: 'UIO',
  destination: 'BOG',
  departureAt: '2026-12-10T08:00:00-05:00',
  arrivalAt: '2026-12-10T09:30:00-05:00',
  aircraftType: 'Airbus A220-300',
  registration: 'HC-J01',
};
const AHORA = new Date('2026-12-10T12:00:00Z');
const estado = (over: Partial<FlightState> = {}): FlightState => ({ ...INITIAL_STATE, ...over });
const aplicar = (current: FlightState, update: Parameters<typeof applyUpdate>[2]) => applyUpdate(current, VUELO, update, 'admin-1', AHORA);

describe('transiciones', () => {
  it('ARRIVED y CANCELLED son finales; el resto no', () => {
    expect(Object.keys(TRANSITIONS).filter((s) => isFinal(s as never))).toEqual(['ARRIVED', 'CANCELLED']);
  });
  it.each([
    ['SCHEDULED', 'BOARDING'],
    ['BOARDING', 'DEPARTED'],
    ['DEPARTED', 'ARRIVED'],
    ['DEPARTED', 'DIVERTED'],
    ['DIVERTED', 'ARRIVED'],
  ] as const)('%s → %s está permitida', (from, to) => expect(codeOf(() => aplicar(estado({ status: from }), { status: to }))).toBeUndefined());
  it.each([
    ['SCHEDULED', 'DEPARTED'],
    ['SCHEDULED', 'ARRIVED'],
    ['DEPARTED', 'BOARDING'],
    ['DEPARTED', 'CANCELLED'],
    ['CANCELLED', 'SCHEDULED'],
    ['ARRIVED', 'DEPARTED'],
  ] as const)('%s → %s → INVALID_STATUS_TRANSITION', (from, to) =>
    expect(codeOf(() => aplicar(estado({ status: from }), { status: to, reason: 'x' }))).toBe('INVALID_STATUS_TRANSITION'));
  it('repetir un estado final tampoco se permite', () => expect(codeOf(() => aplicar(estado({ status: 'ARRIVED' }), { status: 'ARRIVED' }))).toBe('INVALID_STATUS_TRANSITION'));
  it('repetir un estado no final solo actualiza la puerta', () => {
    const next = aplicar(estado({ status: 'BOARDING', departureGate: 'A1' }), { status: 'BOARDING', departureGate: 'B7' });
    expect(next).toMatchObject({ status: 'BOARDING', departureGate: 'B7' });
  });
  it('sin puerta nueva se conserva la anterior', () => expect(aplicar(estado({ departureGate: 'A1' }), { status: 'BOARDING' }).departureGate).toBe('A1'));
  it('guarda quién y cuándo hizo el cambio', () => expect(aplicar(estado(), { status: 'BOARDING' })).toMatchObject({ updatedAt: AHORA.toISOString(), updatedBy: 'admin-1' }));
});

describe('retrasos (R-1)', () => {
  it('DELAYED exige una salida estimada', () => expect(codeOf(() => aplicar(estado(), { status: 'DELAYED' }))).toBe('VALIDATION_FAILED'));
  it('DELAYED con la misma hora programada no es un retraso', () =>
    expect(codeOf(() => aplicar(estado(), { status: 'DELAYED', estimatedDepartureAt: VUELO.departureAt }))).toBe('VALIDATION_FAILED'));
  it('DELAYED con una hora anterior tampoco', () =>
    expect(codeOf(() => aplicar(estado(), { status: 'DELAYED', estimatedDepartureAt: '2026-12-10T07:30:00-05:00' }))).toBe('VALIDATION_FAILED'));
  it('sin llegada estimada, la llegada se corre lo mismo que la salida', () => {
    const next = aplicar(estado(), { status: 'DELAYED', estimatedDepartureAt: '2026-12-10T08:45:00-05:00' });
    expect(Date.parse(next.estimatedArrivalAt!)).toBe(Date.parse('2026-12-10T10:15:00-05:00'));
  });
  it('con llegada estimada, se respeta la indicada', () =>
    expect(
      aplicar(estado(), { status: 'DELAYED', estimatedDepartureAt: '2026-12-10T08:45:00-05:00', estimatedArrivalAt: '2026-12-10T10:00:00-05:00' }).estimatedArrivalAt,
    ).toBe('2026-12-10T10:00:00-05:00'));
  it('un segundo retraso (DELAYED → DELAYED) actualiza la hora', () => {
    const primero = aplicar(estado(), { status: 'DELAYED', estimatedDepartureAt: '2026-12-10T08:30:00-05:00' });
    expect(aplicar(primero, { status: 'DELAYED', estimatedDepartureAt: '2026-12-10T09:00:00-05:00' }).estimatedDepartureAt).toBe('2026-12-10T09:00:00-05:00');
  });
  it('quitar el retraso (DELAYED → SCHEDULED) borra las horas estimadas', () => {
    const atrasado = aplicar(estado(), { status: 'DELAYED', estimatedDepartureAt: '2026-12-10T08:30:00-05:00' });
    expect(aplicar(atrasado, { status: 'SCHEDULED' })).toMatchObject({ status: 'SCHEDULED', estimatedDepartureAt: null, estimatedArrivalAt: null });
  });
  it('un vuelo atrasado que embarca conserva su hora estimada', () => {
    const atrasado = aplicar(estado(), { status: 'DELAYED', estimatedDepartureAt: '2026-12-10T08:30:00-05:00' });
    expect(aplicar(atrasado, { status: 'BOARDING' }).estimatedDepartureAt).toBe('2026-12-10T08:30:00-05:00');
  });
});

describe('cancelación y horas reales', () => {
  it('cancelar exige motivo', () => expect(codeOf(() => aplicar(estado(), { status: 'CANCELLED' }))).toBe('VALIDATION_FAILED'));
  it('un motivo en blanco no cuenta', () => expect(codeOf(() => aplicar(estado(), { status: 'CANCELLED', reason: '   ' }))).toBe('VALIDATION_FAILED'));
  it('con motivo se cancela', () => expect(aplicar(estado(), { status: 'CANCELLED', reason: 'Clima' }).status).toBe('CANCELLED'));
  it('DEPARTED guarda la hora real de salida', () => expect(aplicar(estado({ status: 'BOARDING' }), { status: 'DEPARTED' }).actualDepartureAt).toBe(AHORA.toISOString()));
  it('repetir DEPARTED no cambia la hora real', () =>
    expect(aplicar(estado({ status: 'DEPARTED', actualDepartureAt: 'antes' }), { status: 'DEPARTED' }).actualDepartureAt).toBe('antes'));
  it('ARRIVED guarda la hora real de llegada', () => expect(aplicar(estado({ status: 'DEPARTED' }), { status: 'ARRIVED' }).actualArrivalAt).toBe(AHORA.toISOString()));
});

describe('atOffsetOf: hora local del aeropuerto', () => {
  it('una hora UTC se expresa con el desfase de Ecuador', () =>
    expect(atOffsetOf('2026-12-10T08:00:00-05:00', Date.parse('2026-12-10T14:40:00Z'))).toBe('2026-12-10T09:40:00-05:00'));
  it('con desfase positivo (Madrid)', () => expect(atOffsetOf('2026-12-10T08:00:00+01:00', Date.parse('2026-12-10T23:30:00Z'))).toBe('2026-12-11T00:30:00+01:00'));
  it('si la referencia no tiene desfase, devuelve UTC', () => expect(atOffsetOf('2026-12-10T08:00:00Z', Date.parse('2026-12-10T14:40:00Z'))).toBe('2026-12-10T14:40:00.000Z'));
});

describe('toFlightStatus: forma del contrato v2', () => {
  it('un vuelo sin cambios: programado, sin retraso, terminal conocida en BOG', () => {
    const status = toFlightStatus(VUELO, estado());
    expect(status).toMatchObject({ status: 'SCHEDULED', delayMinutes: null, departure: { iataCode: 'UIO', terminal: null }, arrival: { iataCode: 'BOG', terminal: '1' } });
    expect(status).not.toHaveProperty('updatedAt');
  });
  it('con retraso: minutos de retraso y horas estimadas en hora local (aunque se guarden en UTC)', () => {
    const status = toFlightStatus(VUELO, estado({ status: 'DELAYED', estimatedDepartureAt: '2026-12-10T13:30:00.000Z', estimatedArrivalAt: '2026-12-10T15:00:00.000Z', updatedAt: 'x' }));
    expect(status.delayMinutes).toBe(30);
    expect(status.departure.estimatedAt).toBe('2026-12-10T08:30:00-05:00');
    expect(status.arrival.estimatedAt).toBe('2026-12-10T10:00:00-05:00');
    expect(status.updatedAt).toBe('x');
  });
  it('una salida estimada adelantada no se muestra como retraso negativo', () =>
    expect(toFlightStatus(VUELO, estado({ estimatedDepartureAt: '2026-12-10T12:50:00.000Z' })).delayMinutes).toBeNull());
});
