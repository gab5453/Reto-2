"""Genera contract/events.asyncapi.yaml (AsyncAPI 3.0.0) — V2.1, paso 9.

Uso (desde contract/):  python tools/generar_events_asyncapi.py
Los eventos públicos y los entrantes de Booking REFERENCIAN los schemas CloudEvents de vuelos-openapi-v2.yaml (formato de
schema OpenAPI 3.0), así son iguales al contrato por construcción. Los internos usan JSON Schema propio.
"""
from pathlib import Path

import yaml
SAGA_TYPES = ["CREATE_BOOKING", "ISSUE_TICKETS", "PAYMENT_FAILED", "CHANGE_SEATS", "CHECK_IN", "CANCEL_BOOKING", "CHANGE_DATE",
              "ADD_BAGGAGE", "ASSISTANCE_READY", "UPDATE_FLIGHT_STATUS", "SAVE_PRICES", "PUBLISH_TIMETABLE"]

OUT = Path(__file__).resolve().parent.parent / "events.asyncapi.yaml"
C = "./vuelos-openapi-v2.yaml#/components/schemas"
OAS = "application/vnd.oai.openapi;version=3.0.0"
# Desde el 12/11/2026 el type público es el nombre corto (contrato v2 §8, a pedido de Booking); antes "ec.edu.epn.booking.vuelos.".
PUB = ""
INT = "ec.ecoairlines.internal."

