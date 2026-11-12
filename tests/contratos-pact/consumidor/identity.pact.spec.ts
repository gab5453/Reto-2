import { MatchersV3, PactV3 } from '@pact-foundation/pact';
import { ServiceTokenProvider } from '@ecoairlines/shared/clients/service-token.js';
import { PACT_DIR, PARTICIPANTES } from '../comun.js';

/**
 * Contrato del CONSUMIDOR (CT-1): todo servicio que llama a otro pide su token de servicio a MS.G.Identity con
 * `client_credentials` (D41, D44). El consumidor es la clase real `ServiceTokenProvider`; el proveedor, un servidor simulado de
 * Pact que responde lo que aquí se declara. Al terminar, Pact escribe `contract/pacts/<consumidor>-ms-g-identity.json`.
 *
 * Se usa la interfaz V3 de Pact: es la que permite declarar un cuerpo `application/x-www-form-urlencoded` (el de OAuth2).
 * Los secretos son los de DESARROLLO (públicos en `infra/docker-compose.yml`): el proveedor los conoce al verificar.
 */
const { like, integer, regex } = MatchersV3;
const SECRETO_ESB = 'secreto-esb-dev-solo-local-0001';
const SECRETO_RESERVAS = 'secreto-ms-reservas-dev-solo-local-0001';
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

/** La petición de token: Basic (cualquier valor con esa forma; el ejemplo es el real de desarrollo) y el formulario de OAuth2. */
const peticionDeToken = (clientId: string, secret: string) => ({
  method: 'POST',
  path: '/oauth2/token',
  headers: { authorization: regex(/^Basic [A-Za-z0-9+/=]+$/, basic(clientId, secret)), 'content-type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
  contentType: 'application/x-www-form-urlencoded',
});

describe('ESB → MS.G.Identity: token de servicio (POST /oauth2/token)', () => {
  const pact = new PactV3({ consumer: PARTICIPANTES.esb, provider: PARTICIPANTES.identity, dir: PACT_DIR, logLevel: 'warn' });

  it('con sus credenciales recibe un token Bearer con el scope ecoairlines:internal y su duración', () => {
    pact
      .given('existe el cliente interno ECOAIRLINES_ESB')
      .uponReceiving('una petición de token de servicio del ESB')
      .withRequest(peticionDeToken('ECOAIRLINES_ESB', SECRETO_ESB))
      .willRespondWith({
        status: 200,
        body: { access_token: like('eyJhbGciOiJSUzI1NiJ9.ejemplo.firma'), token_type: 'Bearer', expires_in: integer(3600), scope: 'ecoairlines:internal' },
      });
    return pact.executeTest(async (mockServer) => {
      // El código real del consumidor: si el contrato no le sirve, esta línea falla.
      expect(await new ServiceTokenProvider(mockServer.url, 'ECOAIRLINES_ESB', SECRETO_ESB).token()).toBe('eyJhbGciOiJSUzI1NiJ9.ejemplo.firma');
    });
  });

  it('con un secreto incorrecto recibe invalid_client (401) y lo trata como Identity no disponible', () => {
    pact
      .given('existe el cliente interno ECOAIRLINES_ESB')
      .uponReceiving('una petición de token con un secreto incorrecto')
      .withRequest(peticionDeToken('ECOAIRLINES_ESB', 'secreto-incorrecto'))
      .willRespondWith({ status: 401, body: { error: 'invalid_client', error_description: like('Credenciales del cliente inválidas.') } });
    return pact.executeTest(async (mockServer) => {
      await expect(new ServiceTokenProvider(mockServer.url, 'ECOAIRLINES_ESB', 'secreto-incorrecto').token()).rejects.toMatchObject({ problem: { code: 'PROVIDER_UNAVAILABLE' } });
    });
  });
});

describe('MS de respuesta → MS.G.Identity: su token para llamar al ESB (D44)', () => {
  const pact = new PactV3({ consumer: PARTICIPANTES.msRespuesta, provider: PARTICIPANTES.identity, dir: PACT_DIR, logLevel: 'warn' });

  it('MS.Reservas recibe un token con el scope ecoairlines:esb (el único que acepta el ESB de un MS de respuesta)', () => {
    pact
      .given('existe el cliente interno ECOAIRLINES_MS_RESERVAS')
      .uponReceiving('una petición de token de servicio de MS.Reservas')
      .withRequest(peticionDeToken('ECOAIRLINES_MS_RESERVAS', SECRETO_RESERVAS))
      .willRespondWith({ status: 200, body: { access_token: like('eyJ.ejemplo.reservas'), token_type: 'Bearer', expires_in: integer(3600), scope: 'ecoairlines:esb' } });
    return pact.executeTest(async (mockServer) => {
      expect(await new ServiceTokenProvider(mockServer.url, 'ECOAIRLINES_MS_RESERVAS', SECRETO_RESERVAS).token()).toBe('eyJ.ejemplo.reservas');
    });
  });
});
