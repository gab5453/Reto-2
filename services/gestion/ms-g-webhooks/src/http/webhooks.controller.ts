import { Type } from 'class-transformer';
import { ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Body, Controller, createParamDecorator, Delete, type ExecutionContext, Get, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ActorId, ProblemDetailsException, ServiceTokenGuard } from '@ecoairlines/shared';
import { PUBLIC_EVENTS, type PublicEventName } from '../domain/rules.js';
import { WebhooksService } from '../services/webhooks.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)$/;

/** `X-Owner-Id` (obligatorio): `partner:<clientId>` del sistema partner o el `sub` de un ADMIN (D29). */
const OwnerId = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const owner = context.switchToHttp().getRequest<Request>().header('x-owner-id');
  if (!owner || owner.length > 200 || !/^(partner:[A-Z][A-Z0-9_]{2,39}|[0-9a-f-]{36})$/.test(owner)) {
    throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'Falta X-Owner-Id o no es válido.', invalidParams: [{ name: 'X-Owner-Id', reason: 'partner:<clientId> o el sub de un ADMIN' }] });
  }
  return owner;
});

/** `WebhookSubscription` del contrato v2 (`secret` solo de escritura). */
class SubscriptionDto {
  @IsString() @MaxLength(500) url!: string;
  @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsIn([...PUBLIC_EVENTS], { each: true }) events!: PublicEventName[];
  @IsString() @MinLength(16) @MaxLength(200) secret!: string;
}

class FeedQuery {
  @IsOptional() @IsString() @MaxLength(100) after?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @IsOptional() @IsIn([...PUBLIC_EVENTS]) type?: PublicEventName;
}

class HistoryQuery {
  @IsOptional() @IsString() @MaxLength(60) type?: string;
  @IsOptional() @IsString() @MaxLength(100) correlationId?: string;
  @IsOptional() @Matches(DATE_TIME) from?: string;
  @IsOptional() @Matches(DATE_TIME) to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
}

/** Operaciones de MS.G.Webhooks. Solo el ESB, con su token de servicio. */
@Controller()
@UseGuards(ServiceTokenGuard)
export class WebhooksController {
  constructor(@Inject(WebhooksService) private readonly webhooks: WebhooksService) {}

  @Get('subscriptions')
  list(@OwnerId() owner: string) {
    return this.webhooks.list(owner);
  }

  @Post('subscriptions')
  async subscribe(@Body() body: SubscriptionDto, @OwnerId() owner: string, @Res({ passthrough: true }) response: Response) {
    const created = await this.webhooks.subscribe(owner, body);
    response.location(`/subscriptions/${created.id}`);
    return created;
  }

  @Delete('subscriptions/:id')
  @HttpCode(204)
  async unsubscribe(@Param('id') id: string, @OwnerId() owner: string) {
    await this.webhooks.unsubscribe(owner, id);
  }

  /** `X-Actor-Id` (opcional): el `sub` del ADMIN que lee su propio feed; sin él, un usuario solo ve sus reservas (V2.13). */
  @Get('events')
  feed(@Query() query: FeedQuery, @OwnerId() owner: string, @Req() request: Request) {
    const actor = request.header('x-actor-id');
    return this.webhooks.feed(owner, query.after, query.limit, query.type, actor && UUID.test(actor) ? actor.toLowerCase() : undefined);
  }

  @Get('history')
  history(@Query() query: HistoryQuery, @ActorId() _actor: string) {
    const { limit, cursor, type, ...filter } = query;
    return this.webhooks.history({ ...filter, ...(type ? { name: type } : {}) }, limit, cursor);
  }

  @Get('stats')
  stats() {
    return this.webhooks.stats();
  }
}
