// CD-1: prueba de HUMO después de desplegar (Informacion_General/Pruebas.md §5.4). Contra la nube y SOLO LECTURA: nunca compra,
// retiene ni cambia nada (las operaciones públicas del contrato v2 y la portada de GraphQL). Responde: ¿la versión nueva atiende?
// Uso: node scripts/cloud/humo.mjs https://ecoairlines-reto2.northcentralus.cloudapp.azure.com
// Reintenta durante ~5 min: tras `up -d` los servicios de la VM tardan unos minutos en sanar.
import { randomUUID } from 'node:crypto';

const BASE = (process.argv[2] ?? '').replace(/\/$/, '');
if (!BASE.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE + '/')) throw new Error('Uso: node scripts/cloud/humo.mjs https://<host>  (o http://localhost:8088 para probarla en local)');
const headers = (extra = {}) => ({ 'x-correlation-id': `corr-humo-${randomUUID()}`, 'x-device-fingerprint': 'humo-cd', accept: 'application/json', ...extra });
const fecha = new Date(Date.now() - 5 * 3_600_000 + 7 * 86_400_000).toISOString().slice(0, 10);

const pruebas = [
  ['gateway sano (/health)', async () => {
    const r = await fetch(`${BASE}/health`, { headers: headers() });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  }],
  ['búsqueda v2 (UIO → GYE en 7 días) con ofertas', async () => {
    const r = await fetch(`${BASE}/api/v2/vuelos/search`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: fecha }], passengers: { adults: 1 } }) });
    const body = await r.json();
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${body.code ?? ''}`);
    if (!body.offers?.length) throw new Error('sin ofertas');
    return body.offers[0];
  }],
  ['mapa de asientos de la primera oferta', async (oferta) => {
    const segmento = oferta.itineraries[0].segments[0];
    const r = await fetch(`${BASE}/api/v2/vuelos/offers/${encodeURIComponent(oferta.offerId)}/seatmap?segmentId=${encodeURIComponent(segmento.segmentId)}`, { headers: headers() });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return segmento;
  }],
  ['estado del vuelo (REST v2)', async (segmento) => {
    const r = await fetch(`${BASE}/api/v2/vuelos/flights/${segmento.flightNumber}/status?date=${fecha}`, { headers: headers() });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  }],
  ['GraphQL de la web (aeropuertos)', async () => {
    const r = await fetch(`${BASE}/api/graphql`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ query: '{ airports { code } }' }) });
    const body = await r.json();
    if (r.status !== 200 || body.errors?.length || !body.data?.airports?.length) throw new Error(`HTTP ${r.status} ${JSON.stringify(body.errors?.[0]?.extensions?.code ?? '')}`);
  }],
];

const limite = Date.now() + 5 * 60_000;
for (let intento = 1; ; intento++) {
  const fallas = [];
  let anterior;
  for (const [nombre, prueba] of pruebas) {
    try {
      anterior = await prueba(anterior);
      if (intento === 1 || fallas.length === 0) console.log(`OK    ${nombre}`);
    } catch (error) {
      fallas.push(`${nombre}: ${error.message}`);
      break; // las siguientes dependen de esta
    }
  }
  if (!fallas.length) {
    console.log('Humo OK: la versión desplegada atiende.');
    process.exit(0);
  }
  if (Date.now() > limite) {
    console.error(`HUMO FALLÓ: ${fallas.join(' · ')}`);
    process.exit(1);
  }
  console.log(`… todavía no (${fallas[0]}); reintento en 15 s`);
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
