/**
 * Traducción entre las formas REST de los MS de respuesta y los tipos de `gateway.graphql`. Casi todos los tipos son iguales
 * al contrato v2; aquí solo está lo que cambia de nombre o de forma.
 */
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Scopes: `flights:read` ↔ `FLIGHTS_READ` (enums `Scope` y `PartnerScope`). */
export const scopeToEnum = (scope: string) => scope.replace(':', '_').toUpperCase();
export const enumToScope = (value: string) => value.toLowerCase().replace('_', ':');

/** Eventos: `booking.ticket_issued` ↔ `BOOKING_TICKET_ISSUED` (los puntos no son válidos en un enum GraphQL). */
export const eventToEnum = (event: string) => event.replace('.', '_').toUpperCase();
export const enumToEvent = (value: string) => value.toLowerCase().replace('_', '.');
/** `ec.edu.epn.booking.vuelos.booking.confirmed` → `booking.confirmed`. */
export const eventNameOf = (type: string) => type.replace(/^.*\.vuelos\./, '');

/** Los pagos de la web son siempre de la Payment API (`AIRLINE_DIRECT`, D28); el schema nunca recibe datos de tarjeta. */
export const webPayment = (payment: { paymentReference: string } | null | undefined) =>
  payment ? { paymentReference: payment.paymentReference, provider: 'AIRLINE_DIRECT' } : undefined;

/** El secreto nunca se devuelve: solo sus últimos 4 caracteres (`••••1234`) para que el administrador lo reconozca. */
export const maskSecret = (hint: string | undefined) => `••••${hint ?? ''}`;

export function scopesFrom(scope: string | undefined, known: Set<string>): string[] {
  return (scope ?? '').split(' ').filter(Boolean).map(scopeToEnum).filter((value) => known.has(value));
}

/** Reserva (`BookingDetail`): listas obligatorias en GraphQL que el contrato REST permite omitir. */
export function booking(detail: Any): Any {
  return {
    ...detail,
    itineraries: detail['itineraries'] ?? [],
    passengers: ((detail['passengers'] as Any[] | undefined) ?? []).map((p) => ({ ...p, assignedSeats: p['assignedSeats'] ?? [], extraBaggage: p['extraBaggage'] ?? [] })),
    changes: detail['changes'] ?? [],
  };
}

export function webhook(subscription: Any, hint: string | undefined = subscription['secretHint']): Any {
  return { ...subscription, events: ((subscription['events'] as string[] | undefined) ?? []).map(eventToEnum), secret: maskSecret(hint) };
}

export function partner(body: Any): Any {
  return {
    clientId: body['clientId'],
    name: body['name'],
    scopes: ((body['scopes'] as string[] | undefined) ?? []).map(scopeToEnum),
    status: body['status'],
    createdAt: body['createdAt'],
    secretRotatedAt: body['secretRotatedAt'] ?? null,
    lastTokenAt: body['lastTokenAt'] ?? null,
  };
}

/** `ContratoPromocionesResponse` del contrato v2 (snake_case, español) → `PromotionAgreement` (camelCase). */
export function agreement(contract: Any): Any {
  return {
    partnerId: contract['partnerId'],
    allowsPromotions: contract['permite_promociones'],
    maxDiscountPercentage: contract['porcentaje_descuento_maximo'],
    enabledDestinations: contract['destinos_habilitados'] ?? [],
    enabledRoutes: contract['rutas_habilitadas'] ?? [],
    enabledCabins: contract['cabinas_habilitadas'] ?? [],
    validUntil: contract['vigencia_hasta'] ?? null,
    comboConditions: contract['condiciones_combo'] ?? null,
    updatedAt: contract['actualizado_en'] ?? null,
  };
}

/** `PromotionAgreementInput` → `ContratoPromocionesRequest`. */
export function agreementRequest(input: Any): Any {
  return {
    permite_promociones: input['allowsPromotions'],
    porcentaje_descuento_maximo: input['maxDiscountPercentage'],
    destinos_habilitados: input['enabledDestinations'],
    rutas_habilitadas: input['enabledRoutes'],
    cabinas_habilitadas: input['enabledCabins'],
    vigencia_hasta: input['validUntil'],
    condiciones_combo: input['comboConditions'],
  };
}

