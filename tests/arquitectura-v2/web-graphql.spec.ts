import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchema, parse, validate } from 'graphql';

/**
 * La web contra el contrato GraphQL (V2.17, D51). La web no genera tipos del esquema: cada operación de
 * `ecoairlines-web/src/api/operations.ts` y `admin.ts` escribe su documento a mano. Esta prueba ejecuta TODAS esas funciones
 * con `fetch` interceptado y valida cada documento enviado contra `contract/gateway.graphql` (campos, argumentos, tipos de
 * las variables). Así un cambio del contrato que rompa la web falla aquí y no en el navegador.
 *
 * Además verifica la regla de la fase: la web solo llama al GraphQL del gateway y a la Payment API (ningún `fetch` fuera de
 * `api/client.ts` y `api/payments.ts`, ninguna URL REST del sistema).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WEB = join(ROOT, 'ecoairlines-web', 'src');
const schema = buildSchema(readFileSync(join(ROOT, 'contract', 'gateway.graphql'), 'utf8'));

type Sent = { url: string; body?: string; headers: Record<string, string> };
const sent: Sent[] = [];

/** La ruta va en una variable: así `tsc` (que no conoce `import.meta.env` de Vite) no revisa el código de la web. */
const webModule = (path: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ join(WEB, path));

beforeAll(() => {
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
    sent.push({ url: String(url), body: init.body as string | undefined, headers: init.headers as Record<string, string> });
    // Un error de GraphQL: cada función rechaza enseguida, después de haber enviado su documento.
    return new Response(JSON.stringify({ errors: [{ message: 'prueba', extensions: { status: 500, code: 'INTERNAL_ERROR' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});
afterAll(() => vi.unstubAllGlobals());

/** Llama a cada función exportada con argumentos de relleno (el documento no depende de ellos) y devuelve lo enviado. */
async function documentsOf(path: string) {
  const module = await webModule(path);
  const functions = Object.entries(module).filter(([, value]) => typeof value === 'function') as [string, (...args: unknown[]) => Promise<unknown>][];
  const documents: { name: string; query: string; url: string }[] = [];
  for (const [name, fn] of functions) {
    const before = sent.length;
    await fn('token', 'x', 'x', {}).catch(() => undefined);
    for (const request of sent.slice(before)) documents.push({ name, query: (JSON.parse(request.body ?? '{}') as { query: string }).query, url: request.url });
  }
  return { functions: functions.map(([name]) => name), documents };
}

describe('la web usa solo el contrato GraphQL del gateway', () => {
  it.each(['api/operations.ts', 'api/admin.ts'])('★ cada operación de %s es un documento válido contra gateway.graphql', async (path) => {
    const { functions, documents } = await documentsOf(path);
    // Cada función exportada envió exactamente un documento.
    expect(documents.map((d) => d.name).sort()).toEqual(functions.sort());
    for (const { name, query, url } of documents) {
      expect(url, name).toMatch(/\/api\/graphql$/);
      const errors = validate(schema, parse(query)).map((error) => error.message);
      expect(errors, `${name}:\n${query}`).toEqual([]);
    }
  });

  it('la Payment API se llama con la clave PÚBLICA (pk_test_…) y la tarjeta nunca va al GraphQL', async () => {
    const payments = await webModule('api/payments.ts');
    const before = sent.length;
    await (payments['authorizeCard'] as (...args: unknown[]) => Promise<unknown>)({ holderName: 'A B', number: '4242424242424242', expMonth: 12, expYear: 2030, cvv: '123' }, { currency: 'USD', total: '10.00' }, 'prueba').catch(() => undefined);
    const calls = sent.slice(before);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/payment-methods', '/payments']);
    for (const call of calls) {
      expect(call.headers['X-Api-Key']).toMatch(/^pk_test_/);
      expect(call.headers['Authorization']).toBeUndefined();
    }
    // El número y el CVV viajan solo al tokenizar; la autorización lleva el token de la tarjeta.
    expect(calls[0]!.body).toContain('4242424242424242');
    expect(calls[1]!.body).not.toContain('4242424242424242');
    const graphqlBodies = sent.filter((call) => call.url.endsWith('/api/graphql')).map((call) => call.body ?? '');
    expect(graphqlBodies.some((body) => body.includes('4242424242424242'))).toBe(false);
  });

  it('★ ningún archivo de la web hace fetch fuera de api/client.ts (GraphQL) y api/payments.ts (Payment API)', () => {
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
      });
    })(WEB);
    const allowed = new Set([join('api', 'client.ts'), join('api', 'payments.ts')]);
    const offenders = files.filter((file) => !allowed.has(relative(WEB, file)) && /\bfetch\(|XMLHttpRequest|new WebSocket/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(WEB, file).split(sep).join('/'))).toEqual([]);
    // Ninguna URL REST del sistema (la fachada /api/v2 es de Booking; el monolito y dev-auth se retiran).
    const rest = files.filter((file) => /\/api\/v2|localhost:3000|localhost:4000/.test(readFileSync(file, 'utf8')));
    expect(rest.map((file) => relative(WEB, file))).toEqual([]);
  });
});
