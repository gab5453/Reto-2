import type { KeyObject } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { publicJwk, signJwt, type TokenClaims, type TokenVerifier, verifyJwt } from '@ecoairlines/shared';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config/config.js';
import { type PartnerRecord, RESPONSE_CLIENT_IDS, RESPONSE_SCOPE, type ResponseClientId, type UserRecord } from '../domain/model.js';

/** Cliente interno del ESB (D41): solo de semilla, nunca aparece en /partners. */
export const ESB_CLIENT_ID = 'ECOAIRLINES_ESB';
export const ESB_SCOPE = 'ecoairlines:internal';

/** Identificadores reservados: no se pueden dar de alta como partners. */
export const INTERNAL_CLIENT_IDS: readonly string[] = [ESB_CLIENT_ID, ...RESPONSE_CLIENT_IDS];
export { RESPONSE_CLIENT_IDS, RESPONSE_SCOPE, type ResponseClientId };

/**
 * Emite los tres tipos de token (contrato de Identity, "Tokens emitidos"), todos RS256 con `kid`, y publica la JWKS.
 * También es el TOKEN_VERIFIER de Identity: verifica con sus propias claves, sin llamarse por red.
 */
@Injectable()
export class TokensService implements TokenVerifier {
  constructor(@Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig) {}

  private sign(claims: Pick<TokenClaims, 'sub' | 'token_use' | 'scope' | 'name' | 'email' | 'role'>) {
    return signJwt(claims, this.config.signingKey, {
      issuer: this.config.issuer,
      audience: this.config.audience,
      ttlSeconds: this.config.tokenTtlSeconds,
    });
  }

  issueUserToken(user: UserRecord, scopes: string[]) {
    const { token } = this.sign({ sub: user.sub, token_use: 'user', scope: scopes.join(' '), name: user.fullName, email: user.email, role: user.role });
    return {
      access_token: token,
      token_type: 'Bearer' as const,
      expires_in: this.config.tokenTtlSeconds,
      scope: scopes.join(' '),
      user: { sub: user.sub, fullName: user.fullName, email: user.email, role: user.role },
    };
  }

  issuePartnerToken(partner: Pick<PartnerRecord, 'clientId' | 'name'>, scopes: string[]) {
    const { token } = this.sign({ sub: partner.clientId, token_use: 'partner', scope: scopes.join(' '), name: partner.name });
    return { access_token: token, token_type: 'Bearer' as const, expires_in: this.config.tokenTtlSeconds, scope: scopes.join(' ') };
  }

  /** Token de servicio del ESB (`ecoairlines:internal`, D41) o de un MS de respuesta (`ecoairlines:esb`, D44). */
  issueServiceToken(clientId: string = ESB_CLIENT_ID, scope: string = ESB_SCOPE) {
    const { token } = this.sign({ sub: clientId, token_use: 'service', scope });
    return { access_token: token, token_type: 'Bearer' as const, expires_in: this.config.tokenTtlSeconds, scope };
  }

  /** Clave vigente + las anteriores de una rotación (RFC 7517). Nunca incluye la parte privada. */
  jwks() {
    return { keys: [this.config.signingKey, ...this.config.previousPublicKeys].map((key) => publicJwk(key)) };
  }

  async verify(token: string): Promise<TokenClaims> {
    const keys = new Map<string, KeyObject>(
      [this.config.signingKey, ...this.config.previousPublicKeys].map((key) => [publicJwk(key).kid, key]),
    );
    return verifyJwt(token, (kid) => keys.get(kid), { issuer: this.config.issuer, audience: this.config.audience });
  }
}
