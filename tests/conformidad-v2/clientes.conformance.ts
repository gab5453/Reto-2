import { call, expectConforms, live } from './support/client.js';

/** MS.Clientes — 3 operaciones: listar, registrar y eliminar suscripciones de webhooks (CloudEvents firmados). */
describe.skipIf(!live)('MS.Clientes (contrato v2)', () => {
  it('registra (201, sin devolver el secreto), lista (200) y elimina (204) una suscripción; eliminarla otra vez → 404', async () => {
    const created = await call('createWebhook', {
      body: {
        url: 'https://example.org/webhooks/ecoairlines-conformidad',
        events: ['booking.confirmed', 'flight.status_changed'],
        secret: 'secreto-de-prueba-0123456789',
      },
    });
    expectConforms(created, { status: 201 });
    const subscription = created.body as { id: string; secret?: string };
    expect(subscription.secret).toBeUndefined(); // writeOnly en el contrato v2

    const list = await call('listWebhooks');
    expectConforms(list, { status: 200 });
    expect((list.body as { id: string }[]).map((s) => s.id)).toContain(subscription.id);

    const deleted = await call('deleteWebhook', { params: { id: subscription.id } });
    expectConforms(deleted, { status: 204 });
    const again = await call('deleteWebhook', { params: { id: subscription.id } });
    expectConforms(again, { status: 404 });
  });

  it('400 VALIDATION_FAILED con un secreto de menos de 16 caracteres', async () => {
    const response = await call('createWebhook', {
      body: { url: 'https://example.org/webhooks/x', events: ['booking.confirmed'], secret: 'corto' },
    });
    expectConforms(response, { status: 400, code: 'VALIDATION_FAILED' });
  });

  it('401 sin token', async () => {
    const response = await call('listWebhooks', { auth: 'none' });
    expectConforms(response, { status: 401 });
  });
});