DESCRIPTION = """\
Contrato de **eventos** de EcoAirlines (Reto 2). Documenta el bus interno, lo que sale hacia Booking Prototipo y lo que llega
desde Booking. Decisiones D4, D33, D34, D37, D40 y D41 de `PLAN/PLAN.md`; contrato de Vuelos v2, §8.

### Formato: CloudEvents 1.0 (contrato v2 §8)
Todos los mensajes son CloudEvents en modo estructurado (`application/cloudevents+json`): `specversion`, `type`, `source =
ecoairlines`, `id` (UUID v4 único, para deduplicar), `time`, `subject` (bookingId, holdId o vuelo/fecha),
`correlationid` (el `X-Correlation-Id` del proceso que lo originó, **sin cambios**) y `data`.
- `type` **público**: el nombre corto `<evento>` (`booking.checked_in`; contrato del grupo §8 desde el 12/11/2026, antes
  `ec.edu.epn.booking.vuelos.<evento>`; sus schemas se referencian).
- `type` **interno**: `ec.ecoairlines.internal.<evento>` (nunca sale de EcoAirlines).

### Bus interno — RabbitMQ (D8)
- Exchange `ecoairlines.events`, tipo **topic**, durable. **Routing key = nombre corto** del evento (`booking.confirmed`).
- Propiedades AMQP: `message_id` = `id` del CloudEvent, `correlation_id` = `correlationid`, `content_type` =
  `application/cloudevents+json`, `delivery_mode` = 2 (persistente); cabecera `x-request-id`.
- Cada productor publica desde su **outbox** (ESB y MS.G.Offers): el evento se guarda en la misma transacción que el cambio (en el
  ESB, en el mismo paso de la saga) y un relé lo envía después con **confirmación del broker**, así no se pierden ni se publican
  eventos de cambios que no se guardaron. Entrega "al menos una vez": un evento puede repetirse (la réplica se cayó entre
  publicar y marcar), por eso los consumidores son **idempotentes** y deduplican por `id`.
- **Reintentos y cola de fallidos** (por cada cola de consumidor `<cola>`): si el consumidor falla, el mensaje espera en
  `<cola>.retry.1s`, `.5s`, `.30s` y `.2m` (colas con TTL fijo cuyo *dead letter* lo devuelve SOLO a `<cola>`, sin duplicarlo en
  los otros consumidores) con la cabecera `x-attempts`. Al **5.º intento** fallido va al exchange `ecoairlines.dlx` (*direct*,
  routing key = `<cola>`) y queda en `<cola>.dlq` con `x-last-error`, `x-original-routing-key` y `x-failed-at`; el consumidor
  escribe una línea de ALERTA (la alerta de la plataforma de observabilidad llega en V2.16). Un mensaje ilegible va directo a
  `<cola>.dlq`.

| Cola | Enlaces (routing keys) | Consumidor |
|------|------------------------|------------|
| `webhooks.events` (+ `.retry.*`, `.dlq`) | `#` (todo) | MS.G.Webhooks: guarda el historial y entrega los **públicos** a los suscriptores |
| `flight-status.schedule` (+ `.retry.*`, `.dlq`) | `schedule.published` | MS.G.FlightStatus: proyección `scheduled_flights` (D4) |
| `esb.deferred` ← `esb.deferred.wait.<demora>` (TTL + DLX) | — (cola directa) | ESB: retoma una saga pendiente en el momento de su reintento (2 s, 10 s, 30 s, 2 min, 10 min, 30 min). Es un acelerador: si RabbitMQ no está, el ESB la encuentra igual en `saga_log` |

### Hacia Booking
1. **Webhooks** (obligatorio): MS.G.Webhooks hace `POST` a la URL de cada suscripción con el CloudEvent, firmado con
   `X-Webhook-Signature: sha256=<HMAC-SHA256(secret, cuerpo)>`; reintentos a 1 min, 5 min, 30 min, 2 h y 6 h. Solo eventos
   **públicos**, y de `booking.*` / `hold.*` solo los **del canal del partner** (D40). Respaldo: `GET /vuelos/eventos`.
2. **Stock** (obligatorio): no es un evento de este contrato; MS.G.Offers llama por gRPC a `PushStockUpdate`
   (`booking-inventory.proto`, D33).
3. **Puente al bus del ecosistema** (opcional, si el grupo lo pide): el ESB republica los públicos en el exchange
   `booking.events` con routing key `vuelos.<evento>`.

### Desde Booking (hallazgo BKG-01: canal por confirmar)
`payment.confirmed` → saga "Emitir boletos" · `payment.failed` → saga "Pago fallido" · `package.cancelled` → saga "Cancelar"
con `SAGA_COMPENSATION`. Mientras el grupo responde, el ESB acepta las dos vías documentadas abajo (AMQP en `booking.events` y
webhook firmado). Sin duplicados (D34): `inbound_events` por `id`, y sagas idempotentes.

### Datos sensibles
Ningún evento lleva tokens, datos de tarjeta ni datos de salud. `booking.assistance_requested` solo dice **que** cambió la
asistencia de un pasajero, no cuál es.
"""


def cloud_internal(event, data_schema, subject_desc):
    """Mensaje interno: sobre CloudEvents (JSON Schema) + data."""
    return {
        "allOf": [
            {"$ref": "#/components/schemas/CloudEventEnvelope"},
            {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "const": INT + event},
                    "subject": {"type": "string", "description": subject_desc},
                    "data": data_schema,
                },
            },
        ]
    }


def oas_inline(event, data_props, required):
    """Mensaje público sin schema propio en el contrato: CloudEventBase del contrato + data (formato OpenAPI)."""
    return {
        "schemaFormat": OAS,
        "schema": {
            "allOf": [
                {"$ref": f"{C}/CloudEventBase"},
                {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": [PUB + event]},
                        "data": {"type": "object", "required": required, "properties": data_props},
                    },
                },
            ]
        },
    }


