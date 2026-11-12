// CI-1: las pruebas con PostgreSQL y RabbitMQ reales se OMITEN si falta su variable de entorno, y una prueba omitida no falla.
// Este guardia lee el reporte JSON de Vitest y falla si alguna se omitió o si no corrió ninguna: así una variable mal escrita en el
// flujo no deja la CI en verde sin haber probado nada. También la usa E2E-1 con la suite de conformidad (que omite las pruebas de
// administrador si falta su token). Uso: node scripts/ci/sin-omitidas.mjs <reporte.json> [nombre de la suite]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const suiteName = process.argv[3] ?? 'Pruebas con infraestructura real';
if (!file) {
  console.error('Uso: node scripts/ci/sin-omitidas.mjs <reporte.json>');
  process.exit(2);
}
const report = JSON.parse(readFileSync(file, 'utf8'));
const skipped = report.testResults.flatMap((suite) =>
  suite.assertionResults.filter((test) => test.status === 'skipped' || test.status === 'pending').map((test) => `${suite.name}: ${test.fullName}`),
);
console.log(`${suiteName}: ${report.numPassedTests} pasan, ${report.numFailedTests} fallan, ${skipped.length} omitidas.`);
if (report.numTotalTests === 0) {
  console.error('No corrió ninguna prueba: revisa el filtro o la configuración de la suite.');
  process.exit(1);
}
if (skipped.length) {
  console.error('Se omitieron (¿falta una variable de entorno? *_TEST_DATABASE_URL, BUS_TEST_URL o CONFORMANCE_*):');
  for (const name of skipped) console.error(`  - ${name}`);
  process.exit(1);
}
