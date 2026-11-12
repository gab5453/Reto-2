import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

/**
 * Contrato OpenAPI de un MS de respuesta (V2.12), leído en tiempo de ejecución desde `contract/`: el servicio atiende
 * EXACTAMENTE las operaciones de su contrato (método, ruta, parámetros, cuerpo, respuestas y seguridad). Los `$ref` entre
 * archivos (`./vuelos-openapi-v2.yaml#/paths/...`) se siguen: las 30 operaciones del grupo son idénticas por construcción.
 *
 * Cada schema se identifica por su ubicación (`archivo#puntero`), que es lo que compila Ajv (ver `validation.ts`).
 */
export type Json = Record<string, unknown>;

export interface SchemaRef {
  file: string;
  pointer: string;
}

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  schema: SchemaRef;
}

export interface Operation {
  operationId: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Ruta del contrato, p. ej. `/vuelos/bookings/{bookingId}` (sin `/api/v2`). */
  path: string;
  /** Archivo donde está definida (el del grupo para las 30 del contrato v2). */
  file: string;
  parameters: Parameter[];
  requestBody?: { required: boolean; content: Record<string, SchemaRef | undefined> };
  /** Status → schema JSON de la respuesta (si tiene cuerpo JSON). */
  responses: Record<string, SchemaRef | undefined>;
  /** Requisitos de seguridad (OR entre elementos; `{}` = sin autenticación). */
  security: Record<string, string[]>[];
  /** La operación es del contrato del grupo (`vuelos-openapi-v2.yaml`). */
  fromGroupContract: boolean;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Busca `contract/` subiendo desde este módulo (en el repositorio y en la imagen Docker, que copia `contract/`). */
export function findContractDir(from = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'contract', 'vuelos-openapi-v2.yaml'))) return join(dir, 'contract');
  }
  throw new Error('No se encontró la carpeta contract/');
}

