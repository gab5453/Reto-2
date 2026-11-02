import { randomInt, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { inject } from 'vitest';
import { type ConformanceResponse, conformanceErrors, operation } from './contract.js';

/**
 * Configuración por variables de entorno. Sin CONFORMANCE_BASE_URL solo corre la autoverificación (sin red).
 *
 *   CONFORMANCE_BASE_URL       URL base del contrato v2, p. ej. http://localhost:8080/api/v2 (gateway) o la pública de Azure
 *   CONFORMANCE_PARTNER_TOKEN  token de partner ya emitido, o en su lugar:
 *   CONFORMANCE_CLIENT_ID / CONFORMANCE_CLIENT_SECRET   credenciales del partner (se pide el token a /oauth2/token)
 *   CONFORMANCE_ADMIN_TOKEN    token de un usuario ADMIN (flights:ops y flights:admin); sin él se omiten esas pruebas
 *   CONFORMANCE_USER_ID        X-User-Id del usuario final simulado (por defecto usr-conformidad)
 *   CONFORMANCE_ROUTE          ruta a buscar, ORIGEN-DESTINO (por defecto UIO-GYE)
 *   CONFORMANCE_DAYS_AHEAD     días hasta el vuelo de prueba (por defecto 20: fuera de la ventana de check-in)
 */
export const config = {
  baseUrl: process.env['CONFORMANCE_BASE_URL']?.replace(/\/$/, '') ?? '',
  partnerToken: process.env['CONFORMANCE_PARTNER_TOKEN'] ?? '',
  clientId: process.env['CONFORMANCE_CLIENT_ID'] ?? '',
  clientSecret: process.env['CONFORMANCE_CLIENT_SECRET'] ?? '',
  adminToken: process.env['CONFORMANCE_ADMIN_TOKEN'] ?? '',
  userId: process.env['CONFORMANCE_USER_ID'] ?? 'usr-conformidad',
  partnerId: process.env['CONFORMANCE_CLIENT_ID'] ?? 'BOOKING_PROTOTIPO',
  route: (process.env['CONFORMANCE_ROUTE'] ?? 'UIO-GYE').split('-') as [string, string],
  daysAhead: Number(process.env['CONFORMANCE_DAYS_AHEAD'] ?? 20),
};

export const live = Boolean(config.baseUrl);
export const hasAdmin = live && Boolean(config.adminToken);

let partnerToken: Promise<string> | undefined;

/** Token de servicio OAuth2 client_credentials (PartnerOAuth2 del contrato), pedido una vez por archivo. */
export function getPartnerToken(): Promise<string> {
  if (config.partnerToken) return Promise.resolve(config.partnerToken);
  partnerToken ??= (async () => {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const response = await fetch(`${config.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!response.ok) throw new Error(`No se obtuvo el token de partner: ${response.status} ${await response.text()}`);
    return ((await response.json()) as { access_token: string }).access_token;
  })();
  return partnerToken;
}

export type Auth = 'partner' | 'admin' | 'none';

export interface CallOptions {
  params?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  auth?: Auth;
  /** UUID; `false` para NO enviarla aunque el contrato la exija. Si no se indica y la operación la exige, se genera. */
  idempotencyKey?: string | false;
  /** `null` para no enviar X-Correlation-Id (el servidor debe crearlo). */
  correlationId?: string | null;
  /** X-User-Id del usuario final (solo con token de partner). */
  userId?: string;
  headers?: Record<string, string>;
}

/** Llama a una operación del contrato por su operationId (método y ruta salen del contrato). */
export async function call(operationId: string, options: CallOptions = {}): Promise<ConformanceResponse> {
  const op = operation(operationId);
  const path = op.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = options.params?.[name];
    if (value === undefined) throw new Error(`${operationId}: falta el parámetro de ruta ${name}`);
    return encodeURIComponent(value);
  });
  const url = new URL(config.baseUrl + path);
  for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));

  const correlationId = options.correlationId === undefined ? `corr-conf-${randomUUID().slice(0, 8)}` : options.correlationId;
  const headers: Record<string, string> = { accept: 'application/json, application/problem+json', 'x-request-id': `req-conf-${randomUUID().slice(0, 8)}` };
  if (correlationId) headers['x-correlation-id'] = correlationId;
  const auth = options.auth ?? (op.isPublic ? 'none' : 'partner');
  if (auth === 'partner') {
    headers['authorization'] = `Bearer ${await getPartnerToken()}`;
    headers['x-user-id'] = options.userId ?? config.userId;
  } else if (auth === 'admin') {
    headers['authorization'] = `Bearer ${config.adminToken}`;
  }
  for (const parameter of op.parameters.filter((p) => p.in === 'header' && p.required)) {
    if (parameter.name === 'Idempotency-Key' && options.idempotencyKey !== false) headers['idempotency-key'] = options.idempotencyKey ?? randomUUID();
    if (parameter.name === 'X-Device-Fingerprint') headers['x-device-fingerprint'] = 'fp-conformidad';
  }
  if (typeof options.idempotencyKey === 'string') headers['idempotency-key'] = options.idempotencyKey;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  Object.assign(headers, options.headers);

  const started = performance.now();
  const response = await fetch(url, {
    method: op.method.toUpperCase(),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const result: ConformanceResponse = {
    operationId,
    status: response.status,
    headers: response.headers,
    text,
    body: text ? safeJson(text) : undefined,
    sentCorrelationId: correlationId,
    elapsedMs: performance.now() - started,
  };
  record(result);
  return result;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Falla con el detalle si la respuesta no cumple el contrato; opcionalmente exige status y `code`. */
export function expectConforms(response: ConformanceResponse, expected?: { status?: number | number[]; code?: string }): void {
  const errors = conformanceErrors(response);
  const statuses = expected?.status === undefined ? undefined : ([] as number[]).concat(expected.status);
  if (statuses && !statuses.includes(response.status)) {
    errors.unshift(`${response.operationId}: status ${response.status}, se esperaba ${statuses.join(' o ')}`);
  }
  if (expected?.code && (response.body as { code?: string } | undefined)?.code !== expected.code) {
    errors.unshift(`${response.operationId}: code ${(response.body as { code?: string })?.code}, se esperaba ${expected.code}`);
  }
  if (errors.length) throw new Error(`${errors.join('\n')}\nBody: ${response.text.slice(0, 1500)}`);
}

// ---------------------------------------------------------------------------------------- cobertura (operación + status)

function record(response: ConformanceResponse): void {
  const dir = inject('coverageDir');
  if (dir) appendFileSync(join(dir, `${process.pid}.log`), `${response.operationId} ${response.status}\n`);
}

// ----------------------------------------------------------------------------------------------------- utilidades

export const newKey = (): string => randomUUID();

/** paymentReference de Booking con el formato supuesto en BKG-02 (PAY-BKP-AAAAMMDD-NNNNNN), único por llamada. */
export function newPaymentReference(): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  // NNNNNN son dígitos (el ESB valida el formato): un UUID en hexadecimal daría letras.
  return `PAY-BKP-${day}-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
}

export function dateInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
