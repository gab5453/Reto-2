import { All, Controller, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ServiceTokenGuard } from '@ecoairlines/shared';
import type { IdempotentResult } from '../transversal/idempotency.service.js';
import { RouterService } from '../router/router.service.js';
import { callerOf } from './caller.js';

type RawRequest = Request & { rawBody?: Buffer };

/** Devuelve la respuesta del MS.G (o la guardada, con `Idempotent-Replayed: true`). */
function send(response: Response, result: IdempotentResult): void {
  response.status(result.status);
  for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
  if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
  response.send(result.body);
}

/**
 * Enrutador del ESB (`contract/esb.openapi.yaml`): `/router/<servicio><ruta del MS.G>` para los MS.G REST y
 * `POST /router/offers/<Rpc>` para MS.G.Offers (gRPC). Solo lo llaman los MS de respuesta, con token de servicio.
 */
@Controller('router')
@UseGuards(ServiceTokenGuard)
export class RouterController {
  constructor(@Inject(RouterService) private readonly router: RouterService) {}

  @Post('offers/:rpc')
  async offers(@Param('rpc') rpc: string, @Req() request: RawRequest, @Res() response: Response): Promise<void> {
    send(response, await this.router.offers(rpc, { body: request.rawBody ?? Buffer.alloc(0), caller: callerOf(request), idempotencyKey: request.header('idempotency-key'), instance: request.originalUrl.split('?')[0] }));
  }

  @All(':service/*path')
  async rest(@Param('service') service: string, @Req() request: RawRequest, @Res() response: Response): Promise<void> {
    const prefix = `/router/${service}`;
    const path = request.originalUrl.slice(request.originalUrl.indexOf(prefix) + prefix.length);
    send(
      response,
      await this.router.rest(service, {
        method: request.method,
        path,
        body: request.rawBody ?? Buffer.alloc(0),
        contentType: request.header('content-type'),
        caller: callerOf(request),
        idempotencyKey: request.header('idempotency-key'),
        instance: request.originalUrl.split('?')[0],
      }),
    );
  }
}
