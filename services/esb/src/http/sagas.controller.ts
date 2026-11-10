import { randomUUID } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProblemDetailsException, ServiceTokenGuard } from '@ecoairlines/shared';
import type { Caller } from '../clients/rest.client.js';
import { PostSaleComposition } from '../composition/post-sale.composition.js';
import type { SagaStatus, StoredResponse } from '../repositories/esb.store.js';
import { problemResponse } from '../router/router.service.js';
import { SagasService } from '../sagas/sagas.service.js';
import { IdempotencyService } from '../transversal/idempotency.service.js';
import { callerOf } from './caller.js';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type RawRequest = Request & { rawBody?: Buffer };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLIGHT = /^[A-Z0-9]{2}[0-9]{1,4}$/;
const ROUTE = /^EA[0-9]{1,4}-EA[0-9]{1,4}$/;
const STATUSES: SagaStatus[] = ['RUNNING', 'COMPLETED', 'COMPENSATING', 'COMPENSATED', 'FAILED'];
const invalid = (name: string, reason: string) => new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La petición no es válida.', invalidParams: [{ name, reason }] });
const uuid = (value: string, name: string) => {
  if (!UUID.test(value)) throw invalid(name, 'debe ser un UUID');
  return value.toLowerCase();
};
const object = (body: unknown, name = 'body'): Any => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid(name, 'debe ser un objeto JSON');
  return body as Any;
};
const requireOwner = (caller: Caller) => {
  if (!caller.ownerId) throw invalid('X-Owner-Id', 'obligatorio: dueño de la reserva');
  return caller;
};
const requireActor = (caller: Caller) => {
  if (!caller.actorId) throw invalid('X-Actor-Id', 'obligatorio: sub del administrador');
  return caller;
};
const json = (status: number, body: unknown): StoredResponse => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * Orquestador (V2.10, `contract/esb.openapi.yaml`): una operación por saga, con la entrada del contrato v2 ya validada por el
 * MS de respuesta. Toda escritura admite `Idempotency-Key` (D6). También las consultas de postventa, que necesitan Bookings y
 * PostSale. Solo con token de servicio.
 */
@Controller()
@UseGuards(ServiceTokenGuard)
export class SagasController {
  constructor(
    @Inject(SagasService) private readonly sagas: SagasService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(PostSaleComposition) private readonly postSale: PostSaleComposition,
  ) {}

  /** Idempotencia por dueño + clave; el hash incluye método, ruta y cuerpo exacto. */
  private async write(request: RawRequest, response: Response, execute: (caller: Caller, instance: string) => Promise<StoredResponse>): Promise<void> {
    const instance = request.originalUrl.split('?')[0]!;
    let result;
    try {
      const caller = callerOf(request);
      const scope = caller.ownerId ? `owner:${caller.ownerId}` : caller.actorId ? `actor:${caller.actorId}` : 'anonymous';
      const hash = IdempotencyService.hash('saga', request.method, request.originalUrl, request.rawBody ?? Buffer.alloc(0));
      result = await this.idempotency.run(request.header('idempotency-key'), scope, hash, () => execute(caller, instance));
    } catch (error) {
      if (!(error instanceof ProblemDetailsException) || error.problem.status >= 500) throw error;
      result = { ...problemResponse(error, instance), replayed: false };
    }
    response.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
    if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
    response.send(result.body);
  }

  // ------------------------------------------------------------------------------------------------------------ reservas

  @Post('sagas/bookings')
  createBooking(@Req() req: RawRequest, @Res() res: Response, @Body() body: unknown) {
    return this.write(req, res, (caller, instance) => {
      const request = object(body);
      if (typeof request['holdId'] !== 'string' || !UUID.test(request['holdId'])) throw invalid('holdId', 'UUID obligatorio');
      if (!Array.isArray(request['passengers']) || !request['passengers'].length) throw invalid('passengers', 'al menos uno');
      if (!request['payment'] || typeof request['payment']['paymentReference'] !== 'string') throw invalid('payment.paymentReference', 'obligatorio');
      // El bookingId lo genera el ESB al iniciar la saga (Bookings es idempotente por él).
      const bookingId = randomUUID();
      return this.sagas.execute(this.sagas.createBooking, { bookingId, request: request as never }, requireOwner(caller), instance, {
        onCompleted: (_result, sagaId) => this.sagas.bookingResponse(201, bookingId, caller, sagaId),
        onPending: (sagaId) => this.sagas.bookingResponse(202, bookingId, caller, sagaId),
      });
    });
  }

  @Post('sagas/bookings/:bookingId/tickets')
  issueTickets(@Param('bookingId') bookingId: string, @Req() req: RawRequest, @Res() res: Response) {
    return this.write(req, res, (caller, instance) => this.sagas.execute(this.sagas.issueTickets, { bookingId: uuid(bookingId, 'bookingId') }, caller, instance));
  }

