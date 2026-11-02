import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import formatsModule from 'ajv-formats';
import { load } from 'js-yaml';

/**
 * Carga `contract/vuelos-openapi-v2.yaml` (fuente de verdad, D26) y valida respuestas contra él:
 * status documentado, Content-Type, schema (con `$ref`, `nullable`, formatos y `additionalProperties`) y las reglas
 * transversales del contrato (X-Correlation-Id §6, ProblemDetails §11, Location en los 201).
 */

type JsonSchema = Record<string, unknown>;
export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface MediaObject {
  schema: JsonSchema;
  example?: unknown;
}
interface ResponseObject {
  $ref?: string;
  description?: string;
  headers?: Record<string, unknown>;
  content?: Record<string, MediaObject>;
}
interface ParameterObject {
  $ref?: string;
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema?: JsonSchema;
  example?: unknown;
}
interface OperationObject {
  operationId: string;
  'x-microservice': string;
  security?: Record<string, string[]>[];
  parameters?: ParameterObject[];
  requestBody?: { content: Record<string, MediaObject> };
  responses: Record<string, ResponseObject>;
}
interface OpenApiDocument {
  paths: Record<string, Record<string, OperationObject>>;
  components: {
    schemas: Record<string, JsonSchema>;
    responses: Record<string, ResponseObject>;
    parameters: Record<string, ParameterObject>;
  };
}

export interface ContractOperation {
  operationId: string;
  microservice: string;
  method: Method;
  path: string;
  isPublic: boolean;
  scopes: string[];
  parameters: ParameterObject[];
  operation: OperationObject;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_PATH = resolve(HERE, '../../../contract/vuelos-openapi-v2.yaml');
export const contract = load(readFileSync(CONTRACT_PATH, 'utf8')) as OpenApiDocument;

const METHODS: Method[] = ['get', 'post', 'put', 'patch', 'delete'];

function resolveParameter(parameter: ParameterObject): ParameterObject {
  return parameter.$ref ? contract.components.parameters[parameter.$ref.split('/').at(-1)!]! : parameter;
}

export function resolveResponse(response: ResponseObject): ResponseObject {
  return response.$ref ? contract.components.responses[response.$ref.split('/').at(-1)!]! : response;
}

/** Las 30 operaciones del contrato, indexadas por operationId. */
export const operations: ReadonlyMap<string, ContractOperation> = new Map(
  Object.entries(contract.paths).flatMap(([path, item]) =>
    METHODS.filter((method) => item[method]).map((method) => {
      const operation = item[method]!;
      const security = operation.security ?? [{ PartnerOAuth2: [] }];
      return [
        operation.operationId,
        {
          operationId: operation.operationId,
          microservice: operation['x-microservice'],
          method,
          path,
          isPublic: security.length === 0,
          scopes: security.flatMap((requirement) => Object.values(requirement).flat()),
          parameters: (operation.parameters ?? []).map(resolveParameter),
          operation,
        },
      ] as const;
    }),
  ),
);

export function operation(operationId: string): ContractOperation {
  const found = operations.get(operationId);
  if (!found) throw new Error(`La operación ${operationId} no existe en el contrato v2`);
  return found;
}

// ---------------------------------------------------------------------------------------------------------- Ajv

// ajv-formats es CommonJS con `export default`: en ESM llega como módulo o como función según el cargador.
const addFormats = ((formatsModule as unknown as { default?: unknown }).default ?? formatsModule) as (ajv: Ajv) => Ajv;
export const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
/**
 * OpenAPI 3.0: una propiedad `writeOnly` (el `secret` de un webhook) solo es obligatoria al ENVIARLA, nunca en una respuesta.
 * Ajv no lo sabe: se quita de `required` (aquí solo se validan respuestas y ejemplos).
 */
function withoutWriteOnlyRequired(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutWriteOnlyRequired);
  if (!node || typeof node !== 'object') return node;
  const copy = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, withoutWriteOnlyRequired(value)])) as JsonSchema;
  const properties = copy['properties'] as Record<string, { writeOnly?: boolean }> | undefined;
  if (Array.isArray(copy['required']) && properties) copy['required'] = (copy['required'] as string[]).filter((name) => !properties[name]?.writeOnly);
  return copy;
}
ajv.addSchema({ $id: 'contract', components: { schemas: withoutWriteOnlyRequired(contract.components.schemas) } });

const LOCAL_REF = /"#\/components\/schemas\//g;
const validators = new Map<string, ValidateFunction>();

/** Compila un schema del contrato (sus `$ref` locales apuntan al documento registrado como `contract`). */
export function compile(key: string, schema: JsonSchema): ValidateFunction {
  let validator = validators.get(key);
  if (!validator) {
    validator = ajv.compile(JSON.parse(JSON.stringify(schema).replace(LOCAL_REF, '"contract#/components/schemas/')) as JsonSchema);
    validators.set(key, validator);
  }
  return validator;
}

// ------------------------------------------------------------------------------------------------- validación

export interface ConformanceResponse {
  operationId: string;
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
  /** X-Correlation-Id enviado (null si la prueba no lo envió). */
  sentCorrelationId: string | null;
  elapsedMs: number;
}

/** Errores de conformidad de una respuesta (lista vacía = conforme). */
export function conformanceErrors(response: ConformanceResponse): string[] {
  const op = operation(response.operationId);
  const label = `${op.method.toUpperCase()} ${op.path} → ${response.status}`;
  const errors: string[] = [];

  const documented = op.operation.responses[String(response.status)];
  if (!documented) {
    return [`${label}: el status no está documentado (documentados: ${Object.keys(op.operation.responses).join(', ')})`];
  }
  const resolved = resolveResponse(documented);

  // §6: toda respuesta devuelve X-Correlation-Id; si se envió, sin cambios.
  const correlation = response.headers.get('x-correlation-id');
  if (!correlation) errors.push(`${label}: falta la cabecera X-Correlation-Id (contrato §6)`);
  else if (response.sentCorrelationId && correlation !== response.sentCorrelationId) {
    errors.push(`${label}: X-Correlation-Id cambió (enviado ${response.sentCorrelationId}, devuelto ${correlation})`);
  }

  const [mediaType, media] = Object.entries(resolved.content ?? {})[0] ?? [];
  if (!mediaType || !media) {
    if (response.text) errors.push(`${label}: el contrato no documenta body y la respuesta trae uno`);
  } else {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes(mediaType)) errors.push(`${label}: Content-Type ${contentType}, se esperaba ${mediaType}`);
    const validate = compile(`${response.operationId} ${response.status}`, media.schema);
    if (!validate(response.body)) {
      errors.push(`${label}: el body no cumple el schema:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`);
    }
    // §6 y §11: todo error lleva correlation_id (igual a la cabecera) y timestamp.
    if (mediaType === 'application/problem+json') {
      const problem = response.body as { correlation_id?: string; timestamp?: string };
      if (!problem.correlation_id) errors.push(`${label}: ProblemDetails sin correlation_id (contrato §6)`);
      else if (correlation && problem.correlation_id !== correlation) errors.push(`${label}: correlation_id distinto de la cabecera`);
      if (!problem.timestamp) errors.push(`${label}: ProblemDetails sin timestamp (contrato §11)`);
    }
  }

  // Location en los 201 que la documentan (hold y reserva): ruta /api/v2/vuelos/...
  if (resolved.headers?.['Location'] !== undefined) {
    const location = response.headers.get('location');
    if (!location?.includes('/api/v2/vuelos/')) errors.push(`${label}: falta Location con la ruta /api/v2/vuelos/...`);
  }
  return errors;
}
