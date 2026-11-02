import { GRAPHQL_URL } from '../config';
import type { ProblemDetails } from './types';

/** Error de la API con el ProblemDetails del contrato (o un error de red, status 0). */
export class ApiError extends Error {
  readonly status: number;
  readonly problem?: ProblemDetails;
  /** Segundos de `retryAfter` (409/429/503 del contrato). */
  readonly retryAfter?: number;
  /** `X-Correlation-Id` del proceso, útil para soporte (el panel lo busca en Telemetría). */
  readonly requestId?: string;

  constructor(status: number, message: string, problem?: ProblemDetails, retryAfter?: number, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
    this.retryAfter = retryAfter;
    this.requestId = requestId;
  }
}

export interface GraphqlOptions {
  token?: string | null;
  /** `X-Device-Fingerprint`: obligatoria en `searchFlights` (límite de búsquedas por navegador). */
  fingerprint?: string;
}

interface GraphqlError {
  message: string;
  extensions?: Partial<ProblemDetails> & { retryAfter?: number; correlation_id?: string };
}

/**
 * Cliente GraphQL de la web (D51): un `fetch` a `/api/graphql` del gateway, sin caché ni dependencias. El token viaja solo en
 * `Authorization` (nunca en la URL) y las respuestas se tratan como datos: el renderizado de React las escapa.
 *
 * Cada error de GraphQL trae el ProblemDetails v2 en `extensions` (contrato `gateway.graphql`, ERRORES): se convierte al mismo
 * `ApiError` que ya usan las pantallas. Si hay errores, la operación falla con el primero (el gateway responde HTTP 200).
 */
export async function graphql<T>(query: string, variables: Record<string, unknown> = {}, options: GraphqlOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.fingerprint) headers['X-Device-Fingerprint'] = options.fingerprint;

  let response: Response;
  try {
    response = await fetch(GRAPHQL_URL, { method: 'POST', headers, body: JSON.stringify({ query, variables }), credentials: 'omit' });
  } catch {
    throw new ApiError(0, 'No se pudo conectar con el servidor. Verifica tu conexión e inténtalo de nuevo.');
  }

  const correlationId = response.headers.get('X-Correlation-Id') ?? undefined;
  const body = (await response.json().catch(() => undefined)) as { data?: T; errors?: GraphqlError[] } | undefined;
  const first = body?.errors?.[0];
  if (first) {
    const extensions = first.extensions ?? {};
    const status = typeof extensions.status === 'number' ? extensions.status : response.ok ? 400 : response.status;
    const problem: ProblemDetails = {
      type: extensions.type ?? 'about:blank',
      title: extensions.title ?? first.message,
      status,
      code: extensions.code ?? 'VALIDATION_FAILED',
      ...(extensions.detail ? { detail: extensions.detail } : {}),
      ...(extensions.invalidParams ? { invalidParams: extensions.invalidParams } : {}),
    };
    throw new ApiError(status, problem.title, problem, extensions.retryAfter, extensions.correlation_id ?? correlationId);
  }
  if (!response.ok || !body?.data) throw new ApiError(response.status || 500, `Error ${response.status}`, undefined, undefined, correlationId);
  return body.data;
}
