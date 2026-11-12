import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ActorId, ServiceTokenGuard } from '@ecoairlines/shared';
import { CheckInService } from '../services/check-in.service.js';

/** DTO de contract/ms-g-check-in.openapi.yaml (`additionalProperties: false` lo aplica el ValidationPipe). */
class SegmentDto {
  @IsString() @MaxLength(40) segmentId!: string;
  @Matches(/^[A-Z0-9]{2}[0-9]{1,4}$/) flightNumber!: string;
  @Matches(/^[A-Z]{3}$/) origin!: string;
  @Matches(/^[A-Z]{3}$/) destination!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/) departureAt!: string;
  @IsOptional() @IsIn(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']) cabinClass?: string;
  @IsOptional() @Matches(/^\d{1,3}[A-K]$/) seat!: string | null;
  @IsOptional() @IsString() @MaxLength(10) gate?: string | null;
  @IsOptional() @IsBoolean() needsAssistance?: boolean;
}

class PassengerDto {
  @IsString() @MaxLength(20) passengerId!: string;
  @IsIn(['ADULT', 'YOUTH', 'CHILD', 'INFANT']) passengerType!: 'ADULT' | 'YOUTH' | 'CHILD' | 'INFANT';
  @IsString() @MaxLength(60) firstName!: string;
  @IsString() @MaxLength(60) lastName!: string;
  @IsOptional() @IsString() @MaxLength(20) eTicketNumber?: string | null;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SegmentDto) segments!: SegmentDto[];
}

class RegisterCheckInDto {
  @IsUUID() sagaId!: string;
  @Matches(/^[A-Z0-9]{6}$/) pnr!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(9) @ValidateNested({ each: true }) @Type(() => PassengerDto) passengers!: PassengerDto[];
}

class AssistanceReadyDto {
  @IsString() @MaxLength(20) passengerId!: string;
  @IsString() @MaxLength(40) segmentId!: string;
  @IsBoolean() ready!: boolean;
}

class SagaQuery {
  @IsUUID() sagaId!: string;
}

class VoidCheckInDto {
  @IsUUID() sagaId!: string;
  @IsIn(['BOOKING_CANCELLED', 'DATE_CHANGED']) reason!: 'BOOKING_CANCELLED' | 'DATE_CHANGED';
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) segmentIds?: string[];
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(9) @IsString({ each: true }) @MaxLength(20, { each: true }) passengerIds?: string[];
}

/** Operaciones de MS.G.CheckIn. Solo el ESB, con su token de servicio. */
@Controller()
@UseGuards(ServiceTokenGuard)
export class CheckInController {
  constructor(@Inject(CheckInService) private readonly checkIns: CheckInService) {}

  @Post('check-ins/:bookingId')
  @HttpCode(200)
  register(@Param('bookingId') bookingId: string, @Body() body: RegisterCheckInDto) {
    return this.checkIns.register(bookingId.toLowerCase(), body);
  }

  @Get('check-ins/:bookingId')
  state(@Param('bookingId') bookingId: string) {
    return this.checkIns.state(bookingId.toLowerCase());
  }

  @Delete('check-ins/:bookingId')
  @HttpCode(204)
  async undo(@Param('bookingId') bookingId: string, @Query() query: SagaQuery) {
    await this.checkIns.undo(bookingId.toLowerCase(), query.sagaId);
  }

  /** K-1 (D56): anular check-ins (cancelación o cambio de fecha después del check-in). */
  @Post('check-ins/:bookingId/void')
  @HttpCode(200)
  voidCheckIns(@Param('bookingId') bookingId: string, @Body() body: VoidCheckInDto) {
    return this.checkIns.voidCheckIns(bookingId.toLowerCase(), body);
  }

  /** Compensación de la anulación (la saga falló después). */
  @Delete('check-ins/:bookingId/void')
  @HttpCode(204)
  async restoreVoided(@Param('bookingId') bookingId: string, @Query() query: SagaQuery) {
    await this.checkIns.restoreVoided(bookingId.toLowerCase(), query.sagaId);
  }

  @Get('check-ins/:bookingId/boarding-passes')
  boardingPasses(@Param('bookingId') bookingId: string) {
    return this.checkIns.boardingPasses(bookingId.toLowerCase());
  }

  @Put('check-ins/:bookingId/assistance-ready')
  assistanceReady(@Param('bookingId') bookingId: string, @Body() body: AssistanceReadyDto, @ActorId() actor: string) {
    return this.checkIns.markAssistanceReady(bookingId.toLowerCase(), body, actor);
  }

  @Get('flights/:flightNumber/:date/check-ins')
  flight(@Param('flightNumber') flightNumber: string, @Param('date') date: string) {
    return this.checkIns.flight(flightNumber, date);
  }
}
