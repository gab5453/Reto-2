import { HttpException, Inject, Injectable } from '@nestjs/common';
import { ProblemDetailsException } from '@ecoairlines/shared';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config/config.js';
import { type AccountStatus, type PartnerRecord, toPartner } from '../domain/model.js';
import { grantedScopes, resolvePartnerScopes } from '../domain/rules.js';
import { decodeCursor, IDENTITY_REPOSITORY, type IdentityRepository } from '../repositories/identity.repository.js';
import { AttemptLimiter, hashSecret, newClientSecret, verifySecret } from './security.js';
import { ESB_CLIENT_ID, ESB_SCOPE, INTERNAL_CLIENT_IDS, RESPONSE_CLIENT_IDS, RESPONSE_SCOPE, type ResponseClientId, TokensService } from './tokens.service.js';

/** Error de OAuth2 (RFC 6749 §5.2): el único formato de error que no es ProblemDetails (contrato, `/oauth2/token`). */
export class OAuthError extends HttpException {
  constructor(
    readonly error: 'invalid_request' | 'invalid_client' | 'unsupported_grant_type' | 'invalid_scope',
    readonly description: string,
    status = error === 'invalid_client' ? 401 : 400,
    readonly basicAuth = false,
  ) {
    super({ error, error_description: description }, status);
  }
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  method: 'basic' | 'post';
}

/** Partners (sistemas B2B) y token `client_credentials` (contrato: Partners y OAuth2; D29, D41). */
@Injectable()
export class PartnersService {
  private readonly limiter: AttemptLimiter;
  private esbSecretHash?: Promise<string>;
  private readonly responseSecretHashes = new Map<string, Promise<string>>();

  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly repository: IdentityRepository,
    @Inject(TokensService) private readonly tokens: TokensService,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {
    this.limiter = new AttemptLimiter(config.attemptsPerMinute);
  }

  /** Lee las credenciales de `Authorization: Basic` o del cuerpo (RFC 6749 §2.3.1); las dos a la vez es un error. */
  static credentials(authorization: string | undefined, body: Record<string, unknown>): ClientCredentials {
    const inBody = body['client_id'] !== undefined || body['client_secret'] !== undefined;
    if (authorization?.startsWith('Basic ')) {
      if (inBody) throw new OAuthError('invalid_request', 'Las credenciales del cliente llegaron en la cabecera y en el cuerpo.');
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const invalid = new OAuthError('invalid_client', 'Credenciales del cliente inválidas.', 401, true);
      if (separator < 1) throw invalid;
      try {
        // RFC 6749 §2.3.1: el id y el secreto van codificados como formulario antes de base64.
        return { clientId: decodeURIComponent(decoded.slice(0, separator)), clientSecret: decodeURIComponent(decoded.slice(separator + 1)), method: 'basic' };
      } catch {
        throw invalid;
      }
    }
    if (typeof body['client_id'] !== 'string' || typeof body['client_secret'] !== 'string') {
      throw new OAuthError('invalid_client', 'Faltan las credenciales del cliente.', 401);
    }
    return { clientId: body['client_id'], clientSecret: body['client_secret'], method: 'post' };
  }

  async issueToken(body: Record<string, unknown>, authorization: string | undefined) {
    const allowed = new Set(['grant_type', 'scope', 'client_id', 'client_secret']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) throw new OAuthError('invalid_request', `Parámetros no permitidos: ${unknown.join(', ')}.`);
    if (body['grant_type'] === undefined) throw new OAuthError('invalid_request', 'Falta grant_type.');
    if (body['grant_type'] !== 'client_credentials') throw new OAuthError('unsupported_grant_type', 'Solo se admite grant_type=client_credentials.');
    if (body['scope'] !== undefined && (typeof body['scope'] !== 'string' || !/^[a-z:]+( [a-z:]+)*$/.test(body['scope']) || body['scope'].length > 200)) {
      throw new OAuthError('invalid_request', 'scope debe ser una lista de scopes separados por espacio.');
    }
    const credentials = PartnersService.credentials(authorization, body);
    const wait = this.limiter.hit(`client:${credentials.clientId}`);
    if (wait !== undefined) {
      throw new ProblemDetailsException({ status: 429, code: 'RATE_LIMIT_EXCEEDED', title: 'Demasiados intentos. Espere un minuto.', retryAfterSeconds: wait });
    }
    const requested = body['scope'];
    const invalidClient = () => new OAuthError('invalid_client', 'Credenciales del cliente inválidas.', 401, credentials.method === 'basic');

    // Cliente interno del ESB (D41): solo de semilla y fuera de la tabla de partners.
    if (credentials.clientId === ESB_CLIENT_ID) {
      this.esbSecretHash ??= hashSecret(this.config.esbClientSecret);
      if (!(await verifySecret(credentials.clientSecret, await this.esbSecretHash))) throw invalidClient();
      if (grantedScopes([ESB_SCOPE], requested) === undefined) throw new OAuthError('invalid_scope', `El cliente solo tiene ${ESB_SCOPE}.`);
      return this.tokens.issueServiceToken();
    }

    // Clientes internos de los MS de respuesta (D44): solo de semilla; su token solo lo acepta el ESB.
    if ((RESPONSE_CLIENT_IDS as readonly string[]).includes(credentials.clientId)) {
      const clientId = credentials.clientId as ResponseClientId;
      if (!this.responseSecretHashes.has(clientId)) this.responseSecretHashes.set(clientId, hashSecret(this.config.responseClientSecrets[clientId]));
      if (!(await verifySecret(credentials.clientSecret, await this.responseSecretHashes.get(clientId)))) throw invalidClient();
      if (grantedScopes([RESPONSE_SCOPE], requested) === undefined) throw new OAuthError('invalid_scope', `El cliente solo tiene ${RESPONSE_SCOPE}.`);
      return this.tokens.issueServiceToken(clientId, RESPONSE_SCOPE);
    }

    const partner = await this.repository.findPartner(credentials.clientId);
    // Inexistente, secreto incorrecto o bloqueado: la misma respuesta (no revela qué partners existen).
    if (!(await verifySecret(credentials.clientSecret, partner?.secretHash)) || !partner || partner.status !== 'ACTIVE') throw invalidClient();
    const scopes = grantedScopes(partner.scopes, requested);
    if (!scopes) throw new OAuthError('invalid_scope', 'El cliente pidió un scope que no tiene.');
    await this.repository.touchPartnerToken(partner.clientId, new Date().toISOString());
    return this.tokens.issuePartnerToken(partner, scopes);
  }

