import { type CanActivate, createParamDecorator, type ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemDetailsException } from '../problem-details/problem-details.js';
import { RemoteJwks, scopesOf, type TokenClaims, verifyJwt } from './jwt.js';

/**
 * Guard de los MS.G (D41): solo acepta el token de servicio del ESB (`token_use = service`, scope `ecoairlines:internal`).
 * Un token de usuario o de partner responde 403; sin token o con uno inválido, 401. Cada servicio provee
 * `TOKEN_VERIFIER` (Identity con sus propias claves; los demás con `RemoteJwks`).
 *
 * El ESB usa el mismo guard con `ACCEPTED_SERVICE_SCOPES` = `ecoairlines:internal` o `ecoairlines:esb` (D44): este último lo
 * tienen los MS de respuesta, y un MS.G lo rechaza (un MS de respuesta no puede saltarse el ESB).
 */
export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');
export const INTERNAL_SCOPE = 'ecoairlines:internal';
/** Scope del token de servicio de los MS de respuesta (D44): solo lo acepta el ESB. */
export const ESB_CALLER_SCOPE = 'ecoairlines:esb';
/** Scopes de servicio que acepta el guard (cualquiera de ellos). Sin este proveedor: solo `ecoairlines:internal`. */
export const ACCEPTED_SERVICE_SCOPES = Symbol('ACCEPTED_SERVICE_SCOPES');

export interface TokenVerifier {
  /** Devuelve los claims o lanza si el token no es válido. */
  verify(token: string): Promise<TokenClaims>;
}

export type RequestWithToken = Request & { token?: TokenClaims };

export function bearerToken(request: Request): string | undefined {
  const header = request.header('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7).trim() || undefined : undefined;
}

@Injectable()
export class ServiceTokenGuard implements CanActivate {
  private readonly scopes: readonly string[];

  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Optional() @Inject(ACCEPTED_SERVICE_SCOPES) scopes?: readonly string[],
  ) {
    this.scopes = scopes ?? [INTERNAL_SCOPE];
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithToken>();
    const token = bearerToken(request);
    if (!token) throw new ProblemDetailsException({ status: 401, code: 'UNAUTHORIZED', title: 'Se requiere el token de servicio del ESB.' });
    let claims: TokenClaims;
    try {
      claims = await this.verifier.verify(token);
    } catch {
      throw new ProblemDetailsException({ status: 401, code: 'UNAUTHORIZED', title: 'El token no es válido o venció.' });
    }
    if (claims.token_use !== 'service' || !scopesOf(claims).some((scope) => this.scopes.includes(scope))) {
      throw new ProblemDetailsException({ status: 403, code: 'FORBIDDEN', title: this.scopes.includes(ESB_CALLER_SCOPE) ? 'Solo los MS de respuesta pueden llamar al ESB.' : 'Solo el ESB puede llamar a este servicio.' });
    }
    request.token = claims;
    return true;
  }
}

/**
 * TOKEN_VERIFIER de los MS.G que no son Identity: verifica con la JWKS de Identity. La URL llega por configuración
 * (`IDENTITY_JWKS_URL`), nunca escrita en el código: un MS.G no nombra a otro (prueba de arquitectura, regla 4).
 */
export class JwksTokenVerifier implements TokenVerifier {
  private readonly jwks: RemoteJwks;

  constructor(
    url: string,
    private readonly options: { issuer: string; audience: string },
  ) {
    this.jwks = new RemoteJwks(url);
  }

  async verify(token: string): Promise<TokenClaims> {
    const kid = (() => {
      try {
        return (JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as { kid?: string }).kid;
      } catch {
        return undefined;
      }
    })();
    const key = kid ? await this.jwks.key(kid) : undefined;
    return verifyJwt(token, () => key, this.options);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `X-Actor-Id` de las operaciones que cambian datos (auditoría: `updated_by`, `changed_by`). Lo envía solo el ESB, con el
 * `sub` del administrador; si falta o no es un UUID → 400 VALIDATION_FAILED.
 */
export const ActorId = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const actor = context.switchToHttp().getRequest<Request>().header('x-actor-id');
  if (!actor || !UUID.test(actor)) {
    throw new ProblemDetailsException({
      status: 400,
      code: 'VALIDATION_FAILED',
      title: 'Falta X-Actor-Id (sub del administrador) o no es un UUID.',
      invalidParams: [{ name: 'X-Actor-Id', reason: 'debe ser un UUID' }],
    });
  }
  return actor.toLowerCase();
});
