import { type ArgumentsHost, Body, Catch, Controller, type ExceptionFilter, Get, HttpCode, Inject, Post, Req, Res, UseFilters } from '@nestjs/common';
import type { Request, Response } from 'express';
import { currentCorrelation } from '@ecoairlines/shared';
import { AccountsService } from '../services/accounts.service.js';
import { OAuthError, PartnersService } from '../services/partners.service.js';
import { TokensService } from '../services/tokens.service.js';
import { LoginDto, RegisterDto } from './dto.js';

const clientIp = (request: Request): string => request.ip ?? request.socket.remoteAddress ?? 'desconocida';

/** Registro, login y clave pública (contrato: Autenticación). Sin token: los llama el ESB por la ruta pública. */
@Controller()
export class AuthController {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(TokensService) private readonly tokens: TokensService,
  ) {}

  @Post('auth/register')
  async register(@Body() body: RegisterDto, @Req() request: Request) {
    this.accounts.checkAttempts(`ip:${clientIp(request)}`);
    return this.accounts.register(body);
  }

  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Req() request: Request) {
    this.accounts.checkAttempts(`ip:${clientIp(request)}`);
    return this.accounts.login(body);
  }

  @Get('.well-known/jwks.json')
  jwks(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'public, max-age=3600');
    return this.tokens.jwks();
  }
}

/** Errores de `/oauth2/token` con el formato de OAuth2 (RFC 6749 §5.2) en lugar de ProblemDetails. */
@Catch(OAuthError)
export class OAuthErrorFilter implements ExceptionFilter {
  catch(exception: OAuthError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    if (exception.basicAuth) response.setHeader('WWW-Authenticate', 'Basic realm="ecoairlines"');
    response.status(exception.getStatus()).json({
      error: exception.error,
      error_description: exception.description,
      correlation_id: currentCorrelation()?.correlationId,
      timestamp: new Date().toISOString(),
    });
  }
}

/** Token `client_credentials` para partners y para el ESB (contrato: OAuth2; D29, D41). */
@Controller('oauth2')
@UseFilters(OAuthErrorFilter)
export class OAuthController {
  constructor(@Inject(PartnersService) private readonly partners: PartnersService) {}

  // Cuerpo sin DTO a propósito: el ValidationPipe global no lo toca y los errores salen en formato OAuth2.
  @Post('token')
  @HttpCode(200)
  async token(@Body() body: Record<string, unknown> | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    if (!request.is('application/x-www-form-urlencoded')) {
      throw new OAuthError('invalid_request', 'El cuerpo debe ser application/x-www-form-urlencoded.');
    }
    return this.partners.issueToken(body ?? {}, request.header('authorization'));
  }
}
