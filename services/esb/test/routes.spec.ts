import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { findContractFile } from '../src/clients/contract-files.js';
import { matchRoute, OFFERS_ROUTES, REST_ROUTES } from '../src/router/routes.js';

/** La tabla del enrutador es la del contrato de cada MS.G (por construcción) y la que publica contract/esb.openapi.yaml. */
type Doc = { paths: Record<string, Record<string, { operationId?: string }>>; info: Record<string, unknown> };
const contract = (file: string) => load(readFileSync(findContractFile(file), 'utf8')) as Doc;

describe('tabla del enrutador', () => {
  it.each(REST_ROUTES.map((route) => [`${route.method} ${route.service}${route.path}`, route] as const))('%s existe en el contrato del MS.G con su operationId', (_name, route) => {
    const operation = contract(`ms-g-${route.service}.openapi.yaml`).paths[route.path]?.[route.method.toLowerCase()];
    expect(operation?.operationId).toBe(route.operationId);
  });

  it('x-esb-routes de contract/esb.openapi.yaml es exactamente la tabla del código', () => {
    const published = contract('esb.openapi.yaml').info['x-esb-routes'] as { service: string; method: string; path: string; operationId: string; withoutServiceToken?: boolean }[];
    expect(published.map(({ service, method, path, operationId, withoutServiceToken }) => ({ service, method, path, operationId, ...(withoutServiceToken ? { withoutServiceToken } : {}) }))).toEqual(
      REST_ROUTES.map(({ service, method, path, operationId, withoutServiceToken }) => ({ service, method, path, operationId, ...(withoutServiceToken ? { withoutServiceToken } : {}) })),
    );
    expect(contract('esb.openapi.yaml').info['x-esb-offers-routes']).toEqual([...OFFERS_ROUTES]);
  });

  it('los RPC de Offers del enrutador existen en ms-g-offers.proto', () => {
    const proto = readFileSync(findContractFile('ms-g-offers.proto'), 'utf8');
    for (const rpc of OFFERS_ROUTES) expect(proto).toMatch(new RegExp(`rpc ${rpc}\\(`));
  });

  it('ninguna ruta del enrutador es un paso de saga (los que coordinan varios MS.G son del orquestador)', () => {
    const sagaSteps = ['createBooking', 'issueTickets', 'claimPaymentReference', 'applySeats', 'applyCancellation', 'applyDateChange', 'applyBaggage', 'failBooking', 'registerCheckIn', 'updateFlightStatus', 'saveFarePrices', 'savePromotionAgreement', 'createRoute', 'updateRoute', 'deleteRoute'];
    expect(REST_ROUTES.filter((route) => sagaSteps.includes(route.operationId))).toEqual([]);
  });

  it('coincidencias: parámetros, la primera ruta gana y los segmentos `..` no coinciden', () => {
    expect(matchRoute('bookings', 'GET', '/bookings/abc/tickets/T-1')?.params).toEqual({ bookingId: 'abc', ticketId: 'T-1' });
    expect(matchRoute('identity', 'GET', '/users/summary')?.route.operationId).toBe('getUserSummary');
    expect(matchRoute('identity', 'GET', '/users/9d2c6a3e')?.route.operationId).toBe('getUser');
    expect(matchRoute('bookings', 'GET', '/bookings/..')).toBeUndefined();
    expect(matchRoute('bookings', 'GET', '/bookings/%2E')).toBeUndefined();
    expect(matchRoute('bookings', 'GET', '/bookings/a/b')).toBeUndefined();
  });
});
