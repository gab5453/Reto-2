// SEG-1 (S-2, Informacion_General/Seguridad.md): revisa con `npm audit` las dependencias de PRODUCCIÓN (las que corren en los
// contenedores o llegan al navegador) y falla si hay un aviso ALTO o CRÍTICO. Las de desarrollo solo se informan.
// Uso (desde la carpeta del proyecto npm): node <ruta>/scripts/ci/auditoria.mjs [nombre]  ·  escribe un resumen en Markdown.
//
// EXCEPCIONES: un aviso conocido cuya corrección todavía no cumple la regla de las 2 semanas se acepta HASTA una fecha. Pasada
// la fecha la CI vuelve a fallar: la excepción no se olvida.
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const EXCEPCIONES = [
  {
    aviso: 'GHSA-c4qx-w738-7hr3',
    paquete: '@graphql-tools/utils (vía @nestjs/graphql)',
    hasta: '2026-11-18',
    motivo: 'La corrección llega con @nestjs/graphql 14.2.0, publicada el 04/11: se puede usar desde el 18/11 (regla de las 2 semanas).',
  },
];

const nombre = process.argv[2] ?? 'raíz';
const hoy = new Date().toISOString().slice(0, 10);
const auditar = (args) => {
  try {
    return JSON.parse(execSync(`npm audit --json ${args.join(' ')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (error) {
    // npm audit sale con 1 cuando encuentra avisos: el JSON viene igual en stdout.
    return JSON.parse(error.stdout);
  }
};
const avisos = (reporte) =>
  Object.values(reporte.vulnerabilities ?? {}).flatMap((v) =>
    v.via.filter((x) => typeof x === 'object').map((x) => ({ paquete: v.name, severidad: x.severity, id: x.url.split('/').pop(), titulo: x.title })),
  );

const produccion = avisos(auditar(['--omit=dev']));
const todos = avisos(auditar([]));
const graves = produccion.filter((a) => a.severidad === 'high' || a.severidad === 'critical');
const vigente = (a) => EXCEPCIONES.find((e) => e.aviso === a.id && hoy <= e.hasta);
const bloquean = graves.filter((a) => !vigente(a));
const desarrollo = todos.filter((a) => !produccion.some((p) => p.id === a.id && p.paquete === a.paquete));

const lineas = [
  `### Auditoría de dependencias (${nombre})`,
  '',
  `- Producción: **${produccion.length}** aviso(s), ${graves.length} alto(s) o crítico(s); **${bloquean.length} bloquean la CI**.`,
  `- Desarrollo (solo se informan): ${desarrollo.length} aviso(s).`,
  ...graves.map((a) => `- ${vigente(a) ? '⏳ aceptado' : '❌'} \`${a.paquete}\` ${a.severidad} ${a.id}: ${a.titulo}${vigente(a) ? ` — hasta el ${vigente(a).hasta}: ${vigente(a).motivo}` : ''}`),
];
console.log(lineas.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lineas.join('\n')}\n\n`);
if (bloquean.length) {
  console.error(`\n${bloquean.length} aviso(s) alto(s) o crítico(s) en producción sin excepción vigente: actualizar la dependencia (con 2+ semanas) o, si no se puede todavía, registrar una excepción con fecha en scripts/ci/auditoria.mjs.`);
  process.exit(1);
}
