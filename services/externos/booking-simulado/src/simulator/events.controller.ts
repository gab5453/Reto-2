import { randomUUID } from 'node:crypto';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { IsIn, IsNumberString, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { CLOUDEVENTS_CONTENT_TYPE, correlationHeaders, currentCorrelation, signWebhook, WEBHOOK_SIGNATURE_HEADER } from '@ecoairlines/shared';

/**
 * Emisor de los eventos que Booking publica hacia la aerolínea (contrato v2 §8, events.asyncapi.yaml): `payment.confirmed`,
 * `payment.failed` y `package.cancelled`. Los envía firmados por la vía webhook propuesta en BKG-01
 * (`AIRLINE_EVENTS_URL`, p. ej. https://<gateway>/api/integraciones/booking/eventos). Sin URL, solo devuelve el evento.
 */
const TYPES = {
  'payment.confirmed': 'ec.edu.epn.booking.pagos.payment.confirmed',
  'payment.failed': 'ec.edu.epn.booking.pagos.payment.failed',
  'package.cancelled': 'ec.edu.epn.booking.paquetes.package.cancelled',
} as const;

class EmitEventDto {
  @IsIn(Object.keys(TYPES))
  event!: keyof typeof TYPES;

  @IsUUID()
  bookingId!: string;

  @IsOptional()
  @IsString()
  paymentReference?: string;

  @IsOptional()
  @IsNumberString()
  amount?: string;

  @IsOptional()
  @Matches(/^PKG-[A-Z0-9-]{3,40}$/)
  packageId?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

/** Formato del contrato v2 (`PAY-BKP-AAAAMMDD-NNNNNN`), con la fecha de hoy: el ESB rechaza cualquier otro (BKG-02). */
function defaultReference(): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `PAY-BKP-${today}-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
}

@Controller('simulador/eventos')
export class EventsController {
  @Post()
  @HttpCode(202)
  async emit(@Body() dto: EmitEventDto) {
    const data =
      dto.event === 'package.cancelled'
        ? { packageId: dto.packageId ?? `PKG-SIM-${randomUUID().slice(0, 8).toUpperCase()}`, bookingId: dto.bookingId, reason: dto.reason ?? 'Falló otra parte del combo' }
        : {
            paymentReference: dto.paymentReference ?? defaultReference(),
            bookingId: dto.bookingId,
            ...(dto.amount ? { amount: { currency: 'USD', total: dto.amount } } : {}),
            failureReason: dto.event === 'payment.failed' ? (dto.reason ?? 'Fondos insuficientes') : null,
          };
    const event = {
      specversion: '1.0',
      type: TYPES[dto.event],
      source: '/booking-prototipo',
      id: randomUUID(),
      time: new Date().toISOString(),
      subject: dto.bookingId,
      datacontenttype: 'application/json',
      correlationid: currentCorrelation()!.correlationId,
      data,
    };
    const url = process.env['AIRLINE_EVENTS_URL'];
    if (!url) return { delivered: false, reason: 'AIRLINE_EVENTS_URL no configurada', event };
    const body = JSON.stringify(event);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': CLOUDEVENTS_CONTENT_TYPE,
        [WEBHOOK_SIGNATURE_HEADER]: signWebhook(process.env['AIRLINE_EVENTS_SECRET'] ?? 'secreto-de-prueba-eventos-booking', body),
        ...correlationHeaders(),
      },
      body,
    }).catch((error: unknown) => ({ ok: false, status: 0, error: String(error) }));
    return { delivered: response.ok, status: response.status, event };
  }
}
