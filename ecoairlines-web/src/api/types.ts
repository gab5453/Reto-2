// Tipos de los datos que la web pide al GraphQL del gateway (`contract/gateway.graphql`, que conserva los schemas del contrato
// de Vuelos). Solo declaran los campos que piden las consultas de `operations.ts` y `admin.ts`.

export type CabinClass = 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';
export type PassengerType = 'ADULT' | 'YOUTH' | 'CHILD' | 'INFANT';
export type FlightOperationalStatus = 'SCHEDULED' | 'BOARDING' | 'DEPARTED' | 'DELAYED' | 'ARRIVED' | 'CANCELLED' | 'DIVERTED';
export type BookingStatus =
  | 'PENDING'
  | 'PENDING_PAYMENT'
  | 'TICKET_ISSUING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'CHANGE_PENDING'
  | 'CANCELLATION_PENDING'
  | 'CANCELLED';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  invalidParams?: { name?: string; reason?: string }[];
}

export interface MoneyAmount {
  currency: string;
  baseFare?: string;
  taxes?: string;
  total: string;
}

export interface PassengerBreakdown {
  adults?: number;
  youths?: number;
  children?: number;
  infants?: number;
}

export interface SearchRequest {
  itineraries: { origin: string; destination: string; departureDate: string }[];
  passengers: PassengerBreakdown;
}

export interface FlightEndpoint {
  iataCode: string;
  at: string;
  terminal?: string | null;
}

export interface FlightSegment {
  segmentId: string;
  flightNumber: string;
  departure: FlightEndpoint;
  arrival: FlightEndpoint;
  layoverMinutes?: number;
  marketingCarrier: string;
  operatingCarrier: string;
  aircraft?: string | null;
  durationMinutes?: number | null;
  status?: FlightOperationalStatus | null;
}

export interface CabinPricing {
  cabinClass: CabinClass;
  fareBrand: string;
  availableSeats: number;
  fareRules: { isRefundable: boolean; isChangeable: boolean };
  baggageAllowance: { personalItemIncluded?: boolean; carryOnIncluded?: number; checkedBaggageIncluded?: number };
  extraCheckedBaggagePrice?: MoneyAmount;
  pricePerPassengerType: { passengerType?: string; price?: MoneyAmount }[];
}

export interface ItineraryOption {
  itineraryId: string;
  totalDurationMinutes: number;
  stopsCount: number;
  segments: FlightSegment[];
  pricingOptions: CabinPricing[];
}

export interface FlightOffer {
  offerId: string;
  airline: { code?: string; name?: string };
  itineraries: ItineraryOption[];
  grandTotal: MoneyAmount;
}

export interface SearchResponse {
  totalOffers: number;
  offers: FlightOffer[];
}

export interface SeatMapResponse {
  segmentId?: string;
  cabins?: {
    cabinClass?: string;
    rows?: {
      rowNumber?: number;
      seats?: { seatNumber?: string; isAvailable?: boolean; characteristics?: ('WINDOW' | 'AISLE' | 'EXTRA_LEGROOM' | 'EMERGENCY_EXIT')[] }[];
    }[];
  }[];
}

export interface HoldRequest {
  offerId: string;
  itinerarySelections: { itineraryId: string; cabinClass: string; fareBrand: string }[];
  passengersBreakdown: PassengerBreakdown;
}

export interface HoldResponse {
  holdId: string;
  status: 'HELD';
  expiresAt: string;
  ttlMinutes: number;
  lockedPrice: MoneyAmount;
}

export interface HoldStatusResponse {
  status: 'HELD' | 'RELEASED' | 'EXPIRED' | 'CONSUMED';
  expiresAt?: string;
  remainingSeconds: number;
  lockedPrice: MoneyAmount;
}

export interface PassengerItem {
  passengerId: string;
  passengerType: PassengerType;
  associatedAdultId?: string;
  firstName: string;
  lastName: string;
  documentType: 'PASSPORT' | 'NATIONAL_ID';
  documentNumber: string;
  nationality: string;
  documentExpiryDate?: string;
  birthDate: string;
  gender: 'M' | 'F' | 'X';
  contact: { email: string; phone: string };
  assignedSeats?: { segmentId: string; seatNumber: string }[];
  extraBaggage?: { itineraryId: string; quantity: number }[];
}

export interface PaymentReference {
  paymentReference: string;
}

export type AssistanceType = 'WCHR' | 'WCHS' | 'WCHC' | 'BLND' | 'DEAF' | 'DPNA' | 'MEDA';

/** Asistencia médica o de movilidad. Dato de salud: nunca se registra ni se guarda en el navegador. */
export interface AssistanceInput {
  type: AssistanceType;
  needsCompanion: boolean;
  notes?: string | null;
}

export interface PassengerAssistance extends AssistanceInput {
  passengerId: string;
  status: 'REQUESTED' | 'READY';
  updatedAt: string;
}

export interface BookingRequest {
  holdId: string;
  passengers: PassengerItem[];
  payment: PaymentReference;
  assistance?: (AssistanceInput & { passengerId: string })[];
}