# ------------------------------------------------------------------------------------------------- eventos públicos
# nombre corto, productor, schema del contrato (o inline), resumen
PUBLIC = [
    ("hold.created", "MS.G.Offers", "EventHoldCreated", "Se bloquearon asientos (hold creado)."),
    ("hold.expired", "MS.G.Offers", "EventHoldExpired", "Venció un hold; sus asientos vuelven a AVAILABLE."),
    ("booking.confirmed", "ESB", "EventBookingConfirmed", "Reserva creada (saga \"Crear reserva\")."),
    ("booking.failed", "ESB", "EventBookingFailed", "La reserva falló (pago fallido o saga compensada)."),
    ("booking.ticket_issuing", "ESB", None, "Compatibilidad con v1: la emisión quedó en curso (TICKET_ISSUING)."),
    ("booking.ticket_issued", "ESB", "EventTicketIssued", "Boletos emitidos (lo consume Facturación)."),
    ("booking.ticket_failed", "ESB", None, "Falló la emisión de boletos."),
    ("booking.changed", "ESB", "EventBookingChanged", "Cambio de fecha confirmado."),
    ("booking.baggage_added", "ESB", "EventBookingChanged", "Maletas extra agregadas."),
    ("booking.seat_changed", "ESB", "EventBookingChanged", "Asientos cambiados."),
    ("booking.cancelled", "ESB", "EventBookingCancelled", "Reserva cancelada (reembolso calculado o ejecutado)."),
    ("booking.checked_in", "ESB", "EventCheckedIn", "Check-in realizado."),
    ("flight.status_changed", "ESB", "EventFlightStatusChanged", "Cambió el estado de un vuelo (lo usan Autos y Alojamientos)."),
    ("flight.cancelled", "ESB", None, "Compatibilidad con v1: vuelo cancelado (los nuevos suscriptores usan flight.status_changed)."),
    ("flight.schedule_changed", "ESB", None, "Compatibilidad con v1: cambio de horario (los nuevos usan flight.status_changed)."),
]

BOOKING_DATA = {
    "bookingId": {"type": "string", "format": "uuid"},
    "pnr": {"type": "string"},
    "status": {"$ref": f"{C}/BookingStatus"},
    "errorCode": {"type": "string", "example": "TICKET_ISSUANCE_FAILED"},
}
FLIGHT_DATA = {
    "flightNumber": {"type": "string"},
    "date": {"type": "string", "format": "date"},
    "previousStatus": {"$ref": f"{C}/FlightOperationalStatus"},
    "newStatus": {"$ref": f"{C}/FlightOperationalStatus"},
    "estimatedDepartureAt": {"type": "string", "format": "date-time", "nullable": True},
}

