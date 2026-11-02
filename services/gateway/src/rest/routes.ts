import { ContractFiles, loadOperations, type Json, type Operation, OperationTable } from '@ecoairlines/shared/respuesta/index.js';
import { RESPONSE_SERVICES, type ResponseService, SERVICE_INFO } from '../config.js';

/**
 * Tabla cerrada de la fachada REST (PLAN.md §4.4, D26): las **30 operaciones** de `vuelos-openapi-v2.yaml`, cada una hacia el
 * MS de respuesta de su `x-microservice`, más `POST /oauth2/token` (el `tokenUrl` del contrato, en MS.Clientes). Las
 * operaciones propias (`/ecoairlines/...`) **no** se publican en REST: la web las usa por GraphQL (D23).
 *
 * Se arma con los contratos de los 5 MS y, al arrancar, se comprueba contra el contrato del grupo: si falta o sobra una
 * operación, o una apunta a otro MS, el gateway no arranca.
 */
export const GROUP_CONTRACT = 'vuelos-openapi-v2.yaml';
export const PARTNER_TOKEN_OPERATION = 'issuePartnerToken';

export interface RestRoutes {
  table: OperationTable;
  /** operationId → MS de respuesta que la atiende. */
  targets: Map<string, ResponseService>;
}

export function buildRestRoutes(files = new ContractFiles()): RestRoutes {
  const operations: Operation[] = [];
  const targets = new Map<string, ResponseService>();
  for (const service of RESPONSE_SERVICES) {
    for (const operation of loadOperations(SERVICE_INFO[service].contract, files)) {
      if (!operation.fromGroupContract && operation.operationId !== PARTNER_TOKEN_OPERATION) continue;
      if (targets.has(operation.operationId)) throw new Error(`La operación ${operation.operationId} está en dos MS de respuesta.`);
      operations.push(operation);
      targets.set(operation.operationId, service);
    }
  }

  const expected = new Map<string, string>();
  for (const item of Object.values(files.doc(GROUP_CONTRACT)['paths'] as Record<string, Json>)) {
    for (const operation of Object.values(item)) {
      if (operation && typeof operation === 'object' && 'operationId' in operation) {
        expected.set((operation as Json)['operationId'] as string, (operation as Json)['x-microservice'] as string);
      }
    }
  }
  const missing = [...expected.keys()].filter((id) => !targets.has(id));
  const wrong = [...expected].filter(([id, service]) => targets.has(id) && targets.get(id) !== service).map(([id]) => id);
  const extra = [...targets.keys()].filter((id) => !expected.has(id) && id !== PARTNER_TOKEN_OPERATION);
  if (missing.length || wrong.length || extra.length || !targets.has(PARTNER_TOKEN_OPERATION)) {
    throw new Error(`Tabla REST distinta del contrato v2. Faltan: ${missing.join(', ') || '—'}; en otro MS: ${wrong.join(', ') || '—'}; sobran: ${extra.join(', ') || '—'}`);
  }
  return { table: new OperationTable(operations), targets };
}