export interface TicketSegment {
  segmentId: string;
  status: 'PENDING' | 'ISSUED' | 'FAILED';
  couponNumber?: string | null;
  flightNumber?: string | null;
  departureIataCode?: string | null;
  arrivalIataCode?: string | null;
  seatNumber?: string | null;
}

export interface Ticket {
  ticketId: string;
  bookingId: string;
  passengerId: string;
  passengerName?: string | null;
  eTicketNumber?: string | null;
  status: 'PENDING' | 'ISSUING' | 'ISSUED' | 'FAILED' | 'VOIDED' | 'REFUNDED';
  issuedAt?: string | null;
  segments?: TicketSegment[];
  failureReason?: string | null;
}

export interface BookingDetail {
  bookingId: string;
  pnr: string;
  status: BookingStatus;
  grandTotal: MoneyAmount;
  createdAt: string;
  updatedAt?: string;
  itineraries?: ItineraryOption[];
  passengers?: PassengerItem[];
  tickets?: Ticket[];
  changes?: { changedAt?: string; description?: string }[];
  /** Solo en el detalle (`getBooking`): los reembolsos de la reserva cancelada. */
  refunds?: BookingRefund[];
}

export interface BookingRefund {
  refundId: string;
  amount: string;
  penaltyAmount: string;
  currency: string;
  status: 'CALCULATED' | 'SETTLED' | 'NOT_REFUNDABLE';
}

export interface BookingListResponse {
  nextCursor?: string;
  items?: {
    bookingId?: string;
    pnr?: string;
    status?: string;
    origin?: string;
    destination?: string;
    departureDate?: string;
    grandTotal?: MoneyAmount;
  }[];
}

export type BaggageOptionsResponse = {
  passengerId?: string;
  itineraryId?: string;
  price?: MoneyAmount;
  maxAllowed?: number;
  alreadyPurchased?: number;
}[];

export interface AddBaggageRequest {
  passengerId: string;
  itineraryId: string;
  quantity: number;
  payment: PaymentReference;
}

export interface BaggageAddedResponse {
  passengerId?: string;
  itineraryId?: string;
  totalBaggage?: number;
}

export interface DateChangeSearchRequest {
  changes: { itineraryId: string; newDepartureDate: string }[];
}

export type DateChangeSearchResponse = {
  changeOfferId?: string;
  expiresAt?: string;
  segments?: FlightSegment[];
  priceDifference?: { fareDifference?: string; taxDifference?: string; changeFee?: string; totalToPay?: string };
}[];

export interface DateChangeRequest {
  changeOfferId: string;
  payment?: PaymentReference;
  assignedSeats?: { segmentId?: string; seatNumber?: string }[];
}

export interface CancellationQuoteResponse {
  quoteId: string;
  isRefundable: boolean;
  refundAmount: string;
  penaltyAmount: string;
  currency: string;
  expiresAt: string;
}

export interface CancelBookingRequest {
  quoteId: string;
  reason?: string;
}

export interface CheckInResponse {
  bookingId: string;
  status: 'NOT_ELIGIBLE' | 'AVAILABLE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  checkedInPassengers: {
    passengerId: string;
    status: 'CHECKED_IN' | 'NOT_CHECKED_IN' | 'FAILED';
    segments?: { segmentId: string; seat?: string | null; status: 'CHECKED_IN' | 'NOT_CHECKED_IN' | 'FAILED' }[];
  }[];
}

export interface BoardingPass {
  passengerId: string;
  segmentId: string;
  seat: string;
  boardingGroup?: string | null;
  boardingPosition?: string | null;
  barcode: string;
  barcodeType: 'AZTEC' | 'PDF417' | 'QR';
  gate?: string | null;
}

export interface BoardingPassListResponse {
  bookingId: string;
  boardingPasses: BoardingPass[];
}

interface FlightStatusEndpoint {
  iataCode: string;
  terminal?: string | null;
  scheduledAt: string;
  estimatedAt?: string | null;
  actualAt?: string | null;
}

export interface FlightStatus {
  flightNumber: string;
  date: string;
  marketingCarrier: string;
  operatingCarrier: string;
  departure: FlightStatusEndpoint;
  arrival: FlightStatusEndpoint;
  aircraft?: string | null;
  status: FlightOperationalStatus;
  delayMinutes?: number | null;
}

export interface SeatChangeItem {
  passengerId: string;
  segmentId: string;
  seatNumber: string;
}

export interface SeatChangeResult {
  bookingId: string;
  seats: (SeatChangeItem & { previousSeatNumber?: string | null; status: string })[];
}

export interface CustomerProfileRequest {
  firstName: string;
  lastName: string;
  documentType: 'PASSPORT' | 'NATIONAL_ID';
  documentNumber: string;
  nationality: string;
  documentExpiryDate?: string | null;
  birthDate: string;
  gender: 'M' | 'F' | 'X';
  contact: { email: string; phone: string };
  defaultAssistance?: AssistanceInput | null;
}

export interface CustomerProfile extends CustomerProfileRequest {
  updatedAt: string;
}