# ------------------------------------------------------------------------------------------------- eventos internos
UUID = {"type": "string", "format": "uuid"}
INTERNAL = [
    ("schedule.published", "ESB", "MS.G.FlightStatus",
     "Horario publicado (saga \"Publicar horario\"). Lleva los vuelos, porque FlightStatus no llama a Schedule (D4).",
     {"type": "object", "required": ["publishId", "from", "to", "flights"],
      "properties": {"publishId": UUID, "routeId": {"type": "string", "description": "Ausente si se publicó el horario completo"},
                     "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"},
                     "flights": {"type": "array", "items": {"$ref": "#/components/schemas/ScheduledFlight"}}}},
     "routeId o «timetable»"),
    ("pricing.changed", "ESB", "MS.G.Webhooks (historial)",
     "Se guardaron precios por clase o el descuento máximo (saga \"Guardar precios y descuento máximo\").",
     {"type": "object", "required": ["actorId", "changedPrices", "promotionUpdated"],
      "properties": {"actorId": UUID, "promotionUpdated": {"type": "boolean"},
                     "changedPrices": {"type": "array", "items": {"type": "object", "required": ["cabinClass", "fareBrand", "oldMultiplier", "newMultiplier"],
                                                                   "properties": {"cabinClass": {"type": "string"}, "fareBrand": {"type": "string"},
                                                                                  "oldMultiplier": {"type": "number"}, "newMultiplier": {"type": "number"}}}}}},
     "«fare-prices»"),
    ("user.created", "ESB", "MS.G.Webhooks (historial)", "Un administrador creó un usuario.",
     {"$ref": "#/components/schemas/UserChange"}, "sub del usuario"),
    ("user.role_changed", "ESB", "MS.G.Webhooks (historial)", "Cambió el rol de un usuario.",
     {"$ref": "#/components/schemas/UserChange"}, "sub del usuario"),
    ("user.blocked", "ESB", "MS.G.Webhooks (historial)", "Se bloqueó o activó un usuario.",
     {"$ref": "#/components/schemas/UserChange"}, "sub del usuario"),
    ("partner.created", "ESB", "MS.G.Webhooks (historial)", "Alta de un partner (nunca lleva el secreto).",
     {"$ref": "#/components/schemas/PartnerChange"}, "clientId"),
    ("partner.blocked", "ESB", "MS.G.Webhooks (historial)", "Se bloqueó o activó un partner.",
     {"$ref": "#/components/schemas/PartnerChange"}, "clientId"),
    ("partner.secret_rotated", "ESB", "MS.G.Webhooks (historial)", "Se generó un secreto nuevo para un partner (nunca lo lleva).",
     {"$ref": "#/components/schemas/PartnerChange"}, "clientId"),
    ("booking.assistance_requested", "ESB", "MS.G.Webhooks (historial, sin datos)",
     "Cambió la asistencia médica de un pasajero. Dato de salud: NO lleva el tipo ni las notas y nunca sale a Booking.",
     {"type": "object", "required": ["bookingId", "passengerId", "action"],
      "properties": {"bookingId": UUID, "passengerId": {"type": "string"},
                     "action": {"type": "string", "enum": ["REQUESTED", "UPDATED", "REMOVED", "READY"]}}},
     "bookingId"),
]

# ------------------------------------------------------------------------------------------------- eventos entrantes
INBOUND = [
    ("payment.confirmed", "ec.edu.epn.booking.pagos.payment.confirmed", "pagos.payment.confirmed", "EventPaymentConfirmed",
     "Booking confirmó el pago de una reserva → saga \"Emitir boletos\" (idempotente: issued = 0 si ya estaban)."),
    ("payment.failed", "ec.edu.epn.booking.pagos.payment.failed", "pagos.payment.failed", "EventPaymentConfirmed",
     "Booking no pudo cobrar → saga \"Pago fallido\": liberar el hold y marcar la reserva FAILED."),
    ("package.cancelled", "ec.edu.epn.booking.paquetes.package.cancelled", "paquetes.package.cancelled", "EventPackageCancelled",
     "Falló otra parte del combo → saga \"Cancelar\" con reasonCode SAGA_COMPENSATION (siempre sin penalidad, D42)."),
]


def camel(name):
    parts = name.replace(".", "_").split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def pascal(name):
    c = camel(name)
    return c[0].upper() + c[1:]


AMQP_CHANNEL = {"amqp": {"is": "routingKey", "exchange": {"name": "ecoairlines.events", "type": "topic", "durable": True,
                                                            "autoDelete": False, "vhost": "/"}, "bindingVersion": "0.3.0"}}
AMQP_MESSAGE = {"amqp": {"contentEncoding": "utf-8", "messageType": "cloudevent", "bindingVersion": "0.3.0"}}

