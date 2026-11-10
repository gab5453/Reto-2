import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
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
import type { AircraftType } from '@ecoairlines/shared';
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

  @IsOptional() @IsString() @MaxLength(60)
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
  @IsString() @MaxLength(60)
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

class RoutePriceItemDto {
  @IsIn(BRANDS)
  fareBrand!: FareBrand;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(20_000)
  amount!: number;
}

class RoutePricesDto {
  @IsString() @Matches(/^EA\d{3,4}-EA\d{3,4}$/)
  routeId!: string;

  @IsArray() @ArrayMinSize(4) @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => RoutePriceItemDto)
  prices!: RoutePriceItemDto[];
}

/** P-1: estado completo de la tarifa base (cargo fijo y precio por km) y de los precios exactos por ruta. */
export class SavePricingDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(500)
  fixedCharge!: number;

  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.001) @Max(5)
  perKm!: number;

  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => RoutePricesDto)
  routePrices!: RoutePricesDto[];
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

const COUNTRY = /^[A-Z]{2}$/;

/** M-1: un aeropuerto del catálogo (el código va solo al crearlo y no se edita). */
export class AirportRequestDto {
  @IsString() @MaxLength(80) @Matches(/\S/)
  city!: string;

  @IsString() @MaxLength(120) @Matches(/\S/)
  name!: string;

  /** ISO 3166-1 alfa-2 (EC, CO, US…). */
  @Matches(COUNTRY)
  country!: string;

  @IsOptional() @IsString() @MaxLength(80)
  province?: string | null;

  @IsNumber({ maxDecimalPlaces: 6 }) @Min(-90) @Max(90)
  lat!: number;

  @IsNumber({ maxDecimalPlaces: 6 }) @Min(-180) @Max(180)
  lon!: number;

  /** Desfase fijo respecto de UTC, en minutos (−300 es UTC−5), múltiplo de 15. */
  @IsInt() @Min(-720) @Max(840)
  utcOffsetMinutes!: number;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

export class CreateAirportRequestDto extends AirportRequestDto {
  @Matches(IATA)
  code!: string;
}

class CabinSeatsDto {
  @IsInt() @Min(1) @Max(600)
  seats!: number;

  @IsString() @MaxLength(10)
  configuration!: string;
}

/** M-2: un tipo de avión (el nombre va solo al crearlo y no se edita). */
export class AircraftTypeRequestDto {
  /** `HC-` + una letra. */
  @Matches(/^HC-[A-Z]$/)
  registrationPrefix!: string;

  /** Sin límite: `null`. */
  @IsOptional() @IsInt() @Min(100) @Max(20_000)
  maxRouteKm!: number | null;

  @IsInt() @Min(15) @Max(300)
  turnaroundMinutes!: number;

  @IsDefined() @ValidateNested() @Type(() => CabinSeatsDto)
  business!: CabinSeatsDto;

  @IsDefined() @ValidateNested() @Type(() => CabinSeatsDto)
  economy!: CabinSeatsDto;
}

export class CreateAircraftTypeRequestDto extends AircraftTypeRequestDto {
  @IsString() @MaxLength(60) @Matches(/^[A-Za-z0-9][A-Za-z0-9 .-]{2,59}$/)
  aircraftType!: string;
}


