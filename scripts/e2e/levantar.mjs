// E2E-1: levanta el sistema para las pruebas E2E (infra/docker-compose.e2e.yml): todos los servicios de docker-compose.yml
// menos Prometheus, Grafana y Alertmanager, y espera a que estén sanos. Uso: npm run e2e:up  ·  npm run e2e:down
import { execFileSync } from 'node:child_process';

const FUERA = new Set(['prometheus', 'grafana', 'alertmanager']);
const archivos = ['-f', 'infra/docker-compose.yml', '-f', 'infra/docker-compose.e2e.yml'];
const compose = (args, opciones = {}) => execFileSync('docker', ['compose', ...archivos, ...args], { encoding: 'utf8', ...opciones });

if (process.argv[2] === 'down') {
  compose(['down'], { stdio: 'inherit' });
} else {
  const servicios = compose(['config', '--services']).split(/\r?\n/).filter((nombre) => nombre && !FUERA.has(nombre));
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '600', ...servicios], { stdio: 'inherit' });
}
