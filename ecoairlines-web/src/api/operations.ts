import { graphql } from './client';
import type {
  AddBaggageRequest,
  BaggageAddedResponse,
  BaggageOptionsResponse,
  BoardingPassListResponse,
  BookingDetail,
  BookingListResponse,
  BookingRequest,
  CancelBookingRequest,
  CancellationQuoteResponse,
  CheckInResponse,
  CustomerProfile,
  CustomerProfileRequest,
  AssistanceInput,
  PassengerAssistance,
  DateChangeRequest,
  DateChangeSearchRequest,
  DateChangeSearchResponse,
  FlightStatus,
  HoldRequest,
  HoldResponse,
  HoldStatusResponse,
  SearchRequest,
  SearchResponse,
  SeatChangeItem,
  SeatChangeResult,
  SeatMapResponse,
} from './types';

/*
 * Operaciones del cliente sobre el GraphQL del gateway (`contract/gateway.graphql`). Cada función pide exactamente los campos que
 * usan las pantallas; `test/web-operations.spec.ts` (raíz del repo) valida TODOS los documentos de este archivo y de
 * `admin.ts` contra el esquema, así un cambio del contrato no rompe la web en silencio.
 */

// ── Selecciones reutilizadas (se interpolan dentro de cada documento) ──
export const MONEY = 'currency baseFare taxes total';
const ENDPOINT = 'iataCode at terminal';
export const SEGMENT = `segmentId flightNumber departure { ${ENDPOINT} } arrival { ${ENDPOINT} } layoverMinutes marketingCarrier operatingCarrier aircraft durationMinutes status`;
const PRICING = `cabinClass fareBrand availableSeats fareRules { isRefundable isChangeable }
  baggageAllowance { personalItemIncluded carryOnIncluded checkedBaggageIncluded }
  extraCheckedBaggagePrice { ${MONEY} } pricePerPassengerType { passengerType price { ${MONEY} } }`;
export const ITINERARY = `itineraryId totalDurationMinutes stopsCount segments { ${SEGMENT} } pricingOptions { ${PRICING} }`;
export const PASSENGER = `passengerId passengerType associatedAdultId firstName lastName documentType documentNumber nationality documentExpiryDate
  birthDate gender contact { email phone } assignedSeats { segmentId seatNumber } extraBaggage { itineraryId quantity }`;
export const TICKET = `ticketId bookingId passengerId passengerName eTicketNumber status issuedAt failureReason
  segments { segmentId status couponNumber flightNumber departureIataCode arrivalIataCode seatNumber }`;
export const BOOKING = `bookingId pnr status grandTotal { ${MONEY} } createdAt updatedAt itineraries { ${ITINERARY} }
  passengers { ${PASSENGER} } changes { changedAt description } tickets { ${TICKET} }`;
const HOLD = `holdId status expiresAt ttlMinutes remainingSeconds lockedPrice { ${MONEY} }`;
const PROFILE = `firstName lastName documentType documentNumber nationality documentExpiryDate birthDate gender contact { email phone }
  defaultAssistance { type needsCompanion notes } updatedAt`;

/** `COMPLETED` equivale al 200/201 del contrato REST; `ACCEPTED`, al 202 (la operación sigue en proceso). */
type Outcome = 'COMPLETED' | 'ACCEPTED';
const statusOf = (outcome: Outcome, completed = 200) => (outcome === 'ACCEPTED' ? 202 : completed);

// ── Búsqueda y catálogo (públicos) ──
export const searchFlights = (input: SearchRequest, fingerprint: string) =>
  graphql<{ searchFlights: SearchResponse }>(
    `query Buscar($input: SearchFlightsInput!) {
      searchFlights(input: $input) { totalOffers offers { offerId airline { code name } itineraries { ${ITINERARY} } grandTotal { ${MONEY} } } }
    }`,
    { input },
    { fingerprint },
  ).then((data) => data.searchFlights);

