import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { login, register, type AuthPayload } from '../api/operations';
import { clearOfflineData } from '../lib/offline-trips';
import { friendlyMessage } from '../api/problem-messages';

/** Rol del usuario en MS.G.Identity (`RoleName` de gateway.graphql). */
export type UserRole = 'CUSTOMER' | 'ADMIN';

export interface SessionUser {
  name: string;
  email: string;
  role: UserRole;
  /** Scopes del token (`Scope` de gateway.graphql: FLIGHTS_BOOK, ECOAIRLINES_ADMIN…). Solo deciden qué se muestra. */
  scopes: string[];
}

interface Session {
  token: string;
  user: SessionUser;
  expiresAt: number;
}

interface AuthContextValue {
  token: string | null;
  user: SessionUser | null;
  /** Tiene el scope `ecoairlines:admin`. Solo decide qué muestra la interfaz: el gateway lo verifica en cada operación. */
  isAdmin: boolean;
  login(email: string, password: string): Promise<SessionUser>;
  register(name: string, email: string, password: string): Promise<SessionUser>;
  logout(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * El token vive SOLO en memoria (no en localStorage/sessionStorage): un script inyectado no puede
 * leerlo del almacenamiento y desaparece al cerrar o recargar la pestaña. La sesión se cierra sola
 * al vencer el JWT. El login va por GraphQL (`login`/`register` → MS.Clientes → MS.G.Identity), como todo lo demás.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  /** «Salir» es decisión del cliente: también borra lo guardado para usar sin conexión. */
  const logout = useCallback(() => {
    setSession(null);
    clearOfflineData();
  }, []);

  useEffect(() => {
    if (!session) return;
    // Vencer la sesión no borra los pases guardados: el cliente puede necesitarlos en el aeropuerto.
    const timer = window.setTimeout(() => setSession(null), Math.max(0, session.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [session]);

  const authenticate = useCallback(async (request: () => Promise<AuthPayload>): Promise<SessionUser> => {
    let payload: AuthPayload;
    try {
      payload = await request();
    } catch (caught) {
      throw new Error(caught instanceof ApiError ? friendlyMessage(caught) : 'No se pudo iniciar sesión.');
    }
    const user: SessionUser = { name: payload.user.fullName, email: payload.user.email, role: payload.user.role, scopes: payload.user.scopes };
    setSession({ token: payload.accessToken, user, expiresAt: Date.now() + payload.expiresIn * 1000 });
    return user;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      token: session?.token ?? null,
      user: session?.user ?? null,
      isAdmin: session?.user.scopes.includes('ECOAIRLINES_ADMIN') ?? false,
      login: (email, password) => authenticate(() => login({ email, password })),
      register: (name, email, password) => authenticate(() => register({ fullName: name, email, password })),
      logout,
    }),
    [session, authenticate, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react/only-export-components
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth debe usarse dentro de <AuthProvider>.');
  return context;
}
