import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { createBooking, getHold, getMyProfile, releaseHold } from '../api/operations';
import type { AssistanceInput, PassengerItem, PassengerType } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useBookingFlow, type BookingFlow } from '../booking/BookingFlowContext';
import { AssistanceFields } from '../components/AssistanceFields';
import { CardFields, useCardPayment } from '../components/CardPayment';
import { Countdown } from '../components/Countdown';
import { Field, SelectField } from '../components/FormFields';
import { ItinerarySummary } from '../components/ItinerarySummary';
import { ProblemAlert } from '../components/ProblemAlert';
import { SeatSelectionPanel, type CheckoutPassenger } from './checkout/SeatSelectionPanel';
import { EMPTY_ASSISTANCE, PASSENGER_LABELS, cleanAssistance, formatMoney, todayIso } from '../lib/format';
import { AGE_RANGES, birthDateBounds, passengerIssues } from '../lib/passenger-validation';
import { retryWhileRunning, useIdempotencyKey } from '../lib/request-ids';

interface PassengerForm {
  passengerId: string;
  passengerType: PassengerType;
  associatedAdultId: string;
  firstName: string;
  lastName: string;
  documentType: 'PASSPORT' | 'NATIONAL_ID';
  documentNumber: string;
  nationality: string;
  documentExpiryDate: string;
  birthDate: string;
  gender: 'M' | 'F' | 'X';
  email: string;
  phone: string;
}

export function CheckoutPage() {
  const { flow } = useBookingFlow();
  if (!flow) {
    return (
      <div className="container section narrow">
        <h1>No hay una reserva en curso</h1>
        <p className="muted">Busca un vuelo y elige tu tarifa para continuar.</p>
        <Link to="/" className="btn btn-primary">Buscar vuelos</Link>
      </div>
    );
  }
  return <Checkout flow={flow} />;
}

function buildPassengers(flow: BookingFlow): PassengerForm[] {
  const types: [PassengerType, number, string][] = [
    ['ADULT', flow.passengers.adults, 'a'],
    ['YOUTH', flow.passengers.youths, 'y'],
    ['CHILD', flow.passengers.children, 'c'],
    ['INFANT', flow.passengers.infants, 'i'],
  ];
  return types.flatMap(([passengerType, count, prefix]) =>
    Array.from({ length: count }, (_, index) => ({
      passengerId: `${prefix}${index + 1}`,
      passengerType,
      associatedAdultId: passengerType === 'INFANT' ? `a${index + 1}` : '',
      firstName: '',
      lastName: '',
      documentType: 'PASSPORT' as const,
      documentNumber: '',
      nationality: 'EC',
      documentExpiryDate: '',
      birthDate: '',
      gender: 'F' as const,
      email: '',
      phone: '',
    })),
  );
}

