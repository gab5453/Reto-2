import { ApiError } from './client';

/** Mensajes para el usuario por `code` del enum ProblemDetails del contrato. */
const MESSAGES: Record<string, string> = {
  SEAT_TAKEN: 'Ese asiento acaba de ser ocupado. Elige otro, por favor.',
  AMOUNT_MISMATCH: 'El monto del pago no coincide con el de la operación.',
  BOOKING_NOT_CONFIRMED: 'Esta acción requiere una reserva confirmada.',
  BAGGAGE_LIMIT_EXCEEDED: 'Superaste el máximo de maletas extra permitidas.',
  CUTOFF_PASSED: 'El check-in ya cerró para este vuelo (cierra 60 minutos antes de la salida).',
  FARE_NOT_CHANGEABLE: 'Tu tarifa no permite cambios de fecha.',
  FLIGHT_ALREADY_DEPARTED: 'Ese vuelo ya salió.',
  CHANGE_OFFER_EXPIRED: 'La opción de cambio expiró. Vuelve a buscar alternativas.',
  OFFER_NO_LONGER_AVAILABLE: 'La oferta ya no está disponible o se quedó sin cupos. Vuelve a buscar.',
  QUOTE_EXPIRED: 'La cotización expiró. Solicita una nueva.',
  ALREADY_CANCELLED: 'Esta reserva ya fue cancelada.',
  RATE_LIMIT_EXCEEDED: 'Hiciste demasiadas solicitudes seguidas.',
  INFANT_SEAT_NOT_ALLOWED: 'Los infantes viajan en el regazo de un adulto: no pueden tener asiento propio ni superar en número a los adultos.',
  PAYMENT_REFERENCE_INVALID: 'La referencia de pago no es válida o ya fue utilizada.',
  PAYMENT_NOT_AUTHORIZED: 'El pago no fue autorizado. Intenta con otro medio de pago.',
  PNR_CREATION_FAILED: 'No pudimos crear tu reserva. Inténtalo nuevamente.',
  TICKET_ISSUANCE_FAILED: 'No pudimos emitir tus boletos. Inténtalo nuevamente.',
  TICKET_ALREADY_ISSUED: 'Los boletos ya fueron emitidos.',
  CHECK_IN_NOT_AVAILABLE: 'El check-in aún no está disponible (abre 48 horas antes de la salida).',
  CHECK_IN_FAILED: 'No pudimos completar tu check-in.',
  BOARDING_PASS_NOT_AVAILABLE: 'Aún no hay pases de abordar: primero haz el check-in.',
  SEAT_CABIN_MISMATCH: 'El asiento no corresponde a la cabina que compraste.',
  FLIGHT_STATUS_NOT_AVAILABLE: 'No encontramos información de ese vuelo en esa fecha.',
  // Contrato v2
  HOLD_EXPIRED: 'Tu reserva temporal expiró. Vuelve a buscar el vuelo.',
  HOLD_ALREADY_CONSUMED: 'Esta selección ya se usó para una reserva. Revisa «Mis viajes».',
  IDEMPOTENCY_KEY_REUSED: 'Ya enviaste esta operación con otros datos. Recarga la página e inténtalo de nuevo.',
  PASSENGER_COUNT_MISMATCH: 'Los pasajeros no coinciden con los que elegiste al buscar.',
  INFANT_WITHOUT_ADULT: 'Cada infante debe viajar en brazos de un adulto distinto.',
  DOCUMENT_EXPIRED: 'Un documento vence antes del viaje.',
  PASSPORT_REQUIRED_INTERNATIONAL: 'Los vuelos internacionales requieren pasaporte.',
  BOOKING_NOT_CANCELLABLE: 'Esta reserva ya no se puede cancelar.',
  PROVIDER_UNAVAILABLE: 'Un servicio necesario no está disponible en este momento. Inténtalo en unos segundos.',
  // Cuenta (propios de EcoAirlines)
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos.',
  ACCOUNT_BLOCKED: 'Tu cuenta está bloqueada. Comunícate con EcoAirlines.',
  EMAIL_ALREADY_REGISTERED: 'Ese correo ya tiene una cuenta. Ingresa con tu contraseña.',
  CANNOT_MODIFY_SELF: 'No puedes cambiar tu propio rol ni bloquear tu propia cuenta.',
  LAST_ADMIN: 'Debe quedar al menos un administrador activo.',
  PARTNER_ALREADY_EXISTS: 'Ya existe un partner con ese identificador.',
  MULTIPLIER_OUT_OF_RANGE: 'Cada multiplicador debe estar entre 0,5 y 10.',
  PROMOTION_DISCOUNT_OUT_OF_RANGE: 'El descuento máximo de promociones es 50 %.',
  ROUTE_HAS_SOLD_SEATS: 'La ruta tiene asientos vendidos: gestiona esos vuelos con su estado operativo (p. ej. cancelarlos).',
  NOT_ENOUGH_AIRCRAFT: 'No hay aviones suficientes en ese aeropuerto para operar la ruta.',
  AIRCRAFT_IN_SERVICE: 'El avión opera rutas: primero reasígnalas.',
  INVALID_STATUS_TRANSITION: 'Ese cambio de estado no es válido para el vuelo.',
  // Payment API (tarjeta)
  CARD_NUMBER_INVALID: 'El número de tarjeta no es válido. Revísalo.',
  CARD_BRAND_NOT_SUPPORTED: 'Aceptamos Visa, Mastercard y American Express.',
  CARD_EXPIRED: 'La tarjeta está vencida.',
  CVV_INVALID: 'El código de seguridad (CVV) no es válido.',
  PAYMENT_METHOD_EXPIRED: 'Los datos de la tarjeta vencieron. Vuelve a intentarlo.',
};

/** Estos códigos llegan con 401/403/503 pero dicen algo más preciso que el mensaje genérico de su status. */
const SPECIFIC = new Set(['INVALID_CREDENTIALS', 'ACCOUNT_BLOCKED', 'PROVIDER_UNAVAILABLE']);

/** Mensaje amigable para cualquier error. VALIDATION_FAILED se usa como comodín en el contrato (HALL-05): se usa el título. */
export function friendlyMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Ocurrió un error inesperado.';
  if (error.status === 0) return error.message;
  const known = error.problem?.code;
  if (known && SPECIFIC.has(known)) return MESSAGES[known]!;
  if (error.status === 401) return 'Tu sesión expiró o no es válida. Ingresa nuevamente.';
  if (error.status === 403) return 'Tu cuenta no tiene permiso para esta operación.';
  if (error.status >= 500) return 'El servicio no está disponible en este momento. Inténtalo más tarde.';
  const code = error.problem?.code;
  if (code && code !== 'VALIDATION_FAILED' && MESSAGES[code]) return MESSAGES[code];
  return error.problem?.title ?? error.message;
}
