// Genera infra/cloud/.env para la nube (V2.14): secretos aleatorios propios en lugar de los de desarrollo del repositorio.
// Uso: node scripts/cloud/generar-env.mjs --domain ecoairlines-reto2.northcentralus.cloudapp.azure.com
//        [--booking-grpc booking.epn.edu.ec:50051]
// El archivo NUNCA se sube al repositorio (.gitignore) y no se sobrescribe si ya existe: rotar la clave de Identity
// invalidaría los tokens emitidos, y cambiar las contraseñas de PostgreSQL dejaría las bases ya creadas inaccesibles.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((pair) => pair.trim().split(/\s+/)));
const domain = args.domain;
if (!domain) {
  console.error('Uso: node scripts/cloud/generar-env.mjs --domain <nombre DNS de la VM> [--booking-grpc host:puerto]');
  process.exit(1);
}
const target = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'infra', 'cloud', '.env');
if (existsSync(target)) {
  console.error(`${target} ya existe: no se sobrescribe (ver el comentario del script).`);
  process.exit(1);
}

/** Secreto URL-safe sin caracteres que rompan una URL de conexión (postgres://, amqp://). */
const secret = (bytes = 24) => randomBytes(bytes).toString('base64url');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim().replace(/\n/g, '\\n');

const values = {
  DOMAIN: domain,
  // Stock a Booking en Azure por REST (D53); el gRPC queda como alternativa si se vacía la URL.
  BOOKING_STOCK_URL: 'https://booking-core-api.azurewebsites.net/api/v2/inventory/stock',
  BOOKING_GRPC_ADDRESS: args['booking-grpc'] ?? 'booking.epn.edu.ec:50051',
  BOOKING_BUS_URL: '',
  CORS_ORIGINS: '',
  POSTGRES_ADMIN_USER: 'ecoairlines_admin',
  POSTGRES_ADMIN_PASSWORD: secret(),
  ...Object.fromEntries(['IDENTITY', 'CUSTOMERS', 'WEBHOOKS', 'SCHEDULE', 'OFFERS', 'FLIGHT_STATUS', 'BOOKINGS', 'POST_SALE', 'CHECK_IN', 'ESB', 'PAYMENT'].map((name) => [`PG_PASSWORD_${name}`, secret()])),
  RABBITMQ_USER: 'ecoairlines',
  RABBITMQ_PASSWORD: secret(),
  // Comillas simples: Compose no interpreta los `\n` (Identity los convierte en saltos de línea).
  IDENTITY_PRIVATE_KEY: `'${pem}'`,
  ADMIN_PASSWORD: secret(12),
  BOOKING_CLIENT_SECRET: secret(32),
  ESB_CLIENT_SECRET: secret(32),
  ...Object.fromEntries(['VUELOS', 'RESERVAS', 'POSTVENTA', 'CLIENTES', 'ADMIN'].map((name) => [`MS_${name}_CLIENT_SECRET`, secret(32)])),
  WEBHOOKS_ENCRYPTION_KEY: secret(48),
  // Firma de los eventos que nos envía Booking (BKG-01): se entrega a Booking por un canal privado.
  AIRLINE_EVENTS_SECRET: secret(32),
  BOOKING_SIM_WEBHOOK_SECRET: secret(32),
  // Payment API simulada (D49): pública para el navegador, secreta solo para el ESB.
  PAYMENT_PUBLISHABLE_KEY: `pk_test_${secret(24)}`,
  PAYMENT_SECRET_KEY: `sk_test_${secret(32)}`,
  // Grafana (D50): usuario `admin`.
  GRAFANA_ADMIN_PASSWORD: secret(18),
};

const lines = [
  '# Generado por scripts/cloud/generar-env.mjs (V2.14). SECRETO: no subir al repositorio ni compartir por canales públicos.',
  '# A Booking se le entrega solo: la URL base, BOOKING_CLIENT_SECRET (client_id BOOKING_PROTOTIPO) y AIRLINE_EVENTS_SECRET.',
  ...Object.entries(values).map(([name, value]) => `${name}=${value}`),
];
writeFileSync(target, `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(`Escrito ${target} (${Object.keys(values).length} variables). La contraseña del administrador está en ADMIN_PASSWORD.`);