function Checkout({ flow }: { flow: BookingFlow }) {
  const { token } = useAuth();
  const { setFlow } = useBookingFlow();
  const navigate = useNavigate();
  const [passengers, setPassengers] = useState<PassengerForm[]>(() => buildPassengers(flow));
  /** seats[passengerId][segmentId] = seatNumber */
  const [seats, setSeats] = useState<Record<string, Record<string, string>>>({});
  /** Sube tras un SEAT_TAKEN: el mapa se vuelve a pedir y el asiento que otro tomó sale en gris (T-1). */
  const [seatMapVersion, setSeatMapVersion] = useState(0);
  /** assistance[passengerId]: los pasajeros que marcaron «Necesita asistencia médica». */
  const [assistance, setAssistance] = useState<Record<string, AssistanceInput>>({});
  const card = useCardPayment();
  const lastReference = useRef<string | undefined>(undefined);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [formError, setFormError] = useState<string>();
  /** La tarjeta quedó pendiente: el servidor sigue y la web reintenta la misma petición hasta tener la reserva. */
  const [confirming, setConfirming] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

  // Autocompleta al primer adulto con el perfil del cliente (`myProfile`), si lo registró.
  useEffect(() => {
    if (!token) return;
    let active = true;
    getMyProfile(token)
      .then((profile) => {
        if (!active || !profile) return;
        setPassengers((current) =>
          current.map((passenger, index) =>
            index === 0 && passenger.passengerType === 'ADULT' && !passenger.firstName && !passenger.documentNumber
              ? {
                  ...passenger,
                  firstName: profile.firstName,
                  lastName: profile.lastName,
                  documentType: profile.documentType,
                  documentNumber: profile.documentNumber,
                  nationality: profile.nationality,
                  documentExpiryDate: profile.documentExpiryDate ?? '',
                  birthDate: profile.birthDate,
                  gender: profile.gender,
                  email: profile.contact.email,
                  phone: profile.contact.phone,
                }
              : passenger,
          ),
        );
        const first = profile.defaultAssistance;
        if (first) setAssistance((current) => (current['a1'] ? current : { ...current, a1: { ...first, notes: first.notes ?? '' } }));
        setPrefilled(true);
      })
      .catch(() => undefined); // Sin el scope o sin conexión: el cliente completa el formulario a mano.
    return () => {
      active = false;
    };
  }, [token]);

  const segments = flow.offer.itineraries.flatMap((itinerary, index) =>
    itinerary.segments.map((segment) => ({ segment, cabinClass: flow.choices[index]!.pricing.cabinClass })),
  );
  const travel = {
    firstDeparture: flow.offer.itineraries[0]!.segments[0]!.departure.at.slice(0, 10),
    lastDeparture: flow.offer.itineraries.at(-1)!.segments.at(-1)!.departure.at.slice(0, 10),
  };
  const issues = passengerIssues(passengers, travel);
  const seated = passengers.filter((passenger) => passenger.passengerType !== 'INFANT');
  const adults = passengers.filter((passenger) => passenger.passengerType === 'ADULT');
  const seatedPeople: CheckoutPassenger[] = seated.map((passenger) => {
    const position = passengers.indexOf(passenger) + 1;
    const fallback = `${PASSENGER_LABELS[passenger.passengerType]} ${position}`;
    const name = `${passenger.firstName.trim()} ${passenger.lastName.trim()}`.trim();
    const initials = (passenger.firstName.trim()[0] ?? '') + (passenger.lastName.trim()[0] ?? '');
    return {
      passengerId: passenger.passengerId,
      name: name || fallback,
      initials: initials.toUpperCase() || `P${position}`,
      typeLabel: PASSENGER_LABELS[passenger.passengerType],
    };
  });

  /** La reserva sin el pago: el `paymentReference` lo da la pasarela al enviar. */
  const request = useMemo(
    () => ({
      holdId: flow.hold.holdId,
      passengers: passengers.map((form): PassengerItem => {
        const assignedSeats = Object.entries(seats[form.passengerId] ?? {}).map(([segmentId, seatNumber]) => ({ segmentId, seatNumber }));
        return {
          passengerId: form.passengerId,
          passengerType: form.passengerType,
          ...(form.passengerType === 'INFANT' ? { associatedAdultId: form.associatedAdultId } : {}),
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          documentType: form.documentType,
          documentNumber: form.documentNumber.trim(),
          nationality: form.nationality.trim().toUpperCase(),
          ...(form.documentExpiryDate ? { documentExpiryDate: form.documentExpiryDate } : {}),
          birthDate: form.birthDate,
          gender: form.gender,
          contact: { email: form.email.trim(), phone: form.phone.trim() },
          ...(assignedSeats.length ? { assignedSeats } : {}),
        };
      }),
      ...(Object.keys(assistance).length
        ? { assistance: Object.entries(assistance).map(([passengerId, item]) => ({ passengerId, ...cleanAssistance(item) })) }
        : {}),
    }),
    [flow.hold.holdId, passengers, seats, assistance],
  );
  const idempotency = useIdempotencyKey([JSON.stringify(request)]);

  const update = (index: number, patch: Partial<PassengerForm>) =>
    setPassengers((current) => current.map((passenger, position) => (position === index ? { ...passenger, ...patch } : passenger)));

  const release = async () => {
    if (token) await releaseHold(token, flow.hold.holdId).catch(() => undefined);
    setFlow(null);
    navigate('/');
  };

  const onExpire = async () => {
    if (!token) return;
    const status = await getHold(token, flow.hold.holdId).catch(() => null);
    if (!status || status.status !== 'HELD') setExpired(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    const missing = passengers.find((p) => !p.firstName.trim() || !p.lastName.trim() || !p.documentNumber.trim() || !p.birthDate || !p.email.trim() || !p.phone.trim());
    if (missing) return setFormError(`Completa los datos de ${PASSENGER_LABELS[missing.passengerType]} ${passengers.indexOf(missing) + 1}.`);
    const invalid = Object.entries(issues)[0];
    if (invalid) {
      const [position, fields] = invalid;
      return setFormError(`Revisa al pasajero ${Number(position) + 1}: ${Object.values(fields)[0]}`);
    }
    setFormError(undefined);
    setBusy(true);
    setError(null);
    try {
      // Se cobra exactamente el precio congelado del hold: es el monto que el ESB captura (AMOUNT_MISMATCH si no).
      const paymentReference = await card.pay(flow.hold.lockedPrice, `Reserva EcoAirlines — hold ${flow.hold.holdId.slice(0, 8)}`);
      // Otra autorización es otra petición: una clave nueva (con la anterior sería IDEMPOTENCY_KEY_REUSED).
      if (lastReference.current && lastReference.current !== paymentReference) idempotency.renew();
      lastReference.current = paymentReference;
      const key = idempotency.key();
      const response = await retryWhileRunning(() => createBooking(token, key, { ...request, payment: { paymentReference } }), () => setConfirming(true));
      idempotency.renew();
      card.done();
      setFlow(null);
      navigate(`/mis-viajes/${response.data.bookingId}`, { state: { justBooked: response.status } });
    } catch (caught) {
      card.failed(caught);
      setError(caught);
      // El asiento lo tomó otro viajero (se revisa antes de cobrar): se quita de la selección y se recarga el mapa para elegir otro.
      if (caught instanceof ApiError && caught.problem?.code === 'SEAT_TAKEN') {
        const taken = (caught.problem.invalidParams ?? []).map((param) => /^(\S+) en (\S+)$/.exec(param.reason ?? '')).filter((match) => match !== null);
        setSeats((all) =>
          Object.fromEntries(
            Object.entries(all).map(([passengerId, bySegment]) => [
              passengerId,
              Object.fromEntries(Object.entries(bySegment).filter(([segmentId, seat]) => !taken.some((match) => match[1] === seat && match[2] === segmentId))),
            ]),
          ),
        );
        setSeatMapVersion((version) => version + 1);
      }
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  if (expired) {
    return (
      <div className="container section narrow">
        <h1>Tu reserva temporal expiró</h1>
        <p className="muted">Liberamos los asientos para otros viajeros. Puedes volver a buscar y elegir tu vuelo.</p>
        <Link to="/" className="btn btn-primary" onClick={() => setFlow(null)}>Buscar de nuevo</Link>
      </div>
    );
  }

  return (
    <div className="container section checkout">
      <form className="checkout-main" onSubmit={submit} noValidate>
        <h1>Completa tu reserva</h1>

        <section className="card" aria-labelledby="vuelos-title">
          <h2 id="vuelos-title">Tus vuelos</h2>
          {flow.offer.itineraries.map((itinerary, index) => (
            <div key={itinerary.itineraryId} className="checkout-itinerary">
              <ItinerarySummary itinerary={itinerary} cabinClass={flow.choices[index]!.pricing.cabinClass} label={`Vuelo ${index + 1}`} />
              <p className="small">Tarifa <strong>{flow.choices[index]!.pricing.fareBrand}</strong></p>
            </div>
          ))}
        </section>

        <section aria-labelledby="pasajeros-title">
          <h2 id="pasajeros-title">Pasajeros</h2>
          {prefilled && <p className="muted small">Completamos al pasajero 1 con los datos de tu perfil. Puedes cambiarlos para esta reserva.</p>}
          {passengers.map((passenger, index) => (
            <fieldset key={passenger.passengerId} className="card passenger">
              <legend>
                {PASSENGER_LABELS[passenger.passengerType]} {index + 1}
              </legend>
              <div className="grid-2">
                <Field label="Nombres" value={passenger.firstName} onChange={(firstName) => update(index, { firstName })} autoComplete="given-name" maxLength={60} />
                <Field label="Apellidos" value={passenger.lastName} onChange={(lastName) => update(index, { lastName })} autoComplete="family-name" maxLength={60} />
                <SelectField label="Tipo de documento" value={passenger.documentType} onChange={(documentType) => update(index, { documentType: documentType as PassengerForm['documentType'] })}
                  options={[['PASSPORT', 'Pasaporte'], ['NATIONAL_ID', 'Cédula / DNI']]} />
                <Field label="Número de documento" value={passenger.documentNumber} onChange={(documentNumber) => update(index, { documentNumber })} maxLength={20} error={issues[index]?.documentNumber} />
                <Field label="Nacionalidad (código de país)" value={passenger.nationality} onChange={(nationality) => update(index, { nationality })} maxLength={3} placeholder="EC" />
                <Field label="Vencimiento del documento (opcional)" type="date" min={todayIso()} value={passenger.documentExpiryDate} onChange={(documentExpiryDate) => update(index, { documentExpiryDate })} required={false} error={issues[index]?.documentExpiryDate} />
                <Field label={`Fecha de nacimiento (${AGE_RANGES[passenger.passengerType].hint})`} type="date" {...birthDateBounds(passenger.passengerType, travel.firstDeparture, travel.lastDeparture)}
                  value={passenger.birthDate} onChange={(birthDate) => update(index, { birthDate })} autoComplete="bday" error={issues[index]?.birthDate} />
                <SelectField label="Género" value={passenger.gender} onChange={(gender) => update(index, { gender: gender as PassengerForm['gender'] })}
                  options={[['F', 'Femenino'], ['M', 'Masculino'], ['X', 'No binario / prefiero no decir']]} />
                <Field label="Correo" type="email" value={passenger.email} onChange={(email) => update(index, { email })} autoComplete="email" maxLength={120} />
                <Field label="Teléfono" type="tel" value={passenger.phone} onChange={(phone) => update(index, { phone })} autoComplete="tel" maxLength={20} placeholder="+593…" />
                {passenger.passengerType === 'INFANT' && (
                  <SelectField label="Viaja en brazos de" value={passenger.associatedAdultId} onChange={(associatedAdultId) => update(index, { associatedAdultId })}
                    options={adults.map((adult, position) => [adult.passengerId, adult.firstName ? `${adult.firstName} ${adult.lastName}` : `Adulto ${position + 1}`])} />
                )}
              </div>
              {passenger.passengerType !== 'INFANT' && (
                <div className="assistance-box">
                  <label className="inline-field">
                    <input
                      type="checkbox"
                      checked={Boolean(assistance[passenger.passengerId])}
                      onChange={(event) =>
                        setAssistance(({ [passenger.passengerId]: _removed, ...others }) =>
                          event.target.checked ? { ...others, [passenger.passengerId]: EMPTY_ASSISTANCE } : others,
                        )
                      }
                    />
                    Necesita asistencia médica
                  </label>
                  {assistance[passenger.passengerId] && (
                    <AssistanceFields
                      value={assistance[passenger.passengerId]!}
                      onChange={(value) => setAssistance((current) => ({ ...current, [passenger.passengerId]: value }))}
                    />
                  )}
                </div>
              )}
              {index > 0 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => update(index, { email: passengers[0]!.email, phone: passengers[0]!.phone })}>
                  Usar el contacto del pasajero 1
                </button>
              )}

            </fieldset>
          ))}
        </section>

        {seated.length > 0 && (
          <section className="card" aria-labelledby="asientos-title">
            <h2 id="asientos-title">Selección de asientos <span className="muted small">(opcional)</span></h2>
            <SeatSelectionPanel
              offerId={flow.offer.offerId}
              segments={segments}
              passengers={seatedPeople}
              seats={seats}
              mapVersion={seatMapVersion}
              onChange={(passengerId, segmentId, seat) =>
                setSeats((all) => {
                  const mine = { ...all[passengerId] };
                  if (seat) mine[segmentId] = seat;
                  else delete mine[segmentId];
                  return { ...all, [passengerId]: mine };
                })
              }
            />
          </section>
        )}

        <section className="card" aria-labelledby="pago-title">
          <h2 id="pago-title">Pago</h2>
          <CardFields card={card.card} onChange={card.setCard} disabled={busy} />
          <p className="muted small">¿Necesitas maletas extra? Agrégalas después desde «Mis viajes», con su propio pago.</p>
        </section>

        {confirming && (
          <div className="alert alert-info" role="status">
            <p className="alert-title">Estamos confirmando tu pago con el banco.</p>
            <p>Tu tarjeta quedó pendiente de aprobación; esto puede tardar hasta un minuto. No cierres esta página.</p>
          </div>
        )}
        {formError && <p className="form-error" role="alert">{formError}</p>}
        {error ? <ProblemAlert error={error} /> : null}
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
          {busy ? 'Confirmando…' : `Pagar y reservar ${formatMoney(flow.hold.lockedPrice)}`}
        </button>
      </form>

      <aside className="checkout-aside">
        <div className="card sticky">
          <p className="small muted">Tu precio está congelado por</p>
          <Countdown expiresAt={flow.hold.expiresAt} onExpire={onExpire} />
          <dl className="price-list">
            <div className="price-total"><dt>Total</dt><dd>{formatMoney(flow.hold.lockedPrice)}</dd></div>
          </dl>
          <button type="button" className="btn btn-ghost btn-sm" onClick={release}>Cancelar y liberar asientos</button>
        </div>
      </aside>
    </div>
  );
}
