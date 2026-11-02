import { useState } from 'react';
import type { FlightSegment } from '../../api/types';
import { SeatMapPicker } from '../../components/SeatMapPicker';

export interface CheckoutPassenger {
  passengerId: string;
  /** Nombre a mostrar ("Gabriel Aveiga" o "Adulto 1" si aún no lo escribió). */
  name: string;
  /** Iniciales que se pintan sobre su asiento en el mapa. */
  initials: string;
  /** Tipo de pasajero en texto (Adulto, Niño…). */
  typeLabel: string;
}

/** seats[passengerId][segmentId] = seatNumber */
export type SeatSelection = Record<string, Record<string, string>>;

const route = (segment: FlightSegment) => `${segment.departure.iataCode} - ${segment.arrival.iataCode}`;

/**
 * Selección de asientos de todo el grupo en un solo panel: una pestaña por tramo, la lista de pasajeros a la izquierda y el
 * mapa a la derecha. Se elige al pasajero y con un clic en el mapa queda su asiento; luego pasa solo al siguiente pasajero
 * sin asiento. Tocar el asiento de un acompañante cambia a ese pasajero.
 */
export function SeatSelectionPanel({
  offerId,
  segments,
  passengers,
  seats,
  note = 'Los asientos son opcionales: si no eliges, te asignamos uno en el check-in sin costo.',
  onChange,
}: {
  offerId: string;
  segments: { segment: FlightSegment; cabinClass: string }[];
  passengers: CheckoutPassenger[];
  seats: SeatSelection;
  /** Nota bajo la lista de pasajeros. */
  note?: string;
  onChange: (passengerId: string, segmentId: string, seat: string | undefined) => void;
}) {
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [activeId, setActiveId] = useState(passengers[0]?.passengerId ?? '');
  const current = segments[segmentIndex];
  if (!current || passengers.length === 0) return null;
  const { segment, cabinClass } = current;
  const seatOf = (passengerId: string, segmentId = segment.segmentId) => seats[passengerId]?.[segmentId];
  const active = passengers.find((passenger) => passenger.passengerId === activeId) ?? passengers[0]!;

  const companions: Record<string, string> = {};
  for (const passenger of passengers) {
    const seat = seatOf(passenger.passengerId);
    if (seat && passenger.passengerId !== active.passengerId) companions[seat] = passenger.initials;
  }

  const select = (seat: string | undefined) => {
    onChange(active.passengerId, segment.segmentId, seat);
    if (!seat) return;
    // Pasa al siguiente pasajero sin asiento en este tramo (en orden, empezando después del actual).
    const start = passengers.indexOf(active);
    const next = [...passengers.slice(start + 1), ...passengers.slice(0, start)].find((passenger) => !seatOf(passenger.passengerId));
    if (next) setActiveId(next.passengerId);
  };

  const selectByCompanionSeat = (seat: string) => {
    const owner = passengers.find((passenger) => seatOf(passenger.passengerId) === seat);
    if (owner) setActiveId(owner.passengerId);
  };

  const changeSegment = (index: number) => {
    setSegmentIndex(index);
    const target = segments[index]!.segment.segmentId;
    setActiveId((passengers.find((passenger) => !seatOf(passenger.passengerId, target)) ?? passengers[0]!).passengerId);
  };

  const complete = (segmentId: string) => passengers.every((passenger) => seatOf(passenger.passengerId, segmentId));

  return (
    <div className="picker">
      <div className="tabs" role="tablist" aria-label="Tramos">
        {segments.map(({ segment: candidate }, index) => (
          <button
            key={candidate.segmentId}
            type="button"
            role="tab"
            aria-selected={index === segmentIndex}
            className={`tab${index === segmentIndex ? ' is-active' : ''}`}
            onClick={() => changeSegment(index)}
          >
            {complete(candidate.segmentId) && <span aria-label="completo">✓ </span>}
            {route(candidate)} <span className="muted small">{candidate.flightNumber}</span>
          </button>
        ))}
      </div>

      <div className="picker-layout">
        <ul className="picker-people" aria-label="Pasajeros">
          {passengers.map((passenger) => {
            const seat = seatOf(passenger.passengerId);
            const isActive = passenger.passengerId === active.passengerId;
            return (
              <li key={passenger.passengerId}>
                <div className={`person-card${isActive ? ' is-active' : ''}`}>
                  <button type="button" className="person-select" aria-pressed={isActive} onClick={() => setActiveId(passenger.passengerId)}>
                    <span className={`person-badge${seat ? ' has-seat' : ''}`}>{seat ?? passenger.initials}</span>
                    <span className="person-text">
                      <strong>{passenger.name}</strong>
                      <span className="muted small">{seat ? `Asiento ${seat}` : isActive ? 'Elige un asiento en el mapa' : 'Sin asiento'} · {passenger.typeLabel}</span>
                    </span>
                  </button>
                  {seat && (
                    <button type="button" className="link-button small" onClick={() => onChange(passenger.passengerId, segment.segmentId, undefined)}>
                      ✕ Quitar
                    </button>
                  )}
                </div>
              </li>
            );
          })}
          {segmentIndex < segments.length - 1 && (
            <li>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => changeSegment(segmentIndex + 1)}>
                Siguiente tramo: {route(segments[segmentIndex + 1]!.segment)} →
              </button>
            </li>
          )}
          <li className="muted small">{note}</li>
        </ul>

        <div className="picker-map">
          <p className="small picker-hint">
            Eligiendo para <strong>{active.name}</strong> · {segment.flightNumber} {route(segment)}
          </p>
          <SeatMapPicker
            offerId={offerId}
            segmentId={segment.segmentId}
            cabinClass={cabinClass}
            selected={seatOf(active.passengerId)}
            takenByOthers={Object.keys(companions)}
            companions={companions}
            onCompanionClick={selectByCompanionSeat}
            showSummary={false}
            onSelect={select}
          />
        </div>
      </div>
    </div>
  );
}
