import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { AssistanceType, BookingStatus, ItineraryOption, PaymentOperation, PaymentProvider, SalesChannelCode } from '../domain/model.js';

/**
 * DTO de contract/ms-g-bookings.openapi.yaml (`additionalProperties: false` lo aplica el ValidationPipe). Los itinerarios
 * vienen de Offers tal cual (los arma el ESB) y no se validan campo por campo; los pasajeros sí.
 */
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DECIMAL = /^-?\d{1,9}(\.\d{1,2})?$/;
const PASSENGER_TYPES = ['ADULT', 'YOUTH', 'CHILD', 'INFANT'];
const PROVIDERS: PaymentProvider[] = ['BOOKING_PROTOTIPO', 'AIRLINE_DIRECT'];
const ASSISTANCE: AssistanceType[] = ['WCHR', 'WCHS', 'WCHC', 'BLND', 'DEAF', 'DPNA', 'MEDA'];
const STATUSES: BookingStatus[] = ['PENDING', 'PENDING_PAYMENT', 'TICKET_ISSUING', 'CONFIRMED', 'FAILED', 'CHANGE_PENDING', 'CANCELLATION_PENDING', 'CANCELLED'];

export class MoneyDto {
  @Matches(/^[A-Z]{3}$/) currency!: string;
  @IsOptional() @Matches(DECIMAL) baseFare?: string;
  @IsOptional() @Matches(DECIMAL) taxes?: string;
  @Matches(DECIMAL) total!: string;
}

export class BreakdownDto {
  @IsOptional() @IsInt() @Min(1) @Max(9) adults?: number;
  @IsOptional() @IsInt() @Min(0) @Max(9) youths?: number;
  @IsOptional() @IsInt() @Min(0) @Max(9) children?: number;
  @IsOptional() @IsInt() @Min(0) @Max(9) infants?: number;
}

class ContactDto {
  @IsEmail() @MaxLength(254) email!: string;
  @Matches(/^\+?[0-9 ()-]{6,20}$/) phone!: string;
}

class SeatDto {
  @IsString() @MaxLength(40) segmentId!: string;
  @Matches(/^\d{1,2}[A-K]$/) seatNumber!: string;
}

class BagDto {
  @IsString() @MaxLength(100) itineraryId!: string;
  @IsInt() @Min(1) @Max(3) quantity!: number;
}

export class PassengerDto {
  @IsString() @MaxLength(20) passengerId!: string;
  @IsIn(PASSENGER_TYPES) passengerType!: 'ADULT' | 'YOUTH' | 'CHILD' | 'INFANT';
  @IsOptional() @IsString() @MaxLength(20) associatedAdultId?: string;
  @IsString() @MaxLength(60) @Matches(/\S/) firstName!: string;
  @IsString() @MaxLength(60) @Matches(/\S/) lastName!: string;
  @IsIn(['PASSPORT', 'NATIONAL_ID']) documentType!: 'PASSPORT' | 'NATIONAL_ID';
  @IsString() @MaxLength(30) documentNumber!: string;
  @Matches(/^[A-Z]{2}$/) nationality!: string;
  @IsOptional() @Matches(DATE) documentExpiryDate?: string;
  @Matches(DATE) birthDate!: string;
  @IsIn(['M', 'F', 'X']) gender!: 'M' | 'F' | 'X';
  @ValidateNested() @Type(() => ContactDto) contact!: ContactDto;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SeatDto) assignedSeats?: SeatDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BagDto) extraBaggage?: BagDto[];
}

class SegmentInfoDto {
  @IsString() @MaxLength(40) segmentId!: string;
  @IsString() @MaxLength(10) flightNumber!: string;
  @IsString() departureAt!: string;
  @IsBoolean() international!: boolean;
}

export class ValidatePassengersDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => PassengerDto) passengers!: PassengerDto[];
  @ValidateNested() @Type(() => BreakdownDto) passengersBreakdown!: BreakdownDto;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SegmentInfoDto) segments!: SegmentInfoDto[];
}

export class ClaimPaymentDto {
  @IsUUID() sagaId!: string;
  @IsString() @MaxLength(80) paymentReference!: string;
  @IsIn(PROVIDERS) provider!: PaymentProvider;
  @IsIn(['BOOKING', 'SEATS', 'BAGGAGE', 'DATE_CHANGE']) operation!: PaymentOperation;
  @IsOptional() @IsUUID() bookingId?: string;
  @IsOptional() @ValidateNested() @Type(() => MoneyDto) amount?: MoneyDto;
  @ValidateNested() @Type(() => MoneyDto) expectedAmount!: MoneyDto;
}

