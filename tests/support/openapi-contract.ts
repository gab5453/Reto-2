import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import formatsModule from 'ajv-formats';
import { load } from 'js-yaml';
import type { Response } from 'supertest';

/**
 * Valida respuestas de un servicio contra su contrato OpenAPI (`contract/<archivo>`): el status debe estar documentado en la
 * operación, el Content-Type también, y el cuerpo debe cumplir el schema (`additionalProperties`, `nullable`, formatos y las
 * referencias a otros contratos, p. ej. `./vuelos-openapi-v2.yaml#/components/schemas/CabinClass`).
 *
 * Es código de pruebas compartido: lo importan los `test/` de los servicios (excepción explícita de la regla 1 de la prueba
 * de arquitectura; el código de `src/` nunca lo importa).
 */
type Doc = {
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, unknown> }> }>>;
  components: { responses?: Record<string, { content?: Record<string, unknown> }> };
};

const CONTRACT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../contract');
const BASE = 'https://contract.ecoairlines.local/';
const addFormats = ((formatsModule as unknown as { default?: unknown }).default ?? formatsModule) as (ajv: Ajv) => void;

/**
 * OpenAPI 3.0: una propiedad `writeOnly` (p. ej. `secret`) solo es obligatoria al ENVIARLA, nunca en una respuesta. Ajv no
 * conoce esa regla; como aquí solo se validan respuestas, se quita de `required`.
 */
function withoutWriteOnlyRequired(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutWriteOnlyRequired);
  if (!node || typeof node !== 'object') return node;
  const copy = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, withoutWriteOnlyRequired(value)])) as Record<string, unknown>;
  const properties = copy['properties'] as Record<string, { writeOnly?: boolean }> | undefined;
  if (Array.isArray(copy['required']) && properties) copy['required'] = (copy['required'] as string[]).filter((name) => !properties[name]?.writeOnly);
  return copy;
}

const pointer = (...parts: string[]) => parts.map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

export function contractValidator(file: string) {
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false, formats: { password: true } });
  addFormats(ajv);
  const loaded = new Set<string>();
  const add = (name: string): Doc => {
    const doc = withoutWriteOnlyRequired(load(readFileSync(resolve(CONTRACT_DIR, name), 'utf8'))) as Doc;
    if (!loaded.has(name)) {
      loaded.add(name);
      ajv.addSchema({ $id: `${BASE}${name}`, ...doc });
      // Otros contratos referenciados (`./otro.yaml#/...`).
      for (const [, other] of JSON.stringify(doc).matchAll(/"\$ref":"\.\/([^"#]+)#/g)) if (!loaded.has(other!)) add(other!);
    }
    return doc;
  };
  const doc = add(file);

  /** `path` con la forma del contrato, p. ej. `/routes/{routeId}`. */
  return function expectContract(method: string, path: string, response: Response): void {
    const lower = method.toLowerCase();
    const operation = doc.paths[path]?.[lower];
    if (!operation) throw new Error(`Operación inexistente en ${file}: ${method} ${path}`);
    const status = String(response.status);
    const documented = operation.responses[status];
    if (!documented) throw new Error(`${method} ${path} respondió ${status}, que no está documentado\n${JSON.stringify(response.body).slice(0, 500)}`);
    const name = documented.$ref?.split('/').at(-1);
    const base = name ? `#/components/responses/${pointer(name)}` : `#/paths/${pointer(path)}/${lower}/responses/${status}`;
    const content = (name ? doc.components.responses![name]! : documented).content;
    if (!content) return;
    const mediaType = String(response.headers['content-type'] ?? '').split(';')[0]!;
    if (!content[mediaType]) throw new Error(`${method} ${path} ${status}: Content-Type ${mediaType} no documentado`);
    const validate = ajv.getSchema(`${BASE}${file}${base}/content/${pointer(mediaType)}/schema`)!;
    if (!validate(response.body)) {
      throw new Error(`${method} ${path} ${status} no cumple el contrato: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(response.body).slice(0, 800)}`);
    }
  };
}
