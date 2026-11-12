import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { openSubscription } from '../api/client';
import { useLiveSubscription } from './live';

/**
 * PU-4 (Informacion_General/Pruebas.md §5.1.4): el hook de las vistas en vivo (T-5) con el WebSocket reemplazado por un doble
 * (`vi.mock`). Se prueba la decisión: en vivo, respaldo cada 15 s si se cae, reintento a los 30 s, y nada si está apagado.
 */
vi.mock('../api/client', () => ({ openSubscription: vi.fn() }));
const abrir = vi.mocked(openSubscription);

type Handlers = Parameters<typeof openSubscription>[3];
let ultimo: { handlers: Handlers; opened: () => void; close: Mock<() => void> };
beforeEach(() => {
  vi.useFakeTimers();
  abrir.mockReset();
  abrir.mockImplementation((_token, _query, _variables, handlers, opened) => {
    ultimo = { handlers, opened, close: vi.fn<() => void>() };
    return ultimo.close;
  });
});
afterEach(() => vi.useRealTimers());

const montar = (token: string | null, enabled = true, onData = vi.fn()) =>
  renderHook(({ t, e }) => useLiveSubscription(t, 'subscription { x }', { id: 'c-1' }, onData, e), { initialProps: { t: token, e: enabled } });

describe('useLiveSubscription', () => {
  it('empieza "conectando" y pasa a "en vivo" cuando el servidor confirma', () => {
    const { result } = montar('t-1');
    expect(result.current).toBe('connecting');
    act(() => ultimo.opened());
    expect(result.current).toBe('live');
    expect(abrir).toHaveBeenCalledWith('t-1', 'subscription { x }', { id: 'c-1' }, expect.anything(), expect.any(Function));
  });
  it('cada envío del servidor llega a onData', () => {
    const onData = vi.fn();
    montar('t-1', true, onData);
    act(() => ultimo.handlers.next({ mapa: 1 }));
    expect(onData).toHaveBeenCalledWith({ mapa: 1 });
  });
  it('si la conexión se cae pasa al respaldo y reintenta a los 30 s', () => {
    const { result } = montar('t-1');
    act(() => ultimo.handlers.close());
    expect(result.current).toBe('fallback');
    expect(abrir).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(abrir).toHaveBeenCalledTimes(2);
  });
  it('un error de la suscripción también pasa al respaldo', () => {
    const { result } = montar('t-1');
    act(() => ultimo.handlers.error('Token vencido', 'UNAUTHENTICATED'));
    expect(result.current).toBe('fallback');
  });
  it('sin sesión no abre nada y queda en respaldo', () => {
    const { result } = montar(null);
    expect(result.current).toBe('fallback');
    expect(abrir).not.toHaveBeenCalled();
  });
  it('apagado (un proceso de hace más de 15 min): "off" y no abre WebSocket', () => {
    const { result } = montar('t-1', false);
    expect(result.current).toBe('off');
    expect(abrir).not.toHaveBeenCalled();
  });
  it('al salir de la pantalla cierra la conexión y no reintenta', () => {
    const { unmount } = montar('t-1');
    const cerrar = ultimo.close;
    unmount();
    expect(cerrar).toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(60_000));
    expect(abrir).toHaveBeenCalledTimes(1);
  });
});
