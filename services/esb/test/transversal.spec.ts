import { randomUUID } from 'node:crypto';
import { ProblemDetailsException } from '@ecoairlines/shared';
import { stableUuid } from '../src/transversal/ids.js';
import { IDEMPOTENCY_LEASE_MS, IDEMPOTENCY_TTL_MS, InMemoryEsbStore } from '../src/repositories/esb.store.js';
import { assertAmountMatches, assertBookingPaymentReference } from '../src/transversal/booking-reference.js';
import type { EsbConfig } from '../src/config/config.js';
import type { InboundHandlers } from '../src/inbound/inbound-handlers.js';
import { InboundService } from '../src/inbound/inbound.service.js';

const PATTERN = /^PAY-BKP-(\d{8})-(\d{6})$/;
const NOW = new Date('2026-10-25T12:00:00Z');
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
  return 'OK';
};

describe('validador de referencias de Booking (D28, BKG-02)', () => {
  it('acepta el formato del contrato con una fecha real que no está en el futuro', () => {
    expect(assertBookingPaymentReference(' PAY-BKP-20261023-000981 ', PATTERN, NOW)).toBe('PAY-BKP-20261023-000981');
    expect(codeOf(() => assertBookingPaymentReference('PAY-BKP-20261026-000001', PATTERN, NOW))).toBe('OK'); // mañana: zonas horarias
  });

  it.each([
    ['PAY-BKP-SIM-ABC123', 'otro formato'],
    ['pay_7Hq2mX9cLk4Z', 'una referencia de la Payment API (canal web)'],
    ['PAY-BKP-20261332-000001', 'fecha que no existe'],
    ['PAY-BKP-20270101-000001', 'fecha futura'],
    ['', 'vacía'],
  ])('rechaza %s (%s) con 422 PAYMENT_REFERENCE_INVALID', (reference) => {
    expect(codeOf(() => assertBookingPaymentReference(reference, PATTERN, NOW))).toBe('PAYMENT_REFERENCE_INVALID');
  });

  it('el patrón es configurable (si Booking confirma otro formato) y entonces no se exige fecha', () => {
    expect(codeOf(() => assertBookingPaymentReference('BKP-XYZ', /^BKP-[A-Z]+$/, NOW))).toBe('OK');
  });

  it('monto: si llega debe ser exactamente el total (misma moneda); si no llega, no se compara', () => {
    const total = { currency: 'USD', total: '239.00' };
    expect(codeOf(() => assertAmountMatches({ currency: 'USD', total: '239.0' }, total))).toBe('OK');
    expect(codeOf(() => assertAmountMatches(undefined, total))).toBe('OK');
    expect(codeOf(() => assertAmountMatches({ currency: 'USD', total: '238.99' }, total))).toBe('AMOUNT_MISMATCH');
    expect(codeOf(() => assertAmountMatches({ currency: 'EUR', total: '239.00' }, total))).toBe('AMOUNT_MISMATCH');
  });
});

describe('idempotency_claims en memoria (mismas reglas que PostgreSQL)', () => {
  it('nueva → en curso → respuesta guardada; otro hash → mismatch; a las 24 h la clave se puede reutilizar', async () => {
    const store = new InMemoryEsbStore();
    const key = randomUUID();
    const t0 = Date.now();
    expect(await store.claim('owner:a', key, 'h1', t0)).toEqual({ kind: 'new' });
    expect(await store.claim('owner:a', key, 'h1', t0 + 1)).toEqual({ kind: 'in-progress' });
    expect(await store.claim('owner:a', key, 'h2', t0 + 1)).toEqual({ kind: 'mismatch' });
    expect(await store.claim('owner:b', key, 'h2', t0 + 1)).toEqual({ kind: 'new' }); // otro dueño, otra clave
    await store.complete('owner:a', key, { status: 201, headers: {}, body: '{}' });
    expect(await store.claim('owner:a', key, 'h1', t0 + 2)).toMatchObject({ kind: 'replay', response: { status: 201 } });
    expect(await store.claim('owner:a', key, 'h2', t0 + IDEMPOTENCY_TTL_MS)).toEqual({ kind: 'new' });
  });

  it('una petición "en curso" abandonada (el ESB se cayó) se puede retomar al vencer su plazo; release no borra una respuesta', async () => {
    const store = new InMemoryEsbStore();
    const key = randomUUID();
    const t0 = Date.now();
    await store.claim('s', key, 'h', t0);
    expect(await store.claim('s', key, 'h', t0 + IDEMPOTENCY_LEASE_MS)).toEqual({ kind: 'new' });
    await store.complete('s', key, { status: 200, headers: {}, body: 'x' });
    await store.release('s', key);
    expect((await store.claim('s', key, 'h', t0 + IDEMPOTENCY_LEASE_MS + 1)).kind).toBe('replay');
  });
});

it('stableUuid: el mismo texto da siempre el mismo UUID válido (sagaId de un evento)', () => {
  expect(stableUuid('issue-tickets:evt-1')).toBe(stableUuid('issue-tickets:evt-1'));
  expect(stableUuid('issue-tickets:evt-1')).not.toBe(stableUuid('issue-tickets:evt-2'));
  expect(stableUuid('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

describe('trabajadores en segundo plano: una base que falla no tumba el ESB (V2.12)', () => {
  it('la ronda de eventos de Booking registra el error y la siguiente reintenta', async () => {
    const store = new InMemoryEsbStore();
    let calls = 0;
    store.claimInbound = async () => {
      calls++;
      throw new Error('Connection terminated due to connection timeout');
    };
    const config = { inboundIntervalMs: 5 } as EsbConfig;
    const inbound = new InboundService(store, config, {} as InboundHandlers);
    inbound.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    inbound.onModuleDestroy();
    // Varias rondas fallaron y el proceso sigue (vitest falla la prueba si queda una promesa rechazada sin manejar).
    expect(calls).toBeGreaterThan(1);
  });
});
