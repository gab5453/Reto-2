import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prueba de arquitectura del Reto 2 (V2.2). Verifica sobre el código fuente las reglas de CLAUDE.md y PLAN.md:
 * 1. Un servicio no importa código interno de otro: entre paquetes solo se importa `@ecoairlines/shared`.
 * 2. `packages/shared` no depende de ningún servicio.
 * 3. Ningún paquete nuevo depende del monolito (`@ecoairlines/api|business|data-management|data-access`).
 * 4. Un MS.G nunca llama a otro MS.G (no nombra el host de otro `ms-g-*`).
 * 5. Hacia Booking solo hablan MS.G.Offers (stock gRPC), MS.G.Webhooks (entrega) y el ESB (entrada de eventos); el
 *    simulador de Booking queda fuera porque ES Booking.
 * 6. Un MS de respuesta solo habla con el ESB (V2.12, D43): no nombra el host de un MS.G ni usa gRPC, SOAP, RabbitMQ o una
 *    base de datos.
 * 7. El gateway solo habla con los MS de respuesta (V2.13, PLAN.md §4.4): no nombra al ESB (su URL ni sus rutas
 *    `/router`, `/sagas`, `/composition`) ni a un MS.G, ni usa gRPC, SOAP, RabbitMQ o una base de datos.
 * Cada regla tiene además un caso sintético que comprueba que SÍ detecta la violación (para que no pase en vacío mientras
 * hay pocos servicios).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Workspace {
  name: string;
  dir: string;
  kind: 'shared' | 'gestion' | 'respuesta' | 'externo' | 'esb' | 'gateway';
}

function workspaces(): Workspace[] {
  const found: Workspace[] = [{ name: 'shared', dir: join(ROOT, 'packages', 'shared'), kind: 'shared' }];
  for (const [group, kind] of [['gestion', 'gestion'], ['respuesta', 'respuesta'], ['externos', 'externo']] as const) {
    const base = join(ROOT, 'services', group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) if (statSync(join(base, name)).isDirectory()) found.push({ name, dir: join(base, name), kind });
  }
  for (const kind of ['esb', 'gateway'] as const) {
    if (existsSync(join(ROOT, 'services', kind))) found.push({ name: kind, dir: join(ROOT, 'services', kind), kind });
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.split(sep).some((part) => part === 'node_modules' || part === 'dist'))
    .map((file) => join(dir, file));
}

const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
const MONOLITH = /^@ecoairlines\/(api|business|data-management|data-access)(\/|$)/;

/** Violaciones de las reglas 1–3 en un archivo. */
/** Quita los comentarios de bloque y de línea completa (los ejemplos de import en la documentación no cuentan). */
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

export function importViolations(file: string, source: string, own: Workspace): string[] {
  const errors: string[] = [];
  for (const [, specifier] of withoutComments(source).matchAll(IMPORT)) {
    if (MONOLITH.test(specifier!)) errors.push(`${specifier}: depende del monolito`);
    else if (specifier!.startsWith('@ecoairlines/') && !/^@ecoairlines\/shared(\/|$)/.test(specifier!)) {
      errors.push(`${specifier}: importa otro servicio (solo se permite @ecoairlines/shared)`);
    } else if (own.kind === 'shared' && specifier!.startsWith('@ecoairlines/')) {
      errors.push(`${specifier}: la librería compartida no puede depender de un servicio`);
    } else if (specifier!.startsWith('.')) {
      const target = resolve(dirname(file), specifier!);
      // Excepción: las pruebas de un servicio (`<servicio>/test/`) pueden usar el código de pruebas compartido (`tests/support/`).
      const sharedTestSupport = file.startsWith(join(own.dir, 'test') + sep) && target.startsWith(join(ROOT, 'tests', 'support') + sep);
      if (!target.startsWith(own.dir + sep) && !sharedTestSupport) errors.push(`${specifier}: sale del paquete ${own.name} con una ruta relativa`);
    }
  }
  return errors;
}

/** Regla 4: un MS.G no nombra el host de otro MS.G. */
export function crossMsgViolations(source: string, own: Workspace): string[] {
  if (own.kind !== 'gestion') return [];
  return [...new Set([...source.matchAll(/\bms-g-[a-z-]+/g)].map(([host]) => host!))]
    .filter((host) => host !== own.name)
    .map((host) => `nombra a ${host}: un MS.G nunca llama a otro MS.G (solo el ESB los coordina)`);
}

