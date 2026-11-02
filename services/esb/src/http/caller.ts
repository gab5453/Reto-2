import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemDetailsException } from '@ecoairlines/shared';
import type { Caller } from '../clients/rest.client.js';

/**
 * Mismas formas que validan los MS.G (D29): `sub` (UUID) del usuario web, `partner:<clientId>:<X-User-Id>` (reservas y holds de
 * un usuario de Booking) o `partner:<clientId>` (lo que es del partner completo, como sus suscripciones de webhooks).
 */
const OWNER = /^([0-9a-f-]{36}|partner:[A-Z][A-Z0-9_]{2,39}(:[\x21-\x7E]{1,120})?)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (name: string, reason: string) =>
  new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'Cabecera inválida.', invalidParams: [{ name, reason }] });

/** `X-Owner-Id` y `X-Actor-Id` que calculó el MS de respuesta a partir del token (nunca del cuerpo). El ESB los reenvía tal cual. */
export function callerOf(request: Request): Caller {
  const ownerId = request.header('x-owner-id') || undefined;
  const actorId = request.header('x-actor-id') || undefined;
  if (ownerId !== undefined && !OWNER.test(ownerId)) throw invalid('X-Owner-Id', 'sub, partner:<clientId> o partner:<clientId>:<X-User-Id>');
  if (actorId !== undefined && !UUID.test(actorId)) throw invalid('X-Actor-Id', 'debe ser un UUID');
  return { ...(ownerId ? { ownerId } : {}), ...(actorId ? { actorId: actorId.toLowerCase() } : {}) };
}

export const CallerContext = createParamDecorator((_: unknown, context: ExecutionContext): Caller => callerOf(context.switchToHttp().getRequest<Request>()));
