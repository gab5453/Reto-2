# Contrato de Vuelos v2 (RDA2) — Guía para los equipos de e-commerce de vuelos

**Archivo:** `contracts/vuelos-openapi-v2.yaml` · **Versión:** 2.0.0 · **Reemplaza a:** `vuelos-openapi.yaml` (v1.5, que sigue funcionando en `/api/v1`)

---

## 1. ¿Qué es esto?

Es el contrato que **toda aerolínea debe cumplir** para que Booking Prototipo pueda vender sus vuelos.

- Es **el mismo contrato para todos los equipos de vuelos**. Booking integra cualquier aerolínea igual.
- **Su arquitectura interna es libre** (MS de gestión, ESB, orquestador, SOAP, gRPC interno, GraphQL para su web).
  Lo único obligatorio es que **hacia afuera** respondan lo que dice este contrato.
- Booking **no** llama a su GraphQL ni a sus microservicios internos. Entra por **una sola URL base**:
  `https://<su-aerolinea>/api/v2/vuelos/...`

## 2. ¿Cómo lo veo?

- Pegar el YAML en https://editor.swagger.io, o
- `npx @redocly/cli preview-docs contracts/vuelos-openapi-v2.yaml`

La descripción del contrato (arriba del todo) trae el detalle completo. Este README es el resumen.

## 3. ¿Qué endpoints contiene? (30)

Están agrupados por el microservicio de respuesta que debería implementarlos:

### MS.Vuelos — búsqueda, estado y administración
| Método | Ruta | Para qué | ¿Nuevo? |
|---|---|---|---|
| POST | `/vuelos/search` | Buscar vuelos (ida, ida y vuelta, multidestino) | |
| GET | `/vuelos/offers/{offerId}/seatmap` | Mapa de asientos | |
| GET | `/vuelos/flights/{flightNumber}/status` | Estado del vuelo | |
| PATCH | `/vuelos/flights/{flightNumber}/status` | Cambiar estado del vuelo (rol OPS/ADMIN) | 🆕 |
| GET | `/vuelos/operaciones/vuelos` | Panel de ocupación por vuelo y cabina | 🆕 |
| GET | `/vuelos/health` | Salud del nodo (semáforo 🟢/🔴 de Booking) | 🆕 |
| GET | `/vuelos/eventos` | Feed de eventos (respaldo de los webhooks) | 🆕 |
| GET / PUT | `/vuelos/promociones/contrato` | Acuerdo de promociones y combos | 🆕 |

### MS.Reservas — hold, reservas, boletos, asientos y check-in
| Método | Ruta | Para qué | ¿Nuevo? |
|---|---|---|---|
| POST | `/vuelos/offers/hold` | Bloquear asientos (15 min por defecto) | |
| GET / DELETE | `/vuelos/offers/hold/{holdId}` | Ver o liberar el hold | |
| GET / POST | `/vuelos/bookings` | Listar o crear reservas | |
| GET | `/vuelos/bookings/{bookingId}` | Detalle de la reserva | |
| POST | `/vuelos/bookings/{bookingId}/tickets` | Emitir boletos | 🆕 en el contrato |
| GET | `/vuelos/bookings/{bookingId}/tickets[/{ticketId}]` | Ver boletos | |
| PUT | `/vuelos/bookings/{bookingId}/seats` | Cambiar asiento | 🆕 |
| POST | `/vuelos/bookings/{bookingId}/check-in` | Check-in (abre 48 h antes) | |
| GET | `/vuelos/bookings/{bookingId}/boarding-passes` | Pases de abordar | |

### MS.Postventa — maletas, cambios y cancelación
| Método | Ruta | Para qué |
|---|---|---|
| GET | `/vuelos/bookings/{bookingId}/baggage-options` | Opciones de maletas |
| POST | `/vuelos/bookings/{bookingId}/baggage` | Agregar maletas |
| POST | `/vuelos/bookings/{bookingId}/date-change/search` | Buscar nuevas fechas |
| POST | `/vuelos/bookings/{bookingId}/date-change` | Confirmar cambio de fecha |
| GET | `/vuelos/bookings/{bookingId}/cancellation-quote` | Cotizar cancelación |
| POST | `/vuelos/bookings/{bookingId}/cancel` | Cancelar (también es la compensación de la Saga) |

### MS.Clientes — webhooks
| Método | Ruta | Para qué |
|---|---|---|
| GET / POST | `/vuelos/webhooks` | Listar o registrar suscripciones |
| DELETE | `/vuelos/webhooks/{id}` | Eliminar suscripción |

