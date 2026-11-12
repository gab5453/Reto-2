import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import formatsModule from 'ajv-formats';
import type { InvalidParam } from '../problem-details/problem-details.js';
import type { ContractFiles, Json, Operation, Parameter, SchemaRef } from './contract.js';

/**
 * Validación de la entrada EXACTA al contrato (V2.12, como el monolito del Reto 1, retirado en V2.21): `required`, `enum`, `pattern`, formatos,
 * `minItems`, `additionalProperties: false`… con Ajv sobre los mismos schemas del contrato (no una copia en DTOs). Los valores
 * `default` del contrato se aplican (p. ej. `passengers.adults = 1`, `ttlMinutes = 15`).
 *
 * Y la **proyección** de la salida: de lo que devuelve el ESB solo se publica lo que declara el schema de la respuesta. Así no
 * salen campos internos (`ownerId`, `channel`, `fares`, `refunds`, las marcas `_campo` de proto3…) ni los `writeOnly` (el
 * `secret` de un webhook).
 */
const BASE = 'https://contract.ecoairlines.local/';
const addFormats = ((formatsModule as unknown as { default?: unknown }).default ?? formatsModule) as (ajv: Ajv) => void;
const uri = (ref: SchemaRef) => `${BASE}${ref.file}#${ref.pointer}`;

/**
 * OpenAPI 3.0: un `readOnly` (p. ej. `id`, `createdAt` de un webhook) no se envía; no puede ser obligatorio en la petición.
 */
function withoutReadOnlyRequired(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutReadOnlyRequired);
  if (!node || typeof node !== 'object') return node;
  const copy: Json = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, withoutReadOnlyRequired(value)]));
  const properties = copy['properties'] as Record<string, { readOnly?: boolean }> | undefined;
  if (Array.isArray(copy['required']) && properties) copy['required'] = (copy['required'] as string[]).filter((name) => !properties[name]?.readOnly);
  return copy;
}

function newAjv(coerceTypes: boolean): Ajv {
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false, useDefaults: true, coerceTypes, formats: { password: true } });
  addFormats(ajv);
  return ajv;
}

/** `/passengers/0/firstName` → `passengers[0].firstName`. */
function paramName(error: ErrorObject, root: string): string {
  const parts = error.instancePath.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  const extra = (error.params as { missingProperty?: string; additionalProperty?: string }).missingProperty ?? (error.params as { additionalProperty?: string }).additionalProperty;
  if (extra !== undefined) parts.push(extra);
  const path = parts.reduce((name, part) => (/^\d+$/.test(part) ? `${name}[${part}]` : name ? `${name}.${part}` : part), '');
  return path || root;
}

function reasonOf(error: ErrorObject): string {
  if (error.keyword === 'additionalProperties') return 'propiedad no permitida';
  if (error.keyword === 'required') return 'obligatorio';
  if (error.keyword === 'enum') return `debe ser uno de: ${((error.params as { allowedValues?: unknown[] }).allowedValues ?? []).join(', ')}`;
  return error.message ?? 'inválido';
}

/** Errores de Ajv → `invalidParams` (sin repetir; los de `oneOf`/`anyOf` intermedios no aportan). */
function toInvalidParams(errors: ErrorObject[] | null | undefined, root: string, prefix = ''): InvalidParam[] {
  const seen = new Set<string>();
  const result: InvalidParam[] = [];
  for (const error of errors ?? []) {
    if (error.keyword === 'oneOf' || error.keyword === 'anyOf' || error.keyword === 'if') continue;
    const name = `${prefix}${paramName(error, root)}`;
    const reason = reasonOf(error);
    if (seen.has(`${name}|${reason}`)) continue;
    seen.add(`${name}|${reason}`);
    result.push({ name, reason });
  }
  return result;
}

export interface ValidatedInput {
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: unknown;
}

type Location = 'path' | 'query' | 'header';

/** Validadores compilados de un contrato (uno por operación, al arrancar). */
export class ContractValidator {
  private readonly body = newAjv(false);
  private readonly params = newAjv(true);
  private readonly cache = new Map<string, ValidateFunction>();

