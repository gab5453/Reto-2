// E2E-1: suite de conformidad v2 (54 pruebas, caja negra) contra el sistema LOCAL de docker compose, con el partner Booking de
// desarrollo y un token de administrador pedido aquí (nunca se imprime). Uso: npm run e2e:conformidad [-- <args de vitest>]
// Las claves son las de desarrollo de infra/docker-compose.yml: no sirven en la nube.
import { spawnSync } from 'node:child_process';

const GATEWAY = process.env.E2E_GATEWAY ?? 'http://localhost:8088';
if (!['localhost', '127.0.0.1'].includes(new URL(GATEWAY).hostname)) throw new Error(`Solo contra el sistema local, no contra ${GATEWAY}`);

const login = await fetch(`${GATEWAY}/api/graphql`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-device-fingerprint': 'e2e-conformidad' },
  body: JSON.stringify({ query: 'mutation($i: LoginInput!){ login(input:$i){ accessToken } }', variables: { i: { email: 'admin@ecoairlines.test', password: 'EcoAdmin2026' } } }),
});
const adminToken = (await login.json()).data?.login?.accessToken;
if (!adminToken) throw new Error(`No se pudo iniciar sesión como administrador (${login.status})`);

const result = spawnSync('npm', ['run', 'test:conformidad-v2', '--', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    CONFORMANCE_BASE_URL: `${GATEWAY}/api/v2`,
    CONFORMANCE_CLIENT_ID: 'BOOKING_PROTOTIPO',
    CONFORMANCE_CLIENT_SECRET: 'secreto-booking-dev-solo-local-0001',
    CONFORMANCE_ADMIN_TOKEN: adminToken,
  },
});
process.exit(result.status ?? 1);