export const getSeatMap = (offerId: string, segmentId: string) =>
  graphql<{ seatMap: SeatMapResponse }>(
    `query MapaDeAsientos($offerId: String!, $segmentId: String!) {
      seatMap(offerId: $offerId, segmentId: $segmentId) { segmentId cabins { cabinClass rows { rowNumber seats { seatNumber isAvailable characteristics status } } } }
    }`,
    { offerId, segmentId },
  ).then((data) => data.seatMap);

// ── Hold ──
export const createHold = (token: string, idempotencyKey: string, input: HoldRequest) =>
  graphql<{ holdInventory: HoldResponse }>(
    `mutation Retener($key: UUID!, $input: HoldInput!) { holdInventory(idempotencyKey: $key, input: $input) { ${HOLD} } }`,
    { key: idempotencyKey, input },
    { token },
  ).then((data) => data.holdInventory);

export const getHold = (token: string, holdId: string) =>
  graphql<{ hold: HoldStatusResponse }>(`query Hold($holdId: UUID!) { hold(holdId: $holdId) { ${HOLD} } }`, { holdId }, { token }).then((data) => data.hold);

export const releaseHold = (token: string, holdId: string) =>
  graphql<{ releaseHold: { holdId: string; status: string } }>(
    'mutation Liberar($holdId: UUID!) { releaseHold(holdId: $holdId) { holdId status } }',
    { holdId },
    { token },
  ).then((data) => data.releaseHold);

// ── Reservas ──
/** Devuelve 201 (boletos emitidos) o 202 (pago o emisión en proceso), como el contrato REST. */
export const createBooking = (token: string, idempotencyKey: string, input: BookingRequest) =>
  graphql<{ createBooking: { outcome: Outcome; booking: BookingDetail } }>(
    `mutation Reservar($key: UUID!, $input: CreateBookingInput!) {
      createBooking(idempotencyKey: $key, input: $input) { outcome booking { ${BOOKING} } }
    }`,
    { key: idempotencyKey, input },
    { token },
  ).then(({ createBooking: result }) => ({ status: statusOf(result.outcome, 201), data: result.booking }));

export const listBookings = (
  token: string,
  query: { pnr?: string; status?: string; createdFrom?: string; createdTo?: string; limit?: number; cursor?: string },
) => {
  const { limit, cursor, ...rest } = query;
  const filter = Object.fromEntries(Object.entries(rest).filter(([, value]) => value));
  return graphql<{ bookings: BookingListResponse }>(
    `query MisReservas($filter: BookingFilterInput, $limit: Int, $cursor: String) {
      bookings(filter: $filter, limit: $limit, cursor: $cursor) {
        nextCursor items { bookingId pnr status origin destination departureDate grandTotal { ${MONEY} } }
      }
    }`,
    { filter, limit, cursor },
    { token },
  ).then((data) => data.bookings);
};

export const getBooking = (token: string, bookingId: string) =>
  graphql<{ booking: BookingDetail }>(`query Reserva($id: UUID!) { booking(bookingId: $id) { ${BOOKING} } }`, { id: bookingId }, { token }).then(
    (data) => data.booking,
  );

/** Cambia los asientos de uno o varios pasajeros: todos o ninguno (saga "Cambiar asientos"). Sin costo en EcoAirlines. */
export const changeSeats = (token: string, idempotencyKey: string, bookingId: string, seats: SeatChangeItem[]) =>
  graphql<{ changeSeats: SeatChangeResult }>(
    `mutation CambiarAsientos($key: UUID!, $id: UUID!, $input: ChangeSeatsInput!) {
      changeSeats(idempotencyKey: $key, bookingId: $id, input: $input) { bookingId seats { passengerId segmentId previousSeatNumber seatNumber status } }
    }`,
    { key: idempotencyKey, id: bookingId, input: { seats } },
    { token },
  ).then((data) => data.changeSeats);

