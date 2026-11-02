import { useEffect, useState } from 'react';
import { getSeatMap } from '../api/operations';
import type { SeatMapResponse } from '../api/types';
import { ProblemAlert } from './ProblemAlert';

const CHARACTERISTIC_LABELS: Record<string, string> = {
  WINDOW: 'ventana',
  AISLE: 'pasillo',
  EXTRA_LEGROOM: 'espacio extra',
  EMERGENCY_EXIT: 'salida de emergencia',
};

/**
 * Mapa de asientos de un segmento (`GET /offers/{offerId}/seatmap`). Solo se pueden elegir asientos
 * libres de la cabina comprada; los ya elegidos por otros pasajeros de la misma reserva se bloquean.
 * Con `companions` (asiento → iniciales) esos asientos muestran las iniciales del acompañante y, si se pasa
 * `onCompanionClick`, al tocarlos se cambia a ese pasajero.
 */
export function SeatMapPicker({
  offerId,
  segmentId,
  cabinClass,
  selected,
  takenByOthers,
  companions = {},
  onCompanionClick,
  showSummary = true,
  onSelect,
}: {
  offerId: string;
  segmentId: string;
  cabinClass: string;
  selected?: string;
  takenByOthers: string[];
  companions?: Record<string, string>;
  onCompanionClick?: (seat: string) => void;
  showSummary?: boolean;
  onSelect: (seat: string | undefined) => void;
}) {
  const requestKey = `${offerId}|${segmentId}`;
  const [loaded, setLoaded] = useState<{ key: string; seatMap?: SeatMapResponse; error?: unknown }>({ key: '' });

  useEffect(() => {
    let active = true;
    getSeatMap(offerId, segmentId)
      .then((seatMap) => active && setLoaded({ key: requestKey, seatMap }))
      .catch((error: unknown) => active && setLoaded({ key: requestKey, error }));
    return () => {
      active = false;
    };
  }, [offerId, segmentId, requestKey]);

  // Una respuesta de otro segmento nunca se muestra mientras carga la nueva.
  const { seatMap, error } = loaded.key === requestKey ? loaded : { seatMap: undefined, error: undefined };

  if (error) return <ProblemAlert error={error} />;
  if (!seatMap) return <p className="muted">Cargando mapa de asientos…</p>;

  const cabin = seatMap.cabins?.find((candidate) => candidate.cabinClass === cabinClass);
  if (!cabin) return <p className="muted">No hay mapa de asientos para esta cabina.</p>;

  return (
    <div className="seatmap">
      <div className="seatmap-legend" aria-hidden="true">
        <span><i className="seat-dot seat-free" /> Libre</span>
        <span><i className="seat-dot seat-selected" /> Tu elección</span>
        {Object.keys(companions).length > 0 && <span><i className="seat-dot seat-companion" /> Tu grupo</span>}
        <span><i className="seat-dot seat-taken" /> Ocupado</span>
        <span><i className="seat-dot seat-extra" /> Espacio extra</span>
      </div>
      <div className="seatmap-grid" role="group" aria-label={`Asientos de ${cabinClass === 'BUSINESS' ? 'Business' : 'Economy'}`}>
        {cabin.rows?.map((row) => (
          <div className="seat-row" key={row.rowNumber}>
            <span className="seat-row-number" aria-hidden="true">{row.rowNumber}</span>
            {row.seats?.map((seat) => {
              const number = seat.seatNumber ?? '';
              const isSelected = number === selected;
              const companion = isSelected ? undefined : companions[number];
              const unavailable = !seat.isAvailable || takenByOthers.includes(number);
              const traits = (seat.characteristics ?? []).map((trait) => CHARACTERISTIC_LABELS[trait]).join(', ');
              return (
                <button
                  key={number}
                  type="button"
                  className={[
                    'seat',
                    isSelected ? 'seat-selected' : companion ? 'seat-companion' : unavailable ? 'seat-taken' : 'seat-free',
                    seat.characteristics?.includes('EXTRA_LEGROOM') ? 'seat-extra' : '',
                    seat.characteristics?.includes('AISLE') ? 'seat-aisle' : '',
                  ].join(' ')}
                  disabled={unavailable && !isSelected && !(companion && onCompanionClick)}
                  aria-pressed={isSelected}
                  aria-label={`Asiento ${number}${traits ? `, ${traits}` : ''}${companion ? `, de ${companion}` : unavailable ? ', ocupado' : ''}`}
                  onClick={() => (companion ? onCompanionClick?.(number) : onSelect(isSelected ? undefined : number))}
                >
                  {companion ?? number.replace(/^\d+/, '')}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {showSummary && <p className="muted small">{selected ? `Seleccionado: ${selected}` : 'Sin elegir: te asignaremos uno en el check-in, sin costo.'}</p>}
    </div>
  );
}
