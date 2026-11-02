import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ActorId, ServiceTokenGuard } from '@ecoairlines/shared';
import type { FlightOperationalStatus } from '../domain/status.js';
import { FlightStatusService } from '../services/flight-status.service.js';

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)$/;
const STATUSES: FlightOperationalStatus[] = ['SCHEDULED', 'BOARDING', 'DEPARTED', 'DELAYED', 'ARRIVED', 'CANCELLED', 'DIVERTED'];

class DateQuery {
  @Matches(DATE) date!: string;
}

class ListQuery extends DateQuery {
  @IsOptional() @Matches(/^[A-Z]{3}$/) origin?: string;
  @IsOptional() @Matches(/^[A-Z]{3}$/) destination?: string;
  @IsOptional() @IsIn(STATUSES) status?: FlightOperationalStatus;
}

/** `FlightStatusUpdateRequest` del contrato v2, sin cambios. */
class StatusUpdateDto {
  @Matches(DATE) date!: string;
  @IsIn(STATUSES) status!: FlightOperationalStatus;
  @IsOptional() @Matches(DATE_TIME) estimatedDepartureAt?: string;
  @IsOptional() @Matches(DATE_TIME) estimatedArrivalAt?: string;
  @IsOptional() @IsString() @MaxLength(10) departureGate?: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

/** Operaciones de MS.G.FlightStatus. Solo el ESB, con su token de servicio. */
@Controller()
@UseGuards(ServiceTokenGuard)
export class FlightStatusController {
  constructor(@Inject(FlightStatusService) private readonly flights: FlightStatusService) {}

  @Get('flights')
  list(@Query() query: ListQuery) {
    return this.flights.list(query.date, query);
  }

  @Get('flights/:flightNumber/status')
  get(@Param('flightNumber') flightNumber: string, @Query() query: DateQuery) {
    return this.flights.get(flightNumber, query.date);
  }

  @Patch('flights/:flightNumber/status')
  update(@Param('flightNumber') flightNumber: string, @Body() body: StatusUpdateDto, @ActorId() actor: string) {
    const { date, ...update } = body;
    return this.flights.update(flightNumber, date, update, actor);
  }

  @Get('flights/:flightNumber/status/history')
  history(@Param('flightNumber') flightNumber: string, @Query() query: DateQuery) {
    return this.flights.history(flightNumber, query.date);
  }

  @Post('status-changes/:changeId/revert')
  @HttpCode(200)
  revert(@Param('changeId') changeId: string, @ActorId() actor: string) {
    return this.flights.revert(changeId, actor);
  }
}