export function pricesView(view: Any): Any {
  return { prices: view['prices']?.['items'] ?? [], updatedAt: view['prices']?.['updatedAt'], promotions: ((view['promotions'] as Any[] | undefined) ?? []).map(agreement) };
}

export function indicators(body: Any): Any {
  const bookings = body['bookings'] ?? {};
  const users = body['users'] ?? {};
  return {
    generatedAt: body['generatedAt'],
    totalBookings: bookings['totalBookings'] ?? 0,
    bookingsByChannel: { web: bookings['byChannel']?.['WEB'] ?? 0, booking: bookings['byChannel']?.['BOOKING'] ?? 0 },
    totalPassengers: bookings['totalPassengers'] ?? 0,
    revenue: bookings['revenue'],
    refundsCalculated: bookings['refundsCalculated'] ?? null,
    byRoute: bookings['byRoute'] ?? [],
    usersTotal: users['total'] ?? 0,
    customers: users['byRole']?.['CUSTOMER'] ?? 0,
    admins: users['byRole']?.['ADMIN'] ?? 0,
    flightsToday: body['flightsToday'] ?? 0,
  };
}

export function flightOperation(item: Any): Any {
  return {
    ...item,
    cabins: ((item['cabins'] as Any[] | undefined) ?? []).map((cabin) => {
      const by = cabin['seatsByStatus'] ?? {};
      return { ...cabin, seatsByStatus: { available: by['AVAILABLE'] ?? 0, held: by['HELD'] ?? 0, booked: by['BOOKED'] ?? 0, ticketed: by['TICKETED'] ?? 0, checkedIn: by['CHECKED_IN'] ?? 0, boarded: by['BOARDED'] ?? 0 } };
    }),
    alerts: item['alerts'] ?? [],
  };
}

export function cancellation(status: number, body: Any): Any {
  const refund = body['refund'];
  return {
    outcome: status === 202 || body['status'] === 'CANCELLATION_PENDING' ? 'ACCEPTED' : 'COMPLETED',
    bookingId: body['bookingId'],
    status: body['status'],
    refund: refund ? { refundId: refund['refundId'], amount: refund['amount'], penaltyAmount: refund['penaltyAmount'], currency: refund['currency'], percentage: refund['percentage'] ?? null, status: refund['status'] } : null,
    ticketsVoided: body['ticketsVoided'] ?? null,
    seatsReleased: body['inventoryRestoration']?.['seatsReleased'] ?? null,
  };
}

export function eventHistoryItem(item: Any): Any {
  return { ...item, deliveries: item['deliveries'] ?? [] };
}

export function trace(body: Any): Any {
  return {
    correlationId: body['correlationId'],
    steps: ((body['steps'] as Any[] | undefined) ?? []).map((step) => ({
      timestamp: step['timestamp'],
      service: step['service'],
      operation: step['operation'],
      status: step['status'],
      latencyMs: step['latency_ms'],
      requestId: step['request_id'] ?? null,
      traceId: step['trace_id'] ?? null,
    })),
    sagas: body['sagas'] ?? [],
    events: ((body['events']?.['items'] as Any[] | undefined) ?? []).map(eventHistoryItem),
  };
}

/** Un CloudEvent del feed → `WebhookEvent` de la suscripción (`undefined` si su tipo no está en `WebhookEventType`). */
export function bookingEvent(event: Any, known: Set<string>): Any | undefined {
  const eventType = eventToEnum(eventNameOf(String(event['type'] ?? '')));
  if (!known.has(eventType)) return undefined;
  const data = event['data'] ?? {};
  return {
    eventId: event['id'],
    eventType,
    occurredAt: event['time'],
    apiVersion: '2.0',
    data: { bookingId: data['bookingId'] ?? null, pnr: data['pnr'] ?? null, status: data['status'] ?? null, refundAmount: data['refundAmount'] ?? null },
    correlationId: event['correlationid'] ?? null,
  };
}
