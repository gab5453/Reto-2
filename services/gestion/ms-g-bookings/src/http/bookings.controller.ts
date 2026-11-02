import { Body, Controller, createParamDecorator, Delete, type ExecutionContext, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ActorId, ProblemDetailsException, ServiceTokenGuard } from '@ecoairlines/shared';
import { BookingsService, type Caller } from '../services/bookings.service.js';
import {
  ApplyBaggageDto,
  ApplyCancellationDto,
  ApplyDateChangeDto,
  ApplySeatsDto,
  AssistanceDto,
  AssistanceStatusDto,
  ClaimPaymentDto,
  CreateBookingDto,
  FailBookingDto,
  ListBookingsQuery,
  RangeQuery,
  SagaQuery,
  SeatChangeRequestDto,
  ValidatePassengersDto,
} from './dto.js';

const OWNER = /^([0-9a-f-]{36}|partner:[A-Z][A-Z0-9_]{2,39}:.{1,120})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (name: string, reason: string) => new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: `${name} no es válido.`, invalidParams: [{ name, reason }] });

/** `X-Owner-Id` (D29) y `X-Actor-Id` opcionales: el contexto de quién llama. */
const CallerContext = createParamDecorator((_: unknown, context: ExecutionContext): Caller => {
  const request = context.switchToHttp().getRequest<Request>();
  const ownerId = request.header('x-owner-id') || undefined;
  const actorId = request.header('x-actor-id') || undefined;
  if (ownerId !== undefined && (ownerId.length > 200 || !OWNER.test(ownerId))) throw invalid('X-Owner-Id', 'sub o partner:<clientId>:<X-User-Id>');
  if (actorId !== undefined && !UUID.test(actorId)) throw invalid('X-Actor-Id', 'debe ser un UUID');
  return { ...(ownerId ? { ownerId } : {}), ...(actorId ? { actorId: actorId.toLowerCase() } : {}) };
});

/** Operaciones de MS.G.Bookings (contract/ms-g-bookings.openapi.yaml). Solo el ESB, con su token de servicio. */
@Controller()
@UseGuards(ServiceTokenGuard)
export class BookingsController {
  constructor(@Inject(BookingsService) private readonly bookings: BookingsService) {}

  @Post('passengers/validate')
  @HttpCode(200)
  validate(@Body() body: ValidatePassengersDto) {
    return this.bookings.validatePassengers(body);
  }

  @Post('payment-references/claim')
  async claim(@Body() body: ClaimPaymentDto, @Res({ passthrough: true }) response: Response) {
    const { record, created } = await this.bookings.claimPayment(body);
    response.status(created ? 201 : 200);
    return record;
  }

  @Delete('payment-references/:paymentReference')
  @HttpCode(204)
  async releasePayment(@Param('paymentReference') reference: string, @Query() query: SagaQuery) {
    await this.bookings.releasePayment(reference, query.sagaId);
  }

  @Get('bookings')
  list(@Query() query: ListBookingsQuery, @CallerContext() caller: Caller) {
    const { limit, cursor, ...filter } = query;
    return this.bookings.list(caller, filter, limit, cursor);
  }

  @Post('bookings')
  async create(@Body() body: CreateBookingDto, @CallerContext() caller: Caller, @Res({ passthrough: true }) response: Response) {
    if (!caller.ownerId) throw invalid('X-Owner-Id', 'obligatorio al crear la reserva');
    const { booking, created } = await this.bookings.create(body, caller.ownerId);
    response.status(created ? 201 : 200).location(`/bookings/${booking.bookingId}`);
    return this.bookings.get(booking.bookingId, caller);
  }

  @Get('bookings/:bookingId')
  get(@Param('bookingId') id: string, @CallerContext() caller: Caller) {
    return this.bookings.get(id, caller);
  }

  @Post('bookings/:bookingId/fail')
  @HttpCode(200)
  fail(@Param('bookingId') id: string, @Body() body: FailBookingDto) {
    return this.bookings.fail(id, body.errorCode, body.reason);
  }

