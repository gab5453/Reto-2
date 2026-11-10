import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { checkIn, getBoardingPasses } from '../../api/operations';
import type { BoardingPass, BookingDetail } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { BoardingPassCard } from '../../components/BoardingPassCard';
import { ProblemAlert } from '../../components/ProblemAlert';
import { savePasses } from '../../lib/offline-trips';

export function CheckInPanel({ booking, onChanged }: { booking: BookingDetail; onChanged: () => Promise<void> }) {
  const { token, user } = useAuth();
  const [passes, setPasses] = useState<BoardingPass[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const loadPasses = async () => {
    if (!token) return;
    try {
      const { boardingPasses } = await getBoardingPasses(token, booking.bookingId);
      setPasses(boardingPasses);
      // Para abrirlos sin conexión en el aeropuerto (PLAN.md §4.9).
      if (user) savePasses(user.email, booking.bookingId, boardingPasses.map(toView));
    } catch (caught) {
      // BOARDING_PASS_NOT_AVAILABLE: todavía no hay check-in; no es un error para el usuario.
      if (caught instanceof ApiError && (caught.status === 404 || caught.problem?.code === 'BOARDING_PASS_NOT_AVAILABLE')) setPasses([]);
      else setError(caught);
    }
  };

  useEffect(() => {
    void loadPasses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.bookingId]);

  const doCheckIn = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await checkIn(token, booking.bookingId);
      await Promise.all([loadPasses(), onChanged()]);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const toView = (pass: BoardingPass) => {
    const segment = booking.itineraries?.flatMap((itinerary) => itinerary.segments).find((candidate) => candidate.segmentId === pass.segmentId);
    const passenger = booking.passengers?.find((candidate) => candidate.passengerId === pass.passengerId);
    return {
      bookingId: booking.bookingId,
      pnr: booking.pnr,
      passengerName: passenger ? `${passenger.firstName} ${passenger.lastName}` : pass.passengerId,
      flightNumber: segment?.flightNumber ?? '',
      origin: segment?.departure.iataCode ?? '',
      destination: segment?.arrival.iataCode ?? '',
      departureAt: segment?.departure.at ?? '',
      seat: pass.seat,
      boardingGroup: pass.boardingGroup,
      boardingPosition: pass.boardingPosition,
      gate: pass.gate,
      barcode: pass.barcode,
    };
  };

  return (
    <div>
      <p className="muted">El check-in abre 48 horas antes de la salida y cierra a la hora de salida (a la nueva hora, si el vuelo está retrasado). Si no elegiste asiento, te asignamos uno.</p>
      <button type="button" className="btn btn-primary" onClick={doCheckIn} disabled={busy}>
        {busy ? 'Procesando…' : passes?.length ? 'Actualizar check-in' : 'Hacer check-in'}
      </button>
      {error ? <ProblemAlert error={error} /> : null}

      {passes && passes.length > 0 && (
        <div className="passes">
          <p className="muted small">Quedan guardados en este dispositivo para abrirlos sin conexión.</p>
          {passes.map((pass) => (
            <BoardingPassCard key={`${pass.passengerId}-${pass.segmentId}`} pass={toView(pass)} />
          ))}
        </div>
      )}
    </div>
  );
}