## 4. ¿Qué cambió respecto a v1?

| Cambio | Detalle |
|---|---|
| **Rutas** | `https://api.booking-hub.com/flights/v1/search` → `/api/v2/vuelos/search` |
| **7 endpoints nuevos** | health, eventos, promociones (GET/PUT), operaciones, cambio de estado del vuelo, cambio de asiento |
| **Emisión de boletos** | `POST .../tickets` ya existía en la implementación; ahora está en el contrato |
| **Errores** | `ProblemDetails` suma `instance`, `correlation_id`, `timestamp` y nuevos códigos |
| **Cancelación** | Responde reembolso + inventario restaurado; acepta `reasonCode` (`SAGA_COMPENSATION`, etc.) |
| **Campos nuevos (opcionales)** | `ttlMinutes` en el hold, `status` por asiento en el seatmap, `salesChannel` en la reserva, `_links` (HATEOAS) |
| **Webhooks** | Ahora entregan **CloudEvents** firmados con HMAC-SHA256; hay eventos nuevos |
| **Encabezados** | `X-Correlation-Id`, `X-Request-Id` y `X-User-Id` en todo el contrato |

**Lo que NO cambió:** los nombres de campos del dominio (inglés camelCase), los schemas de búsqueda, reserva, boletos y check-in, y los estados (enums). Si ya implementaron v1, la mayoría de su código sirve.

## 5. Reglas importantes

### 💳 Pagos — cobra Booking
1. Booking cobra al cliente y obtiene un `paymentReference`.
2. Booking lo envía en `POST /vuelos/bookings` (y en maletas, asientos o cambio de fecha).
3. **La aerolínea NO vuelve a cobrar.** Su saga se salta el paso de pago y solo valida la referencia.
4. En cancelaciones la aerolínea **calcula** el reembolso; **Booking lo ejecuta**.

### 🔐 Seguridad — dos capas
- El gateway de Booking valida al usuario.
- La aerolínea le da a Booking un **token de servicio** (OAuth2 `client_credentials`) desde su `dev-auth`.
- Booking manda quién es el usuario en `X-User-Id`.
- Son públicos (sin token): `search`, `seatmap`, `GET flights/{n}/status` y `health`.

### 🔎 Correlation ID — para seguir una compra de punta a punta
- Llega en `X-Correlation-Id`. **Nunca se cambia.** Se reenvía a todo lo que llamen:
  - HTTP: encabezado `X-Correlation-Id`
  - gRPC: metadata `x-correlation-id`
  - SOAP: `<soap:Header>`
  - RabbitMQ / Kafka: header + campo `correlationid` del CloudEvent
- Se devuelve en cada respuesta y en cada error, y se escribe en cada log.

### 🔁 Idempotencia
- `Idempotency-Key` (UUID) es **obligatorio** en hold, crear reserva, maletas, asientos, cambio de fecha, cancelar y promociones.
- Un reintento con la misma clave devuelve **la misma respuesta**, sin duplicar.

## 6. Eventos que deben publicar

Se entregan a Booking por **webhooks** (y opcionalmente por RabbitMQ/Kafka) con
`type = ec.edu.epn.booking.vuelos.<evento>`:

| Evento | Cuándo |
|---|---|
| `hold.created` / `hold.expired` | Se bloquean asientos / vence el hold |
| `booking.confirmed` / `booking.failed` | Se crea la reserva / falla |
| `booking.ticket_issued` / `booking.ticket_failed` | Se emiten los boletos (lo usa Facturación) |
| `booking.changed` / `booking.baggage_added` / `booking.seat_changed` | Postventa |
| `booking.cancelled` | Cancelación |
| `booking.checked_in` | Check-in hecho |
| `flight.status_changed` | Demora, cancelación o cambio de puerta (lo usan Autos y Alojamientos) |

**Eventos que deben escuchar (los publica Booking):** `payment.confirmed` (emitir boletos), `payment.failed` (liberar hold), `package.cancelled` (cancelar la parte de vuelo de un combo).

## 7. Stock por gRPC

Cada vez que cambian los asientos libres (hold, liberación, venta, cancelación), la aerolínea avisa a Booking por gRPC
(`inventory.InventoryStockService`, puerto 50051), con el mismo `.proto` que usa autos:

- `item_id` = vuelo + cabina, ej. `AV1632-ECONOMY`
- `available_units` = asientos libres
