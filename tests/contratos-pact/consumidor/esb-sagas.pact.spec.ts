import { MatchersV3, PactV4 } from '@pact-foundation/pact';
import type { OperationContext } from '@ecoairlines/shared/respuesta/app.js';
import { EsbClient } from '@ecoairlines/shared/respuesta/esb-client.js';
import { sagaOutcome } from '@ecoairlines/shared/respuesta/sagas.js';
import { DUENO_RESERVA, PACT_DIR, PARTICIPANTES, RESERVA_ID, SAGA_COMPENSADA, SAGA_COMPLETADA, TOKEN_DE_EJEMPLO, tokenFijo } from '../comun.js';

/**
 * Contrato del CONSUMIDOR (CT-1): cuando una saga no termina en el plazo, el ESB responde 202 con su `sagaId` y el MS de
 * respuesta (MS.Reservas, MS.Postventa…) consulta después `GET /sagas/{sagaId}` para dar el resultado real. El consumidor es el
 * código real: `sagaOutcome` del kit de los MS de respuesta, con el `EsbClient` real.
 */
const { like, regex, uuid } = MatchersV3;
const pact = new PactV4({ consumer: PARTICIPANTES.msRespuesta, provider: PARTICIPANTES.esb, dir: PACT_DIR, logLevel: 'warn' });
const AUTORIZACION = regex(/^Bearer .+$/, `Bearer ${TOKEN_DE_EJEMPLO}`);

/** Lo mínimo del contexto de una operación que usa `sagaOutcome`: la llamada al ESB. */
const contexto = (url: string) => {
  const esb = new EsbClient(url, tokenFijo, 5_000);
  return { esb: (call: Parameters<EsbClient['expect']>[0]) => esb.expect(call) } as unknown as OperationContext;
};
/** La respuesta 202 que el ESB dio al crear la reserva (y guardó para la Idempotency-Key). */
const aceptada = (sagaId: string) => ({ status: 202, headers: new Headers(), body: { sagaId, bookingId: RESERVA_ID }, replayed: true });

describe('MS de respuesta → ESB: resultado de una saga que no terminó a tiempo (GET /sagas/{sagaId})', () => {
  it('si terminó, se responde su resultado como si hubiera terminado a tiempo', () =>
    pact
      .addInteraction()
      .given('la saga de crear reserva del usuario de Booking terminó bien')
      .uponReceiving('la consulta de una saga completada por su dueño')
      .withRequest('GET', `/sagas/${SAGA_COMPLETADA}`, (b) => b.headers({ authorization: AUTORIZACION, 'x-owner-id': DUENO_RESERVA }))
      .willRespondWith(200, (b) =>
        b.jsonBody({ sagaId: uuid(SAGA_COMPLETADA), status: 'COMPLETED', result: like({ bookingId: RESERVA_ID, pnr: 'ABC234', status: 'CONFIRMED' }) }),
      )
      .executeTest(async (mockServer) => {
        expect(await sagaOutcome(contexto(mockServer.url), aceptada(SAGA_COMPLETADA), { ownerId: DUENO_RESERVA })).toEqual({
          done: true,
          status: 200,
          body: { bookingId: RESERVA_ID, pnr: 'ABC234', status: 'CONFIRMED' },
          replayed: true,
        });
      }));

  it('si falló y se compensó, se responde el MISMO error del paso que falló', () =>
    pact
      .addInteraction()
      .given('la saga de crear reserva del usuario de Booking se compensó por asiento tomado')
      .uponReceiving('la consulta de una saga compensada por su dueño')
      .withRequest('GET', `/sagas/${SAGA_COMPENSADA}`, (b) => b.headers({ authorization: AUTORIZACION, 'x-owner-id': DUENO_RESERVA }))
      .willRespondWith(200, (b) => b.jsonBody({ sagaId: uuid(SAGA_COMPENSADA), status: 'COMPENSATED', error: { status: 409, code: 'SEAT_TAKEN', title: like('Asiento no disponible') } }))
      .executeTest(async (mockServer) => {
        await expect(sagaOutcome(contexto(mockServer.url), aceptada(SAGA_COMPENSADA), { ownerId: DUENO_RESERVA })).rejects.toMatchObject({ problem: { status: 409, code: 'SEAT_TAKEN' } });
      }));

  it('la saga de otro dueño no existe para él: 404', () =>
    pact
      .addInteraction()
      .given('la saga de crear reserva del usuario de Booking terminó bien')
      .uponReceiving('la consulta de una saga por otro dueño')
      .withRequest('GET', `/sagas/${SAGA_COMPLETADA}`, (b) => b.headers({ authorization: AUTORIZACION, 'x-owner-id': 'partner:BOOKING_PROTOTIPO:otro-usuario' }))
      .willRespondWith(404, (b) => b.jsonBody({ status: 404, code: 'NOT_FOUND' }).headers({ 'Content-Type': 'application/problem+json' }))
      .executeTest(async (mockServer) => {
        await expect(sagaOutcome(contexto(mockServer.url), aceptada(SAGA_COMPLETADA), { ownerId: 'partner:BOOKING_PROTOTIPO:otro-usuario' })).rejects.toMatchObject({ problem: { status: 404 } });
      }));
});
