import { Inject, Injectable } from '@nestjs/common';
import { createCloudEvent, ProblemDetailsException } from '@ecoairlines/shared';
import type { Caller } from '../clients/rest.client.js';
import { UPSTREAMS, type Upstreams } from '../clients/upstreams.js';
import { ESB_CONFIG, type EsbConfig } from '../config/config.js';
import { EVENTS_PUBLISHER, type EventsPublisher } from '../inbound/events-publisher.js';
import { stableUuid } from '../transversal/ids.js';
import type { SagaRecord, StoredResponse } from '../repositories/esb.store.js';
import { problemResponse } from '../router/router.service.js';
import {
  AddBaggageSaga,
  AssistanceReadySaga,
  CancelBookingSaga,
  ChangeDateSaga,
  ChangeSeatsSaga,
  CheckInSaga,
  CreateBookingSaga,
  IssueTicketsSaga,
  PaymentFailedSaga,
} from './booking-sagas.js';
import { SagaEngine, type SagaDefinition } from './engine.js';
import { FlightStatusSaga, PublishTimetableSaga, SavePricesSaga } from './operations-sagas.js';

const json = (status: number, body: unknown): StoredResponse => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * Las 11 sagas del orquestador, por HTTP. Cada operación respeta el timeout de 5 s de Booking: si la saga no termina en
 * `sagaDeadlineMs`, se responde `202` con su estado y la saga sigue en segundo plano (y la retoma el trabajador de
 * recuperación si la réplica se cae). Un error de negocio vuelve con su ProblemDetails, ya compensado.
 */
@Injectable()
export class SagasService {
  constructor(
    @Inject(SagaEngine) readonly engine: SagaEngine,
    @Inject(ESB_CONFIG) private readonly config: EsbConfig,
    @Inject(UPSTREAMS) private readonly upstreams: Upstreams,
    @Inject(EVENTS_PUBLISHER) private readonly events: EventsPublisher,
    @Inject(CreateBookingSaga) readonly createBooking: CreateBookingSaga,
    @Inject(IssueTicketsSaga) readonly issueTickets: IssueTicketsSaga,
    @Inject(PaymentFailedSaga) readonly paymentFailed: PaymentFailedSaga,
    @Inject(ChangeSeatsSaga) readonly changeSeats: ChangeSeatsSaga,
    @Inject(CheckInSaga) readonly checkIn: CheckInSaga,
    @Inject(CancelBookingSaga) readonly cancel: CancelBookingSaga,
    @Inject(ChangeDateSaga) readonly changeDate: ChangeDateSaga,
    @Inject(AddBaggageSaga) readonly addBaggage: AddBaggageSaga,
    @Inject(AssistanceReadySaga) readonly assistanceReady: AssistanceReadySaga,
    @Inject(FlightStatusSaga) readonly flightStatus: FlightStatusSaga,
    @Inject(SavePricesSaga) readonly savePrices: SavePricesSaga,
    @Inject(PublishTimetableSaga) readonly publishTimetable: PublishTimetableSaga,
  ) {
    for (const definition of [createBooking, issueTickets, paymentFailed, changeSeats, checkIn, cancel, changeDate, addBaggage, assistanceReady, flightStatus, savePrices, publishTimetable]) {
      engine.register(definition);
    }
  }

  /** Inicia la saga y espera hasta el plazo. `onPending` arma la respuesta `202` (por defecto, el estado de la saga). */
  async execute<I, R>(
    definition: SagaDefinition<I, R>,
    input: I,
    caller: Caller,
    instance: string,
    options: { okStatus?: number; onCompleted?: (result: R, sagaId: string) => Promise<StoredResponse>; onPending?: (sagaId: string) => Promise<StoredResponse> } = {},
  ): Promise<StoredResponse> {
    const { sagaId, done } = await this.engine.start(definition, input, caller);
    // La saga sigue aunque se responda 202: su error (ya compensado) queda en saga_log.
    done.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolve) => (timer = setTimeout(() => resolve('deadline'), this.config.sagaDeadlineMs)));
    try {
      const outcome = await Promise.race([done, deadline]);
      if (outcome === 'deadline' || outcome.status === 'PENDING') {
        return options.onPending ? options.onPending(sagaId) : json(202, { sagaId, status: 'RUNNING', type: definition.type });
      }
      const completed = outcome;
      return options.onCompleted ? options.onCompleted(completed.result, sagaId) : json(options.okStatus ?? 200, completed.result);
    } catch (error) {
      if (error instanceof ProblemDetailsException && error.problem.status < 500) return problemResponse(error, instance);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** La reserva tal como quedó (para `201`/`202` de "Crear reserva"). */
  async bookingResponse(status: number, bookingId: string, caller: Caller, sagaId: string): Promise<StoredResponse> {
    try {
      const booking = await this.upstreams.rest.bookings.json<Record<string, unknown>>('GET', `/bookings/${bookingId}`, { caller });
      // Compatibilidad con v1: la emisión quedó en curso (se responde 202). Un id estable: un reintento no lo duplica.
      if (status === 202 && booking['status'] === 'TICKET_ISSUING') {
        await this.events.publish(
          { ...createCloudEvent({ name: 'booking.ticket_issuing', visibility: 'public', subject: bookingId, data: { bookingId, pnr: booking['pnr'], status: 'TICKET_ISSUING' } }), id: stableUuid(`${sagaId}:booking.ticket_issuing`) },
          caller.ownerId,
        );
      }
      return { ...json(status, booking), headers: { 'content-type': 'application/json', location: `/bookings/${bookingId}`, 'x-saga-id': sagaId } };
    } catch (error) {
      if (error instanceof ProblemDetailsException && error.problem.status === 404) return json(202, { sagaId, bookingId, status: 'PENDING' });
      throw error;
    }
  }

  /** Estado público de una saga: sin su entrada (puede tener datos personales o de salud). */
  static view(this: void, record: SagaRecord) {
    return {
      sagaId: record.sagaId,
      type: record.type,
      status: record.status,
      steps: record.steps.map(({ name, status, at }) => ({ name, status, at })),
      result: record.status === 'COMPLETED' ? record.result : null,
      error: record.error,
      correlationId: record.correlationId,
      parentSagaId: record.parentSagaId,
      attempts: record.attempts,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