doc = {
    "asyncapi": "3.0.0",
    "info": {
        "title": "EcoAirlines — eventos (bus interno, webhooks a Booking y eventos de Booking)",
        "version": "1.0.0",
        "description": DESCRIPTION,
        "license": {"name": "Uso académico — Integración de Sistemas (sin licencia de distribución)"},
    },
    "defaultContentType": "application/cloudevents+json",
    "servers": {
        "ecoairlines-bus": {"host": "rabbitmq:5672", "protocol": "amqp", "protocolVersion": "0.9.1",
                            "description": "RabbitMQ interno de EcoAirlines (Docker Compose / nube). Exchange `ecoairlines.events`."},
        "booking-bus": {"host": "booking.epn.edu.ec:5672", "protocol": "amqp", "protocolVersion": "0.9.1",
                        "description": "Bus del ecosistema de Booking (exchange `booking.events`). Opcional; credenciales por confirmar (BKG-01)."},
        "booking-webhooks": {"host": "rda1-backend-integracion-sistemas.onrender.com", "protocol": "https",
                             "description": "Receptor de webhooks de Booking (la URL exacta es la de cada suscripción)."},
        "ecoairlines-public": {"host": "ecoairlines-gateway.azurecontainerapps.io", "protocol": "https",
                               "description": "Gateway público de EcoAirlines (entrada de eventos de Booking por webhook, BKG-01)."},
    },
    "channels": {},
    "operations": {},
    "components": {
        "schemas": {
            "CloudEventEnvelope": {
                "type": "object",
                "required": ["specversion", "type", "source", "id", "time", "correlationid", "data"],
                "properties": {
                    "specversion": {"type": "string", "const": "1.0"},
                    "type": {"type": "string"},
                    "source": {"type": "string", "const": "ecoairlines"},
                    "id": {"type": "string", "description": "Único; los consumidores deduplican por él"},
                    "time": {"type": "string", "format": "date-time"},
                    "subject": {"type": "string"},
                    "datacontenttype": {"type": "string", "const": "application/json"},
                    "correlationid": {"type": "string", "maxLength": 100, "description": "X-Correlation-Id del proceso (sin cambios)"},
                    "data": {"type": "object"},
                },
            },
            "UserChange": {
                "type": "object", "required": ["sub", "role", "status", "actorId"],
                "properties": {"sub": UUID, "role": {"type": "string", "enum": ["CUSTOMER", "ADMIN"]},
                               "status": {"type": "string", "enum": ["ACTIVE", "BLOCKED"]}, "actorId": UUID,
                               "reason": {"type": "string", "maxLength": 200}},
            },
            "PartnerChange": {
                "type": "object", "required": ["clientId", "status", "actorId"],
                "properties": {"clientId": {"type": "string"}, "status": {"type": "string", "enum": ["ACTIVE", "BLOCKED"]},
                               "actorId": UUID, "reason": {"type": "string", "maxLength": 200}},
            },
            "ScheduledFlight": {
                "type": "object",
                "required": ["flightNumber", "date", "routeId", "origin", "destination", "departureAt", "arrivalAt", "aircraftType", "registration"],
                "description": "Igual que ScheduledFlight de ms-g-schedule.openapi.yaml",
                "properties": {"flightNumber": {"type": "string"}, "date": {"type": "string", "format": "date"},
                               "routeId": {"type": "string"}, "origin": {"type": "string"}, "destination": {"type": "string"},
                               "departureAt": {"type": "string", "format": "date-time"}, "arrivalAt": {"type": "string", "format": "date-time"},
                               "aircraftType": {"type": "string"}, "registration": {"type": "string"}},
            },
            "DeferredTask": {
                "type": "object", "required": ["sagaId", "sagaType", "step", "attempt", "notBefore"],
                "properties": {"sagaId": UUID, "sagaType": {"type": "string", "enum": list(SAGA_TYPES)},
                               "step": {"type": "string", "example": "offers.release", "description": "Paso de la saga que quedó pendiente"},
                               "attempt": {"type": "integer", "minimum": 1},
                               "notBefore": {"type": "string", "format": "date-time"}, "correlationId": {"type": "string"}},
            },
        },
        "messages": {},
        "correlationIds": {
            "CloudEventCorrelation": {"description": "X-Correlation-Id del proceso, en el atributo `correlationid` del CloudEvent.",
                                      "location": "$message.payload#/correlationid"},
        },
    },
}
ch, ops, msgs = doc["channels"], doc["operations"], doc["components"]["messages"]
CORR = {"$ref": "#/components/correlationIds/CloudEventCorrelation"}

