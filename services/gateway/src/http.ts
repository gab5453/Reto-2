import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { CORS_ALLOWED_HEADERS, CORS_EXPOSED_HEADERS, earlyErrorHandler, type SecurityConfig } from '@ecoairlines/shared/respuesta/index.js';

export const GRAPHQL_PATH = '/api/graphql';
export const DOCS_PATH = '/api/docs';

/**
 * Endurecimiento HTTP del gateway (la única puerta pública): lo mismo que los MS de respuesta (`http-security.ts` de shared),
 * con tres diferencias:
 * - Swagger UI (`/api/docs`) carga sus scripts y estilos del mismo origen: su CSP es la de helmet por defecto; el resto solo
 *   devuelve JSON (`default-src 'none'`).
 * - La fachada REST reenvía el cuerpo **tal cual** (JSON o el formulario de `/oauth2/token`): el MS lo valida contra el
 *   contrato. GraphQL lee JSON.
 * - CORS admite además la cabecera `Apollo-Require-Preflight` (protección CSRF de Apollo para las queries por GET).
 * Debe aplicarse antes de `app.init()`.
 */
export function applyGatewaySecurity(app: NestExpressApplication, config: SecurityConfig): void {
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  const hsts = config.production ? { maxAge: 31_536_000, includeSubDomains: true } : false;
  const apiHelmet = helmet({ contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, strictTransportSecurity: hsts });
  const docsHelmet = helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: config.production ? [] : null } }, strictTransportSecurity: hsts });
  app.use((req: Request, res: Response, next: NextFunction) => (req.path === DOCS_PATH || req.path.startsWith(`${DOCS_PATH}/`) ? docsHelmet : apiHelmet)(req, res, next));
  app.enableCors({
    origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [...CORS_ALLOWED_HEADERS, 'Apollo-Require-Preflight'],
    exposedHeaders: CORS_EXPOSED_HEADERS,
    credentials: false,
    maxAge: 600,
  });
  app.use(GRAPHQL_PATH, express.json({ limit: config.bodyLimit }));
  // Cualquier tipo de contenido: el MS de respuesta decide qué acepta (415/400 según su contrato).
  app.use(['/api/v2', '/oauth2'], express.raw({ type: () => true, limit: config.bodyLimit }));
  app.use(earlyErrorHandler);
}
