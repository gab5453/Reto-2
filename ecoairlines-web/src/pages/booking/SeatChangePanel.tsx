import { useMemo, useState } from 'react';
import { changeSeats } from '../../api/operations';
import type { BookingDetail, SeatChangeItem } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ProblemAlert } from '../../components/ProblemAlert';
import { PASSENGER_LABELS } from '../../lib/format';
import { useIdempotencyKey } from '../../lib/request-ids';
import { SeatSelectionPanel, type CheckoutPassenger, type SeatSelection } from '../checkout/SeatSelectionPanel';

/** Asientos actuales de la reserva: seats[passengerId][segmentId] = seatNumber. */
function currentSeats(booking: BookingDetail): SeatSelection {
  return Object.fromEntries(
    (booking.passengers ?? []).map((passenger) => [passenger.passengerId, Object.fromEntries((passenger.assignedSeats ?? []).map((seat) => [seat.segmentId, seat.seatNumber]))]),
  );
}

/**
 * Cambio de asientos de uno o varios pasajeros a la vez (`changeSeats` del contrato v2: todos o ninguno). No tiene costo en
 * EcoAirlines, así que no pide tarjeta. El mapa sale de `seatMap`: el `offerId` de una reserva se arma con sus itinerarios
 * (`itinerario~itinerario`), que Offers reconstruye a partir de sus ids.
 */
export function SeatChangePanel({ booking, onChanged }: { booking: BookingDetail; onChanged: () => Promise<void> }) {
  const { token } = useAuth();
  const original = useMemo(() => currentSeats(booking), [booking]);
  const [chosen, setChosen] = useState<SeatSelection>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<unknown>(null);

  const people: CheckoutPassenger[] = (booking.passengers ?? [])
    .filter((passenger) => passenger.passengerType !== 'INFANT')
    .map((passenger) => ({
      passengerId: passenger.passengerId,
      name: `${passenger.firstName} ${passenger.lastName}`,
      initials: `${passenger.firstName[0] ?? ''}${passenger.lastName[0] ?? ''}`.toUpperCase(),
      typeLabel: PASSENGER_LABELS[passenger.passengerType] ?? passenger.passengerType,
    }));
  const segments = (booking.itineraries ?? []).flatMap((itinerary) =>
    itinerary.segments.map((segment) => ({ segment, cabinClass: itinerary.pricingOptions[0]?.cabinClass ?? 'ECONOMY' })),
  );
  const offerId = (booking.itineraries ?? []).map((itinerary) => itinerary.itineraryId).join('~');

  /** Lo elegido sobre lo actual: el mapa muestra el asiento nuevo, o el de siempre si no se tocó. */
  const seats: SeatSelection = Object.fromEntries(people.map(({ passengerId }) => [passengerId, { ...original[passengerId], ...chosen[passengerId] }]));
  const changes: SeatChangeItem[] = Object.entries(chosen).flatMap(([passengerId, bySegment]) =>
    Object.entries(bySegment)
      .filter(([segmentId, seatNumber]) => seatNumber !== original[passengerId]?.[segmentId])
      .map(([segmentId, seatNumber]) => ({ passengerId, segmentId, seatNumber })),
  );
  const idempotency = useIdempotencyKey([JSON.stringify(changes)]);

  /** «Quitar» vuelve al asiento actual: un pasajero con reserva no se queda sin asiento. */
  const select = (passengerId: string, segmentId: string, seat: string | undefined) => {
    setMessage(undefined);
    setError(null);
    setChosen((all) => {
      const mine = { ...all[passengerId] };
      if (seat) mine[segmentId] = seat;
      else delete mine[segmentId];
      return { ...all, [passengerId]: mine };
    });
  };

  const confirm = async () => {
    if (!token || changes.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await changeSeats(token, idempotency.key(), booking.bookingId, changes);
      idempotency.renew();
      setChosen({});
      await onChanged();
      setMessage(`Listo: ${result.seats.map((seat) => `${seat.previousSeatNumber ?? 'sin asiento'} → ${seat.seatNumber}`).join(', ')}.`);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  if (people.length === 0 || segments.length === 0) return <p className="muted">Esta reserva no tiene asientos que cambiar.</p>;

  return (
    <div className="seat-change">
      <p className="muted">
        Elige asientos libres de tu cabina para uno o varios pasajeros. Se cambian todos juntos: si alguno ya no está libre, no cambia ninguno. Los anteriores se liberan para otros
        viajeros.
      </p>
      <SeatSelectionPanel
        key={message ?? ''}
        offerId={offerId}
        segments={segments}
        passengers={people}
        seats={seats}
        note="«Quitar» devuelve al pasajero a su asiento actual."
        onChange={select}
      />
      {error ? <ProblemAlert error={error} /> : null}
      {message && <p className="alert alert-success" role="status">{message}</p>}
      <button type="button" className="btn btn-primary" onClick={confirm} disabled={changes.length === 0 || busy}>
        {busy ? 'Cambiando…' : changes.length ? `Cambiar ${changes.length} asiento${changes.length > 1 ? 's' : ''}` : 'Elige un asiento nuevo'}
      </button>
    </div>
  );
}
