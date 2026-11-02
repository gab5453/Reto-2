import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { completeProblem, genericCode, ProblemDetailsException } from './problem-details.js';

/**
 * Convierte cualquier error en un ProblemDetails v2 (`application/problem+json`):
 * - ProblemDetailsException: se responde tal cual (con Retry-After si corresponde).
 * - HttpException de Nest (ruta inexistente, JSON inválido…): código genérico del contrato según el status.
 * - Cualquier otro error: 500 INTERNAL_ERROR sin detalle; el mensaje y el stack solo van al log.
 * Siempre agrega `instance`, `correlation_id` y `timestamp`.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetails');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const instance = request.originalUrl.split('?')[0] ?? request.originalUrl;

    if (response.headersSent) {
      this.logger.error(`${request.method} ${instance} → ${describe(exception)}`);
      return;
    }

    if (exception instanceof ProblemDetailsException) {
      if (exception.retryAfterSeconds !== undefined) response.setHeader('Retry-After', String(exception.retryAfterSeconds));
      send(response, completeProblem(exception.problem, instance));
      return;
    }

    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500) this.logger.error(`${request.method} ${instance} → ${describe(exception)}`);
    send(
      response,
      completeProblem(
        {
          type: 'about:blank',
          title: '',
          status,
          code: genericCode(status),
          ...(status < 500 && exception instanceof HttpException ? { detail: exception.message } : {}),
        },
        instance,
      ),
    );
  }
}

function send(response: Response, body: { status: number }): void {
  response.status(body.status).contentType('application/problem+json').json(body);
}

function describe(exception: unknown): string {
  return exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
}
