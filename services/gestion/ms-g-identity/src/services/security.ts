import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Contraseñas y secretos de partner derivados con scrypt y sal propia (igual que dev-auth). Formato guardado:
 * `scrypt$<sal hex>$<hash hex>`. Se usa la versión asíncrona para no bloquear el event loop en cada login.
 */
const scryptAsync = promisify(scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>;
const KEY_LENGTH = 64;

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await scryptAsync(secret, salt, KEY_LENGTH)).toString('hex')}`;
}

/**
 * Compara en tiempo constante. Sin hash (usuario inexistente) se deriva igual con una sal fija, para que un correo
 * inexistente tarde lo mismo que una contraseña incorrecta y no revele qué cuentas existen.
 */
export async function verifySecret(secret: string, stored: string | undefined): Promise<boolean> {
  const [, salt = 'sin-usuario', hash = ''] = (stored ?? '').split('$');
  const candidate = await scryptAsync(secret, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');
  return stored !== undefined && expected.length === KEY_LENGTH && timingSafeEqual(candidate, expected);
}

/** Secreto de partner generado por el servicio: 32 bytes aleatorios en base64url (se muestra una sola vez). */
export const newClientSecret = (): string => randomBytes(32).toString('base64url');

/** Límite de intentos por clave (IP o client_id) en una ventana de 1 minuto. */
export class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly perMinute: number) {}

  /** Registra un intento; devuelve los segundos de espera si se pasó del límite. */
  hit(key: string, now = Date.now()): number | undefined {
    const recent = (this.attempts.get(key) ?? []).filter((time) => now - time < 60_000);
    recent.push(now);
    this.attempts.set(key, recent);
    if (this.attempts.size > 10_000) this.attempts.delete(this.attempts.keys().next().value!);
    return recent.length > this.perMinute ? Math.ceil((60_000 - (now - recent[0]!)) / 1000) : undefined;
  }
}

/** UUID con forma v4 derivado del correo: los usuarios de prueba conservan su `sub` (y sus reservas) entre reinicios. */
export function seedSub(email: string): string {
  const hex = createHash('sha256').update(`ecoairlines-seed:${email}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