// ── Postventa ──
export const getBaggageOptions = (token: string, bookingId: string) =>
  graphql<{ booking: { baggageOptions: BaggageOptionsResponse } }>(
    `query OpcionesDeMaletas($id: UUID!) { booking(bookingId: $id) { baggageOptions { passengerId itineraryId price { ${MONEY} } maxAllowed alreadyPurchased } } }`,
    { id: bookingId },
    { token },
  ).then((data) => data.booking.baggageOptions);

export const addBaggage = (token: string, idempotencyKey: string, bookingId: string, input: AddBaggageRequest) =>
  graphql<{ addBaggage: { outcome: Outcome; baggage: BaggageAddedResponse | null } }>(
    `mutation AgregarMaletas($key: UUID!, $id: UUID!, $input: AddBaggageInput!) {
      addBaggage(idempotencyKey: $key, bookingId: $id, input: $input) { outcome baggage { passengerId itineraryId totalBaggage } }
    }`,
    { key: idempotencyKey, id: bookingId, input },
    { token },
  ).then(({ addBaggage: result }) => ({ status: statusOf(result.outcome), data: result.baggage ?? undefined }));

export const searchDateChange = (token: string, bookingId: string, input: DateChangeSearchRequest) =>
  graphql<{ dateChangeOptions: DateChangeSearchResponse }>(
    `query OpcionesDeCambio($id: UUID!, $input: DateChangeSearchInput!) {
      dateChangeOptions(bookingId: $id, input: $input) { changeOfferId expiresAt segments { ${SEGMENT} } priceDifference { fareDifference taxDifference changeFee totalToPay } }
    }`,
    { id: bookingId, input },
    { token },
  ).then((data) => data.dateChangeOptions);

export const confirmDateChange = (token: string, idempotencyKey: string, bookingId: string, input: DateChangeRequest) =>
  graphql<{ confirmDateChange: { outcome: Outcome; booking: BookingDetail } }>(
    `mutation CambiarFecha($key: UUID!, $id: UUID!, $input: ConfirmDateChangeInput!) {
      confirmDateChange(idempotencyKey: $key, bookingId: $id, input: $input) { outcome booking { ${BOOKING} } }
    }`,
    { key: idempotencyKey, id: bookingId, input },
    { token },
  ).then(({ confirmDateChange: result }) => ({ status: statusOf(result.outcome), data: result.booking }));

export const getCancellationQuote = (token: string, bookingId: string) =>
  graphql<{ booking: { cancellationQuote: CancellationQuoteResponse } }>(
    'query Cotizar($id: UUID!) { booking(bookingId: $id) { cancellationQuote { quoteId isRefundable refundAmount penaltyAmount currency expiresAt } } }',
    { id: bookingId },
    { token },
  ).then((data) => data.booking.cancellationQuote);

export const cancelBooking = (token: string, idempotencyKey: string, bookingId: string, input: CancelBookingRequest) =>
  graphql<{ cancelBooking: { outcome: Outcome; status: string } }>(
    `mutation Cancelar($key: UUID!, $id: UUID!, $input: CancelBookingInput!) {
      cancelBooking(idempotencyKey: $key, bookingId: $id, input: $input) { outcome bookingId status }
    }`,
    { key: idempotencyKey, id: bookingId, input },
    { token },
  ).then((data) => data.cancelBooking);

// ── Asistencia médica (dato de salud) ──
const ASSISTANCE = 'passengerId type needsCompanion notes status updatedAt';

export const getAssistance = (token: string, bookingId: string) =>
  graphql<{ booking: { assistance: PassengerAssistance[] } }>(`query Asistencia($id: UUID!) { booking(bookingId: $id) { assistance { ${ASSISTANCE} } } }`, { id: bookingId }, { token }).then(
    (data) => data.booking.assistance,
  );

