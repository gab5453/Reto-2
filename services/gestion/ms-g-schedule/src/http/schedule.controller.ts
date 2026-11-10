import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ActorId, ProblemDetailsException, ServiceTokenGuard } from '@ecoairlines/shared';
import { AircraftTypesService } from '../services/aircraft-types.service.js';
import { AirportsService } from '../services/airports.service.js';
import { PricingService } from '../services/pricing.service.js';
import { PromotionsService } from '../services/promotions.service.js';
import { ScheduleService } from '../services/schedule.service.js';
import {
  AircraftRequestDto,
  AircraftTypeRequestDto,
  CreateAircraftTypeRequestDto,
  AirportRequestDto,
  CreateAirportRequestDto,
  CreateRouteQuery,
  DateQuery,
  HistoryQuery,
  PromotionAgreementDto,
  RouteChangeRequestDto,
  SaveFarePricesDto,
  SavePricingDto,
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

  @Get('pricing')
  pricingSettings() {
    return this.pricing.pricing();
  }

  @Put('pricing')
  savePricing(@Body() body: SavePricingDto, @ActorId() actor: string) {
    return this.pricing.savePricing(body, actor);
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

const quarterHour = (minutes: number) => {
  if (minutes % 15 !== 0) {
    throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'Huso horario inválido.', invalidParams: [{ name: 'utcOffsetMinutes', reason: 'múltiplo de 15 minutos' }] });
  }
};
const iataParam = (code: string) => {
  if (!/^[A-Z]{3}$/.test(code)) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'Código inválido.', invalidParams: [{ name: 'code', reason: '3 letras mayúsculas' }] });
};

/** Catálogo de aeropuertos (M-1; contrato: Aeropuertos). */
@Controller('airports')
@UseGuards(ServiceTokenGuard)
export class AirportsController {
  constructor(@Inject(AirportsService) private readonly airports: AirportsService) {}

  @Get()
  list() {
    return this.airports.list();
  }

  @Post()
  async create(@Body() body: CreateAirportRequestDto, @ActorId() actor: string, @Res({ passthrough: true }) response: Response) {
    quarterHour(body.utcOffsetMinutes);
    const { code, ...input } = body;
    const airport = await this.airports.create(code, input, actor);
    response.location(`/airports/${airport.code}`);
    return airport;
  }

  @Get(':code')
  get(@Param('code') code: string) {
    iataParam(code);
    return this.airports.get(code);
  }

  @Put(':code')
  update(@Param('code') code: string, @Body() body: AirportRequestDto, @ActorId() actor: string) {
    iataParam(code);
    quarterHour(body.utcOffsetMinutes);
    return this.airports.update(code, body, actor);
  }

  @Delete(':code')
  @HttpCode(204)
  async remove(@Param('code') code: string, @ActorId() _actor: string) {
    iataParam(code);
    await this.airports.delete(code);
  }
}

/** Catálogo de tipos de avión (M-2; contrato: Flota). El nombre va en la ruta codificado («Airbus%20A320neo»). */
@Controller('aircraft-types')
@UseGuards(ServiceTokenGuard)
export class AircraftTypesController {
  constructor(@Inject(AircraftTypesService) private readonly types: AircraftTypesService) {}

  @Get()
  list() {
    return this.types.list();
  }

  @Post()
  async create(@Body() body: CreateAircraftTypeRequestDto, @ActorId() actor: string, @Res({ passthrough: true }) response: Response) {
    const { aircraftType, ...input } = body;
    const created = await this.types.create(aircraftType.trim(), { ...input, maxRouteKm: input.maxRouteKm ?? null }, actor);
    response.location(`/aircraft-types/${encodeURIComponent(created.aircraftType)}`);
    return created;
  }

  @Put(':aircraftType')
  update(@Param('aircraftType') aircraftType: string, @Body() body: AircraftTypeRequestDto, @ActorId() actor: string) {
    return this.types.update(aircraftType, { ...body, maxRouteKm: body.maxRouteKm ?? null }, actor);
  }

  @Delete(':aircraftType')
  @HttpCode(204)
  async remove(@Param('aircraftType') aircraftType: string, @ActorId() _actor: string) {
    await this.types.delete(aircraftType);
  }
}
