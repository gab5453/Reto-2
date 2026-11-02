// Saga "Publicar horario" del ESB (D3) en la nube (V2.14): se ejecuta DENTRO del contenedor del ESB (red interna de Docker),
// con su token de servicio y el `sub` del administrador como actor. Lo lanza scripts/cloud/publicar-horario.sh.
// Variables (del contenedor del ESB): IDENTITY_URL, ESB_CLIENT_SECRET; y ADMIN_PASSWORD, que pasa el script.
import { randomUUID } from 'node:crypto';

const identity = process.env.IDENTITY_URL;
const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: 'ECOAIRLINES_ESB', client_secret: process.env.ESB_CLIENT_SECRET ?? '' });
const service = await (await fetch(`${identity}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })).json();
if (!service.access_token) throw new Error(`Sin token de servicio: ${JSON.stringify(service)}`);
const login = await (await fetch(`${identity}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@ecoairlines.test', password: process.env.ADMIN_PASSWORD }) })).json();
if (!login.user?.sub) throw new Error(`No se pudo iniciar sesión como administrador: ${login.title ?? login.error ?? 'sin detalle'}`);
const response = await fetch('http://localhost:8080/sagas/timetable/publish', {
  method: 'POST',
  headers: { authorization: `Bearer ${service.access_token}`, 'x-actor-id': login.user.sub, 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
  body: '{}',
});
console.log(`Publicar horario: ${response.status} ${(await response.text()).slice(0, 400)}`);
