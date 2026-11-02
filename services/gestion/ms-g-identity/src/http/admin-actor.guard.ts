import { type CanActivate, createParamDecorator, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ProblemDetailsException, type RequestWithToken } from '@ecoairlines/shared';
import { AccountsService } from '../services/accounts.service.js';

type RequestWithActor = RequestWithToken & { actorSub?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Va después de ServiceTokenGuard en las operaciones de administración (D41): `X-Actor-Id` debe ser el `sub` de un ADMIN
 * activo en esta base. El ESB ya validó el token del usuario; esto evita que un ESB con un error actúe en nombre de un
 * cliente o de un administrador bloqueado después de emitido su token.
 */
@Injectable()
export class AdminActorGuard implements CanActivate {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithActor>();
    const actor = request.header('x-actor-id');
    if (!actor || !UUID.test(actor) || !(await this.accounts.isActiveAdmin(actor))) {
      throw new ProblemDetailsException({ status: 403, code: 'FORBIDDEN', title: 'X-Actor-Id no corresponde a un administrador activo.' });
    }
    request.actorSub = actor.toLowerCase();
    return true;
  }
}

/** `sub` del administrador validado por AdminActorGuard. */
export const ActorSub = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  return context.switchToHttp().getRequest<RequestWithActor>().actorSub!;
});
