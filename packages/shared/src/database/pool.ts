import { Logger } from '@nestjs/common';

/** Lo único que se necesita de un `pg.Pool` (la librería compartida no depende de `pg`). */
export interface ErrorEmittingPool {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * Protege un pool de PostgreSQL (`pg.Pool`) para que una conexión INACTIVA que se cae no tumbe el proceso.
 *
 * Cuando PostgreSQL cierra una conexión que el pool tenía guardada (se reinició la base, un despliegue la recreó, un corte de
 * red), `pg` emite `'error'` en el pool. Un `'error'` sin manejador en Node termina el proceso: el 11/11 el ESB terminó con
 * `Exited (1)` al reiniciarse PostgreSQL (E2E-1), y en la nube solo lo salvaba `restart: unless-stopped`, con la saga en curso
 * a medias hasta que el servicio volvía. Con este manejador se registra un aviso y el pool abre otra conexión en la próxima
 * consulta. Una consulta EN CURSO sigue fallando con su error (y la saga compensa o reintenta, como cualquier falla).
 *
 * La regla de arquitectura `tests/arquitectura-v2/arquitectura.spec.ts` exige usarla en todo `new pg.Pool(…)`.
 */
export function guardPool<T extends ErrorEmittingPool>(pool: T, service: string): T {
  const logger = new Logger('PostgreSQL');
  pool.on('error', (error) => logger.warn(`[${service}] PostgreSQL cerró una conexión inactiva (${error.message}); se abre otra en la próxima consulta.`));
  return pool;
}
