import { useId } from 'react';
import type { AssistanceInput, AssistanceType } from '../api/types';
import { ASSISTANCE_LABELS } from '../lib/format';

/**
 * Datos de una asistencia médica o de movilidad (tipo IATA, acompañante y notas). Es un dato de salud: vive solo en memoria,
 * viaja por GraphQL y nunca se escribe en logs ni en el almacenamiento del navegador.
 */
export function AssistanceFields({ value, onChange, disabled = false }: { value: AssistanceInput; onChange: (value: AssistanceInput) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="assistance-fields">
      <label className="field" htmlFor={`${id}-type`}>
        Tipo de asistencia
        <select id={`${id}-type`} value={value.type} disabled={disabled} onChange={(event) => onChange({ ...value, type: event.target.value as AssistanceType })}>
          {Object.entries(ASSISTANCE_LABELS).map(([code, label]) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>
      </label>
      <label className="inline-field" htmlFor={`${id}-companion`}>
        <input id={`${id}-companion`} type="checkbox" checked={value.needsCompanion} disabled={disabled} onChange={(event) => onChange({ ...value, needsCompanion: event.target.checked })} />
        Necesita acompañante
      </label>
      <label className="field" htmlFor={`${id}-notes`}>
        Notas para la tripulación (opcional)
        <input id={`${id}-notes`} value={value.notes ?? ''} maxLength={200} disabled={disabled} onChange={(event) => onChange({ ...value, notes: event.target.value })} />
      </label>
    </div>
  );
}
