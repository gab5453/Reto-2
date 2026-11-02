import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ajv, compile, contract, operations, resolveResponse } from './support/contract.js';

/**
 * Autoverificación (corre siempre, sin servidor): la suite y el contrato están alineados.
 * 1. El contrato tiene 30 operaciones y Ajv compila el schema de cada respuesta documentada.
 * 2. Los ejemplos del propio contrato cumplen sus schemas (respuestas, parámetros y schemas con `example`).
 * 3. Cada una de las 30 operaciones tiene al menos una prueba en esta suite.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

describe('autoverificación de la suite contra vuelos-openapi-v2.yaml', () => {
  it('el contrato tiene las 30 operaciones repartidas según x-microservice', () => {
    const byMs: Record<string, number> = {};
    for (const op of operations.values()) byMs[op.microservice] = (byMs[op.microservice] ?? 0) + 1;
    expect(operations.size).toBe(30);
    expect(byMs).toEqual({ 'MS.Vuelos': 9, 'MS.Reservas': 12, 'MS.Postventa': 6, 'MS.Clientes': 3 });
  });

  it('Ajv compila el schema de todas las respuestas documentadas', () => {
    let compiled = 0;
    for (const op of operations.values()) {
      for (const [status, response] of Object.entries(op.operation.responses)) {
        for (const media of Object.values(resolveResponse(response).content ?? {})) {
          expect(() => compile(`${op.operationId} ${status}`, media.schema)).not.toThrow();
          compiled++;
        }
      }
    }
    expect(compiled).toBeGreaterThan(100);
  });

  it('los ejemplos de respuestas de error del contrato cumplen ProblemDetails', () => {
    const validate = compile('ProblemDetails', { $ref: '#/components/schemas/ProblemDetails' });
    const examples = Object.entries(contract.components.responses).flatMap(([name, response]) =>
      Object.values(response.content ?? {}).flatMap((media) => (media.example === undefined ? [] : [[name, media.example] as const])),
    );
    expect(examples.length).toBeGreaterThan(0);
    for (const [name, example] of examples) {
      expect(validate(example), `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it('los ejemplos de los parámetros cumplen su schema (p. ej. FlightNumber, BookingId)', () => {
    const parameters = [
      ...Object.values(contract.components.parameters),
      ...[...operations.values()].flatMap((op) => op.parameters),
    ].filter((p) => p.example !== undefined && p.schema);
    for (const parameter of parameters) {
      const validate = compile(`param ${parameter.name}`, parameter.schema!);
      expect(validate(parameter.example), `${parameter.name}=${String(parameter.example)}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it('los schemas del contrato con `example` completo lo cumplen (VuelosCloudEvent, Links)', () => {
    const withExample = Object.entries(contract.components.schemas).filter(([, schema]) => (schema as { example?: unknown }).example !== undefined);
    for (const [name, schema] of withExample) {
      const example = (schema as { example: unknown }).example;
      const validate = compile(`example ${name}`, { $ref: `#/components/schemas/${name}` });
      // Los enums escalares (CabinClass, SeatStatus…) también traen ejemplo: se validan igual.
      expect(validate(example), `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
    expect(withExample.map(([name]) => name)).toEqual(expect.arrayContaining(['VuelosCloudEvent', 'Links']));
  });

  it('cada una de las 30 operaciones tiene al menos una prueba en la suite', () => {
    const sources = readdirSync(HERE)
      .filter((file) => file.endsWith('.conformance.ts') && !file.startsWith('autoverificacion'))
      .map((file) => readFileSync(join(HERE, file), 'utf8'))
      .join('\n');
    const called = new Set([...sources.matchAll(/call\('(\w+)'/g)].map((match) => match[1]));
    const flows = readFileSync(join(HERE, 'support', 'flows.ts'), 'utf8');
    for (const match of flows.matchAll(/call\('(\w+)'/g)) called.add(match[1]);
    const missing = [...operations.keys()].filter((id) => !called.has(id));
    expect(missing).toEqual([]);
  });
});
