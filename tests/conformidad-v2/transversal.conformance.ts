import { call, expectConforms, live } from './support/client.js';

/** Reglas transversales del contrato v2: X-Correlation-Id (§6), ProblemDetails (§11) y seguridad en dos capas (§5). */
describe.skipIf(!live)('Reglas transversales (contrato v2)', () => {
  it('§6 devuelve el X-Correlation-Id recibido, sin cambios, en una respuesta correcta', async () => {
    const response = await call('getHealth', { correlationId: 'corr-conformidad-fijo-123' });
    expectConforms(response, { status: [200, 503] });
    expect(response.headers.get('x-correlation-id')).toBe('corr-conformidad-fijo-123');
  });

  it('§6 lo devuelve también en un error y dentro de ProblemDetails.correlation_id', async () => {
    const response = await call('getSeatMap', {
      correlationId: 'corr-conformidad-error-456',
      params: { offerId: 'OFF-NO-EXISTE' },
      query: { segmentId: 'SEG-NO-EXISTE' },
    });
    expectConforms(response, { status: [404, 410] });
    expect((response.body as { correlation_id: string }).correlation_id).toBe('corr-conformidad-error-456');
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  it('§6 si no llega X-Correlation-Id, el servidor crea uno y lo devuelve', async () => {
    const response = await call('getHealth', { correlationId: null });
    expectConforms(response, { status: [200, 503] });
    expect(response.headers.get('x-correlation-id')).toBeTruthy();
  });

  it('§11 ProblemDetails con instance, code, correlation_id y timestamp', async () => {
    const response = await call('listBookings', { auth: 'none' });
    expectConforms(response, { status: 401 });
    const problem = response.body as Record<string, unknown>;
    expect(problem).toEqual(expect.objectContaining({ status: 401, instance: expect.stringContaining('/vuelos/bookings') }));
  });

  it('§5 un token inválido responde 401', async () => {
    const response = await call('listBookings', { auth: 'none', headers: { authorization: 'Bearer token-invalido' } });
    expectConforms(response, { status: 401 });
  });
});
