import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { operations } from './contract.js';

declare module 'vitest' {
  export interface ProvidedContext {
    coverageDir: string;
  }
}

/**
 * Cobertura del contrato: cada llamada registra "operationId status". Al terminar, si la suite corrió contra un servidor,
 * se informa qué operaciones y status se probaron y se falla si alguna de las 30 operaciones quedó sin probar.
 */
export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'conformidad-v2-'));
  project.provide('coverageDir', dir);
  return () => {
    const lines = readdirSync(dir).flatMap((file) => readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean));
    rmSync(dir, { recursive: true, force: true });
    if (!process.env['CONFORMANCE_BASE_URL']) return;
    const tested = new Set(lines.map((line) => line.split(' ')[0]));
    const pairs = new Set(lines);
    const documented = [...operations.values()].reduce((total, op) => total + Object.keys(op.operation.responses).length, 0);
    const missing = [...operations.keys()].filter((id) => !tested.has(id));
    console.log(
      `\nCobertura del contrato v2: ${tested.size}/${operations.size} operaciones · ${pairs.size}/${documented} combinaciones operación+status`,
    );
    if (missing.length) throw new Error(`Operaciones del contrato sin probar: ${missing.join(', ')}`);
  };
}