  constructor(private readonly files: ContractFiles) {
    for (const [file, doc] of files.loadedWithReferences()) {
      const schema = { $id: `${BASE}${file}`, ...(withoutReadOnlyRequired(doc) as Json) };
      this.body.addSchema(schema);
      this.params.addSchema(schema);
    }
  }

  private compile(ajv: Ajv, key: string, schema: object): ValidateFunction {
    let validate = this.cache.get(key);
    if (!validate) {
      validate = ajv.compile(schema);
      this.cache.set(key, validate);
    }
    return validate;
  }

  /** Compila todo al arrancar: un contrato con un schema roto no deja arrancar el servicio. */
  precompile(operations: Operation[]): void {
    for (const operation of operations) {
      for (const location of ['path', 'query', 'header'] as Location[]) this.paramValidator(operation, location);
      for (const [type, schema] of Object.entries(operation.requestBody?.content ?? {})) if (schema) this.bodyValidator(operation, type, schema);
    }
  }

  private paramValidator(operation: Operation, location: Location): ValidateFunction {
    const parameters = operation.parameters.filter((p) => p.in === location);
    const key = (p: Parameter) => (location === 'header' ? p.name.toLowerCase() : p.name);
    return this.compile(this.params, `${operation.operationId}:${location}`, {
      type: 'object',
      properties: Object.fromEntries(parameters.map((p) => [key(p), { $ref: uri(p.schema) }])),
      required: parameters.filter((p) => p.required).map(key),
    });
  }

  private bodyValidator(operation: Operation, type: string, schema: SchemaRef): ValidateFunction {
    return this.compile(this.body, `${operation.operationId}:body:${type}`, { $ref: uri(schema) });
  }

  /**
   * Valida y devuelve SOLO los parámetros declarados (los demás se ignoran: no llegan al ESB), ya convertidos a su tipo y con
   * sus `default`. Lanza la lista de `invalidParams` si algo no cumple.
   */
  validate(operation: Operation, raw: { params: Record<string, string>; query: Record<string, unknown>; headers: Record<string, string | string[] | undefined>; body: unknown; contentType?: string; skipBody?: boolean }): ValidatedInput | InvalidParam[] {
    const errors: InvalidParam[] = [];
    const pick = (location: Location, source: Record<string, unknown>) => {
      const declared = operation.parameters.filter((p) => p.in === location);
      const values: Record<string, unknown> = {};
      for (const parameter of declared) {
        const name = location === 'header' ? parameter.name.toLowerCase() : parameter.name;
        if (source[name] !== undefined) values[name] = source[name];
      }
      const validate = this.paramValidator(operation, location);
      if (!validate(values)) {
        // El nombre visible es el del contrato (`X-Device-Fingerprint`, no `x-device-fingerprint`).
        const pretty = new Map(declared.map((p) => [location === 'header' ? p.name.toLowerCase() : p.name, p.name]));
        errors.push(...toInvalidParams(validate.errors, location).map((e) => ({ ...e, name: pretty.get(e.name.split(/[.[]/)[0]) ?? e.name })));
      }
      return values;
    };
    const params = pick('path', raw.params);
    const query = pick('query', raw.query);
    const headers = pick('header', raw.headers);

    let body: unknown;
    const requestBody = operation.requestBody;
    const empty = raw.body === undefined || (typeof raw.body === 'object' && raw.body !== null && !Array.isArray(raw.body) && !Object.keys(raw.body).length && !raw.contentType);
    if (raw.skipBody) {
      body = raw.body;
    } else if (requestBody && !empty) {
      const type = Object.keys(requestBody.content).find((t) => raw.contentType?.toLowerCase().startsWith(t)) ?? (raw.contentType ? undefined : Object.keys(requestBody.content)[0]);
      const schema = type ? requestBody.content[type] : undefined;
      if (!type) {
        errors.push({ name: 'Content-Type', reason: `debe ser ${Object.keys(requestBody.content).join(' o ')}` });
      } else if (schema) {
        body = structuredClone(raw.body);
        const validate = this.bodyValidator(operation, type, schema);
        if (!validate(body)) errors.push(...toInvalidParams(validate.errors, 'body'));
      } else {
        body = raw.body;
      }
    } else if (requestBody?.required) {
      errors.push({ name: 'body', reason: 'obligatorio' });
    }
    return errors.length ? errors : { params, query, headers, body };
  }
}

// ------------------------------------------------------------------------------------------------------------ proyección

/**
 * Deja en `value` solo lo que declara `schema` (siguiendo `$ref`, `allOf`, `oneOf`/`anyOf`, arreglos y mapas). Un objeto con
 * `properties` pierde las propiedades no declaradas, salvo que `additionalProperties` sea un schema (mapa, p. ej. `Links`) o
 * `true` sin `properties`. Las `writeOnly` nunca se devuelven y las `readOnly` no se aceptan del cliente.
 */
export class Projector {
  constructor(private readonly files: ContractFiles) {}