# ---- públicos en el bus interno
for name, producer, schema, summary in PUBLIC:
    key = pascal(name)
    if schema:
        payload = {"schemaFormat": OAS, "schema": {"$ref": f"{C}/{schema}"}}
    elif name.startswith("booking."):
        payload = oas_inline(name, BOOKING_DATA, ["bookingId", "pnr", "status"])
    else:
        payload = oas_inline(name, FLIGHT_DATA, ["flightNumber", "date", "newStatus"])
    msgs[key] = {"name": name, "title": f"{name} (público)", "summary": summary, "contentType": "application/cloudevents+json",
                 "correlationId": CORR, "payload": payload, "bindings": AMQP_MESSAGE,
                 "x-cloudevent-type": PUB + name, "x-public": True}
    ch[camel(name)] = {"address": name, "servers": [{"$ref": "#/servers/ecoairlines-bus"}],
                       "messages": {key: {"$ref": f"#/components/messages/{key}"}}, "bindings": AMQP_CHANNEL}
    ops[f"publish{key}"] = {"action": "send", "channel": {"$ref": f"#/channels/{camel(name)}"},
                            "messages": [{"$ref": f"#/channels/{camel(name)}/messages/{key}"}],
                            "summary": f"Lo publica {producer} desde su outbox.", "x-service": producer}
    ops[f"consume{key}"] = {"action": "receive", "channel": {"$ref": f"#/channels/{camel(name)}"},
                            "messages": [{"$ref": f"#/channels/{camel(name)}/messages/{key}"}],
                            "summary": "MS.G.Webhooks (cola webhooks.events): historial y entrega a los suscriptores.",
                            "x-service": "MS.G.Webhooks"}

# ---- internos
for name, producer, consumer, summary, data, subject in INTERNAL:
    key = pascal(name) + "Internal"
    msgs[key] = {"name": name, "title": f"{name} (interno)", "summary": summary, "contentType": "application/cloudevents+json",
                 "correlationId": CORR, "payload": cloud_internal(name, data, subject), "bindings": AMQP_MESSAGE,
                 "x-cloudevent-type": INT + name, "x-public": False}
    cname = camel(name) + "Internal"
    ch[cname] = {"address": name, "servers": [{"$ref": "#/servers/ecoairlines-bus"}],
                 "messages": {key: {"$ref": f"#/components/messages/{key}"}}, "bindings": AMQP_CHANNEL}
    ops[f"publish{key}"] = {"action": "send", "channel": {"$ref": f"#/channels/{cname}"},
                            "messages": [{"$ref": f"#/channels/{cname}/messages/{key}"}],
                            "summary": f"Lo publica {producer} desde su outbox. Nunca sale de EcoAirlines.", "x-service": producer}
    ops[f"consume{key}"] = {"action": "receive", "channel": {"$ref": f"#/channels/{cname}"},
                            "messages": [{"$ref": f"#/channels/{cname}/messages/{key}"}],
                            "summary": f"Lo consume {consumer}.", "x-service": consumer}

# ---- reintentos diferidos del ESB (TTL + dead letter): una cola de espera por demora del motor de sagas
msgs["DeferredTask"] = {"name": "esb.deferred", "title": "Reintento diferido (interno)", "contentType": "application/json",
                        "summary": "Retoma una saga pendiente (después del punto sin retorno, o una compensación que no pudo hacerse) en el momento de su reintento.",
                        "payload": {"$ref": "#/components/schemas/DeferredTask"},
                        "bindings": {"amqp": {"messageType": "deferred-task", "bindingVersion": "0.3.0"}}}