export const savePassengerAssistance = (token: string, bookingId: string, passengerId: string, input: AssistanceInput) =>
  graphql<{ savePassengerAssistance: PassengerAssistance }>(
    `mutation GuardarAsistencia($id: UUID!, $passengerId: String!, $input: AssistanceInput!) {
      savePassengerAssistance(bookingId: $id, passengerId: $passengerId, input: $input) { ${ASSISTANCE} }
    }`,
    { id: bookingId, passengerId, input },
    { token },
  ).then((data) => data.savePassengerAssistance);

export const deletePassengerAssistance = (token: string, bookingId: string, passengerId: string) =>
  graphql<{ deletePassengerAssistance: boolean }>(
    'mutation QuitarAsistencia($id: UUID!, $passengerId: String!) { deletePassengerAssistance(bookingId: $id, passengerId: $passengerId) }',
    { id: bookingId, passengerId },
    { token },
  ).then(() => undefined);

// ── Check-in ──
export const checkIn = (token: string, bookingId: string) =>
  graphql<{ checkIn: CheckInResponse }>(
    'mutation CheckIn($id: UUID!) { checkIn(bookingId: $id) { bookingId status checkedInPassengers { passengerId status segments { segmentId seat status } } } }',
    { id: bookingId },
    { token },
  ).then((data) => data.checkIn);

export const getBoardingPasses = (token: string, bookingId: string) =>
  graphql<{ booking: BoardingPassListResponse }>(
    `query Pases($id: UUID!) {
      booking(bookingId: $id) { bookingId boardingPasses { passengerId segmentId seat boardingGroup boardingPosition barcode barcodeType gate } }
    }`,
    { id: bookingId },
    { token },
  ).then((data) => data.booking);

// ── Estado de vuelo (público) ──
export const getFlightStatus = (flightNumber: string, date: string) =>
  graphql<{ flightStatus: FlightStatus }>(
    `query EstadoDeVuelo($flightNumber: String!, $date: Date!) {
      flightStatus(flightNumber: $flightNumber, date: $date) {
        flightNumber date marketingCarrier operatingCarrier aircraft status delayMinutes
        departure { iataCode terminal scheduledAt estimatedAt actualAt gate } arrival { iataCode terminal scheduledAt estimatedAt actualAt gate }
      }
    }`,
    { flightNumber, date },
  ).then((data) => data.flightStatus);

// ── Perfil del cliente ──
/** `null` si el cliente todavía no guardó su perfil. */
export const getMyProfile = (token: string) =>
  graphql<{ myProfile: CustomerProfile | null }>(`query MiPerfil { myProfile { ${PROFILE} } }`, {}, { token }).then((data) => data.myProfile);

export const saveMyProfile = (token: string, input: CustomerProfileRequest) =>
  graphql<{ saveMyProfile: CustomerProfile }>(
    `mutation GuardarPerfil($input: CustomerProfileInput!) { saveMyProfile(input: $input) { ${PROFILE} } }`,
    { input },
    { token },
  ).then((data) => data.saveMyProfile);

// ── Sesión (públicas): MS.Clientes → MS.G.Identity ──
export interface AuthPayload {
  accessToken: string;
  expiresIn: number;
  user: { fullName: string; email: string; role: 'CUSTOMER' | 'ADMIN'; scopes: string[] };
}
const AUTH_PAYLOAD = 'accessToken expiresIn user { fullName email role scopes }';

export const login = (input: { email: string; password: string }) =>
  graphql<{ login: AuthPayload }>(`mutation Ingresar($input: LoginInput!) { login(input: $input) { ${AUTH_PAYLOAD} } }`, { input }).then((data) => data.login);

export const register = (input: { fullName: string; email: string; password: string }) =>
  graphql<{ register: AuthPayload }>(`mutation Registrarse($input: RegisterInput!) { register(input: $input) { ${AUTH_PAYLOAD} } }`, { input }).then(
    (data) => data.register,
  );