  /**
   * `response` (por defecto): quita las `writeOnly` (p. ej. el `secret` de un webhook nunca vuelve). `request`: quita las
   * `readOnly` (p. ej. `id`, `createdAt`), que el cliente no puede fijar, y conserva las `writeOnly`, que son para enviarse.
   */
  project(value: unknown, ref: SchemaRef | undefined, direction: 'request' | 'response' = 'response'): unknown {
    return ref ? this.walk(value, this.files.at(ref) as Json, ref.file, 0, direction === 'request' ? 'readOnly' : 'writeOnly') : value;
  }

  private walk(value: unknown, schema: Json | undefined, file: string, depth: number, hidden: 'readOnly' | 'writeOnly'): unknown {
    if (!schema || depth > 40 || value === null || value === undefined) return value;
    if (typeof schema['$ref'] === 'string') {
      const target = this.files.resolve(schema['$ref'], file);
      return this.walk(value, this.files.at(target) as Json, target.file, depth + 1, hidden);
    }
    if (Array.isArray(value)) {
      const items = schema['items'] as Json | undefined;
      return items ? value.map((item) => this.walk(item, items, file, depth + 1, hidden)) : value;
    }
    if (typeof value !== 'object') return value;

    const { properties, additional } = this.shape(schema, file, depth);
    if (!properties.size && additional === undefined) return value; // objeto libre (sin schema de propiedades)
    const result: Json = {};
    for (const [key, item] of Object.entries(value as Json)) {
      const declared = properties.get(key);
      if (declared) {
        if (this.flag(declared.schema, declared.file, hidden)) continue;
        result[key] = this.walk(item, declared.schema, declared.file, depth + 1, hidden);
      } else if (additional && typeof additional.schema === 'object') {
        result[key] = this.walk(item, additional.schema, additional.file, depth + 1, hidden);
      } else if (additional?.schema === true && !properties.size) {
        result[key] = item;
      }
    }
    return result;
  }

  /** `readOnly`/`writeOnly` de una propiedad (también si la declara un `$ref`). */
  private flag(schema: Json, file: string, name: 'readOnly' | 'writeOnly'): boolean {
    if (schema[name] === true) return true;
    if (typeof schema['$ref'] !== 'string') return false;
    const target = this.files.resolve(schema['$ref'], file);
    return (this.files.at(target) as Json | undefined)?.[name] === true;
  }

  /** Propiedades declaradas de un objeto, uniendo `allOf`, `oneOf` y `anyOf`. */
  private shape(schema: Json, file: string, depth: number) {
    const properties = new Map<string, { schema: Json; file: string }>();
    let additional: { schema: Json | true; file: string } | undefined;
    const visit = (node: Json | undefined, at: string, level: number) => {
      if (!node || level > 20) return;
      if (typeof node['$ref'] === 'string') {
        const target = this.files.resolve(node['$ref'], at);
        visit(this.files.at(target) as Json, target.file, level + 1);
        return;
      }
      for (const [key, property] of Object.entries((node['properties'] as Record<string, Json> | undefined) ?? {})) if (!properties.has(key)) properties.set(key, { schema: property, file: at });
      const extra = node['additionalProperties'];
      if (extra && typeof extra === 'object') additional = { schema: extra as Json, file: at };
      else if (extra === true && !additional) additional = { schema: true, file: at };
      for (const keyword of ['allOf', 'oneOf', 'anyOf']) {
        for (const branch of (node[keyword] as Json[] | undefined) ?? []) visit(branch, at, level + 1);
      }
    };
    visit(schema, file, depth);
    return { properties, additional };
  }
}
