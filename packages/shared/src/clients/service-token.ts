import { correlationHeaders } from '../correlation/correlation.js';
import { ProblemDetailsException } from '../problem-details/problem-details.js';

/** Fuente del token de servicio: el del ESB hacia los MS.G (D41) o el de un MS de respuesta hacia el ESB (D44). */
export interface TokenSource {
  token(): Promise<string>;
  /** Olvida el token guardado (un MS.G lo rechazó: p. ej. Identity rotó sus claves). */
  invalidate?(): void;
}

/**
 * Token de servicio: `client_credentials` contra MS.G.Identity (`POST /oauth2/token`, `token_use = service`). El ESB recibe el
 * scope `ecoairlines:internal` (D41) y cada MS de respuesta `ecoairlines:esb` (D44). Se guarda en memoria y se renueva 60 s antes
 * de vencer; si varias llamadas lo piden a la vez, se pide una sola vez. El token nunca se escribe en logs.
 */
export class ServiceTokenProvider implements TokenSource {
  private cached?: { token: string; expiresAt: number };
  private pending?: Promise<string>;

  constructor(
    private readonly identityUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly timeoutMs = 4_000,
  ) {}

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > Date.now()) return this.cached.token;
    this.pending ??= this.fetchToken().finally(() => (this.pending = undefined));
    return this.pending;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`).toString('base64');
    let response: Response;
    try {
      response = await fetch(`${this.identityUrl}/oauth2/token`, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', ...correlationHeaders() },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw unavailable('MS.G.Identity no respondió al pedir el token de servicio.');
    }
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token) throw unavailable(`MS.G.Identity rechazó las credenciales de ${this.clientId} (${response.status}).`);
    this.cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
    return body.access_token;
  }
}

const unavailable = (title: string) => new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title, retryAfterSeconds: 5 });