ch["esbDeferred"] = {"address": "esb.deferred.{sagaType}", "servers": [{"$ref": "#/servers/ecoairlines-bus"}],
                     "parameters": {"sagaType": {"enum": list(SAGA_TYPES)}},
                     "messages": {"DeferredTask": {"$ref": "#/components/messages/DeferredTask"}},
                     "description": "Se publica en la cola de espera de su demora, `esb.deferred.wait.{2s,10s,30s,2m,10m,30m}` (TTL fijo por cola: sin bloqueo cabeza de fila); al vencer, el dead letter la lleva a la cola `esb.deferred`, que consume el ESB.",
                     "bindings": {"amqp": {"is": "queue", "queue": {"name": "esb.deferred", "durable": True, "exclusive": False,
                                                                     "autoDelete": False, "vhost": "/"}, "bindingVersion": "0.3.0"}}}
ops["scheduleDeferredTask"] = {"action": "send", "channel": {"$ref": "#/channels/esbDeferred"}, "summary": "El ESB programa un reintento.",
                               "messages": [{"$ref": "#/channels/esbDeferred/messages/DeferredTask"}], "x-service": "ESB"}
ops["runDeferredTask"] = {"action": "receive", "channel": {"$ref": "#/channels/esbDeferred"}, "summary": "El ESB ejecuta el reintento.",
                          "messages": [{"$ref": "#/channels/esbDeferred/messages/DeferredTask"}], "x-service": "ESB"}

# ---- webhooks hacia Booking (todos los públicos)
public_refs = {pascal(n): {"$ref": f"#/components/messages/{pascal(n)}"} for n, *_ in PUBLIC}
ch["bookingWebhook"] = {
    "address": "{subscriptionUrl}",
    "servers": [{"$ref": "#/servers/booking-webhooks"}],
    "parameters": {"subscriptionUrl": {"description": "`url` de la suscripción (POST /vuelos/webhooks del contrato v2)"}},
    "description": "Entrega de webhooks del contrato v2 (callback `vuelosEvent`): POST del CloudEvent firmado.",
    "messages": public_refs,
}
ops["deliverWebhook"] = {
    "action": "send", "channel": {"$ref": "#/channels/bookingWebhook"},
    "messages": [{"$ref": f"#/channels/bookingWebhook/messages/{k}"} for k in public_refs],
    "summary": "MS.G.Webhooks entrega cada evento público suscrito, firmado con HMAC-SHA256, con reintentos 1 min → 6 h.",
    "description": "Filtro D40: `booking.*` y `hold.*` solo si la reserva o el hold son del canal del partner; `flight.*` a todos.",
    "bindings": {"http": {"method": "POST", "bindingVersion": "0.3.0"}},
    "x-service": "MS.G.Webhooks",
}
for k in public_refs:
    props = {
        "X-Webhook-Signature": {"type": "string", "pattern": "^sha256=[0-9a-f]{64}$", "description": "Solo en la entrega por webhook"},
        "X-Correlation-Id": {"type": "string", "maxLength": 100, "description": "Solo en la entrega por webhook"},
    }
    if k.startswith("Hold") or k.startswith("Booking"):
        # V2.8: el CloudEvent no lleva el dueño (es el mismo cuerpo que recibe Booking). En el bus interno viaja como cabecera
        # AMQP para que MS.G.Webhooks aplique el filtro D40; nunca se reenvía en el webhook ni en el feed.
        props["x-owner-id"] = {
            "type": "string", "maxLength": 200,
            "description": "Solo en el bus interno (cabecera AMQP), nunca en la entrega: dueño del hold o la reserva (D29: `sub` "
                           "de la web o `partner:<clientId>:<X-User-Id>`). Lo pone quien publica (Offers en hold.*, el ESB en "
                           "booking.*) y MS.G.Webhooks lo usa para el filtro D40.",
        }
    msgs[k].setdefault("headers", {
        "type": "object",
        "description": "Cabeceras: las HTTP de la entrega por webhook y, en hold.* y booking.*, la AMQP `x-owner-id` del bus interno",
        "properties": props,
    })

