import { timingSafeEqual } from 'node:crypto';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Body, type CanActivate, Controller, type ExecutionContext, Get, Headers, HttpCode, Inject, Injectable, Param, Post, Res, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ProblemDetailsException } from '@ecoairlines/shared';
import { RateLimiter } from '@ecoairlines/shared/respuesta/http-security.js';
import { PAYMENT_API_CONFIG, type PaymentApiConfig } from '../config.js';
import { PaymentsService, type Result } from '../services/payments.service.js';

// ------------------------------------------------------------------------------------------------------- DTOs del contrato

class MoneyAmountDto {
  @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
  @IsString() @Matches(/^[0-9]+\.[0-9]{2}$/) total!: string;
}

/** `CardRequest`: el número y el CVV solo existen durante esta petición (nunca se guardan ni se registran). */
class CardRequestDto {
  @IsString() @MinLength(2) @MaxLength(60) holderName!: string;
  @IsString() @Matches(/^[0-9]{13,19}$/) number!: string;
  @IsInt() @Min(1) @Max(12) expMonth!: number;
  @IsInt() @Min(2026) @Max(2050) expYear!: number;
  @IsString() @Matches(/^[0-9]{3,4}$/) cvv!: string;
}

class AuthorizePaymentDto {
  @IsString() @Matches(/^pm_[A-Za-z0-9]{12,32}$/) paymentMethodToken!: string;
  @ValidateNested() @Type(() => MoneyAmountDto) amount!: MoneyAmountDto;
  @IsOptional() @IsString() @MaxLength(120) description?: string;
}

class CaptureDto {
  @IsString() @MinLength(1) @MaxLength(64) orderId!: string;
  @IsIn(['BOOKING', 'SEATS', 'BAGGAGE', 'DATE_CHANGE']) operation!: 'BOOKING' | 'SEATS' | 'BAGGAGE' | 'DATE_CHANGE';
  @ValidateNested() @Type(() => MoneyAmountDto) expectedAmount!: MoneyAmountDto;
}

class RefundDto {
  @IsString() @Matches(/^pay_[A-Za-z0-9]{12,32}$/) paymentReference!: string;
  @ValidateNested() @Type(() => MoneyAmountDto) amount!: MoneyAmountDto;
  @IsIn(['CUSTOMER_REQUEST', 'FLIGHT_CANCELLED', 'SAGA_COMPENSATION', 'OTHER']) reason!: 'CUSTOMER_REQUEST' | 'FLIGHT_CANCELLED' | 'SAGA_COMPENSATION' | 'OTHER';
  @IsOptional() @IsString() @MaxLength(64) orderId?: string;
}

// ------------------------------------------------------------------------------------------------------------------- claves

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /^pay_[A-Za-z0-9]{12,32}$/;

/** Comparación en tiempo constante (la duración no revela cuántos caracteres coinciden). */
const sameKey = (given: string | undefined, expected: string) => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
const unauthorized = (title: string) => new ProblemDetailsException({ status: 401, code: 'UNAUTHORIZED', title });

type Access = 'browser' | 'browser-unlimited' | 'esb';
const ACCESS = 'payment-api:access';
const Access = (access: Access) => SetMetadata(ACCESS, access);

/**
 * Claves de la pasarela, ANTES de validar el cuerpo (sin la clave correcta no se informa nada del formato): el navegador usa la
 * pública `pk_test_…` (`X-Api-Key`) con un límite de intentos por IP; el ESB, la secreta `sk_test_…` (`Authorization: Bearer`).
 * La clave pública en una operación del ESB → `401`.
 */
@Injectable()
export class PaymentKeysGuard implements CanActivate {
  private readonly limiter = new RateLimiter(60_000);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PAYMENT_API_CONFIG) private readonly config: PaymentApiConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const access = this.reflector.get<Access | undefined>(ACCESS, context.getHandler());
    const request = context.switchToHttp().getRequest<Request>();
    if (access === 'esb') {
      const header = request.header('authorization');
      if (!sameKey(header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined, this.config.secretKey)) throw unauthorized('Se requiere la clave secreta (Authorization: Bearer sk_test_…).');
      return true;
    }
    if (!sameKey(request.header('x-api-key'), this.config.publishableKey)) throw unauthorized('Falta la clave pública (X-Api-Key) o no es válida.');
    if (access === 'browser') {
      const wait = this.limiter.hit(`ip:${request.ip}`, this.config.browserLimitPerMinute);
      if (wait !== undefined) throw new ProblemDetailsException({ status: 429, code: 'RATE_LIMIT_EXCEEDED', title: 'Demasiados intentos desde esta IP.', detail: `Reintente en ${wait} s.`, retryAfterSeconds: wait });
    }
    return true;
  }
}

/** Operaciones de la Payment API (contract/payment-api.openapi.yaml). */
@Controller()
@UseGuards(PaymentKeysGuard)
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  private static idempotencyKey(value: string | undefined): string {
    if (!value || !UUID.test(value)) throw new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'Falta Idempotency-Key o no es un UUID.', invalidParams: [{ name: 'Idempotency-Key', reason: 'UUID obligatorio' }] });
    return value.toLowerCase();
  }

  private static reference(value: string): string {
    // Una referencia con otro formato no existe (no se informa más).
    if (!REFERENCE.test(value)) throw new ProblemDetailsException({ status: 404, code: 'PAYMENT_NOT_FOUND', title: 'Pago no encontrado.' });
    return value;
  }

  private static send(response: Response, result: Result<unknown>) {
    response.status(result.status);
    if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  // ------------------------------------------------------------------------------------------------------------- navegador
  @Get('test-cards')
  @Access('browser-unlimited')
  testCards() {
    return this.payments.testCards();
  }

  @Post('payment-methods')
  @HttpCode(201)
  @Access('browser')
  async tokenize(@Body() body: CardRequestDto, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.payments.tokenize(body);
  }

  @Post('payments')
  @Access('browser')
  async authorize(@Headers('idempotency-key') key: string | undefined, @Body() body: AuthorizePaymentDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.payments.authorize(PaymentsController.idempotencyKey(key), body);
    response.setHeader('Cache-Control', 'no-store');
    if (result.status === 201) response.location(`/payments/${(result.body as { paymentReference: string }).paymentReference}`);
    return PaymentsController.send(response, result);
  }

  // ------------------------------------------------------------------------------------------------------------------- ESB
  @Get('payments/:paymentReference')
  @Access('esb')
  get(@Param('paymentReference') reference: string) {
    return this.payments.get(PaymentsController.reference(reference));
  }

  @Post('payments/:paymentReference/capture')
  @HttpCode(200)
  @Access('esb')
  capture(@Param('paymentReference') reference: string, @Body() body: CaptureDto) {
    return this.payments.capture(PaymentsController.reference(reference), body);
  }

  @Post('payments/:paymentReference/void')
  @HttpCode(200)
  @Access('esb')
  void(@Param('paymentReference') reference: string) {
    return this.payments.void(PaymentsController.reference(reference));
  }

  @Post('refunds')
  @Access('esb')
  async refund(@Headers('idempotency-key') key: string | undefined, @Body() body: RefundDto, @Res({ passthrough: true }) response: Response) {
    return PaymentsController.send(response, await this.payments.refund(PaymentsController.idempotencyKey(key), body));
  }
}