// Marcas de COMUNICACIÓN con Booking (dirección, gRPC de stock, eventos, webhooks). Mencionar al partner no cuenta:
// Identity guarda y autentica a BOOKING_PROTOTIPO (BOOKING_CLIENT_SECRET) pero nunca le habla.
const BOOKING_MARKERS =
  /booking-inventory\.proto|InventoryStockService|\bBOOKING_(?!SIM_)(?:[A-Z]+_)*(?:URL|HOST|PORT|ADDRESS|ENDPOINT|GRPC|STOCK|EVENTS|BUS|WEBHOOKS?)\b|booking\.epn\.edu\.ec/;
const MAY_TALK_TO_BOOKING = new Set(['ms-g-offers', 'ms-g-webhooks', 'esb', 'booking-simulado']);

/**
 * Regla 6: el código (`src/`) de un MS de respuesta no nombra a un MS.G ni usa sus protocolos o una base de datos: su única
 * salida es el ESB. Sus pruebas sí nombran contratos de los MS.G (`ms-g-identity.openapi.yaml`) para validar respuestas.
 */
const RESPONSE_FORBIDDEN = /\bms-g-[a-z-]+|['"](@grpc\/grpc-js|@grpc\/proto-loader|soap|amqplib|pg)['"]/g;
export function responseViolations(source: string, own: Workspace): string[] {
  if (own.kind !== 'respuesta') return [];
  return [...new Set([...source.matchAll(RESPONSE_FORBIDDEN)].map(([match]) => match!))].map((match) => `usa ${match}: un MS de respuesta solo habla con el ESB`);
}

/** Regla 7: el código (`src/`) del gateway solo llama a los 5 MS de respuesta (sin contar los comentarios). */
const GATEWAY_FORBIDDEN = /\bms-g-[a-z-]+|\bESB_URL\b|\/\/esb[:/]|['"`]\/(?:router|sagas|composition)\/|['"](@grpc\/grpc-js|@grpc\/proto-loader|soap|amqplib|pg)['"]/g;
export function gatewayViolations(source: string, own: Workspace): string[] {
  if (own.kind !== 'gateway') return [];
  return [...new Set([...withoutComments(source).matchAll(GATEWAY_FORBIDDEN)].map(([match]) => match!))].map((match) => `usa ${match}: el gateway solo habla con los MS de respuesta`);
}

/** Regla 5: referencias a la integración con Booking fuera de las tres piezas autorizadas. */
export function bookingViolations(source: string, own: Workspace): string[] {
  if (MAY_TALK_TO_BOOKING.has(own.name) || own.kind === 'shared') return [];
  const match = source.match(BOOKING_MARKERS);
  return match ? [`usa ${match[0]}: hacia Booking solo hablan Offers, Webhooks y el ESB`] : [];
}

describe('arquitectura del Reto 2 (microservicios)', () => {
  const all = workspaces();

  it('encuentra la librería compartida y los servicios', () => {
    expect(all.map((w) => w.name)).toEqual(expect.arrayContaining(['shared', 'booking-simulado']));
  });

  it('encuentra los 5 MS de respuesta', () => {
    expect(all.filter((w) => w.kind === 'respuesta').map((w) => w.name).sort()).toEqual(['ms-admin', 'ms-clientes', 'ms-postventa', 'ms-reservas', 'ms-vuelos']);
  });

  it.each(all.map((w) => [w.name, w] as const))('%s respeta las reglas 1 a 6', (_name, workspace) => {
    const errors = sourceFiles(workspace.dir).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...importViolations(file, source, workspace), ...crossMsgViolations(source, workspace), ...bookingViolations(source, workspace), ...(file.includes(`${sep}src${sep}`) ? [...responseViolations(source, workspace), ...gatewayViolations(source, workspace)] : [])].map(
        (error) => `${relative(ROOT, file)}: ${error}`,
      );
    });
    expect(errors).toEqual([]);
  });

  describe('cada regla detecta su violación (casos sintéticos)', () => {
    const offers: Workspace = { name: 'ms-g-offers', dir: join(ROOT, 'services', 'gestion', 'ms-g-offers'), kind: 'gestion' };
    const bookings: Workspace = { name: 'ms-g-bookings', dir: join(ROOT, 'services', 'gestion', 'ms-g-bookings'), kind: 'gestion' };
    const shared: Workspace = { name: 'shared', dir: join(ROOT, 'packages', 'shared'), kind: 'shared' };
    const file = join(bookings.dir, 'src', 'x.ts');

    it('regla 1: importar otro servicio o salir del paquete', () => {
      expect(importViolations(file, `import { X } from '@ecoairlines/ms-g-offers';`, bookings)).toHaveLength(1);
      expect(importViolations(file, `import { X } from '../../ms-g-offers/src/x.js';`, bookings)).toHaveLength(1);
      expect(importViolations(file, `import { X } from '@ecoairlines/shared';\nimport { Y } from './y.js';`, bookings)).toEqual([]);
    });

    it('regla 1: solo las pruebas de un servicio usan tests/support (el código de src/ no)', () => {
      const support = (depth: number) => `import { contractValidator } from '${'../'.repeat(depth)}tests/support/openapi-contract.js';`;
      expect(importViolations(join(bookings.dir, 'test', 'x.spec.ts'), support(4), bookings)).toEqual([]);
      expect(importViolations(join(bookings.dir, 'src', 'x', 'y.ts'), support(5), bookings)).toHaveLength(1);
    });

    it('regla 2: la librería compartida no depende de servicios', () => {
      expect(importViolations(join(shared.dir, 'src', 'x.ts'), `import { X } from '@ecoairlines/ms-g-offers';`, shared)).toHaveLength(1);
    });

    it('un import dentro de un comentario no cuenta', () => {
      expect(importViolations(file, `/** Ejemplo: import { X } from '@ecoairlines/ms-g-offers'; */
// import { Y } from '@ecoairlines/api/x.js';`, bookings)).toEqual([]);
    });

    it('regla 3: nadie depende del monolito', () => {
      expect(importViolations(file, `import { X } from '@ecoairlines/business/services/x.js';`, bookings)).toEqual([expect.stringContaining('monolito')]);
    });

    it('regla 4: un MS.G no llama a otro', () => {
      expect(crossMsgViolations(`const url = 'http://ms-g-offers:8080';`, bookings)).toHaveLength(1);
      expect(crossMsgViolations(`const name = 'ms-g-bookings';`, bookings)).toEqual([]);
    });

    it('regla 6: un MS de respuesta solo habla con el ESB', () => {
      const vuelos: Workspace = { name: 'ms-vuelos', dir: join(ROOT, 'services', 'respuesta', 'ms-vuelos'), kind: 'respuesta' };
      expect(responseViolations(`fetch('http://ms-g-bookings:8080/bookings')`, vuelos)).toHaveLength(1);
      expect(responseViolations(`import * as grpc from '@grpc/grpc-js';`, vuelos)).toHaveLength(1);
      expect(responseViolations(`import pg from 'pg';`, vuelos)).toHaveLength(1);
      expect(responseViolations(`context.esb({ path: '/router/bookings/bookings' })`, vuelos)).toEqual([]);
      expect(responseViolations(`fetch('http://ms-g-bookings:8080')`, bookings)).toEqual([]);
    });

    it('regla 7: el gateway solo habla con los MS de respuesta', () => {
      const gateway: Workspace = { name: 'gateway', dir: join(ROOT, 'services', 'gateway'), kind: 'gateway' };
      expect(gatewayViolations(`fetch(process.env['ESB_URL'] + '/router/bookings/bookings')`, gateway)).toHaveLength(2);
      expect(gatewayViolations(`fetch('http://esb:8080/health')`, gateway)).toHaveLength(1);
      expect(gatewayViolations(`fetch('http://ms-g-identity:8080/oauth2/token')`, gateway)).toHaveLength(1);
      expect(gatewayViolations(`import amqp from 'amqplib';`, gateway)).toHaveLength(1);
      expect(gatewayViolations(`ms.call('MS.Reservas', 'GET', '/vuelos/bookings')`, gateway)).toEqual([]);
      expect(gatewayViolations(`// nunca llama al ESB (/router/…)
const x = 1;`, gateway)).toEqual([]);
      expect(gatewayViolations(`fetch('http://esb:8080/health')`, { ...gateway, kind: 'respuesta' })).toEqual([]);
    });

    it('regla 5: solo Offers, Webhooks y el ESB hablan con Booking', () => {
      expect(bookingViolations(`load('booking-inventory.proto')`, bookings)).toHaveLength(1);
      expect(bookingViolations(`process.env.BOOKING_STOCK_URL`, bookings)).toHaveLength(1);
      expect(bookingViolations(`load('booking-inventory.proto')`, offers)).toEqual([]);
      expect(bookingViolations(`process.env.BOOKING_GRPC_ADDRESS`, bookings)).toHaveLength(1);
      // Identity autentica al partner Booking sin hablarle: su secreto y su clientId no son comunicación.
      expect(bookingViolations(`env['BOOKING_CLIENT_SECRET']; const id = 'BOOKING_PROTOTIPO';`, bookings)).toEqual([]);
    });
  });
});