  @Put('sagas/bookings/:bookingId/seats')
  changeSeats(@Param('bookingId') bookingId: string, @Req() req: RawRequest, @Res() res: Response, @Body() body: unknown) {
    return this.write(req, res, (caller, instance) => {
      const request = object(body);
      if (!Array.isArray(request['seats']) || !request['seats'].length) throw invalid('seats', 'al menos uno');
      return this.sagas.execute(this.sagas.changeSeats, { bookingId: uuid(bookingId, 'bookingId'), request: request as never }, caller, instance);
    });
  }

  @Post('sagas/bookings/:bookingId/check-in')
  checkIn(@Param('bookingId') bookingId: string, @Req() req: RawRequest, @Res() res: Response) {
    return this.write(req, res, (caller, instance) => this.sagas.execute(this.sagas.checkIn, { bookingId: uuid(bookingId, 'bookingId') }, caller, instance));
  }

  @Post('sagas/bookings/:bookingId/cancel')
  cancel(@Param('bookingId') bookingId: string, @Req() req: RawRequest, @Res() res: Response, @Body() body: unknown) {
    return this.write(req, res, (caller, instance) => {
      const id = uuid(bookingId, 'bookingId');
      const request = body === undefined || body === null || (typeof body === 'object' && !Object.keys(body).length) ? {} : object(body);
      return this.sagas.execute(this.sagas.cancel, { bookingId: id, request: request as never }, caller, instance, {
        onPending: async (sagaId) => json(202, { bookingId: id, status: 'CANCELLATION_PENDING', sagaId }),
      });
    });
  }

  @Post('sagas/bookings/:bookingId/date-change')
  changeDate(@Param('bookingId') bookingId: string, @Req() req: RawRequest, @Res() res: Response, @Body() body: unknown) {
    return this.write(req, res, (caller, instance) => {
      const request = object(body);
      if (typeof request['changeOfferId'] !== 'string') throw invalid('changeOfferId', 'obligatorio');
      return this.sagas.execute(this.sagas.changeDate, { bookingId: uuid(bookingId, 'bookingId'), request: request as never }, caller, instance);
    });
  }

  @Post('sagas/bookings/:bookingId/baggage')
  addBaggage(@Param('bookingId') bookingId: string, @Req() req: RawRequest, @Res() res: Response, @Body() body: unknown) {
    return this.write(req, res, (caller, instance) => {
      const request = object(body);
      if (!Number.isInteger(request['quantity']) || request['quantity'] < 1) throw invalid('quantity', 'entero ≥ 1');
      return this.sagas.execute(this.sagas.addBaggage, { bookingId: uuid(bookingId, 'bookingId'), request: request as never }, caller, instance);
    });
  }

  @Put('sagas/bookings/:bookingId/assistance-ready')
  assistanceReady(@Param('bookingId') bookingId: string, @Req() req: RawRequest, @Res() res: Response, @Body() body: unknown) {
    return this.write(req, res, (caller, instance) => {
      const request = object(body);
      if (typeof request['ready'] !== 'boolean' || typeof request['passengerId'] !== 'string' || typeof request['segmentId'] !== 'string') throw invalid('body', 'passengerId, segmentId y ready');
      return this.sagas.execute(this.sagas.assistanceReady, { bookingId: uuid(bookingId, 'bookingId'), request: request as never }, requireActor(caller), instance);
    });
  }

  // ---------------------------------------------------------------------------------------------------------- operación

  @Patch('sagas/flights/:flightNumber/status')
  flightStatus(@Param('flightNumber') flightNumber: string, @Req() req: RawRequest, @Res() res: Response, @Body() body: unknown) {
    return this.write(req, res, (caller, instance) => {
      if (!FLIGHT.test(flightNumber)) throw invalid('flightNumber', 'p. ej. EA100');
      const request = object(body);
      if (typeof request['date'] !== 'string' || typeof request['status'] !== 'string') throw invalid('body', 'date y status obligatorios');
      return this.sagas.execute(this.sagas.flightStatus, { flightNumber, request: request as never }, requireActor(caller), instance);
    });
  }

  @Put('sagas/fare-prices')
  farePrices(@Req() req: RawRequest, @Res() res: Response, @Body() body: unknown) {
    return this.write(req, res, (caller, instance) => {
      const request = object(body);
      if (!Array.isArray(request['items'])) throw invalid('items', 'obligatorio');
      return this.sagas.execute(this.sagas.savePrices, { kind: 'fare-prices', items: request['items'] }, requireActor(caller), instance);
    });
  }

