import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { changeUserRole, changeUserStatus, createUser, listUsers, type RoleName, type User } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { Field, SelectField } from '../../components/FormFields';
import { ProblemAlert } from '../../components/ProblemAlert';
import { STATUS_LABELS, formatDateTime } from '../../lib/format';

const PAGE_SIZE = 20;
const ROLE_LABELS: Record<RoleName, string> = { CUSTOMER: 'Cliente', ADMIN: 'Administrador' };
const EMPTY_FORM = { fullName: '', email: '', password: '', role: 'CUSTOMER' as RoleName };

/**
 * Usuarios y roles (`users`, `createUser`, `changeUserRole`, `changeUserStatus`; → MS.Admin → MS.G.Identity). Identity impide
 * quitarse el rol a uno mismo y dejar el sistema sin administradores (`CANNOT_MODIFY_SELF`, `LAST_ADMIN`).
 */
export function AdminUsersPage() {
  const { token } = useAuth();
  const [filters, setFilters] = useState({ q: '', role: '', status: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState<{ items: User[]; cursor?: string } | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string>();

  const fetchPage = useCallback((cursor?: string) => listUsers(token ?? '', { ...applied, limit: PAGE_SIZE, cursor }), [token, applied]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    fetchPage()
      .then((data) => active && setPage({ items: data.items, cursor: data.nextCursor ?? undefined }))
      .catch((caught: unknown) => active && setError(caught));
    return () => {
      active = false;
    };
  }, [token, fetchPage]);

  /** Una acción sobre un usuario: reemplaza su fila con lo que devolvió el servidor. */
  const act = async (action: () => Promise<User>, done: (user: User) => string) => {
    setBusy(true);
    setError(null);
    setMessage(undefined);
    try {
      const user = await action();
      setPage((current) => current && { ...current, items: current.items.map((item) => (item.sub === user.sub ? user : item)) });
      setMessage(done(user));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const block = (user: User) => {
    const reason = window.prompt(`Motivo del bloqueo de ${user.email} (opcional):`);
    if (reason === null) return;
    void act(() => changeUserStatus(token ?? '', user.sub, { status: 'BLOCKED', ...(reason.trim() ? { reason: reason.trim() } : {}) }), (updated) => `${updated.email} quedó bloqueado.`);
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    setMessage(undefined);
    try {
      const user = await createUser(token, { ...form, fullName: form.fullName.trim(), email: form.email.trim() });
      setPage((current) => current && { ...current, items: [user, ...current.items] });
      setForm(EMPTY_FORM);
      setCreating(false);
      setMessage(`Usuario ${user.email} creado como ${ROLE_LABELS[user.role]}.`);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const loadMore = async () => {
    if (!page?.cursor) return;
    try {
      const data = await fetchPage(page.cursor);
      setPage({ items: [...page.items, ...data.items], cursor: data.nextCursor ?? undefined });
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <div className="container section admin">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Portal administrativo</p>
          <h1>Usuarios y roles</h1>
        </div>
        <div className="admin-actions">
          <button type="button" className="btn btn-primary" onClick={() => setCreating((value) => !value)}>{creating ? 'Cerrar' : '+ Nuevo usuario'}</button>
        </div>
      </header>

      {creating && (
        <form className="card" onSubmit={create}>
          <h2>Nuevo usuario</h2>
          <div className="grid-2">
            <Field label="Nombre completo" value={form.fullName} onChange={(fullName) => setForm({ ...form, fullName })} maxLength={80} />
            <Field label="Correo" type="email" value={form.email} onChange={(email) => setForm({ ...form, email })} maxLength={254} />
            <Field label="Contraseña inicial" type="password" value={form.password} onChange={(password) => setForm({ ...form, password })} maxLength={128} autoComplete="new-password" />
            <SelectField label="Rol" value={form.role} onChange={(role) => setForm({ ...form, role: role as RoleName })} options={Object.entries(ROLE_LABELS)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creando…' : 'Crear usuario'}</button>
        </form>
      )}

      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(filters);
        }}
      >
        <label className="inline-field">
          Buscar
          <input value={filters.q} placeholder="Nombre o correo" onChange={(event) => setFilters({ ...filters, q: event.target.value })} />
        </label>
        <label className="inline-field">
          Rol
          <select value={filters.role} onChange={(event) => setFilters({ ...filters, role: event.target.value })}>
            <option value="">Todos</option>
            {Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="inline-field">
          Estado
          <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
            <option value="">Todos</option>
            <option value="ACTIVE">Activa</option>
            <option value="BLOCKED">Bloqueada</option>
          </select>
        </label>
        <button type="submit" className="btn btn-ghost btn-sm">Filtrar</button>
      </form>

      {error ? <ProblemAlert error={error} /> : null}
      {message && <p className="alert alert-success" role="status">{message}</p>}
      {!page && !error && <p className="muted">Cargando usuarios…</p>}

      {page && (
        <section className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Nombre</th>
                  <th scope="col">Correo</th>
                  <th scope="col">Rol</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Último ingreso</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {page.items.length === 0 ? (
                  <tr><td colSpan={6} className="muted">No hay usuarios con ese filtro.</td></tr>
                ) : (
                  page.items.map((user) => (
                    <tr key={user.sub}>
                      <td>{user.fullName}</td>
                      <td className="small">{user.email}</td>
                      <td>
                        <select
                          aria-label={`Rol de ${user.email}`}
                          value={user.role}
                          disabled={busy}
                          onChange={(event) => void act(() => changeUserRole(token ?? '', user.sub, event.target.value as RoleName), (updated) => `${updated.email} ahora es ${ROLE_LABELS[updated.role]}.`)}
                        >
                          {Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      </td>
                      <td>{STATUS_LABELS[user.status] ?? user.status}</td>
                      <td className="small">{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Nunca'}</td>
                      <td>
                        {user.status === 'ACTIVE' ? (
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => block(user)}>Bloquear</button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void act(() => changeUserStatus(token ?? '', user.sub, { status: 'ACTIVE' }), (updated) => `${updated.email} quedó activo.`)}
                          >
                            Activar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {page.cursor && <button type="button" className="btn btn-ghost" onClick={() => void loadMore()}>Cargar más</button>}
        </section>
      )}
    </div>
  );
}
