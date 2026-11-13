import { useEffect, useState } from 'react';
import { adminCheckIn, getAdminBoardingPasses, type AdminBooking } from '../../api/admin';
import { ApiError } from '../../api/client';
import { getFlightStatus } from '../../api/operations';
import type { BoardingPass } from '../../api/types';
import { ProblemAlert } from '../../components/ProblemAlert';
import { printablePasses } from '../../lib/boarding-pass-print';

/**
 * Check-in en mostrador (D57, `PLAN/Check_in_Mostrador.md`): el administrador hace el check-in de TODA la reserva (CM-2 = A) y le
 * imprime los pases en PDF a un pasajero que no puede mostrar el suyo.
 *
 * El botón SIEMPRE intenta primero el check-in de lo pendiente (CM-4): una reserva puede tener pases y aun así tramos sin check-in
 * (la vuelta de un ida y vuelta, que abre 48 h antes de SU salida; el vuelo nuevo tras un cambio de fecha, D56). Qué está pendiente
 * lo decide el servidor (la ventana no se copia en la web); si no hay nada (`CHECK_IN_NOT_AVAILABLE`) y ya hay pases, solo reimprime.
 */
export function CounterCheckIn({ token, booking, onCheckedIn }: { token: string; booking: AdminBooking; onCheckedIn: () => void }) {
  const eligible = booking.status === 'CONFIRMED' && booking.tickets.some((ticket) => ticket.status === 'ISSUED');
  // Los pases de la reserva que se cargaron (con el id, para no mostrar los de otra); sin check-in el servidor responde 409.
  const [loaded, setLoaded] = useState<{ id: string; passes: BoardingPass[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!eligible) return;
    let active = true;
    getAdminBoardingPasses(token, booking.bookingId).then(
      (passes) => active && setLoaded({ id: booking.bookingId, passes }),
      () => active && setLoaded({ id: booking.bookingId, passes: [] }),
    );
    return () => {
      active = false;
    };
  }, [token, booking.bookingId, eligible]);

  if (!eligible) return null;
  const passes = loaded?.id === booking.bookingId ? loaded.passes : null;
  const checkedIn = (passes?.length ?? 0) > 0;

  /** Con un retraso vigente, el embarque se calcula desde la salida ESTIMADA (si FlightStatus no responde, desde la programada). */
  const estimatedDepartures = async () => {
    const segments = booking.itineraries.flatMap((itinerary) => itinerary.segments);
    const entries = await Promise.all(
      segments.map(async (segment) => {
        try {
          const status = await getFlightStatus(segment.flightNumber, segment.departure.at.slice(0, 10));
          const estimated = status.departure?.estimatedAt;
          return estimated && estimated !== status.departure?.scheduledAt ? ([segment.segmentId, estimated] as const) : null;
        } catch {
          return null;
        }
      }),
    );
    return Object.fromEntries(entries.filter((entry) => entry !== null));
  };

  /** Imprime los pases de los tramos que aún no salen; `false` si no queda ninguno. */
  const print = async (list: BoardingPass[]) => {
    const pages = printablePasses(booking, list, await estimatedDepartures());
    if (!pages.length) return false;
    const { downloadBoardingPasses } = await import('../../lib/boarding-pass-pdf');
    await downloadBoardingPasses(pages);
    return true;
  };

  /** Check-in de lo pendiente. Con pases ya emitidos, «no hay nada pendiente» no es un error: se reimprime. */
  const checkInPending = async () => {
    try {
      await adminCheckIn(token, booking.bookingId);
      return true;
    } catch (caught) {
      if (checkedIn && caught instanceof ApiError && caught.problem?.code === 'CHECK_IN_NOT_AVAILABLE') return false;
      throw caught;
    }
  };

  const run = async () => {
    if (!checkedIn && !window.confirm(`¿Hacer el check-in en mostrador de la reserva ${booking.pnr}? Se hará el check-in de todos los pasajeros pendientes y se descargarán sus pases en PDF.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const newCheckIn = await checkInPending();
      const list = await getAdminBoardingPasses(token, booking.bookingId);
      setLoaded({ id: booking.bookingId, passes: list });
      if (!(await print(list))) setNotice('No hay pases por imprimir: los vuelos de la reserva ya salieron.');
      if (newCheckIn) onCheckedIn();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="counter-check-in">
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || passes === null} onClick={() => void run()}>
        {busy ? 'Generando pases…' : checkedIn ? 'Reimprimir pases' : 'Check-in en mostrador e imprimir'}
      </button>
      {checkedIn ? <p className="muted small">La reserva ya tiene check-in ({passes?.length} pase{passes?.length === 1 ? '' : 's'}). Si hay un tramo pendiente en su ventana (p. ej. la vuelta), también se le hace el check-in.</p> : null}
      {notice ? <p className="small" role="status">{notice}</p> : null}
      {error ? <ProblemAlert key={error instanceof ApiError ? error.message : 'error'} error={error} /> : null}
    </div>
  );
}
