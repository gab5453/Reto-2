import { useEffect, useState, type FormEvent } from 'react';
import { PARTNER_SCOPES, changePartnerStatus, createPartner, listPartners, rotatePartnerSecret, type Partner, type PartnerScope } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { Field } from '../../components/FormFields';
import { ProblemAlert } from '../../components/ProblemAlert';
import { STATUS_LABELS, formatDateTime } from '../../lib/format';

const SCOPE_LABELS: Record<PartnerScope, string> = {
  FLIGHTS_READ: 'Consultar (flights:read)',
  FLIGHTS_HOLD: 'Retener (flights:hold)',
  FLIGHTS_BOOK: 'Reservar (flights:book)',
  FLIGHTS_CANCEL: 'Cancelar (flights:cancel)',
  FLIGHTS_WEBHOOKS: 'Webhooks (flights:webhooks)',
  FLIGHTS_OPS: 'Operaciones (flights:ops)',
};
const EMPTY_FORM = { clientId: '', name: '', scopes: [...PARTNER_SCOPES] as PartnerScope[] };

/**
 * Partners: sistemas B2B como Booking (`partners`, `createPartner`, `changePartnerStatus`, `rotatePartnerSecret`). El secreto
 * se devuelve UNA sola vez: vive solo en el estado de esta pantalla, hasta que el administrador lo cierra o sale de ella.
 */
export function AdminPartnersPage() {
  const { token } = useAuth();
  const [partners, setPartners] = useState<Partner[] | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ clientId: string; value: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (!token) return;
    let active = true;
    listPartners(token)
      .then((data) => active && setPartners(data))
      .catch((caught: unknown) => active && setError(caught));
    return () => {
      active = false;
    };
  }, [token]);

  const replace = (partner: Partner) => setPartners((current) => current?.map((item) => (item.clientId === partner.clientId ? partner : item)) ?? [partner]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(undefined);
    try {
      await action();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    void run(async () => {
      const { partner, clientSecret } = await createPartner(token, { ...form, clientId: form.clientId.trim(), name: form.name.trim() });
      setPartners((current) => [...(current ?? []), partner]);
      setSecret({ clientId: partner.clientId, value: clientSecret });
      setForm(EMPTY_FORM);
      setCreating(false);
    });
  };

  const rotate = (partner: Partner) => {
    if (!token || !window.confirm(`¿Rotar el secreto de ${partner.clientId}? El anterior deja de funcionar: su sistema no podrá pedir tokens hasta recibir el nuevo.`)) return;
    void run(async () => {
      const rotated = await rotatePartnerSecret(token, partner.clientId);
      replace(rotated.partner);
      setSecret({ clientId: partner.clientId, value: rotated.clientSecret });
    });
  };

  const toggle = (partner: Partner) => {
    if (!token) return;
    const status = partner.status === 'ACTIVE' ? 'BLOCKED' : 'ACTIVE';
    let reason: string | null = '';
    if (status === 'BLOCKED') {
      reason = window.prompt(`Motivo del bloqueo de ${partner.clientId} (opcional). Sus tokens dejarán de funcionar:`);
      if (reason === null) return;
    }
    void run(async () => {
      replace(await changePartnerStatus(token, partner.clientId, { status, ...(reason?.trim() ? { reason: reason.trim() } : {}) }));
      setMessage(`${partner.clientId}: ${status === 'BLOCKED' ? 'bloqueado' : 'activo'}.`);
    });
  };

  return (
    <div className="container section admin">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Portal administrativo</p>
          <h1>Partners</h1>
          <p className="muted small">Sistemas externos que usan la API de vuelos con OAuth2, como Booking.</p>
        </div>
        <div className="admin-actions">
          <button type="button" className="btn btn-primary" onClick={() => setCreating((value) => !value)}>{creating ? 'Cerrar' : '+ Nuevo partner'}</button>
        </div>
      </header>

      {secret && (
        <div className="alert alert-info secret-box" role="status">
          <p className="alert-title">Secreto de {secret.clientId}: se muestra una sola vez</p>
          <code>{secret.value}</code>
          <p>Cópialo ahora y entrégalo al partner por un canal privado. EcoAirlines no lo puede volver a mostrar.</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSecret(undefined)}>Ya lo guardé</button>
        </div>
      )}

      {creating && (
        <form className="card" onSubmit={create}>
          <h2>Nuevo partner</h2>
          <div className="grid-2">
            <Field label="Identificador (client_id)" value={form.clientId} onChange={(clientId) => setForm({ ...form, clientId: clientId.toUpperCase() })} maxLength={40} placeholder="BOOKING_PROTOTIPO" />
            <Field label="Nombre" value={form.name} onChange={(name) => setForm({ ...form, name })} maxLength={80} />
          </div>
          <fieldset className="assistance-box">
            <legend>Permisos</legend>
            <div className="check-grid">
              {PARTNER_SCOPES.map((scope) => (
                <label key={scope} className="inline-field">
                  <input
                    type="checkbox"
                    checked={form.scopes.includes(scope)}
                    onChange={(event) => setForm({ ...form, scopes: event.target.checked ? [...form.scopes, scope] : form.scopes.filter((item) => item !== scope) })}
                  />
                  {SCOPE_LABELS[scope]}
                </label>
              ))}
            </div>
          </fieldset>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creando…' : 'Crear partner'}</button>
        </form>
      )}

      {error ? <ProblemAlert error={error} /> : null}
      {message && <p className="alert alert-success" role="status">{message}</p>}
      {!partners && !error && <p className="muted">Cargando partners…</p>}

      {partners && (
        <section className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Partner</th>
                  <th scope="col">Permisos</th>
                  <th scope="col">Estado</th>
                  <th scope="col" title="Indica si su sistema está conectado">Último token</th>
                  <th scope="col">Secreto rotado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {partners.length === 0 ? (
                  <tr><td colSpan={6} className="muted">Todavía no hay partners.</td></tr>
                ) : (
                  partners.map((partner) => (
                    <tr key={partner.clientId}>
                      <td><strong>{partner.clientId}</strong><br /><span className="muted small">{partner.name}</span></td>
                      <td className="small">{partner.scopes.map((scope) => SCOPE_LABELS[scope].split(' ')[0]).join(', ')}</td>
                      <td>{STATUS_LABELS[partner.status] ?? partner.status}</td>
                      <td className="small">{partner.lastTokenAt ? formatDateTime(partner.lastTokenAt) : 'Nunca'}</td>
                      <td className="small">{partner.secretRotatedAt ? formatDateTime(partner.secretRotatedAt) : '—'}</td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => rotate(partner)}>Rotar secreto</button>
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => toggle(partner)}>{partner.status === 'ACTIVE' ? 'Bloquear' : 'Activar'}</button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
