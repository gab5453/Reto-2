import { ProblemDetailsException } from '@ecoairlines/shared';

/**
 * Estado operativo de un vuelo (contract/ms-g-flight-status.openapi.yaml). El horario es una PROYECCIÓN del evento
 * `schedule.published` (D4): FlightStatus nunca llama a Schedule.
 */
export type FlightOperationalStatus = 'SCHEDULED' | 'BOARDING' | 'DEPARTED' | 'DELAYED' | 'ARRIVED' | 'CANCELLED' | 'DIVERTED';

/** Transiciones válidas (contrato). ARRIVED y CANCELLED son finales. */
export const TRANSITIONS: Readonly<Record<FlightOperationalStatus, readonly FlightOperationalStatus[]>> = {
  SCHEDULED: ['DELAYED', 'BOARDING', 'CANCELLED'],
  DELAYED: ['DELAYED', 'BOARDING', 'CANCELLED'],
  BOARDING: ['DEPARTED', 'DELAYED', 'CANCELLED'],
  DEPARTED: ['ARRIVED', 'DIVERTED'],
  DIVERTED: ['ARRIVED'],
  ARRIVED: [],
  CANCELLED: [],
};
export const isFinal = (status: FlightOperationalStatus) => TRANSITIONS[status].length === 0;

/** Vuelo de la proyección (`scheduled_flights`), tal como llega en `schedule.published`. */
export interface ScheduledFlightRecord {
  flightNumber: string;
  date: string;
  routeId: string;
  origin: string;
  destination: string;
  departureAt: string;
  arrivalAt: string;
  aircraftType: string;
  registration: string;
}

/** Lo que el administrador cambió sobre el horario (`overrides`). */
export interface FlightState {
  status: FlightOperationalStatus;
  departureGate: string | null;
  estimatedDepartureAt: string | null;
  estimatedArrivalAt: string | null;
  actualDepartureAt: string | null;
  actualArrivalAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const INITIAL_STATE: FlightState = {
  status: 'SCHEDULED',
  departureGate: null,
  estimatedDepartureAt: null,
  estimatedArrivalAt: null,
  actualDepartureAt: null,
  actualArrivalAt: null,
  updatedAt: null,
  updatedBy: null,
};

export interface StatusChangeRecord {
  changeId: string;
  flightNumber: string;
  date: string;
  /** Estado completo antes y después del cambio (para revertir exactamente). */
  previous: FlightState;
  next: FlightState;
  reason: string | null;
  changedBy: string;
  changedAt: string;
  reverted: boolean;
}

export interface StatusUpdate {
  status: FlightOperationalStatus;
  estimatedDepartureAt?: string;
  estimatedArrivalAt?: string;
  departureGate?: string;
  reason?: string;
}

const problem = (status: number, code: string, title: string, detail?: string, name?: string) =>
  new ProblemDetailsException({ status, code, title, ...(detail ? { detail } : {}), ...(name ? { invalidParams: [{ name, reason: title }] } : {}) });

/**
 * Aplica un cambio sobre el estado actual: valida la transición (409 INVALID_STATUS_TRANSITION) y las reglas del contrato
 * (DELAYED exige una salida estimada posterior a la programada; CANCELLED exige motivo; DEPARTED y ARRIVED guardan la hora
 * real del cambio). El mismo estado en uno no final solo actualiza puerta u horas.
 */
export function applyUpdate(current: FlightState, flight: ScheduledFlightRecord, update: StatusUpdate, actor: string, now: Date): FlightState {
  const same = update.status === current.status;
  if (same && isFinal(current.status)) {
    throw problem(409, 'INVALID_STATUS_TRANSITION', 'Transición de estado no permitida.', `${current.status} es un estado final.`);
  }
  if (!same && !TRANSITIONS[current.status].includes(update.status)) {
    throw problem(409, 'INVALID_STATUS_TRANSITION', 'Transición de estado no permitida.', `No se puede pasar de ${current.status} a ${update.status}.`);
  }
  const estimatedDeparture = update.estimatedDepartureAt ?? current.estimatedDepartureAt;
  if (update.status === 'DELAYED' && !(estimatedDeparture && Date.parse(estimatedDeparture) > Date.parse(flight.departureAt))) {
    throw problem(400, 'VALIDATION_FAILED', 'DELAYED exige estimatedDepartureAt posterior a la hora programada.', undefined, 'estimatedDepartureAt');
  }
  if (update.status === 'CANCELLED' && !update.reason?.trim()) {
    throw problem(400, 'VALIDATION_FAILED', 'Para cancelar un vuelo hay que indicar el motivo.', undefined, 'reason');
  }
  const stamp = now.toISOString();
  return {
    status: update.status,
    departureGate: update.departureGate ?? current.departureGate,
    estimatedDepartureAt: estimatedDeparture,
    estimatedArrivalAt: update.estimatedArrivalAt ?? current.estimatedArrivalAt,
    actualDepartureAt: update.status === 'DEPARTED' && !current.actualDepartureAt ? stamp : current.actualDepartureAt,
    actualArrivalAt: update.status === 'ARRIVED' && !current.actualArrivalAt ? stamp : current.actualArrivalAt,
    updatedAt: stamp,
    updatedBy: actor,
  };
}

/** Terminales conocidas (las mismas de Offers); el resto opera con terminal única. */
const TERMINALS: Readonly<Record<string, string>> = { BOG: '1', MAD: '4S', MIA: 'N', MEX: '1' };

/** `FlightStatus` del contrato v2. */
export function toFlightStatus(flight: ScheduledFlightRecord, state: FlightState) {
  const delay = state.estimatedDepartureAt ? Math.round((Date.parse(state.estimatedDepartureAt) - Date.parse(flight.departureAt)) / 60_000) : null;
  return {
    flightNumber: flight.flightNumber,
    date: flight.date,
    marketingCarrier: 'EA',
    operatingCarrier: 'EA',
    departure: {
      iataCode: flight.origin,
      terminal: TERMINALS[flight.origin] ?? null,
      gate: state.departureGate,
      scheduledAt: flight.departureAt,
      estimatedAt: state.estimatedDepartureAt,
      actualAt: state.actualDepartureAt,
    },
    arrival: {
      iataCode: flight.destination,
      terminal: TERMINALS[flight.destination] ?? null,
      gate: null,
      scheduledAt: flight.arrivalAt,
      estimatedAt: state.estimatedArrivalAt,
      actualAt: state.actualArrivalAt,
    },
    aircraft: flight.aircraftType,
    status: state.status,
    delayMinutes: delay !== null && delay > 0 ? delay : null,
    ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
  };
}
