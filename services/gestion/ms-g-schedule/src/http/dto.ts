import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AIRCRAFT_TYPES, type AircraftType } from '@ecoairlines/shared';
import { type CabinClass, type FareBrand, WEEKDAY_CODES, type WeekdayCode } from '../domain/model.js';

/**
 * DTO de los esquemas de contract/ms-g-schedule.openapi.yaml. Los rangos de negocio (multiplicador 0,5–10, descuento 0–50 %)
 * NO se validan aquí: los valida el dominio con su código propio (422 MULTIPLIER_OUT_OF_RANGE, PROMOTION_DISCOUNT_OUT_OF_RANGE).
 */
const IATA = /^[A-Z]{3}$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const REGISTRATION = /^HC-[A-Z0-9]{2,6}$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CABINS: CabinClass[] = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'];
const BRANDS: FareBrand[] = ['SEMILLA', 'BROTE', 'BOSQUE', 'DOSEL'];

/** Fecha de calendario real (rechaza 2026-02-30). */
const isCalendarDate = (value: string) => DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

export class ScheduledRouteRequestDto {
  @Matches(IATA)
  origin!: string;

  @Matches(IATA)
  destination!: string;

  @Matches(TIME, { message: 'outboundDepartureLocal debe tener el formato HH:MM' })
  outboundDepartureLocal!: string;

  @Matches(TIME, { message: 'inboundDepartureLocal debe tener el formato HH:MM' })
  inboundDepartureLocal!: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ArrayUnique() @IsIn([...WEEKDAY_CODES], { each: true })
  weekdays!: WeekdayCode[];

  @IsOptional() @IsIn([...AIRCRAFT_TYPES])
  aircraftType?: AircraftType;

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ArrayUnique() @Matches(REGISTRATION, { each: true })
  aircraft?: string[];
}

export class RouteChangeRequestDto {
  @ValidateNested() @Type(() => ScheduledRouteRequestDto)
  route!: ScheduledRouteRequestDto;

  @IsInt() @Min(0)
  soldSeats!: number;
}

export class CreateRouteQuery {
  @IsOptional() @Matches(/^EA[0-9]{1,4}-EA[0-9]{1,4}$/)
  restoreRouteId?: string;
}

export class SoldSeatsQuery {
  @Type(() => Number) @IsInt() @Min(0)
  soldSeats!: number;
}

export class AircraftRequestDto {
  @IsIn([...AIRCRAFT_TYPES])
  aircraftType!: AircraftType;

  @Matches(IATA)
  base!: string;
}

export class UpdateAircraftRequestDto {
  @Matches(IATA)
  base!: string;
}

export class TimetableQuery {
  @Matches(DATE) from!: string;
  @Matches(DATE) to!: string;
  @IsOptional() @IsString() @MaxLength(20) routeId?: string;

  static valid(query: TimetableQuery): boolean {
    return isCalendarDate(query.from) && isCalendarDate(query.to);
  }
}

export class DateQuery {
  @Matches(DATE) date!: string;

  static valid(query: DateQuery): boolean {
    return isCalendarDate(query.date);
  }
}

export class FarePriceItemDto {
  @IsIn(CABINS)
  cabinClass!: CabinClass;

  @IsIn(BRANDS)
  fareBrand!: FareBrand;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  multiplier!: number;
}

export class SaveFarePricesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => FarePriceItemDto)
  items!: FarePriceItemDto[];
}

export class HistoryQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit = 20;

  @IsOptional() @IsString() @MaxLength(200)
  cursor?: string;
}

/** `ContratoPromocionesRequest` del contrato v2. */
export class PromotionAgreementDto {
  @IsBoolean()
  permite_promociones!: boolean;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  porcentaje_descuento_maximo!: number;

  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(80, { each: true })
  destinos_habilitados?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(200) @Matches(/^[A-Z]{3}-[A-Z]{3}$/, { each: true })
  rutas_habilitadas?: string[];

  @IsOptional() @IsArray() @IsIn(CABINS, { each: true })
  cabinas_habilitadas?: CabinClass[];

  @IsOptional() @Matches(DATE)
  vigencia_hasta?: string;

  @IsOptional() @IsString() @MaxLength(500)
  condiciones_combo?: string;

  static valid(dto: PromotionAgreementDto): boolean {
    return !dto.vigencia_hasta || isCalendarDate(dto.vigencia_hasta);
  }
}
