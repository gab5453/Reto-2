import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { guardPool } from './pool.js';

/**
 * guardPool con PostgreSQL REAL (corre con `npm run test:infra`; sin la variable se omite, y en la CI eso la hace fallar).
 * Reproduce el hallazgo de E2E-1: PostgreSQL corta las conexiones inactivas del pool (como al reiniciarse) y el proceso sigue.
 * Solo se cortan las conexiones con el `application_name` de esta prueba: las demás pruebas comparten la base en la CI.
 */
const url = process.env['ESB_TEST_DATABASE_URL'];

describe.skipIf(!url)('guardPool con PostgreSQL real', () => {
  it('PostgreSQL corta las conexiones inactivas: se registra un aviso, el proceso sigue y el pool vuelve a consultar', async () => {
    const nombre = `guardpool-${randomUUID().slice(0, 8)}`;
    const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const pool = guardPool(new pg.Pool({ connectionString: url, max: 2, application_name: nombre }), 'prueba');
    try {
      // Deja una conexión INACTIVA guardada en el pool.
      await pool.query('SELECT 1');

      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      const { rows } = await admin.query<{ cortada: boolean }>('SELECT pg_terminate_backend(pid) AS cortada FROM pg_stat_activity WHERE application_name = $1', [nombre]);
      await admin.end();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.cortada)).toBe(true);

      // Sin guardPool, aquí el «error» del pool quedaría sin manejar y terminaría el proceso (Vitest lo reporta como error).
      await vi.waitFor(() => expect(aviso).toHaveBeenCalledWith(expect.stringContaining('[prueba] PostgreSQL cerró una conexión inactiva')));
      const { rows: despues } = await pool.query<{ uno: number }>('SELECT 1 AS uno');
      expect(despues[0].uno).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
