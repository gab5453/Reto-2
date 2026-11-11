import { currentCorrelation, ProblemDetailsException, signWebhook } from '@ecoairlines/shared';
import type { EsbConfig } from '../config/config.js';
import type { EsbStore, InboundEventRecord } from '../repositories/esb.store.js';
import type { InboundHandlers } from './inbound-handlers.js';
import { InboundService, RETRY_DELAYS_MS } from './inbound.service.js';

/**
 * PU-3 (Informacion_General/Pruebas.md §5.1.3): entrada de eventos de Booking — firma del webhook, validación del CloudEvent,
 * sin procesar dos veces el mismo `id` (capa 1 de idempotencia) y qué pasa con cada error (REJECTED o RETRY, nunca se pierde).
 */

const SECRETO = 'secreto-compartido-con-booking';
const CONFIG = { bookingEventsSecret: SECRETO, inboundIntervalMs: 60_000 } as EsbConfig;
const BOOKING_ID = '562db2df-a55e-4b32-8272-11ebfcab1289';
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ProblemDetailsException).problem.code;
  }
};

const evento = (over: Record<string, unknown> = {}) => ({
  specversion: '1.0',
  id: 'evt-1',
  source: 'booking-core-api',
  type: 'ec.edu.epn.booking.pagos.payment.confirmed',
  correlationid: 'corr-de-booking',
  data: { bookingId: BOOKING_ID, paymentReference: 'PAY-BKP-20261201-000001' },
  ...over,
});

let store: { insertInbound: ReturnType<typeof vi.fn>; claimInbound: ReturnType<typeof vi.fn>; finishInbound: ReturnType<typeof vi.fn> };
let handlers: { paymentConfirmed: ReturnType<typeof vi.fn>; paymentFailed: ReturnType<typeof vi.fn>; packageCancelled: ReturnType<typeof vi.fn> };
let service: InboundService;
beforeEach(() => {
  store = { insertInbound: vi.fn().mockResolvedValue(true), claimInbound: vi.fn().mockResolvedValue([]), finishInbound: vi.fn() };
  handlers = { paymentConfirmed: vi.fn().mockResolvedValue({ ticketsIssued: 2 }), paymentFailed: vi.fn().mockResolvedValue({}), packageCancelled: vi.fn().mockResolvedValue({}) };
  service = new InboundService(store as unknown as EsbStore, CONFIG, handlers as unknown as InboundHandlers);
});

describe('recepción por webhook', () => {
  const firmado = (body: unknown, secreto = SECRETO) => {
    const raw = Buffer.from(JSON.stringify(body));
    return [raw, signWebhook(secreto, raw.toString('utf8'))] as const;
  };

  it('una firma válida se acepta y el evento se guarda una vez por su id', async () => {
    expect(await service.receiveWebhook(...firmado(evento()))).toEqual({ id: 'evt-1', duplicate: false });
    expect(store.insertInbound).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt-1', bookingId: BOOKING_ID, channel: 'WEBHOOK', status: 'PENDING', correlationId: 'corr-de-booking' }));
  });
  it('una firma hecha con otro secreto → 401, y no se guarda nada', async () => {
    expect(await codeOf(service.receiveWebhook(...firmado(evento(), 'otro-secreto')))).toBe('UNAUTHORIZED');
    expect(store.insertInbound).not.toHaveBeenCalled();
  });
  it('si alguien cambia un byte del cuerpo después de firmarlo, la firma ya no vale', async () => {
    const [raw, firma] = firmado(evento());
    expect(await codeOf(service.receiveWebhook(Buffer.from(raw.toString('utf8').replace('payment.confirmed', 'payment.failed')), firma))).toBe('UNAUTHORIZED');
  });
  it('sin firma o sin cuerpo → 401', async () => {
    expect(await codeOf(service.receiveWebhook(Buffer.from('{}'), undefined))).toBe('UNAUTHORIZED');
    expect(await codeOf(service.receiveWebhook(undefined, 'x'))).toBe('UNAUTHORIZED');
  });
  it('un cuerpo firmado que no es JSON → VALIDATION_FAILED', async () => {
    const raw = Buffer.from('no es json');
    expect(await codeOf(service.receiveWebhook(raw, signWebhook(SECRETO, 'no es json')))).toBe('VALIDATION_FAILED');
  });
});

