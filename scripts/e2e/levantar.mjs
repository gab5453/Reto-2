// E2E-1: levanta el sistema para las pruebas E2E (infra/docker-compose.e2e.yml): todos los servicios de docker-compose.yml
// menos Prometheus, Grafana y Alertmanager, espera a que estén sanos y PUBLICA EL HORARIO. Uso: npm run e2e:up · npm run e2e:down
//
// Publicar el horario: la semilla de MS.G.Schedule solo crea las rutas en su base; los vuelos salen a la venta en Offers con la
// saga «Publicar horario» del ESB (como en la nube, scripts/cloud/publicar-horario.sh). En una base nueva (la CI), sin este paso
// no hay ningún vuelo. Se ejecuta dentro del contenedor del ESB, con su token de servicio y el administrador de desarrollo.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FUERA = new Set(['prometheus', 'grafana', 'alertmanager']);
const archivos = ['-f', 'infra/docker-compose.yml', '-f', 'infra/docker-compose.e2e.yml'];
const compose = (args, opciones = {}) => execFileSync('docker', ['compose', ...archivos, ...args], { encoding: 'utf8', ...opciones });

if (process.argv[2] === 'down') {
  compose(['down'], { stdio: 'inherit' });
} else {
  const servicios = compose(['config', '--services']).split(/\r?\n/).filter((nombre) => nombre && !FUERA.has(nombre));
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '600', ...servicios], { stdio: 'inherit' });
  const salida = compose(['exec', '-T', '-e', 'ADMIN_PASSWORD=EcoAdmin2026', 'esb', 'node', '--input-type=module'], {
    input: readFileSync('scripts/cloud/publicar-horario.mjs'),
  });
  console.log(salida.trim());
  if (!/Publicar horario: 20[01]/.test(salida)) throw new Error('No se pudo publicar el horario: sin vuelos a la venta, las E2E no tienen qué comprar.');
}
