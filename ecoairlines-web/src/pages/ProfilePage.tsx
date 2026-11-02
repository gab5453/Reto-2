import { useEffect, useState, type FormEvent } from 'react';
import { getMyProfile, saveMyProfile } from '../api/operations';
import type { CustomerProfileRequest } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AssistanceFields } from '../components/AssistanceFields';
import { Field, SelectField } from '../components/FormFields';
import { ProblemAlert } from '../components/ProblemAlert';
import { EMPTY_ASSISTANCE, cleanAssistance, formatDateTime, todayIso } from '../lib/format';

const EMPTY: CustomerProfileRequest = {
  firstName: '',
  lastName: '',
  documentType: 'PASSPORT',
  documentNumber: '',
  nationality: 'EC',
  documentExpiryDate: '',
  birthDate: '',
  gender: 'F',
  contact: { email: '', phone: '' },
};

/**
 * Perfil del cliente (`myProfile` / `saveMyProfile` del GraphQL, MS.Clientes). Usa los campos de pasajero del contrato; al
 * reservar, el checkout lo copia al primer pasajero.
 */
export function ProfilePage() {
  const { token, user } = useAuth();
  const [form, setForm] = useState<CustomerProfileRequest>({ ...EMPTY, contact: { email: user?.email ?? '', phone: '' } });
  const [updatedAt, setUpdatedAt] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    getMyProfile(token)
      .then((profile) => {
        // null: el cliente todavía no registró su perfil; se muestra el formulario vacío.
        if (!active || !profile) return;
        const { updatedAt: savedAt, ...fields } = profile;
        setForm({ ...EMPTY, ...fields, documentExpiryDate: fields.documentExpiryDate ?? '' });
        setUpdatedAt(savedAt);
      })
      .catch((caught: unknown) => active && setError(caught))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [token]);

  const update = (patch: Partial<CustomerProfileRequest>) => {
    setSaved(false);
    setForm((current) => ({ ...current, ...patch }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const { documentExpiryDate, defaultAssistance, ...rest } = form;
      const profile = await saveMyProfile(token, {
        ...rest,
        firstName: rest.firstName.trim(),
        lastName: rest.lastName.trim(),
        documentNumber: rest.documentNumber.trim(),
        nationality: rest.nationality.trim().toUpperCase(),
        contact: { email: rest.contact.email.trim(), phone: rest.contact.phone.trim() },
        ...(documentExpiryDate ? { documentExpiryDate } : {}),
        ...(defaultAssistance ? { defaultAssistance: cleanAssistance(defaultAssistance) } : {}),
      });
      setUpdatedAt(profile.updatedAt);
      setSaved(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="container section muted">Cargando tu perfil…</p>;

  return (
    <div className="container section narrow">
      <h1>Mi perfil</h1>
      <p className="muted">
        Guarda tus datos de viajero una sola vez: los usaremos para completar automáticamente al primer pasajero de tus
        reservas.{updatedAt && <> Última actualización: {formatDateTime(updatedAt)}.</>}
      </p>
      <form className="card" onSubmit={submit} noValidate>
        <div className="grid-2">
          <Field label="Nombres" value={form.firstName} onChange={(firstName) => update({ firstName })} autoComplete="given-name" maxLength={60} />
          <Field label="Apellidos" value={form.lastName} onChange={(lastName) => update({ lastName })} autoComplete="family-name" maxLength={60} />
          <SelectField label="Tipo de documento" value={form.documentType} onChange={(documentType) => update({ documentType: documentType as CustomerProfileRequest['documentType'] })}
            options={[['PASSPORT', 'Pasaporte'], ['NATIONAL_ID', 'Cédula / DNI']]} />
          <Field label="Número de documento" value={form.documentNumber} onChange={(documentNumber) => update({ documentNumber })} maxLength={30} />
          <Field label="Nacionalidad (código de país)" value={form.nationality} onChange={(nationality) => update({ nationality })} maxLength={2} placeholder="EC" />
          <Field label="Vencimiento del documento (opcional)" type="date" min={todayIso()} value={form.documentExpiryDate ?? ''} onChange={(documentExpiryDate) => update({ documentExpiryDate })} required={false} />
          <Field label="Fecha de nacimiento" type="date" max={todayIso()} value={form.birthDate} onChange={(birthDate) => update({ birthDate })} autoComplete="bday" />
          <SelectField label="Género" value={form.gender} onChange={(gender) => update({ gender: gender as CustomerProfileRequest['gender'] })}
            options={[['F', 'Femenino'], ['M', 'Masculino'], ['X', 'No binario / prefiero no decir']]} />
          <Field label="Correo" type="email" value={form.contact.email} onChange={(email) => update({ contact: { ...form.contact, email } })} autoComplete="email" maxLength={254} />
          <Field label="Teléfono" type="tel" value={form.contact.phone} onChange={(phone) => update({ contact: { ...form.contact, phone } })} autoComplete="tel" maxLength={30} placeholder="+593…" />
        </div>
        <fieldset className="assistance-box">
          <legend>Asistencia predeterminada</legend>
          <label className="inline-field">
            <input
              type="checkbox"
              checked={Boolean(form.defaultAssistance)}
              onChange={(event) => update({ defaultAssistance: event.target.checked ? EMPTY_ASSISTANCE : null })}
            />
            Suelo necesitar asistencia médica o de movilidad
          </label>
          {form.defaultAssistance && <AssistanceFields value={form.defaultAssistance} onChange={(defaultAssistance) => update({ defaultAssistance })} />}
          <p className="muted small">Se propondrá al completar tus reservas. Puedes cambiarla en cada una.</p>
        </fieldset>
        {error ? <ProblemAlert error={error} /> : null}
        {saved && <p className="alert alert-success" role="status">Perfil guardado.</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar perfil'}</button>
      </form>
    </div>
  );
}