  async create(input: { clientId: string; name: string; scopes?: string[] }, actorSub: string | null) {
    const scopes = resolvePartnerScopes(input.scopes);
    if (INTERNAL_CLIENT_IDS.includes(input.clientId)) {
      throw new ProblemDetailsException({ status: 409, code: 'PARTNER_ALREADY_EXISTS', title: 'Ya existe un partner con ese identificador.' });
    }
    const clientSecret = newClientSecret();
    const partner: PartnerRecord = {
      clientId: input.clientId,
      name: input.name.trim(),
      secretHash: await hashSecret(clientSecret),
      scopes,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      createdBy: actorSub,
      secretRotatedAt: null,
      lastTokenAt: null,
    };
    if (!(await this.repository.insertPartner(partner))) {
      throw new ProblemDetailsException({ status: 409, code: 'PARTNER_ALREADY_EXISTS', title: 'Ya existe un partner con ese identificador.' });
    }
    return { ...toPartner(partner), clientSecret };
  }

  /** Partner de semilla con un secreto conocido (BOOKING_CLIENT_SECRET); si existe, se actualiza el secreto y los scopes. */
  async upsertSeedPartner(input: { clientId: string; name: string; secret: string; scopes: string[] }) {
    const scopes = resolvePartnerScopes(input.scopes);
    const existing = await this.repository.findPartner(input.clientId);
    const secretHash = await hashSecret(input.secret);
    if (existing) {
      await this.repository.updatePartner({ ...existing, name: input.name, scopes, secretHash });
      return;
    }
    await this.repository.insertPartner({
      clientId: input.clientId,
      name: input.name,
      secretHash,
      scopes,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      createdBy: null,
      secretRotatedAt: null,
      lastTokenAt: null,
    });
  }

  async list(status: AccountStatus | undefined, limit: number, cursor?: string) {
    const page = await this.repository.listPartners(status, limit, decodeCursor(cursor));
    return { items: page.items.map(toPartner), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async get(clientId: string) {
    return toPartner(await this.require(clientId));
  }

  async changeStatus(clientId: string, status: AccountStatus, actorSub: string) {
    const partner = await this.require(clientId);
    if (partner.status === status) return toPartner(partner);
    return toPartner(this.found(await this.repository.patchPartner(clientId, { status, updatedAt: new Date().toISOString(), updatedBy: actorSub })));
  }

  /** El secreto anterior deja de servir de inmediato; el nuevo se devuelve una sola vez. */
  async rotateSecret(clientId: string, actorSub: string) {
    await this.require(clientId);
    const clientSecret = newClientSecret();
    const now = new Date().toISOString();
    const updated = await this.repository.patchPartner(clientId, { secretHash: await hashSecret(clientSecret), secretRotatedAt: now, updatedAt: now, updatedBy: actorSub });
    return { ...toPartner(this.found(updated)), clientSecret };
  }

  private async require(clientId: string): Promise<PartnerRecord> {
    return this.found(await this.repository.findPartner(clientId));
  }

  private found(partner: PartnerRecord | undefined): PartnerRecord {
    if (!partner) throw ProblemDetailsException.notFound('Partner no encontrado.', 'PARTNER_NOT_FOUND');
    return partner;
  }
}
