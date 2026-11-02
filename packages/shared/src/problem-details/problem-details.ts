import { STATUS_CODES } from 'node:http';
import { HttpException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { currentCorrelation } from '../correlation/correlation.js';

/**
 * ProblemDetails del contrato de Vuelos v2 (RFC 7807, §11): `type`, `title`, `status`, `code` obligatorios; `detail`,
 * `instance`, `correlation_id`, `timestamp` e `invalidParams`. Los códigos del contrato se usan tal cual; cada servicio
 * agrega los suyos (los contratos internos `ms-g-*.openapi.yaml` los enumeran) y el ESB los traduce a los públicos.
 */
export const CONTRACT_PROBLEM_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMIT_EXCEEDED',
  'IDEMPOTENCY_KEY_REUSED',
  'INTERNAL_ERROR',
  'PROVIDER_UNAVAILABLE',
  'OFFER_NO_LONGER_AVAILABLE',
  'HOLD_EXPIRED',
  'HOLD_ALREADY_CONSUMED',
  'SEAT_TAKEN',
  'SEAT_CABIN_MISMATCH',
  'INFANT_SEAT_NOT_ALLOWED',
  'INFANT_WITHOUT_ADULT',
  'PASSENGER_COUNT_MISMATCH',
  'DOCUMENT_EXPIRED',
  'PASSPORT_REQUIRED_INTERNATIONAL',
  'PAYMENT_REFERENCE_INVALID',
  'PAYMENT_NOT_AUTHORIZED',
  'AMOUNT_MISMATCH',
  'PNR_CREATION_FAILED',
  'BOOKING_NOT_CONFIRMED',
  'TICKET_ISSUANCE_FAILED',
  'TICKET_ALREADY_ISSUED',
  'BAGGAGE_LIMIT_EXCEEDED',
  'FARE_NOT_CHANGEABLE',
  'CHANGE_OFFER_EXPIRED',
  'QUOTE_EXPIRED',
  'ALREADY_CANCELLED',
  'BOOKING_NOT_CANCELLABLE',
  'CUTOFF_PASSED',
  'CHECK_IN_NOT_AVAILABLE',
  'CHECK_IN_FAILED',
  'BOARDING_PASS_NOT_AVAILABLE',
  'FLIGHT_ALREADY_DEPARTED',
  'FLIGHT_CANCELLED',
  'FLIGHT_STATUS_NOT_AVAILABLE',
  'INVALID_STATUS_TRANSITION',
  'PROMOTION_DISCOUNT_OUT_OF_RANGE',
] as const;

export type ContractProblemCode = (typeof CONTRACT_PROBLEM_CODES)[number];
/** Código del contrato o uno propio del servicio (en MAYÚSCULAS_CON_GUION_BAJO). */
export type ProblemCode = ContractProblemCode | (string & {});

export interface InvalidParam {
  name: string;
  reason: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail?: string;
  instance?: string;
  correlation_id?: string;
  timestamp?: string;
  invalidParams?: InvalidParam[];
}

export interface ProblemOptions {
  status: number;
  code: ProblemCode;
  title: string;
  detail?: string;
  type?: string;
  invalidParams?: InvalidParam[];
  /** Segundos para la cabecera Retry-After (409, 429, 503). */
  retryAfterSeconds?: number;
}

/** Error de negocio con la forma de ProblemDetails. `instance`, `correlation_id` y `timestamp` los completa el filtro. */
export class ProblemDetailsException extends HttpException {
  readonly problem: Omit<ProblemDetails, 'instance' | 'correlation_id' | 'timestamp'>;
  readonly retryAfterSeconds?: number;

  constructor(options: ProblemOptions) {
    const problem = {
      type: options.type ?? 'about:blank',
      title: options.title,
      status: options.status,
      code: options.code,
      ...(options.detail ? { detail: options.detail } : {}),
      ...(options.invalidParams?.length ? { invalidParams: options.invalidParams } : {}),
    };
    super(problem, options.status);
    this.problem = problem;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  static notFound(title: string, code: ProblemCode = 'NOT_FOUND'): ProblemDetailsException {
    return new ProblemDetailsException({ status: 404, code, title });
  }
}

/** Código genérico del contrato para un status HTTP sin código específico. */
export function genericCode(status: number): ContractProblemCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMIT_EXCEEDED';
  if (status === 503) return 'PROVIDER_UNAVAILABLE';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'VALIDATION_FAILED';
}

/** Completa un ProblemDetails con `instance`, `correlation_id` y `timestamp` (contrato §6 y §11). */
export function completeProblem(problem: Omit<ProblemDetails, 'instance' | 'correlation_id' | 'timestamp'>, instance: string): ProblemDetails {
  return {
    ...problem,
    title: problem.title || STATUS_CODES[problem.status] || 'Error',
    instance,
    correlation_id: currentCorrelation()?.correlationId,
    timestamp: new Date().toISOString(),
  };
}

function flatten(errors: ValidationError[], parent = ''): InvalidParam[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((reason) => ({ name: path, reason }));
    return [...own, ...(error.children?.length ? flatten(error.children, path) : [])];
  });
}

/** `exceptionFactory` del ValidationPipe: 400 VALIDATION_FAILED con cada violación en `invalidParams`. */
export function validationExceptionFactory(errors: ValidationError[]): ProblemDetailsException {
  return new ProblemDetailsException({
    status: 400,
    code: 'VALIDATION_FAILED',
    title: 'La petición no cumple con las reglas de validación.',
    invalidParams: flatten(errors),
  });
}
