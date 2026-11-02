import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { currentCorrelation } from '../correlation/correlation.js';
import { type InvalidParam, ProblemDetailsException } from '../problem-details/problem-details.js';

/**
 * Endurecimiento HTTP de los MS de respuesta: lo mismo que hace hoy `EcoAirlines.API` (`src/security/`), en un solo lugar para
 * los cinco servicios (V2.12).
 */
export interface SecurityConfig {
  production: boolean;
  /** Orígenes CORS permitidos (nunca `*`). La web habla con el gateway; aquí solo para desarrollo. */
  corsOrigins: string[];
  /** `trust proxy` de Express (detrás del gateway: 1). */
  trustProxy: boolean | number | string;
  bodyLimit: string;
  rateLimit: { windowMs: number; limit: number; searchLimit: number; seatmapLimit: number };
}

const positive = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} debe ser un entero positivo.`);
  return parsed;
};

export function loadSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const production = env['NODE_ENV'] === 'production';
  const corsOrigins = (env['CORS_ORIGINS'] ?? (production ? '' : 'http://localhost:5173')).split(',').map((o) => o.trim()).filter(Boolean);
  if (corsOrigins.includes('*')) throw new Error('CORS_ORIGINS no admite "*": declare los orígenes permitidos.');
  const trust = env['TRUST_PROXY'];
  return {
    production,
    corsOrigins,
    trustProxy: trust === undefined || trust === '' || trust === 'false' ? false : trust === 'true' ? true : /^\d+$/.test(trust) ? Number(trust) : trust,
    bodyLimit: env['BODY_LIMIT'] ?? '100kb',
    rateLimit: {
      windowMs: positive(env, 'RATE_LIMIT_TTL_MS', 60_000),
      limit: positive(env, 'RATE_LIMIT_LIMIT', 300),
      searchLimit: positive(env, 'RATE_LIMIT_SEARCH_LIMIT', 30),
      seatmapLimit: positive(env, 'RATE_LIMIT_SEATMAP_LIMIT', 60),
    },
  };
}

/** Cabeceras que un navegador puede enviar (las del contrato) y leer. */
export const CORS_ALLOWED_HEADERS = ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Correlation-Id', 'X-Request-Id', 'X-Device-Fingerprint', 'X-User-Id', 'X-User-Roles'];
export const CORS_EXPOSED_HEADERS = ['Retry-After', 'X-Correlation-Id', 'X-Request-Id', 'Location', 'Idempotent-Replayed'];

function problem(res: Response, status: number, title: string, invalidParams: InvalidParam[], code = 'VALIDATION_FAILED'): void {
  res
    .status(status)
    .contentType('application/problem+json')
    .json({ type: 'about:blank', title, status, code, instance: res.req.originalUrl.split('?')[0], correlation_id: currentCorrelation()?.correlationId, timestamp: new Date().toISOString(), ...(invalidParams.length ? { invalidParams } : {}) });
}

/**
 * Errores de los middlewares de Express (lector de JSON) que ocurren antes de llegar a Nest: se responden como ProblemDetails.
 * Sin esto Express respondería su página HTML (con el stack fuera de producción). También lo usa el gateway (V2.13).
 */
export function earlyErrorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(error);
  const { type, status } = (error ?? {}) as { type?: string; status?: number };
  if (type === 'entity.too.large') return problem(res, 400, 'El cuerpo excede el tamaño máximo permitido.', [{ name: 'body', reason: 'demasiado grande' }]);
  if (type === 'entity.parse.failed') return problem(res, 400, 'El cuerpo no es un JSON válido.', [{ name: 'body', reason: 'JSON mal formado' }]);
  if (status !== undefined && status >= 400 && status < 500) return problem(res, 400, 'La petición no pudo procesarse.', [{ name: 'body', reason: type ?? 'inválida' }]);
  void req;
  next(error);
}

/** Debe aplicarse antes de `app.init()`, para que los middlewares queden delante de las rutas. */
export function applyHttpSecurity(app: INestApplication, config: SecurityConfig): void {
  const express = app as NestExpressApplication;
  express.set('trust proxy', config.trustProxy);
  express.disable('x-powered-by');
  // Solo JSON: no carga recursos ni se deja embeber.
  express.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      strictTransportSecurity: config.production ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  express.enableCors({
    // Sin Origin (servidor a servidor, curl) no es CORS.
    origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    credentials: false,
    maxAge: 600,
  });
  express.useBodyParser('json', { limit: config.bodyLimit });
  // Solo `POST /oauth2/token` (RFC 6749: formulario).
  express.useBodyParser('urlencoded', { extended: false, limit: '16kb' });
  express.use(earlyErrorHandler);
}

// --------------------------------------------------------------------------------------------------------- saneamiento

/** Claves que permiten contaminar prototipos al copiar objetos. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Caracteres de control C0 y DEL, salvo tabulación, salto de línea y retorno de carro. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const invalid = (name: string, reason: string) =>
  new ProblemDetailsException({ status: 400, code: 'VALIDATION_FAILED', title: 'La petición contiene datos no permitidos.', invalidParams: [{ name: name || 'body', reason }] });

/**
 * Saneamiento previo a la validación (como el `SanitizeInputPipe` del monolito): rechaza `__proto__`, `constructor` y
 * `prototype`, rechaza caracteres de control y recorta espacios de los textos. No escapa HTML: eso es de quien presenta.
 */
export function sanitize(value: unknown, path = ''): unknown {
  if (typeof value === 'string') {
    if (CONTROL_CHARACTERS.test(value)) throw invalid(path, 'contiene caracteres de control');
    return value.trim();
  }
  if (Array.isArray(value)) return value.map((item, index) => sanitize(item, `${path}[${index}]`));
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return value;
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const nestedPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEYS.has(key)) throw invalid(nestedPath, 'nombre de propiedad no permitido');
      result[key] = sanitize(nested, nestedPath);
    }
    return result;
  }
  return value;
}

// ------------------------------------------------------------------------------------------------- límite de peticiones

/**
 * Ventana fija en memoria (por instancia, como el monolito). Con varias réplicas el límite es por réplica; un almacenamiento
 * compartido (Redis) quedaría para V2.14 si hiciera falta.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly windowMs: number) {}

  /** Cuenta una petición; devuelve los segundos de espera si se pasó del límite. */
  hit(key: string, limit: number, now = Date.now()): number | undefined {
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
      if (this.windows.size > 50_000) this.sweep(now);
    }
    window.count++;
    return window.count > limit ? Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000)) : undefined;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (now - window.start >= this.windowMs) this.windows.delete(key);
  }
}