export class PurchasedFareDto {
  @IsString() @MaxLength(100) itineraryId!: string;
  @IsIn(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']) cabinClass!: string;
  @IsString() @MaxLength(20) fareBrand!: string;
  @IsArray() @IsString({ each: true }) segmentIds!: string[];
  @ValidateNested() @Type(() => MoneyDto) price!: MoneyDto;
  @IsBoolean() isRefundable!: boolean;
  @IsBoolean() isChangeable!: boolean;
  @IsOptional() @Matches(DECIMAL) changeFeeUsd?: string;
}

class PaymentRefDto {
  @IsString() @MaxLength(80) paymentReference!: string;
  @IsIn(PROVIDERS) provider!: PaymentProvider;
}

class SalesChannelDto {
  @IsOptional() @IsString() @MaxLength(40) partnerId?: string;
  @IsOptional() @IsString() @MaxLength(80) partnerOrderId?: string;
  @IsOptional() @IsString() @MaxLength(80) packageId?: string | null;
  @IsOptional() @IsBoolean() promotionApplied?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(100) discountPercentage?: number;
}

export class AssistanceDto {
  @IsIn(ASSISTANCE) type!: AssistanceType;
  @IsOptional() @IsBoolean() needsCompanion?: boolean;
  @IsOptional() @IsString() @MaxLength(200) notes?: string;
}

class BookingAssistanceDto extends AssistanceDto {
  @IsString() @MaxLength(20) passengerId!: string;
}

export class CreateBookingDto {
  @IsUUID() bookingId!: string;
  @IsUUID() sagaId!: string;
  @IsUUID() holdId!: string;
  @IsString() @MaxLength(400) offerId!: string;
  @ValidateNested() @Type(() => BreakdownDto) passengersBreakdown!: BreakdownDto;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => PassengerDto) passengers!: PassengerDto[];
  @IsArray() @ArrayMinSize(1) @IsObject({ each: true }) itineraries!: ItineraryOption[];
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PurchasedFareDto) fares!: PurchasedFareDto[];
  @ValidateNested() @Type(() => MoneyDto) grandTotal!: MoneyDto;
  @ValidateNested() @Type(() => PaymentRefDto) payment!: PaymentRefDto;
  @IsOptional() @ValidateNested() @Type(() => SalesChannelDto) salesChannel?: SalesChannelDto;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BookingAssistanceDto) assistance?: BookingAssistanceDto[];
}

export class FailBookingDto {
  @IsIn(['PAYMENT_NOT_AUTHORIZED', 'TICKET_ISSUANCE_FAILED', 'PNR_CREATION_FAILED', 'SAGA_COMPENSATED']) errorCode!: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

class SeatChangeDto {
  @IsString() @MaxLength(20) passengerId!: string;
  @IsString() @MaxLength(40) segmentId!: string;
  @Matches(/^\d{1,2}[A-K]$/) seatNumber!: string;
}

class SeatPaymentDto {
  @IsString() @MaxLength(80) paymentReference!: string;
  @IsOptional() @ValidateNested() @Type(() => MoneyDto) amount?: MoneyDto;
  @IsOptional() @IsIn(PROVIDERS) provider?: PaymentProvider;
}

export class SeatChangeRequestDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SeatChangeDto) seats!: SeatChangeDto[];
  @IsOptional() @ValidateNested() @Type(() => SeatPaymentDto) payment?: SeatPaymentDto;
}

export class ApplySeatsDto {
  @IsIn(['CUSTOMER_CHANGE', 'CHECK_IN_AUTO']) reason!: 'CUSTOMER_CHANGE' | 'CHECK_IN_AUTO';
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SeatChangeDto) seats!: SeatChangeDto[];
  @IsOptional() @ValidateNested() @Type(() => MoneyDto) amountCharged?: MoneyDto;
  @IsOptional() @IsString() @MaxLength(80) paymentReference?: string;
}

export class ApplyBaggageDto {
  @IsString() @MaxLength(20) passengerId!: string;
  @IsString() @MaxLength(100) itineraryId!: string;
  @IsInt() @Min(1) @Max(3) quantity!: number;
  @ValidateNested() @Type(() => MoneyDto) amountCharged!: MoneyDto;
  @IsString() @MaxLength(80) paymentReference!: string;
}

export class ApplyDateChangeDto {
  @IsString() @MaxLength(100) changeOfferId!: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) replacedItineraryIds!: string[];
  @IsArray() @ArrayMinSize(1) @IsObject({ each: true }) newItineraries!: ItineraryOption[];
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PurchasedFareDto) newFares!: PurchasedFareDto[];
  @ValidateNested() @Type(() => MoneyDto) priceDifference!: MoneyDto;
  @IsOptional() @IsString() @MaxLength(80) paymentReference?: string | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SeatChangeDto) assignedSeats?: SeatChangeDto[];
}

class RefundDto {
  @IsString() @MaxLength(40) refundId!: string;
  @Matches(DECIMAL) amount!: string;
  @Matches(DECIMAL) penaltyAmount!: string;
  @IsOptional() @IsBoolean() penaltyWaived?: boolean;
  @Matches(/^[A-Z]{3}$/) currency!: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) percentage?: number;
  @IsOptional() @IsString() @MaxLength(80) originalPaymentReference?: string | null;
  @IsIn(['CALCULATED', 'SETTLED', 'NOT_REFUNDABLE']) status!: 'CALCULATED' | 'SETTLED' | 'NOT_REFUNDABLE';
  @IsOptional() @IsString() settledAt?: string | null;
}

export class ApplyCancellationDto {
  @IsIn(['CUSTOMER_REQUEST', 'SAGA_COMPENSATION', 'FLIGHT_CANCELLED', 'OTHER']) reasonCode!: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
  @IsOptional() @IsString() @MaxLength(80) quoteId?: string | null;
  @ValidateNested() @Type(() => RefundDto) refund!: RefundDto;
  @IsInt() @Min(0) seatsReleased!: number;
}

export class AssistanceStatusDto {
  @IsIn(['REQUESTED', 'READY']) status!: 'REQUESTED' | 'READY';
}

export class ListBookingsQuery {
  @IsOptional() @Matches(/^[A-Z0-9]{6}$/) pnr?: string;
  @IsOptional() @IsIn(STATUSES) status?: BookingStatus;
  @IsOptional() @IsIn(['WEB', 'BOOKING']) channel?: SalesChannelCode;
  @IsOptional() @Matches(DATE) createdFrom?: string;
  @IsOptional() @Matches(DATE) createdTo?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
}

export class SagaQuery {
  @IsUUID() sagaId!: string;
}

export class RangeQuery {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
}
