import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { InvalidTokenError, publicJwk, RemoteJwks, signJwt, verifyJwt } from './jwt.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const options = { issuer: 'ecoairlines-identity', audience: 'ecoairlines', ttlSeconds: 3600 };
const keys = (kid: string): KeyObject | undefined => (kid === publicJwk(publicKey).kid ? publicKey : undefined);
const claims = { sub: 'BOOKING_PROTOTIPO', token_use: 'partner' as const, scope: 'flights:read flights:hold' };

describe('JWT RS256 y JWKS (D22)', () => {
  it('firma y verifica; el kid es la huella de la clave pública', () => {
    const { token } = signJwt(claims, privateKey, options);
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: publicJwk(publicKey).kid });
    expect(verifyJwt(token, keys, options)).toMatchObject({ ...claims, iss: 'ecoairlines-identity', aud: 'ecoairlines' });
    expect(publicJwk(privateKey)).toEqual(publicJwk(publicKey)); // la JWKS nunca expone la parte privada
    expect(Object.keys(publicJwk(privateKey)).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
  });

  it.each([
    ['vencido', () => signJwt(claims, privateKey, { ...options, now: Math.floor(Date.now() / 1000) - 7200 }).token, /vencido/],
    ['otra audiencia', () => signJwt(claims, privateKey, { ...options, audience: 'otra' }).token, /audiencia/],
    ['otro emisor', () => signJwt(claims, privateKey, { ...options, issuer: 'otro' }).token, /emisor/],
    ['firmado con otra clave (kid desconocido)', () => signJwt(claims, other.privateKey, options).token, /kid/],
    ['alg none', () => `${Buffer.from('{"alg":"none","kid":"x"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`, /algoritmo/],
    ['payload alterado', () => {
      const [h, , s] = signJwt(claims, privateKey, options).token.split('.');
      return `${h}.${Buffer.from(JSON.stringify({ ...claims, scope: 'flights:admin', iss: options.issuer, aud: options.audience, exp: 9e9 })).toString('base64url')}.${s}`;
    }, /firma/],
  ])('rechaza un token %s', (_label, make, message) => {
    expect(() => verifyJwt(make(), keys, options)).toThrow(InvalidTokenError);
    expect(() => verifyJwt(make(), keys, options)).toThrow(message);
  });

  it('RemoteJwks descarga la JWKS y la usa para verificar', async () => {
    const server = createServer((_req, res) => res.end(JSON.stringify({ keys: [publicJwk(publicKey)] }))).listen(0);
    await once(server, 'listening');
    const jwks = new RemoteJwks(`http://localhost:${(server.address() as AddressInfo).port}/.well-known/jwks.json`);
    const kid = publicJwk(publicKey).kid;
    const key = await jwks.key(kid);
    server.close();
    const { token } = signJwt(claims, privateKey, options);
    expect(verifyJwt(token, () => key, options).sub).toBe('BOOKING_PROTOTIPO');
  });
});