describe('validación del CloudEvent', () => {
  it.each([
    ['specversion distinto de 1.0', { specversion: '0.3' }],
    ['tipo que no es de Booking', { type: 'ec.edu.epn.booking.otro' }],
    ['sin source', { source: '' }],
    ['bookingId que no es UUID', { data: { bookingId: 'b-1' } }],
    ['paymentReference que no es texto', { data: { bookingId: BOOKING_ID, paymentReference: 123 } }],
  ])('%s → VALIDATION_FAILED', async (_caso, over) => expect(await codeOf(service.receive(evento(over), 'AMQP'))).toBe('VALIDATION_FAILED'));
  it('el mismo id dos veces: OK pero se marca repetido (no se procesa otra vez)', async () => {
    store.insertInbound.mockResolvedValue(false);
    expect(await service.receive(evento(), 'AMQP')).toEqual({ id: 'evt-1', duplicate: true });
  });
  it('sin correlationid válido se genera uno nuevo', async () => {
    await service.receive(evento({ correlationid: 'con espacios no vale' }), 'AMQP');
    expect((store.insertInbound.mock.calls[0]![0] as InboundEventRecord).correlationId).not.toBe('con espacios no vale');
  });
  it('el bookingId se guarda en minúsculas', async () => {
    await service.receive(evento({ data: { bookingId: BOOKING_ID.toUpperCase() } }), 'AMQP');
    expect((store.insertInbound.mock.calls[0]![0] as InboundEventRecord).bookingId).toBe(BOOKING_ID);
  });
});

describe('procesamiento: PROCESSED, REJECTED o RETRY', () => {
  const registro = (type: string, attempts = 1): InboundEventRecord =>
    ({ id: 'evt-1', type, source: 's', bookingId: BOOKING_ID, correlationId: 'corr-de-booking', channel: 'AMQP', event: evento({ type }), status: 'PROCESSING', attempts }) as unknown as InboundEventRecord;
  const procesar = async (record: InboundEventRecord) => {
    store.claimInbound.mockResolvedValueOnce([record]).mockResolvedValue([]);
    return service.processDue();
  };

  it('cada tipo va a su manejador, con el correlation ID del evento', async () => {
    let visto: string | undefined;
    handlers.packageCancelled.mockImplementation(async () => ((visto = currentCorrelation()?.correlationId), {}));
    await procesar(registro('ec.edu.epn.booking.paquetes.package.cancelled'));
    expect(handlers.packageCancelled).toHaveBeenCalled();
    expect(handlers.paymentConfirmed).not.toHaveBeenCalled();
    expect(visto).toBe('corr-de-booking');
  });
  it('si sale bien queda PROCESSED con el resultado', async () => {
    await procesar(registro('ec.edu.epn.booking.pagos.payment.confirmed'));
    expect(store.finishInbound).toHaveBeenCalledWith('evt-1', 'PROCESSED', { ticketsIssued: 2 }, expect.any(String), undefined);
  });
  it('un error de negocio queda REJECTED (no se reintenta: reintentarlo no lo arregla)', async () => {
    handlers.paymentFailed.mockRejectedValue(new ProblemDetailsException({ status: 422, code: 'PAYMENT_REFERENCE_INVALID', title: 'no es la de la reserva' }));
    await procesar(registro('ec.edu.epn.booking.pagos.payment.failed'));
    expect(store.finishInbound).toHaveBeenCalledWith('evt-1', 'REJECTED', expect.objectContaining({ problem: expect.objectContaining({ code: 'PAYMENT_REFERENCE_INVALID' }) }), expect.any(String), undefined);
  });
  it('un MS.G caído deja el evento en RETRY con espera creciente (nunca se descarta)', async () => {
    handlers.paymentConfirmed.mockRejectedValue(new ProblemDetailsException({ status: 503, code: 'PROVIDER_UNAVAILABLE', title: 'caído' }));
    const antes = Date.now();
    await procesar(registro('ec.edu.epn.booking.pagos.payment.confirmed', 3));
    const [, status, , , next] = store.finishInbound.mock.calls[0]!;
    expect(status).toBe('RETRY');
    expect(Date.parse(next as string) - antes).toBeGreaterThanOrEqual(RETRY_DELAYS_MS[2]!);
  });
  it('un error inesperado (no ProblemDetails) también se reintenta', async () => {
    handlers.paymentConfirmed.mockRejectedValue(new Error('timeout'));
    await procesar(registro('ec.edu.epn.booking.pagos.payment.confirmed'));
    expect(store.finishInbound.mock.calls[0]![1]).toBe('RETRY');
  });
  it('las esperas crecen y se quedan en 1 hora', () => expect(RETRY_DELAYS_MS).toEqual([5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000]));
});
