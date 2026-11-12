import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, graphql, openSubscription, wsUrl } from './client';

/**
 * PU-4 (Informacion_General/Pruebas.md §5.1.4): el único punto de acceso de la web al gateway. `fetch` y `WebSocket` son
 * dobles: nada sale a la red.
 */

const respuesta = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('graphql()', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  // Con llaves: si beforeEach DEVUELVE una función, Vitest la usa como limpieza y llamaría al spy al terminar cada prueba.
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  it('envía la consulta por POST, con el token en Authorization (nunca en la URL) y sin cookies', async () => {
    fetchSpy.mockResolvedValue(respuesta({ data: { ok: true } }));
    expect(await graphql('{ ok }', { a: 1 }, { token: 't-123', fingerprint: 'fp-1' })).toEqual({ ok: true });
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).not.toContain('t-123');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', body: JSON.stringify({ query: '{ ok }', variables: { a: 1 } }) });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer t-123', 'X-Device-Fingerprint': 'fp-1' });
  });
  it('con token y sin huella (casi todas las consultas) igual manda Authorization (lo encontró la mutación manual)', async () => {
    fetchSpy.mockResolvedValue(respuesta({ data: {} }));
    await graphql('{ ok }', {}, { token: 't-9' });
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer t-9');
    expect(headers).not.toHaveProperty('X-Device-Fingerprint');
  });
  it('sin token no manda Authorization', async () => {
    fetchSpy.mockResolvedValue(respuesta({ data: {} }));
    await graphql('{ ok }');
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty('Authorization');
  });
  it('un error de GraphQL se convierte en ApiError con el ProblemDetails de extensions', async () => {
    fetchSpy.mockResolvedValue(
      respuesta({ errors: [{ message: 'Asiento no disponible', extensions: { code: 'SEAT_TAKEN', status: 409, detail: 'El 12A ya fue tomado.', retryAfter: 2, correlation_id: 'corr-1' } }] }),
    );
    const error = (await graphql('{ x }').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: 'Asiento no disponible', retryAfter: 2, requestId: 'corr-1', problem: { code: 'SEAT_TAKEN', detail: 'El 12A ya fue tomado.' } });
  });
  it('si el error no trae correlation_id, usa la cabecera X-Correlation-Id de la respuesta', async () => {
    fetchSpy.mockResolvedValue(respuesta({ errors: [{ message: 'x' }] }, 200, { 'X-Correlation-Id': 'corr-cabecera' }));
    expect(((await graphql('{ x }').catch((e: unknown) => e)) as ApiError).requestId).toBe('corr-cabecera');
  });
  it('sin conexión (fetch falla): status 0 y el mensaje de "verifica tu conexión"', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = (await graphql('{ x }').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.message).toContain('No se pudo conectar');
  });
  it('un 503 del proxy mientras un servicio reinicia NO se muestra como "sin conexión" (incidente del 10/11)', async () => {
    fetchSpy.mockResolvedValue(respuesta({ status: 503, code: 'PROVIDER_UNAVAILABLE', title: 'Servicio no disponible' }, 503));
    const error = (await graphql('{ x }').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(503);
    expect(error.message).not.toContain('No se pudo conectar');
  });
  it('una respuesta que no es JSON (HTML de error) también da un ApiError con su status', async () => {
    fetchSpy.mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 }));
    expect(((await graphql('{ x }').catch((e: unknown) => e)) as ApiError).status).toBe(502);
  });
});

// ------------------------------------------------------------------------------------------------ WebSocket
class FakeSocket {
  static OPEN = 1;
  static ultimo: FakeSocket;
  readyState = 1;
  sent: { type: string; id?: string; payload?: unknown }[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  readonly url: string;
  readonly protocol: string;
  constructor(url: string, protocol: string) {
    this.url = url;
    this.protocol = protocol;
    FakeSocket.ultimo = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  recibir(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe('openSubscription (graphql-transport-ws, T-5)', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const handlers = () => ({ next: vi.fn(), error: vi.fn(), close: vi.fn() });

  it('wsUrl: http → ws y https → wss', () => {
    expect(wsUrl('https://x/api/graphql')).toBe('wss://x/api/graphql');
    expect(wsUrl('http://localhost:8088/api/graphql')).toBe('ws://localhost:8088/api/graphql');
  });
  it('abre con el protocolo graphql-transport-ws y manda el token en connection_init', () => {
    openSubscription('t-1', 'subscription { x }', {}, handlers(), vi.fn());
    const socket = FakeSocket.ultimo;
    expect(socket.protocol).toBe('graphql-transport-ws');
    socket.onopen!();
    expect(socket.sent[0]).toEqual({ type: 'connection_init', payload: { authorization: 'Bearer t-1' } });
  });
  it('tras connection_ack avisa "abierta" y se suscribe con la consulta y las variables', () => {
    const opened = vi.fn();
    openSubscription('t', 'subscription S($id: String!) { x(id: $id) }', { id: 'c-1' }, handlers(), opened);
    FakeSocket.ultimo.recibir({ type: 'connection_ack' });
    expect(opened).toHaveBeenCalled();
    expect(FakeSocket.ultimo.sent.at(-1)).toEqual({ id: '1', type: 'subscribe', payload: { query: 'subscription S($id: String!) { x(id: $id) }', variables: { id: 'c-1' } } });
  });
  it('cada next entrega sus datos; un ping se responde con pong', () => {
    const h = handlers();
    openSubscription('t', 's', {}, h, vi.fn());
    FakeSocket.ultimo.recibir({ type: 'next', id: '1', payload: { data: { mapa: 1 } } });
    FakeSocket.ultimo.recibir({ type: 'ping' });
    expect(h.next).toHaveBeenCalledWith({ mapa: 1 });
    expect(FakeSocket.ultimo.sent.at(-1)).toEqual({ type: 'pong' });
  });
  it('un error de la operación (p. ej. token vencido) llega con su código', () => {
    const h = handlers();
    openSubscription('t', 's', {}, h, vi.fn());
    FakeSocket.ultimo.recibir({ type: 'next', id: '1', payload: { errors: [{ message: 'Token vencido', extensions: { code: 'UNAUTHENTICATED' } }] } });
    expect(h.error).toHaveBeenCalledWith('Token vencido', 'UNAUTHENTICATED');
    expect(h.next).not.toHaveBeenCalled();
  });
  it('un mensaje que no es JSON se ignora (no rompe la conexión)', () => {
    const h = handlers();
    openSubscription('t', 's', {}, h, vi.fn());
    FakeSocket.ultimo.onmessage!({ data: 'basura' });
    expect(h.close).not.toHaveBeenCalled();
  });
  it('si el servidor no confirma en 8 s (un proxy sin WebSocket), se cierra y avisa para pasar al respaldo', () => {
    const h = handlers();
    openSubscription('t', 's', {}, h, vi.fn());
    vi.advanceTimersByTime(7_999);
    expect(h.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.close).toHaveBeenCalledTimes(1);
  });
  it('cerrar desde la web manda complete y no avisa "cerrada" (no es una caída)', () => {
    const h = handlers();
    const cerrar = openSubscription('t', 's', {}, h, vi.fn());
    cerrar();
    expect(FakeSocket.ultimo.sent.at(-1)).toEqual({ id: '1', type: 'complete' });
    expect(h.close).not.toHaveBeenCalled();
  });
});
