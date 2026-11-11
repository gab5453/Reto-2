// CI-1: las pruebas con PostgreSQL y RabbitMQ reales se OMITEN si falta su variable de entorno, y una prueba omitida no falla.
// Este guardia lee el reporte JSON de Vitest y falla si alguna se omitió o si no corrió ninguna: así una variable mal escrita en el
// flujo no deja la CI en verde sin haber probado nada. Uso: node scripts/ci/sin-omitidas.mjs resultados-infra.json
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Uso: node scripts/ci/sin-omitidas.mjs <reporte.json>');
  process.exit(2);
}
const report = JSON.parse(readFileSync(file, 'utf8'));
const skipped = report.testResults.flatMap((suite) =>
  suite.assertionResults.filter((test) => test.status === 'skipped' || test.status === 'pending').map((test) => `${suite.name}: ${test.fullName}`),
);
console.log(`Pruebas con infraestructura real: ${report.numPassedTests} pasan, ${report.numFailedTests} fallan, ${skipped.length} omitidas.`);
if (report.numTotalTests === 0) {
  console.error('No corrió ninguna prueba: revisa el filtro de `npm run test:infra`.');
  process.exit(1);
}
if (skipped.length) {
  console.error('Se omitieron (¿falta su variable *_TEST_DATABASE_URL o BUS_TEST_URL?):');
  for (const name of skipped) console.error(`  - ${name}`);
  process.exit(1);
}
