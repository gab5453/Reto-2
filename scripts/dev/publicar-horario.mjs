#!/usr/bin/env node
/**
 * Solo DESARROLLO (hasta V2.10): hace el trabajo de las sagas "Publicar horario" y "Guardar precios" del ESB, que todavía no
 * existe. Pide el token de servicio a Identity, lee de Schedule el horario de la ventana de venta (92 días), los precios y el
 * acuerdo de promociones con Booking, y los publica en Offers por gRPC (PublishTimetable y PublishFarePrices) y como evento
 * interno `schedule.published` en RabbitMQ (de ahí arma FlightStatus su proyección del horario, D4).
 *
 *   node scripts/dev/publicar-horario.mjs
 *
 * Variables (valores por defecto del docker compose local): IDENTITY_URL, SCHEDULE_URL, OFFERS_GRPC, BUS_URL, ESB_CLIENT_SECRET.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../services/gestion/ms-g-offers/package.json'));
const grpc = require('@grpc/grpc-js');
const amqp = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/shared/package.json'))('amqplib');
const protoLoader = require('@grpc/proto-loader');

const IDENTITY = process.env.IDENTITY_URL ?? 'http://localhost:4001';
const SCHEDULE = process.env.SCHEDULE_URL ?? 'http://localhost:4004';
const OFFERS = process.env.OFFERS_GRPC ?? 'localhost:50061';
const BUS = process.env.BUS_URL ?? 'amqp://ecoairlines:dev-rabbitmq-solo-local@localhost:5672';
const SECRET = process.env.ESB_CLIENT_SECRET ?? 'secreto-esb-dev-solo-local-0001';
const correlationId = `corr-publicar-${Date.now()}`;

const token = await fetch(`${IDENTITY}/oauth2/token`, {
  method: 'POST',
  headers: { authorization: `Basic ${Buffer.from(`ECOAIRLINES_ESB:${SECRET}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
}).then((r) => r.json());
if (!token.access_token) throw new Error(`Identity no entregó el token: ${JSON.stringify(token)}`);
const get = (path) => fetch(`${SCHEDULE}${path}`, { headers: { authorization: `Bearer ${token.access_token}`, 'x-correlation-id': correlationId } }).then(async (r) => {
  if (!r.ok && r.status !== 404) throw new Error(`Schedule ${path} → ${r.status} ${await r.text()}`);
  return r.status === 404 ? undefined : r.json();
});

const today = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const until = new Date(Date.parse(`${today}T00:00:00Z`) + 91 * 86_400_000).toISOString().slice(0, 10);
const [timetable, prices, agreement] = await Promise.all([get(`/timetable?from=${today}&to=${until}`), get('/fare-prices'), get('/promotion-agreements/BOOKING_PROTOTIPO')]);

const definition = protoLoader.loadSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../contract/ms-g-offers.proto'), { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true });
const pkg = grpc.loadPackageDefinition(definition).ecoairlines.offers.v1;
const client = new pkg.PublishingService(OFFERS, grpc.credentials.createInsecure());
const metadata = new grpc.Metadata();
metadata.set('authorization', `Bearer ${token.access_token}`);
metadata.set('x-correlation-id', correlationId);
const call = (rpc, request) => new Promise((ok, fail) => client[rpc](request, metadata, (error, response) => (error ? fail(error) : ok(response))));

const published = await call('PublishTimetable', { publishId: `dev-${correlationId}`, from: today, to: until, flights: timetable.flights });
const fares = await call('PublishFarePrices', {
  publishId: `dev-precios-${correlationId}`,
  prices: prices.items.map((p) => ({ cabinClass: `CABIN_CLASS_${p.cabinClass}`, fareBrand: p.fareBrand, multiplier: p.multiplier })),
  promotions: agreement
    ? [{
        partnerId: 'BOOKING_PROTOTIPO',
        allowsPromotions: agreement.permite_promociones,
        maxDiscountPercentage: agreement.porcentaje_descuento_maximo,
        routes: agreement.rutas_habilitadas ?? [],
        cabins: (agreement.cabinas_habilitadas ?? []).map((c) => `CABIN_CLASS_${c}`),
        ...(agreement.vigencia_hasta ? { validUntil: agreement.vigencia_hasta } : {}),
      }]
    : [],
});
client.close();
console.log(`Horario ${today} … ${until}: ${timetable.flights.length} vuelos →`, published.result);
console.log('Precios y promociones →', fares.result, `[${correlationId}]`);

// schedule.published (CloudEvent interno; exchange ecoairlines.events, routing key = nombre del evento).
const event = {
  specversion: '1.0', type: 'ec.ecoairlines.internal.schedule.published', source: '/aerolineas/ecoairlines/vuelos', id: crypto.randomUUID(),
  time: new Date().toISOString(), subject: 'timetable', datacontenttype: 'application/json', correlationid: correlationId,
  data: { publishId: crypto.randomUUID(), from: today, to: until, flights: timetable.flights },
};
const connection = await amqp.connect(BUS);
const channel = await connection.createConfirmChannel();
await channel.assertExchange('ecoairlines.events', 'topic', { durable: true });
channel.publish('ecoairlines.events', 'schedule.published', Buffer.from(JSON.stringify(event)), { persistent: true, contentType: 'application/cloudevents+json', messageId: event.id, correlationId, headers: { 'x-correlation-id': correlationId } });
await channel.waitForConfirms();
await connection.close();
console.log(`schedule.published → bus (${timetable.flights.length} vuelos, evento ${event.id})`);
