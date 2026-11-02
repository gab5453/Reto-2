import type { LoggerService } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import type { NextFunction, Request, Response } from 'express';
import { currentCorrelation } from '../correlation/correlation.js';

/**
 * Logs estructurados: una línea JSON por evento, siempre con `service`, `correlation_id` y `request_id`.
 * Nunca registran cabeceras, bodies ni query strings (tokens, tarjetas, datos de salud, documentos): CLAUDE.md, datos
 * sensibles. Las claves sensibles que lleguen en un objeto se reemplazan por "[REDACTADO]".
 */
const SENSITIVE_KEYS = /authorization|password|secret|token|card|cvv|assistance|notes|document|email|phone/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SENSITIVE_KEYS.test(key) ? '[REDACTADO]' : redact(item, depth + 1)]),
  );
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<Level, SeverityNumber> = { debug: SeverityNumber.DEBUG, info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR };

function write(service: string, level: Level, fields: Record<string, unknown>): void {
  const correlation = currentCorrelation();
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    service,
    correlation_id: correlation?.correlationId,
    request_id: correlation?.requestId,
    trace_id: trace.getActiveSpan()?.spanContext().traceId,
    ...fields,
  };
  const line = JSON.stringify(record);
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  // V2.16: la misma línea a la plataforma de observabilidad (Loki, por OTLP). Los campos simples van como atributos para
  // buscar por `correlation_id`; sin OTEL_EXPORTER_OTLP_ENDPOINT no hay proveedor de logs y esto no hace nada.
  const attributes: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' || typeof value === 'number') attributes[key] = value;
  }
  logs.getLogger(service).emit({ severityNumber: SEVERITY[level], severityText: level.toUpperCase(), body: line, attributes });
}

/** Logger de NestJS en JSON (se activa con `app.useLogger`). */
export class JsonLogger implements LoggerService {
  constructor(private readonly service: string) {}

  log(message: unknown, context?: string): void {
    write(this.service, 'info', { context, message: redact(message) });
  }
  warn(message: unknown, context?: string): void {
    write(this.service, 'warn', { context, message: redact(message) });
  }
  error(message: unknown, stackOrContext?: string, context?: string): void {
    write(this.service, 'error', { context: context ?? stackOrContext, message: redact(message) });
  }
  debug(message: unknown, context?: string): void {
    if (process.env['LOG_LEVEL'] === 'debug') write(this.service, 'debug', { context, message: redact(message) });
  }
  verbose(message: unknown, context?: string): void {
    this.debug(message, context);
  }
}

/**
 * Una línea por petición con los campos de `api_request_logs` del contrato v2 (§6): correlation_id, request_id, service,
 * operation, status, latency_ms y timestamp. `operation` es el método + la ruta declarada (sin valores ni query).
 */
export function createRequestLogMiddleware(service: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    // El contexto se toma al LLEGAR la petición: algunas librerías (p. ej. `soap`) terminan la respuesta fuera de él.
    const correlation = currentCorrelation();
    res.on('finish', () => {
      const route = (req as Request & { route?: { path?: string } }).route?.path;
      const operation = `${req.method} ${route ? `${req.baseUrl}${route}` : (req.originalUrl.split('?')[0] ?? '')}`;
      const status = res.statusCode;
      write(service, status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', {
        ...(correlation ? { correlation_id: correlation.correlationId, request_id: correlation.requestId } : {}),
        type: 'api_request',
        operation,
        status,
        latency_ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
      });
    });
    next();
  };
}

export const requestLogEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env['HTTP_REQUEST_LOG'] !== undefined ? env['HTTP_REQUEST_LOG'] === 'true' : env['NODE_ENV'] !== 'test';
