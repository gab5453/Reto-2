import { buildJourney, flattenOtlp, maskIds, type RawSpan } from '../src/composition/journey.js';

/** Vista «Recorrido» (PLAN_Telemetria_Asientos T-4): de spans de Tempo a saltos por capas. */
const T = 1_794_297_355_000_000_000n;
const ms = (value: number) => T + BigInt(value) * 1_000_000n;
const span = (spanId: string, service: string, kind: string, start: number, end: number, extra: Partial<RawSpan> = {}): RawSpan => ({
  traceId: 'trace-1', spanId, service, name: 'POST', kind, startNs: ms(start), endNs: ms(end), error: false, attributes: {}, ...extra,
});

describe('buildJourney', () => {
  const spans: RawSpan[] = [
    // Entra desde la web al gateway (sin padre): sale del nodo «cliente». Lleva la IP del usuario: no debe salir.
    span('a', 'gateway', 'SPAN_KIND_SERVER', 0, 900, { attributes: { 'http.request.method': 'POST', 'http.route': '/api/graphql', 'client.address': '157.100.1.2', 'http.response.status_code': '200' } }),
    span('b', 'gateway', 'SPAN_KIND_CLIENT', 10, 880, { parentSpanId: 'a', attributes: { 'http.request.method': 'POST', 'url.full': 'http://ms-reservas:8080/api/v2/vuelos/bookings?email=ana@x.ec' } }),
    span('c', 'ms-reservas', 'SPAN_KIND_SERVER', 12, 870, { parentSpanId: 'b', attributes: { 'http.request.method': 'POST', 'http.route': '/api/v2/vuelos/bookings', 'http.response.status_code': '201' } }),
    span('d', 'ms-reservas', 'SPAN_KIND_CLIENT', 20, 860, { parentSpanId: 'c', attributes: { 'http.request.method': 'POST', 'url.full': 'http://esb:8080/sagas/bookings' } }),
    span('e', 'esb', 'SPAN_KIND_SERVER', 22, 850, { parentSpanId: 'd', attributes: { 'http.request.method': 'POST', 'http.route': '/sagas/bookings' } }),
    // gRPC a Offers y una llamada a un servicio sin trazas (va al nodo del host).
    span('f', 'esb', 'SPAN_KIND_CLIENT', 30, 60, { parentSpanId: 'e', attributes: { 'rpc.service': 'ecoairlines.offers.v1.InventoryService', 'rpc.method': 'ValidateHold' } }),
    span('g', 'ms-g-offers', 'SPAN_KIND_SERVER', 32, 58, { parentSpanId: 'f', attributes: { 'rpc.service': 'ecoairlines.offers.v1.InventoryService', 'rpc.method': 'ValidateHold' } }),
    span('h', 'esb', 'SPAN_KIND_CLIENT', 70, 300, { parentSpanId: 'e', error: true, attributes: { 'http.request.method': 'POST', 'url.full': 'http://bancoexterno.test/cobros' } }),
    // Un span interno (ni cliente ni servidor) no es un salto.
    span('i', 'esb', 'SPAN_KIND_INTERNAL', 300, 310, { parentSpanId: 'e' }),
  ];

  it('★ saltos en orden de tiempo, desde el inicio del proceso, con su capa; sin datos personales', () => {
    const journey = buildJourney('corr-1', spans);
    expect(journey.hops.map((hop) => `${hop.from}→${hop.to}`)).toEqual(['cliente→gateway', 'gateway→ms-reservas', 'ms-reservas→esb', 'esb→ms-g-offers', 'esb→bancoexterno.test']);
    expect(journey.hops[1]).toMatchObject({ sequence: 2, operation: 'POST /api/v2/vuelos/bookings', startMs: 10, durationMs: 870, status: 'OK', httpStatus: 201 });
    expect(journey.hops[3].operation).toBe('InventoryService/ValidateHold');
    expect(journey.hops[4]).toMatchObject({ operation: 'POST /cobros', status: 'ERROR' });
    expect(journey.nodes).toEqual([
      { id: 'cliente', layer: 'CLIENT' },
      { id: 'gateway', layer: 'GATEWAY' },
      { id: 'ms-reservas', layer: 'RESPONSE' },
      { id: 'esb', layer: 'ESB' },
      { id: 'ms-g-offers', layer: 'MANAGEMENT' },
      { id: 'bancoexterno.test', layer: 'EXTERNAL' },
    ]);
    expect(journey).toMatchObject({ traces: 1, durationMs: 900, truncated: false, startedAt: new Date(Number(T / 1_000_000n)).toISOString() });
    const text = JSON.stringify(journey);
    expect(text).not.toContain('157.100.1.2');
    expect(text).not.toContain('ana@x.ec');
  });

  it('sin spans: recorrido vacío', () => {
    expect(buildJourney('corr-x', [])).toMatchObject({ hops: [], nodes: [], startedAt: null });
  });

  it('flattenOtlp: lee el OTLP JSON de Tempo (servicio del recurso, ids, tiempos, estado y atributos)', () => {
    const body = { trace: { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'esb' } }] }, scopeSpans: [{ spans: [{ traceId: 'AAA=', spanId: 'BBB=', parentSpanId: 'CCC=', name: 'GET', kind: 'SPAN_KIND_CLIENT', startTimeUnixNano: '1794297355585000000', endTimeUnixNano: '1794297355600000000', status: { code: 'STATUS_CODE_ERROR' }, attributes: [{ key: 'http.response.status_code', value: { intValue: '503' } }] }] }] }] } };
    expect(flattenOtlp(body)).toEqual([{ traceId: 'AAA=', spanId: 'BBB=', parentSpanId: 'CCC=', service: 'esb', name: 'GET', kind: 'SPAN_KIND_CLIENT', startNs: 1794297355585000000n, endNs: 1794297355600000000n, error: true, attributes: { 'http.response.status_code': '503' } }]);
  });
});

describe('maskIds', () => {
  it('★ cambia por {id} los identificadores de la ruta (reserva, referencia de pago); deja la ruta y la versión', () => {
    expect(maskIds('/payments/pay_9RQp0FS2M17AKa019d8b/capture')).toBe('/payments/{id}/capture');
    expect(maskIds('/bookings/562db2df-a55e-4b32-8272-11ebfcab1289/tickets')).toBe('/bookings/{id}/tickets');
    expect(maskIds('/api/v2/vuelos/flights/EA324/status')).toBe('/api/v2/vuelos/flights/EA324/status');
    expect(maskIds('/api/v2/ecoairlines/bookings')).toBe('/api/v2/ecoairlines/bookings');
    expect(maskIds('/router/offers/HC-N01ABC')).toBe('/router/offers/{id}');
  });
});

