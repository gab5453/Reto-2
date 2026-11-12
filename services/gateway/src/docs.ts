import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import type { ContractFiles } from '@ecoairlines/shared/respuesta/index.js';
import { DOCS_PATH } from './http.js';
import { GROUP_CONTRACT } from './rest/routes.js';

export const DOCS_JSON_PATH = `${DOCS_PATH}/openapi.json`;

/**
 * El contrato v2 del grupo tal cual (D26), con un solo cambio **en memoria**: se antepone este gateway (`/api/v2`, relativo al
 * origen) a `servers` para que «Try it out» funcione. El archivo nunca se modifica y los servidores originales se conservan.
 */
export function contractDocument(files: ContractFiles): Record<string, unknown> {
  const contract = structuredClone(files.doc(GROUP_CONTRACT)) as Record<string, unknown> & { servers?: { url: string; description?: string }[] };
  contract.servers = [{ url: '/api/v2', description: 'Este gateway (agregado al publicar; no forma parte del contrato)' }, ...(contract.servers ?? [])];
  return contract;
}

/** Swagger UI en `/api/docs` y el documento en `/api/docs/openapi.json` (PLAN.md §4.4). */
export function setupDocs(app: NestExpressApplication, files: ContractFiles): void {
  const document = contractDocument(files);
  (app.getHttpAdapter().getInstance()).get(DOCS_JSON_PATH, (_req: Request, res: Response) => {
    res.json(document);
  });
  app.use(
    DOCS_PATH,
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      customSiteTitle: 'EcoAirlines — Contrato de Vuelos v2',
      swaggerOptions: { url: DOCS_JSON_PATH, persistAuthorization: false, displayRequestDuration: true },
    }),
  );
}
