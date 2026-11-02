import { createHash, createPublicKey, type JsonWebKey, type KeyObject, randomUUID, sign, verify } from 'node:crypto';

/**
 * JWT RS256 y JWKS (D22) sin dependencias externas: firma y verificación con `node:crypto`.
 * - Identity firma con su clave privada; los demás servicios verifican con la clave pública publicada en
 *   `/.well-known/jwks.json` (ver RemoteJwks), así ninguno necesita un secreto compartido.
 * - Solo se acepta `alg: RS256` (un token con `alg: none` o HS256 se rechaza siempre).
 */
export type TokenUse = 'user' | 'partner' | 'service';

export interface TokenClaims {
  sub: string;
  token_use: TokenUse;
  scope: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  name?: string;
  /** Solo en el token de usuario (V2.13): el gateway arma `me` sin llamar a ningún servicio. */
  email?: string;
  role?: 'CUSTOMER' | 'ADMIN';
}

export interface Jwk {
  kty: 'RSA';
  kid: string;
  use: 'sig';
  alg: 'RS256';
  n: string;
  e: string;
}

const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** `kid` = huella SHA-256 de la clave pública (RFC 7638): cambia si cambia la clave, así se puede rotar. */
export function publicJwk(key: KeyObject): Jwk {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  const { n, e } = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const kid = createHash('sha256').update(JSON.stringify({ e, kty: 'RSA', n })).digest('base64url');
  return { kty: 'RSA', kid, use: 'sig', alg: 'RS256', n, e };
}

export interface SignOptions {
  issuer: string;
  audience: string;
  ttlSeconds: number;
  now?: number;
}

export function signJwt(
  claims: Omit<TokenClaims, 'iss' | 'aud' | 'iat' | 'exp' | 'jti'>,
  privateKey: KeyObject,
  options: SignOptions,
): { token: string; claims: TokenClaims } {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const full: TokenClaims = { ...claims, iss: options.issuer, aud: options.audience, iat: now, exp: now + options.ttlSeconds, jti: randomUUID() };
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: publicJwk(privateKey).kid });
  const payload = encode(full);
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return { token: `${header}.${payload}.${signature}`, claims: full };
}

export class InvalidTokenError extends Error {}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  /** Tolerancia de reloj entre servicios, en segundos. */
  clockToleranceSeconds?: number;
  now?: number;
}

/** Verifica firma, algoritmo, emisor, audiencia y vigencia. `keys` = las claves públicas de la JWKS por `kid`. */
export function verifyJwt(token: string, keys: (kid: string) => KeyObject | undefined, options: VerifyOptions): TokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new InvalidTokenError('formato inválido');
  const [header64, payload64, signature64] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: TokenClaims;
  try {
    header = JSON.parse(Buffer.from(header64, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(payload64, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidTokenError('no se pudo leer el token');
  }
  if (header.alg !== 'RS256') throw new InvalidTokenError(`algoritmo no permitido: ${header.alg}`);
  const key = header.kid ? keys(header.kid) : undefined;
  if (!key) throw new InvalidTokenError('clave desconocida (kid)');
  if (!verify('RSA-SHA256', Buffer.from(`${header64}.${payload64}`), key, Buffer.from(signature64, 'base64url'))) {
    throw new InvalidTokenError('firma inválida');
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockToleranceSeconds ?? 30;
  if (claims.iss !== options.issuer) throw new InvalidTokenError('emisor inválido');
  if (claims.aud !== options.audience) throw new InvalidTokenError('audiencia inválida');
  if (typeof claims.exp !== 'number' || claims.exp + tolerance < now) throw new InvalidTokenError('token vencido');
  if (typeof claims.iat === 'number' && claims.iat - tolerance > now) throw new InvalidTokenError('token emitido en el futuro');
  if (!['user', 'partner', 'service'].includes(claims.token_use)) throw new InvalidTokenError('token_use inválido');
  return claims;
}

export const scopesOf = (claims: Pick<TokenClaims, 'scope'>): string[] => claims.scope.split(' ').filter(Boolean);

/**
 * Cliente de la JWKS de MS.G.Identity para los demás servicios: la descarga al primer uso, la guarda una hora y la vuelve
 * a pedir si aparece un `kid` desconocido (rotación de claves).
 */
export class RemoteJwks {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;

  constructor(
    private readonly url: string,
    private readonly maxAgeMs = 3_600_000,
  ) {}

  async key(kid: string): Promise<KeyObject | undefined> {
    const stale = Date.now() - this.fetchedAt > this.maxAgeMs;
    if (stale || !this.keys.has(kid)) await this.refresh();
    return this.keys.get(kid);
  }

  private async refresh(): Promise<void> {
    // Como mucho una descarga cada 10 s, aunque lleguen muchos kid desconocidos (evita que un atacante sature a Identity).
    if (Date.now() - this.fetchedAt < 10_000 && this.keys.size) return;
    const response = await fetch(this.url);
    if (!response.ok) throw new Error(`JWKS ${this.url} respondió ${response.status}`);
    const { keys } = (await response.json()) as { keys: Jwk[] };
    this.keys = new Map(keys.filter((k) => k.alg === 'RS256').map((k) => [k.kid, createPublicKey({ key: { ...k } as JsonWebKey, format: 'jwk' })]));
    this.fetchedAt = Date.now();
  }
}