  @Get('bookings/:bookingId/fares')
  fares(@Param('bookingId') id: string, @CallerContext() caller: Caller) {
    return this.bookings.fares(id, caller);
  }

  @Post('bookings/:bookingId/tickets')
  @HttpCode(200)
  issue(@Param('bookingId') id: string, @CallerContext() caller: Caller) {
    return this.bookings.issueTickets(id, caller);
  }

  @Get('bookings/:bookingId/tickets')
  tickets(@Param('bookingId') id: string, @CallerContext() caller: Caller) {
    return this.bookings.tickets(id, caller);
  }

  @Get('bookings/:bookingId/tickets/:ticketId')
  ticket(@Param('bookingId') id: string, @Param('ticketId') ticketId: string, @CallerContext() caller: Caller) {
    return this.bookings.ticket(id, ticketId, caller);
  }

  @Post('bookings/:bookingId/seats/plan')
  @HttpCode(200)
  planSeats(@Param('bookingId') id: string, @Body() body: SeatChangeRequestDto, @CallerContext() caller: Caller) {
    return this.bookings.planSeats(id, body.seats, caller);
  }

  @Put('bookings/:bookingId/seats')
  applySeats(@Param('bookingId') id: string, @Body() body: ApplySeatsDto, @CallerContext() caller: Caller) {
    return this.bookings.applySeats(id, body, caller);
  }

  @Post('bookings/:bookingId/baggage')
  @HttpCode(200)
  baggage(@Param('bookingId') id: string, @Body() body: ApplyBaggageDto, @CallerContext() caller: Caller) {
    return this.bookings.applyBaggage(id, body, caller);
  }

  @Post('bookings/:bookingId/date-change')
  @HttpCode(200)
  dateChange(@Param('bookingId') id: string, @Body() body: ApplyDateChangeDto, @CallerContext() caller: Caller) {
    return this.bookings.applyDateChange(id, body, caller);
  }

  @Post('bookings/:bookingId/cancellation')
  @HttpCode(200)
  cancel(@Param('bookingId') id: string, @Body() body: ApplyCancellationDto, @CallerContext() caller: Caller) {
    return this.bookings.applyCancellation(id, body, caller);
  }

  @Get('flights/:flightNumber/:date/bookings')
  flightBookings(@Param('flightNumber') flightNumber: string, @Param('date') date: string) {
    return this.bookings.flightBookings(flightNumber, date);
  }

  @Get('flights/:flightNumber/:date/assistance')
  flightAssistance(@Param('flightNumber') flightNumber: string, @Param('date') date: string, @ActorId() _actor: string) {
    return this.bookings.flightAssistance(flightNumber, date);
  }

  @Put('bookings/:bookingId/passengers/:passengerId/assistance')
  saveAssistance(@Param('bookingId') id: string, @Param('passengerId') passengerId: string, @Body() body: AssistanceDto, @CallerContext() caller: Caller) {
    return this.bookings.saveAssistance(id, passengerId, body, caller);
  }

  @Delete('bookings/:bookingId/passengers/:passengerId/assistance')
  @HttpCode(204)
  async deleteAssistance(@Param('bookingId') id: string, @Param('passengerId') passengerId: string, @CallerContext() caller: Caller) {
    await this.bookings.deleteAssistance(id, passengerId, caller);
  }

  @Put('bookings/:bookingId/passengers/:passengerId/assistance/status')
  assistanceStatus(@Param('bookingId') id: string, @Param('passengerId') passengerId: string, @Body() body: AssistanceStatusDto, @ActorId() _actor: string) {
    return this.bookings.setAssistanceStatus(id, passengerId, body.status);
  }

  @Get('indicators')
  indicators(@Query() query: RangeQuery, @ActorId() _actor: string) {
    return this.bookings.summary(query.from, query.to);
  }
}
