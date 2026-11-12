// CI-2: escribe el resumen de cobertura (coverage/coverage-summary.json de `npm run test:coverage`) como tabla en Markdown, para el
// resumen de la ejecución en GitHub Actions ($GITHUB_STEP_SUMMARY). Uso: node scripts/ci/resumen-cobertura.mjs >> "$GITHUB_STEP_SUMMARY"
import { readFileSync } from 'node:fs';

const total = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8')).total;
const fila = (nombre, clave) => `| ${nombre} | ${total[clave].pct} % | ${total[clave].covered} / ${total[clave].total} |`;
console.log(
  [
    '### Cobertura (código de producción)',
    '',
    '| Métrica | % | Cubiertas |',
    '|---|---:|---:|',
    fila('Líneas', 'lines'),
    fila('Ramas', 'branches'),
    fila('Funciones', 'functions'),
    fila('Sentencias', 'statements'),
    '',
    'Mínimos (fallan la CI): dominios ≥ 95 % de líneas y ≥ 85 % de ramas; motor de sagas ≥ 90 % y ≥ 80 %. Reporte completo en el artefacto «cobertura».',
  ].join('\n'),
);
