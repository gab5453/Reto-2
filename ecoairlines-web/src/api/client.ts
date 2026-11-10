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

// ── Suscripciones por WebSocket (PLAN_Telemetria_Asientos T-5, D-T13) ──
// Como el resto del acceso al gateway, el WebSocket del GraphQL también se abre solo aquí. Protocolo `graphql-transport-ws`:
// `connection_init` con el token → `connection_ack` → `subscribe` → `next`… Cliente mínimo propio, sin dependencias.
const ACK_TIMEOUT_MS = 8_000;

/** `https://…/api/graphql` → `wss://…/api/graphql`. */
export const wsUrl = (httpUrl: string) => httpUrl.replace(/^http/, 'ws');

interface Handlers<T> {
  next: (data: T) => void;
  /** Error de la operación (p. ej. el token venció): la suscripción terminó. */
  error: (message: string, code?: string) => void;
  close: () => void;
}

/** Abre una conexión y una suscripción. Devuelve con qué cerrarla. */
export function openSubscription<T>(token: string, query: string, variables: Record<string, unknown>, handlers: Handlers<T>, opened: () => void): () => void {
  let socket: WebSocket;
  try {
    socket = new WebSocket(wsUrl(GRAPHQL_URL), 'graphql-transport-ws');
  } catch {
    queueMicrotask(handlers.close);
    return () => undefined;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(ackTimer);
    handlers.close();
  };
  // Si el servidor no confirma la conexión a tiempo (un proxy que no deja pasar WebSocket), se pasa al respaldo.
  const ackTimer = setTimeout(() => socket.close(), ACK_TIMEOUT_MS);
  socket.onopen = () => socket.send(JSON.stringify({ type: 'connection_init', payload: { authorization: `Bearer ${token}` } }));
  socket.onmessage = (event) => {
    let message: { type: string; id?: string; payload?: unknown };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.type === 'connection_ack') {
      clearTimeout(ackTimer);
      opened();
      socket.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query, variables } }));
    } else if (message.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong' }));
    } else if (message.type === 'next') {
      const payload = message.payload as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
      if (payload.errors?.length) handlers.error(payload.errors[0]!.message, payload.errors[0]!.extensions?.code);
      else if (payload.data) handlers.next(payload.data);
    } else if (message.type === 'error') {
      const errors = message.payload as { message: string; extensions?: { code?: string } }[];
      handlers.error(errors?.[0]?.message ?? 'Error de la suscripción.', errors?.[0]?.extensions?.code);
    } else if (message.type === 'complete') {
      socket.close();
    }
  };
  socket.onerror = () => socket.close();
  socket.onclose = finish;
  return () => {
    done = true;
    clearTimeout(ackTimer);
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: '1', type: 'complete' }));
    socket.close();
  };
}