const escape = (part: string) => part.replace(/~/g, '~0').replace(/\//g, '~1');
const unescape = (part: string) => part.replace(/~1/g, '/').replace(/~0/g, '~');

/** Documentos YAML del contrato cargados una vez, y navegación por `$ref` (archivo + puntero JSON). */
export class ContractFiles {
  private readonly docs = new Map<string, Json>();

  constructor(readonly dir = findContractDir()) {}

  doc(file: string): Json {
    let doc = this.docs.get(file);
    if (!doc) {
      doc = load(readFileSync(join(this.dir, file), 'utf8')) as Json;
      this.docs.set(file, doc);
    }
    return doc;
  }

  /** Archivos cargados hasta ahora (y los que referencian), para registrarlos en Ajv. */
  loadedWithReferences(): Map<string, Json> {
    const pending = [...this.docs.keys()];
    while (pending.length) {
      const file = pending.pop()!;
      for (const [, other] of JSON.stringify(this.doc(file)).matchAll(/"\$ref":"\.\/([^"#]+)#/g)) {
        if (!this.docs.has(other)) {
          this.doc(other);
          pending.push(other);
        }
      }
    }
    return this.docs;
  }

  at(ref: SchemaRef): unknown {
    let node: unknown = this.doc(ref.file);
    for (const part of ref.pointer.split('/').slice(1)) node = (node as Json | undefined)?.[unescape(part)];
    return node;
  }

  /** Resuelve un `$ref` relativo a `file`: `./otro.yaml#/a/b` o `#/a/b`. */
  resolve(ref: string, file: string): SchemaRef {
    const [target, pointer = ''] = ref.split('#');
    return { file: target ? target.replace(/^\.\//, '') : file, pointer };
  }

  /** Sigue los `$ref` de un nodo (path item, parámetro, respuesta) hasta el objeto real. */
  follow(location: SchemaRef): { node: Json; location: SchemaRef } {
    let current = location;
    let node = this.at(current) as Json;
    for (let hops = 0; node && typeof node['$ref'] === 'string'; hops++) {
      if (hops > 10) throw new Error(`$ref circular en ${current.file}#${current.pointer}`);
      current = this.resolve(node['$ref'], current.file);
      node = this.at(current) as Json;
    }
    if (!node) throw new Error(`$ref sin destino: ${location.file}#${location.pointer}`);
    return { node, location: current };
  }
}

const child = (location: SchemaRef, ...parts: string[]): SchemaRef => ({ file: location.file, pointer: `${location.pointer}/${parts.map(escape).join('/')}` });

function jsonSchemaOf(files: ContractFiles, content: unknown, at: SchemaRef, mediaType?: string): SchemaRef | undefined {
  if (!content || typeof content !== 'object') return undefined;
  const types = Object.keys(content);
  const chosen = mediaType ?? types.find((type) => type === 'application/json' || type === 'application/problem+json');
  if (!chosen || !(content as Json)[chosen]) return undefined;
  const media = (content as Json)[chosen] as Json;
  return media['schema'] ? child(at, 'content', chosen, 'schema') : undefined;
}

/** Carga las operaciones de `contract/<file>` (p. ej. `ms-vuelos.openapi.yaml`). */
export function loadOperations(file: string, files = new ContractFiles()): Operation[] {
  const doc = files.doc(file);
  const globalSecurity = (doc['security'] as Record<string, string[]>[] | undefined) ?? [];
  const operations: Operation[] = [];
  for (const path of Object.keys(doc['paths'] as Json)) {
    const { node: item, location: itemLocation } = files.follow({ file, pointer: `/paths/${escape(path)}` });
    const shared = ((item['parameters'] as unknown[]) ?? []).map((_, i) => child(itemLocation, 'parameters', String(i)));
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      const opLocation = child(itemLocation, method);
      const parameters: Parameter[] = [];
      for (const location of [...shared, ...((op['parameters'] as unknown[]) ?? []).map((_, i) => child(opLocation, 'parameters', String(i)))]) {
        const { node, location: real } = files.follow(location);
        const parameter: Parameter = { name: node['name'] as string, in: node['in'] as Parameter['in'], required: node['required'] === true, schema: child(real, 'schema') };
        // Un parámetro de la operación reemplaza al del path item con el mismo nombre y ubicación (OpenAPI 3.0).
        const index = parameters.findIndex((p) => p.name.toLowerCase() === parameter.name.toLowerCase() && p.in === parameter.in);
        if (index >= 0) parameters[index] = parameter;
        else parameters.push(parameter);
      }
      let requestBody: Operation['requestBody'];
      if (op['requestBody']) {
        const { node, location } = files.follow(child(opLocation, 'requestBody'));
        const content = (node['content'] as Json | undefined) ?? {};
        requestBody = {
          required: node['required'] === true,
          content: Object.fromEntries(Object.keys(content).map((type) => [type, jsonSchemaOf(files, content, location, type)])),
        };
      }
      const responses: Operation['responses'] = {};
      for (const status of Object.keys((op['responses'] as Json) ?? {})) {
        const { node, location } = files.follow(child(opLocation, 'responses', status));
        responses[status] = jsonSchemaOf(files, node['content'], location);
      }
      operations.push({
        operationId: op['operationId'] as string,
        method: method.toUpperCase() as Operation['method'],
        path,
        file: itemLocation.file,
        parameters,
        ...(requestBody ? { requestBody } : {}),
        responses,
        security: (op['security'] as Record<string, string[]>[] | undefined) ?? globalSecurity,
        fromGroupContract: itemLocation.file === 'vuelos-openapi-v2.yaml',
      });
    }
  }
  return operations;
}

export interface MatchedOperation {
  operation: Operation;
  params: Record<string, string>;
}

/** Tabla de rutas de un contrato: busca la operación por método y ruta (sin query). */
export class OperationTable {
  private readonly compiled: { operation: Operation; regex: RegExp; names: string[] }[];

  constructor(readonly operations: Operation[]) {
    // Las rutas fijas antes que las de parámetros (`/offers/hold` antes que `/offers/{offerId}/seatmap`).
    const literal = (path: string) => path.split('/').filter((part) => !part.startsWith('{')).length;
    this.compiled = [...operations]
      .sort((a, b) => literal(b.path) - literal(a.path))
      .map((operation) => ({
        operation,
        names: [...operation.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
        regex: new RegExp(`^${operation.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '([^/]+)')}$`),
      }));
  }

  /** `undefined` → 404; si la ruta existe con otro método, `methodNotAllowed`. */
  match(method: string, path: string): MatchedOperation | { methodNotAllowed: string[] } | undefined {
    // `..` o `.` (también codificados) no se normalizan hacia otra ruta: no existen.
    if (path.split('/').some((segment) => /^(\.|%2e){1,2}$/i.test(segment))) return undefined;
    const allowed: string[] = [];
    for (const candidate of this.compiled) {
      const match = candidate.regex.exec(path);
      if (!match) continue;
      if (candidate.operation.method !== method) {
        allowed.push(candidate.operation.method);
        continue;
      }
      try {
        return { operation: candidate.operation, params: Object.fromEntries(candidate.names.map((name, i) => [name, decodeURIComponent(match[i + 1])])) };
      } catch {
        return undefined; // %-codificación inválida
      }
    }
    return allowed.length ? { methodNotAllowed: [...new Set(allowed)] } : undefined;
  }

  byId(operationId: string): Operation {
    const operation = this.operations.find((op) => op.operationId === operationId);
    if (!operation) throw new Error(`El contrato no tiene la operación ${operationId}`);
    return operation;
  }
}
