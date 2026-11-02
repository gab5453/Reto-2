import { useState } from 'react';
import { DataTable as Table, Stat } from '../../components/AdminUi';
import { formatDateTime } from '../../lib/format';
import { EventsPanel } from './EventsPanel';
import { FleetSchedulePanel } from './FleetSchedulePanel';
import { browserObservability, type BrowserSnapshot, type ObservabilityEvent } from '../../lib/observability';

/**
 * Observabilidad de la operación y del navegador (solo administradores; el backend está en Telemetría):
 * - **Eventos:** lo publicado en el bus y sus entregas de webhooks (`eventHistory`).
 * - **Flota:** rotación de cada avión por día (`fleetSchedule`).
 * - **Navegador:** rendimiento, errores, recursos, interacciones y entorno, guardados solo en este navegador.
 */
export function AdminObservabilityPage() {
  const [browser, setBrowser] = useState<BrowserSnapshot>(() => browserObservability.getSnapshot());
  const [status, setStatus] = useState('Panel cargado con los datos disponibles.');

  const refresh = () => {
    browserObservability.refreshEnvironment();
    setBrowser(browserObservability.getSnapshot());
  };

  const download = () => {
    const content = JSON.stringify(browserObservability.getSnapshot(), null, 2);
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `ecoairlines-observabilidad-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('Snapshot JSON descargado.');
  };

  const clear = () => {
    if (!window.confirm('¿Borrar los datos de observabilidad guardados en este navegador?')) return;
    browserObservability.clear();
    setBrowser(browserObservability.getSnapshot());
    setStatus('Almacenamiento local de observabilidad limpiado.');
  };

  const log = browser.log;
  const byCategory = (category: ObservabilityEvent['categoria']) => log.filter((event) => event.categoria === category);
  const environment = browser.environment;

  return (
    <div className="container section admin">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Portal administrativo</p>
          <h1>Observabilidad</h1>
          <p className="muted small">Solo visible para administradores. Nunca se registran tokens, contraseñas, datos de pago ni valores de formularios.</p>
        </div>
      </header>

      <div className="admin-actions" role="toolbar" aria-label="Acciones del panel">
        <button type="button" className="btn btn-primary" onClick={() => { refresh(); setStatus(`Datos actualizados el ${formatDateTime(new Date().toISOString())}.`); }}>Actualizar datos</button>
        <button type="button" className="btn btn-ghost" onClick={() => { browserObservability.logDemoEvent(); setBrowser(browserObservability.getSnapshot()); setStatus('Evento de demostración agregado al registro.'); }}>Generar evento de demostración</button>
        <button type="button" className="btn btn-ghost" onClick={download}>Descargar snapshot JSON</button>
        <button type="button" className="btn btn-danger" onClick={clear}>Limpiar almacenamiento</button>
      </div>
      <p className="muted small" role="status" aria-live="polite">{status}</p>

      <EventsPanel />

      <FleetSchedulePanel />

      <h2>Navegador (este equipo)</h2>
      <section className="stats-grid" aria-label="Resumen del navegador">
        <Stat label="Sesión" value={browser.meta?.sessionId.slice(-6) ?? '—'} />
        <Stat label="Eventos registrados" value={log.length} />
        <Stat label="Errores JS" value={byCategory('error').length} />
        <Stat label="Viewport" value={environment?.viewport.width ? `${environment.viewport.width} × ${environment.viewport.height}` : '—'} />
        <Stat label="Conexión" value={environment?.conexion.soportado ? environment.conexion.effectiveType ?? 'sí' : 'No informada'} />
        <Stat label="Almacenamiento" value={browser.almacenamientoDisponible ? 'localStorage' : 'Solo memoria'} />
      </section>

      <Table
        caption="Rendimiento de navegación (Performance API)"
        headers={['Hora', 'Página', 'TTFB', 'DOMContentLoaded', 'Carga completa', 'Método']}
        empty="Sin datos todavía."
        rows={byCategory('performance').map((event) => [
          formatDateTime(event.timestamp),
          event.pagina,
          ms(event.detalle.tiempoHastaPrimerByte),
          ms(event.detalle.domContentCargado),
          ms(event.detalle.cargaCompleta),
          text(event.detalle.metodo ?? event.detalle.motivo),
        ])}
      />
      <Table
        caption="Errores de JavaScript y promesas rechazadas"
        headers={['Hora', 'Tipo', 'Página', 'Mensaje', 'Ubicación']}
        empty="Sin errores registrados."
        rows={byCategory('error').map((event) => [
          formatDateTime(event.timestamp),
          event.tipo === 'promesa-rechazada' ? 'Promesa rechazada' : 'Error de JavaScript',
          event.pagina,
          text(event.detalle.mensaje),
          event.detalle.archivo ? `${text(event.detalle.archivo)}:${text(event.detalle.linea)}` : '—',
        ])}
      />
      <Table
        caption="Errores de carga de recursos"
        headers={['Hora', 'Página', 'Etiqueta', 'Fuente']}
        empty="Sin errores de recursos registrados."
        rows={byCategory('recurso').map((event) => [formatDateTime(event.timestamp), event.pagina, text(event.detalle.etiqueta), text(event.detalle.fuente)])}
      />
      <Table
        caption="Clics en enlaces, botones y controles (últimos 50)"
        headers={['Hora', 'Página', 'Elemento', 'Texto / destino']}
        empty="Sin interacciones registradas."
        rows={[...byCategory('interaccion'), ...byCategory('demo')]
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
          .slice(0, 50)
          .map((event) =>
            event.categoria === 'demo'
              ? [formatDateTime(event.timestamp), event.pagina, 'Evento de demostración', text(event.detalle.mensaje)]
              : [formatDateTime(event.timestamp), event.pagina, text(event.detalle.etiqueta), text(event.detalle.texto ?? event.detalle.href)],
          )}
      />
      <Table
        caption="Cambios de visibilidad de la pestaña"
        headers={['Hora', 'Página', 'Estado']}
        empty="Sin cambios de visibilidad registrados."
        rows={byCategory('visibilidad').map((event) => [formatDateTime(event.timestamp), event.pagina, event.tipo === 'hidden' ? 'Oculta' : 'Visible'])}
      />

      <section className="card" aria-labelledby="json-title">
        <h2 id="json-title">Snapshot JSON del navegador</h2>
        <pre className="snapshot-json" tabIndex={0}>{JSON.stringify(browser, null, 2)}</pre>
      </section>
    </div>
  );
}

const text = (value: unknown) => (value === null || value === undefined || value === '' ? '—' : String(value));
const ms = (value: unknown) => (typeof value === 'number' ? `${value} ms` : '—');