# ---- puente opcional al bus del ecosistema
ch["bookingEcosystemBridge"] = {
    "address": "vuelos.{evento}", "servers": [{"$ref": "#/servers/booking-bus"}],
    "parameters": {"evento": {"description": "Nombre corto del evento público (p. ej. booking.confirmed)"}},
    "description": "Opcional (contrato v2 §8): exchange `booking.events`, routing key `vuelos.<evento>`.",
    "messages": public_refs,
    "bindings": {"amqp": {"is": "routingKey", "exchange": {"name": "booking.events", "type": "topic", "durable": True,
                                                            "autoDelete": False, "vhost": "/"}, "bindingVersion": "0.3.0"}},
}
ops["bridgeToBookingBus"] = {"action": "send", "channel": {"$ref": "#/channels/bookingEcosystemBridge"},
                             "messages": [{"$ref": f"#/channels/bookingEcosystemBridge/messages/{k}"} for k in public_refs],
                             "summary": "Opcional: el ESB republica los eventos públicos en el bus del ecosistema.", "x-service": "ESB",
                             "x-optional": True}

# ---- entrantes desde Booking (dos vías hasta que se responda BKG-01)
inbound_refs = {}
for name, ce_type, rkey, schema, summary in INBOUND:
    key = "Booking" + pascal(name)
    msgs[key] = {"name": name, "title": f"{name} (de Booking)", "summary": summary, "contentType": "application/cloudevents+json",
                 "correlationId": CORR, "payload": {"schemaFormat": OAS, "schema": {"$ref": f"{C}/{schema}"}},
                 "x-cloudevent-type": ce_type}
    inbound_refs[key] = {"$ref": f"#/components/messages/{key}"}
    cname = "from" + key
    ch[cname] = {"address": rkey, "servers": [{"$ref": "#/servers/booking-bus"}],
                 "messages": {key: {"$ref": f"#/components/messages/{key}"}},
                 "description": "Vía AMQP en el bus del ecosistema (routing key por confirmar, BKG-01).",
                 "bindings": {"amqp": {"is": "routingKey", "exchange": {"name": "booking.events", "type": "topic", "durable": True,
                                                                         "autoDelete": False, "vhost": "/"}, "bindingVersion": "0.3.0"}}}
    ops[f"receive{key}"] = {"action": "receive", "channel": {"$ref": f"#/channels/{cname}"},
                            "messages": [{"$ref": f"#/channels/{cname}/messages/{key}"}],
                            "summary": "Entrada de eventos del ESB: deduplica por `id` (inbound_events) y dispara la saga.",
                            "x-service": "ESB"}
ch["bookingEventsWebhookIn"] = {
    "address": "/api/integraciones/booking/eventos", "servers": [{"$ref": "#/servers/ecoairlines-public"}],
    "description": "Vía webhook (propuesta, BKG-01): Booking hace POST del CloudEvent firmado con HMAC-SHA256 (secreto compartido).",
    "messages": inbound_refs,
}
ops["receiveBookingEventsByWebhook"] = {
    "action": "receive", "channel": {"$ref": "#/channels/bookingEventsWebhookIn"},
    "messages": [{"$ref": f"#/channels/bookingEventsWebhookIn/messages/{k}"} for k in inbound_refs],
    "summary": "Entrada de eventos del ESB por webhook: verifica la firma, deduplica por `id` y dispara la saga.",
    "bindings": {"http": {"method": "POST", "bindingVersion": "0.3.0"}}, "x-service": "ESB",
}

header = ("# =====================================================================================================================\n"
          "# GENERADO por contract/tools/generar_events_asyncapi.py — no editar a mano: cambie el generador y vuelva a ejecutarlo.\n"
          "# =====================================================================================================================\n")
OUT.write_text(header + yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, width=130), encoding="utf-8")
print("escrito", OUT.name, "·", len(msgs), "mensajes ·", len(ch), "canales ·", len(ops), "operaciones")
