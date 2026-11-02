import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Busca `contract/<archivo>` subiendo desde este módulo (en el repositorio y en la imagen Docker, que copia `contract/`). */
export function findContractFile(file: string, from = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'contract', file);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No se encontró contract/${file}`);
}
