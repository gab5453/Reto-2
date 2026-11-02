import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';

/**
 * Correlation ID del contrato de Vuelos v2 (§6) y decisión D31 de PLAN.md:
 * - `X-Correlation-Id` identifica TODO el proceso de negocio. Lo crea el gateway de Booking (o el primer servicio si no
 *   llega) y se propaga SIN CAMBIOS por HTTP, gRPC, SOAP y RabbitMQ. Se devuelve en toda respuesta.
 * - `X-Request-Id` identifica UN salto. Se conserva el recibido si es válido; si no, este servicio crea uno.
 * - `trace_id` es el de OpenTelemetry: distinto de los dos anteriores. El correlation ID viaja como atributo del span.
 */
export const CORRELATION_HEADER = 'X-Correlation-Id';
export const REQUEST_ID_HEADER = 'X-Request-Id';
/** Nombre de la metadata gRPC y del atributo de los spans y logs. */
export const CORRELATION_KEY = 'x-correlation-id';
export const REQUEST_ID_KEY = 'x-request-id';

/** Hasta 100 caracteres visibles (contrato: maxLength 100); sin espacios ni caracteres de control, para no ensuciar logs. */
const VALID_ID = /^[\x21-\x7E]{1,100}$/;

export interface CorrelationContext {
  correlationId: string;
  requestId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export const newCorrelationId = (): string => `corr-${randomUUID()}`;
export const newRequestId = (): string => `req-${randomUUID()}`;
export const isValidId = (value: string | undefined): value is string => value !== undefined && VALID_ID.test(value);

/** Contexto de la petición en curso (undefined fuera de una petición, p. ej. en un proceso de fondo). */
export function currentCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

/** Ejecuta `fn` con un contexto de correlación (para consumidores de RabbitMQ, gRPC o tareas de fondo). */
export function runWithCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  trace.getActiveSpan()?.setAttribute('correlation_id', context.correlationId);
  return storage.run(context, fn);
}

/**
 * Middleware Express: lee o crea los dos identificadores, los devuelve en la respuesta y los deja disponibles en
 * `currentCorrelation()` durante toda la petición. Un X-Correlation-Id inválido no se cambia en silencio: se responde
 * 400 (con uno nuevo en la cabecera) para que el llamador lo corrija.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  const invalid = incoming !== undefined && !isValidId(incoming);
  const context: CorrelationContext = {
    correlationId: incoming !== undefined && !invalid ? incoming : newCorrelationId(),
    requestId: isValidId(req.header(REQUEST_ID_HEADER)) ? req.header(REQUEST_ID_HEADER)! : newRequestId(),
  };
  res.setHeader(CORRELATION_HEADER, context.correlationId);
  res.setHeader(REQUEST_ID_HEADER, context.requestId);
  runWithCorrelation(context, () => {
    if (invalid) {
      res
        .status(400)
        .contentType('application/problem+json')
        .json({
          type: 'about:blank',
          title: 'El encabezado X-Correlation-Id no es válido.',
          status: 400,
          code: 'VALIDATION_FAILED',
          instance: req.originalUrl.split('?')[0],
          correlation_id: context.correlationId,
          timestamp: new Date().toISOString(),
          invalidParams: [{ name: CORRELATION_HEADER, reason: 'hasta 100 caracteres visibles, sin espacios' }],
        });
      return;
    }
    next();
  });
}

// ------------------------------------------------------------------------------------- propagación hacia otros servicios

function outgoing(): CorrelationContext {
  const current = currentCorrelation();
  return { correlationId: current?.correlationId ?? newCorrelationId(), requestId: newRequestId() };
}

/** Cabeceras HTTP para una llamada saliente: el mismo X-Correlation-Id y un X-Request-Id nuevo para ese salto. */
export function correlationHeaders(): Record<string, string> {
  const { correlationId, requestId } = outgoing();
  return { [CORRELATION_HEADER]: correlationId, [REQUEST_ID_HEADER]: requestId };
}

/** Pares de metadata gRPC (`x-correlation-id`, `x-request-id`); se agregan con `metadata.set(key, value)`. */
export function correlationMetadata(): [string, string][] {
  const { correlationId, requestId } = outgoing();
  return [
    [CORRELATION_KEY, correlationId],
    [REQUEST_ID_KEY, requestId],
  ];
}

/** Propiedades AMQP de un mensaje: `correlation_id` y la cabecera `x-request-id` (events.asyncapi.yaml). */
export function correlationAmqpProperties(): { correlationId: string; headers: Record<string, string> } {
  const { correlationId, requestId } = outgoing();
  return { correlationId, headers: { [REQUEST_ID_KEY]: requestId } };
}

/** Bloques de `<soap:Header>` de MS.G.PostSale (ms-g-post-sale.wsdl): CorrelationId y RequestId en el namespace de tipos. */
export function correlationSoapHeaders(namespace: string): string {
  const { correlationId, requestId } = outgoing();
  const escape = (value: string) => value.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return (
    `<corr:CorrelationId xmlns:corr="${namespace}">${escape(correlationId)}</corr:CorrelationId>` +
    `<corr:RequestId xmlns:corr="${namespace}">${escape(requestId)}</corr:RequestId>`
  );
}