  /** P-1: tarifa base y/o precio exacto de los paquetes de una ruta (`route.prices` vacío lo quita). */
  @Put('sagas/pricing')
  pricing(@Req() req: RawRequest, @Res() res: Response, @Body() body: unknown) {
    return this.write(req, res, (caller, instance) => {
      const request = object(body);
      const fixedCharge = request['fixedCharge'];
      const perKm = request['perKm'];
      const route = request['route'] as { routeId?: unknown; prices?: unknown } | undefined;
      if (fixedCharge !== undefined && typeof fixedCharge !== 'number') throw invalid('fixedCharge', 'número');
      if (perKm !== undefined && typeof perKm !== 'number') throw invalid('perKm', 'número');
      if (route !== undefined && (typeof route.routeId !== 'string' || !Array.isArray(route.prices))) throw invalid('route', 'routeId y prices');
      if (fixedCharge === undefined && perKm === undefined && route === undefined) throw invalid('body', 'fixedCharge, perKm o route');
      return this.sagas.execute(
        this.sagas.savePrices,
        { kind: 'pricing', ...(fixedCharge !== undefined ? { fixedCharge } : {}), ...(perKm !== undefined ? { perKm } : {}), ...(route ? { route: route as never } : {}) },
        requireActor(caller),
        instance,
      );
    });
  }

  @Put('sagas/promotion-agreements/:partnerId')
  promotionAgreement(@Param('partnerId') partnerId: string, @Req() req: RawRequest, @Res() res: Response, @Body() body: unknown) {
    return this.write(req, res, (caller, instance) => {
      if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(partnerId)) throw invalid('partnerId', 'mayúsculas, dígitos y guion bajo');
      return this.sagas.execute(this.sagas.savePrices, { kind: 'promotion-agreement', partnerId, agreement: object(body) }, requireActor(caller), instance);
    });
  }

  @Post('sagas/routes')
  createRoute(@Req() req: RawRequest, @Res() res: Response, @Body() body: unknown) {
    return this.write(req, res, (caller, instance) => this.sagas.execute(this.sagas.publishTimetable, { action: 'create', route: object(body) }, requireActor(caller), instance, { okStatus: 201 }));
  }

  @Put('sagas/routes/:routeId')
  updateRoute(@Param('routeId') routeId: string, @Req() req: RawRequest, @Res() res: Response, @Body() body: unknown) {
    return this.write(req, res, (caller, instance) => {
      if (!ROUTE.test(routeId)) throw invalid('routeId', 'p. ej. EA100-EA101');
      return this.sagas.execute(this.sagas.publishTimetable, { action: 'update', routeId, route: object(body) }, requireActor(caller), instance);
    });
  }

  @Delete('sagas/routes/:routeId')
  deleteRoute(@Param('routeId') routeId: string, @Req() req: RawRequest, @Res() res: Response) {
    return this.write(req, res, (caller, instance) => {
      if (!ROUTE.test(routeId)) throw invalid('routeId', 'p. ej. EA100-EA101');
      return this.sagas.execute(this.sagas.publishTimetable, { action: 'delete', routeId }, requireActor(caller), instance);
    });
  }

  @Post('sagas/timetable/publish')
  publishAll(@Req() req: RawRequest, @Res() res: Response) {
    return this.write(req, res, (caller, instance) => this.sagas.execute(this.sagas.publishTimetable, { action: 'publish-all' }, requireActor(caller), instance));
  }

  // ------------------------------------------------------------------------------------------------- estado de las sagas

  @Get('sagas/:sagaId')
  async saga(@Param('sagaId') sagaId: string, @Req() req: Request) {
    const caller = callerOf(req);
    const record = await this.sagas.engine.saga(uuid(sagaId, 'sagaId'));
    // Solo su dueño o un administrador la ve; para otro dueño no existe.
    if (!record || (!caller.actorId && record.ownerId !== (caller.ownerId ?? null))) throw ProblemDetailsException.notFound('Saga no encontrada.');
    return SagasService.view(record);
  }

  @Get('sagas')
  async list(@Req() req: Request, @Query('status') status?: string, @Query('type') type?: string, @Query('parentSagaId') parentSagaId?: string, @Query('limit') limit?: string) {
    requireActor(callerOf(req));
    if (status !== undefined && !STATUSES.includes(status as SagaStatus)) throw invalid('status', STATUSES.join(', '));
    const size = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > 200) throw invalid('limit', 'entre 1 y 200');
    const items = await this.sagas.engine.listSagas({ ...(status ? { status: status as SagaStatus } : {}), ...(type ? { type } : {}), ...(parentSagaId ? { parentSagaId: uuid(parentSagaId, 'parentSagaId') } : {}), limit: size });
    return { items: items.map(SagasService.view) };
  }

  // ------------------------------------------------------------------------------------------------ consultas de postventa

  @Get('composition/bookings/:bookingId/cancellation-quote')
  cancellationQuote(@Param('bookingId') bookingId: string, @Req() req: Request) {
    return this.postSale.cancellationQuote(uuid(bookingId, 'bookingId'), callerOf(req));
  }

  @Get('composition/bookings/:bookingId/baggage-options')
  baggageOptions(@Param('bookingId') bookingId: string, @Req() req: Request) {
    return this.postSale.baggageOptions(uuid(bookingId, 'bookingId'), callerOf(req));
  }

  @Post('composition/bookings/:bookingId/date-change/search')
  @HttpCode(200)
  dateChangeSearch(@Param('bookingId') bookingId: string, @Req() req: Request, @Body() body: unknown) {
    return this.postSale.searchDateChange(uuid(bookingId, 'bookingId'), callerOf(req), object(body));
  }
}
