import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ActorId, ProblemDetailsException, ServiceTokenGuard } from '@ecoairlines/shared';
import { PricingService } from '../services/pricing.service.js';
import { PromotionsService } from '../services/promotions.service.js';
import { ScheduleService } from '../services/schedule.service.js';
import {
  AircraftRequestDto,
  CreateRouteQuery,
  DateQuery,
  HistoryQuery,
  PromotionAgreementDto,
  RouteChangeRequestDto,
  SaveFarePricesDto,
  ScheduledRouteRequestDto,
  SoldSeatsQuery,
  TimetableQuery,
  UpdateAircraftRequestDto,
} from './dto.js';

const invalidDate = (name: string) =>
  new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'Fecha inválida.', invalidParams: [{ name, reason: 'no es una fecha de calendario' }] });

/** Rutas, flota y horario (contrato: Rutas, Flota, Horario). Solo el ESB, con su token de servicio. */
@Controller()
@UseGuards(ServiceTokenGuard)
export class ScheduleController {
  constructor(@Inject(ScheduleService) private readonly schedule: ScheduleService) {}

  @Get('routes')
  listRoutes() {
    return this.schedule.listRoutes();
  }

  @Post('routes')
  async createRoute(@Body() body: ScheduledRouteRequestDto, @Query() query: CreateRouteQuery, @ActorId() actor: string, @Res({ passthrough: true }) response: Response) {
    const route = await this.schedule.createRoute(body, actor, query.restoreRouteId);
    response.location(`/routes/${route.routeId}`);
    return route;
  }

  @Get('routes/:routeId')
  getRoute(@Param('routeId') routeId: string) {
    return this.schedule.getRoute(routeId);
  }

  @Put('routes/:routeId')
  updateRoute(@Param('routeId') routeId: string, @Body() body: RouteChangeRequestDto, @ActorId() actor: string) {
    return this.schedule.updateRoute(routeId, body.route, body.soldSeats, actor);
  }

  @Delete('routes/:routeId')
  @HttpCode(204)
  async deleteRoute(@Param('routeId') routeId: string, @Query() query: SoldSeatsQuery, @ActorId() _actor: string) {
    await this.schedule.deleteRoute(routeId, query.soldSeats);
  }

  @Get('aircraft-types')
  aircraftTypes() {
    return this.schedule.listAircraftTypes();
  }

  @Get('aircraft')
  listAircraft() {
    return this.schedule.listAircraft();
  }

  @Post('aircraft')
  async createAircraft(@Body() body: AircraftRequestDto, @ActorId() actor: string, @Res({ passthrough: true }) response: Response) {
    const plane = await this.schedule.createAircraft(body, actor);
    response.location(`/aircraft/${plane.registration}`);
    return plane;
  }

  @Get('aircraft/:registration')
  getAircraft(@Param('registration') registration: string) {
    return this.schedule.getAircraft(registration);
  }

  @Put('aircraft/:registration')
  updateAircraft(@Param('registration') registration: string, @Body() body: UpdateAircraftRequestDto, @ActorId() actor: string) {
    return this.schedule.updateAircraft(registration, body.base, actor);
  }

  @Delete('aircraft/:registration')
  @HttpCode(204)
  async deleteAircraft(@Param('registration') registration: string, @ActorId() _actor: string) {
    await this.schedule.deleteAircraft(registration);
  }

  @Get('timetable')
  timetable(@Query() query: TimetableQuery) {
    if (!TimetableQuery.valid(query)) throw invalidDate('from/to');
    return this.schedule.timetable(query.from, query.to, query.routeId);
  }

  @Get('fleet-schedule')
  fleetSchedule(@Query() query: DateQuery) {
    if (!DateQuery.valid(query)) throw invalidDate('date');
    return this.schedule.fleetSchedule(query.date);
  }
}

/** Precios por clase y acuerdo de promociones (contrato: Precios, Promociones). */
@Controller()
@UseGuards(ServiceTokenGuard)
export class PricingController {
  constructor(
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(PromotionsService) private readonly promotions: PromotionsService,
  ) {}

  @Get('fare-prices')
  table() {
    return this.pricing.table();
  }

  @Put('fare-prices')
  save(@Body() body: SaveFarePricesDto, @ActorId() actor: string) {
    return this.pricing.save(body.items, actor);
  }

  @Get('fare-prices/reference')
  reference() {
    return this.pricing.reference();
  }

  @Get('fare-prices/history')
  history(@Query() query: HistoryQuery) {
    return this.pricing.history(query.limit, query.cursor);
  }

  @Get('promotion-agreements/:partnerId')
  getAgreement(@Param('partnerId') partnerId: string) {
    return this.promotions.get(partnerId);
  }

  @Put('promotion-agreements/:partnerId')
  saveAgreement(@Param('partnerId') partnerId: string, @Body() body: PromotionAgreementDto, @ActorId() actor: string) {
    if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(partnerId)) {
      throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'partnerId inválido.', invalidParams: [{ name: 'partnerId', reason: 'mayúsculas, dígitos y guion bajo' }] });
    }
    if (!PromotionAgreementDto.valid(body)) throw invalidDate('vigencia_hasta');
    return this.promotions.save(partnerId, body, actor);
  }
}
