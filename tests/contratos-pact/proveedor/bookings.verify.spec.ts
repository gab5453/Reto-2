import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Verifier } from '@pact-foundation/pact';
import { BookingsModule, setupApp } from '../../../services/gestion/ms-g-bookings/src/app.module.js';
import { loadConfig } from '../../../services/gestion/ms-g-bookings/src/config/config.js';
import type { BookingRecord } from '../../../services/gestion/ms-g-bookings/src/domain/model.js';
import { issueTickets, pendingTickets } from '../../../services/gestion/ms-g-bookings/src/domain/rules.js';
import { InMemoryBookingsStore } from '../../../services/gestion/ms-g-bookings/src/repositories/in-memory.store.js';
import { DUENO_RESERVA, pactFile, PARTICIPANTES, RESERVA_ID, tokenDeServicio, verificador } from '../comun.js';

/**
 * Verificación del PROVEEDOR (CT-1): MS.G.Bookings real con su almacén en memoria. Cada «estado» del contrato prepara los
 * datos que la interacción necesita (una reserva confirmada de Booking). El token que trae el contrato es de ejemplo: el
 * `requestFilter` lo cambia por un token de servicio válido del ESB (como el que emitiría Identity).
 */
let app: NestExpressApplication;
let baseUrl: string;
const store = new InMemoryBookingsStore();

/** Una reserva confirmada de un usuario de Booking, con boletos emitidos, que sale en 30 días. */
function reservaConfirmada(): BookingRecord {
  const salida = new Date(Date.now() + 30 * 86_400_000);
  const dia = salida.toISOString().slice(0, 10);
  const segmentId = `EA100-${dia.replaceAll('-', '')}`;
  const base = {
    bookingId: RESERVA_ID,
    pnr: 'ABC234',
    ownerId: DUENO_RESERVA,
    channel: 'BOOKING',
    partnerId: 'BOOKING_PROTOTIPO',
    status: 'CONFIRMED',
    holdId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
    offerId: segmentId,
    sagaId: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
    passengersBreakdown: { adults: 1, youths: 0, children: 0, infants: 0 },
    passengers: [
      {
        passengerId: 'P1', passengerType: 'ADULT', firstName: 'Ana', lastName: 'Pérez', documentType: 'NATIONAL_ID', documentNumber: '1710034065',
        nationality: 'EC', birthDate: '1990-05-01', gender: 'F', contact: { email: 'ana@example.com', phone: '+593999999999' },
      },
    ],
    itineraries: [
      {
        itineraryId: segmentId,
        segments: [{ segmentId, flightNumber: 'EA100', departure: { iataCode: 'UIO', at: `${dia}T08:00:00-05:00` }, arrival: { iataCode: 'GYE', at: `${dia}T08:50:00-05:00` } }],
        pricingOptions: [{ baggageAllowance: { checkedBaggageIncluded: 0 } }],
      },
    ],
    fares: [{ itineraryId: segmentId, cabinClass: 'ECONOMY', fareBrand: 'SEMILLA', segmentIds: [segmentId], price: { currency: 'USD', total: '127.00' }, isRefundable: false, isChangeable: false }],
    grandTotal: { currency: 'USD', baseFare: '100.00', taxes: '27.00', total: '127.00' },
    payment: { paymentReference: 'PAY-BKP-20261201-000001', provider: 'BOOKING_PROTOTIPO' },
    changes: [],
    refunds: [],
    checkedIn: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as BookingRecord;
  return { ...base, tickets: issueTickets({ ...base, tickets: pendingTickets(base) }, new Date().toISOString()).tickets };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [BookingsModule.register(loadConfig({ NODE_ENV: 'test' }), { store, verifier: verificador })] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  setupApp(app);
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(() => app.close());

it('MS.G.Bookings cumple el contrato del ESB', () =>
  new Verifier({
    provider: PARTICIPANTES.bookings,
    providerBaseUrl: baseUrl,
    pactUrls: [pactFile(PARTICIPANTES.esb, PARTICIPANTES.bookings)],
    stateHandlers: {
      'existe una reserva confirmada de un usuario de Booking': async () => {
        await store.transaction(async (tx) => {
          if (!(await tx.booking(RESERVA_ID))) await tx.insertBooking(reservaConfirmada());
        });
      },
      // El almacén empieza vacío: ninguna referencia se usó.
      'la referencia de pago PAY-BKP-20261201-000099 no se ha usado': async () => undefined,
    },
    // El contrato trae un token de ejemplo; el proveedor exige uno de servicio válido (D41).
    requestFilter: (req, _res, next) => {
      req.headers['authorization'] = tokenDeServicio('ECOAIRLINES_ESB', 'ecoairlines:internal');
      next();
    },
    logLevel: 'warn',
  }).verifyProvider());
