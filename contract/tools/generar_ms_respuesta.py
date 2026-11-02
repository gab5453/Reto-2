"""Genera los contratos de los 5 microservicios de respuesta (V2.1, paso 7).

Las operaciones del contrato del grupo se REFERENCIAN por ruta ($ref a vuelos-openapi-v2.yaml#/paths/...), así son idénticas
por construcción. Las operaciones propias (solo para la web, vía GraphQL) van bajo /ecoairlines/... y referencian los schemas de
los contratos internos de los MS.G.
"""
import json
import sys
import yaml

CONTRACT_DIR = sys.argv[1]
C = "./vuelos-openapi-v2.yaml"
group = yaml.safe_load(open(f"{CONTRACT_DIR}/vuelos-openapi-v2.yaml", encoding="utf-8"))

METHODS = ("get", "post", "put", "patch", "delete")


def contract_paths(ms):
    """Rutas del contrato del grupo cuyo x-microservice es `ms`, como $ref (en el orden del contrato)."""
    lines = []
    for path, item in group["paths"].items():
        owners = {op["x-microservice"] for m, op in item.items() if m in METHODS}
        if owners == {ms}:
            pointer = path.replace("~", "~0").replace("/", "~1")
            ops = ", ".join(f"{m.upper()} {op['operationId']}" for m, op in item.items() if m in METHODS)
            lines.append(f"  # contrato v2 · {ops}")
            lines.append(f"  {path}:")
            lines.append(f"    $ref: '{C}#/paths/{pointer}'")
    return "\n".join(lines)


def count(ms):
    return sum(1 for item in group["paths"].values() for m, op in item.items() if m in METHODS and op["x-microservice"] == ms)


COMMON_SECURITY_TEXT = """
    ### Seguridad (D22, D29, D41)
    Verifica el token con la JWKS de MS.G.Identity (el gateway ya lo verificó; aquí se verifica otra vez, defensa en
    profundidad) y los scopes de cada operación:
    - **Token de partner** (`token_use = partner`, Booking): las operaciones del contrato. Solo con este token se lee `X-User-Id`;
      el dueño es `partner:<clientId>:<X-User-Id>`.
    - **Token de usuario** (`token_use = user`, la web): equivale al `BearerAuth` del contrato. El dueño es su `sub`; `X-User-Id`
      se ignora.
    - **Token de servicio** (`token_use = service`, del ESB o de otro MS): se **rechaza** (`401`); solo lo aceptan el ESB y los MS.G.
    El dueño **nunca** sale del cuerpo. Un recurso de otro dueño responde `404`.

    ### Qué hace en cada petición (como hoy `EcoAirlines.API`)
    1. Valida el DTO exacto al contrato (`required`, `enum`, `pattern`, `additionalProperties`…) → `400 VALIDATION_FAILED`.
    2. Aplica el límite de peticiones → `429`.
    3. Llama al **ESB** (enrutador, orquestador o composición) con **su propio** token de servicio (cliente interno del MS en
       Identity, scope `ecoairlines:esb`, D44: lo acepta el ESB y lo rechazan los MS.G), `X-Owner-Id` / `X-Actor-Id`,
       `X-Correlation-Id` (sin cambiarlo), un `X-Request-Id` nuevo y la `Idempotency-Key` recibida (el ESB la resuelve, D6).
    4. Arma la respuesta pública: quita los campos internos (`ownerId`, `channel`, `fares`…), agrega `_links` (HATEOAS) y
       `Location` con la ruta `/api/v2/vuelos/...`, y traduce los errores a `ProblemDetails` v2.
    5. Devuelve `X-Correlation-Id` en **toda** respuesta, también en los errores.
"""

HEADER = """openapi: 3.0.3
info:
  title: {title}
  version: {version}
  license:
    name: Uso académico — Integración de Sistemas (sin licencia de distribución)
  description: |
{description}
servers:
  - url: http://{host}:8080/api/v2
    description: Red interna (detrás del gateway, que publica /api/v2/vuelos/* y /api/graphql)
  - url: http://localhost:{port}/api/v2
    description: Desarrollo local
"""


def indent(text, n=4):
    return "\n".join((" " * n + line) if line.strip() else "" for line in text.strip("\n").splitlines())


# ------------------------------------------------------------------------------------------------- componentes comunes
def components(extra_schemas="", extra_params="", extra_responses=""):
    return f"""
components:
  securitySchemes:
    PartnerOAuth2:
      $ref: '{C}#/components/securitySchemes/PartnerOAuth2'
    BearerAuth:
      $ref: '{C}#/components/securitySchemes/BearerAuth'
    PartnerClientBasic:
      $ref: './ms-g-identity.openapi.yaml#/components/securitySchemes/PartnerClientBasic'
    UserJwt:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: Token de usuario de la web (`token_use = user`), emitido por MS.G.Identity. Lo reenvía el gateway GraphQL.

  parameters:
    CorrelationId:
      $ref: '{C}#/components/parameters/CorrelationId'
{extra_params}
  responses:
    Problem400:
      $ref: '{C}#/components/responses/Problem400'
    Problem401:
      $ref: '{C}#/components/responses/Problem401'
    Problem403:
      $ref: '{C}#/components/responses/Problem403'
    Problem404:
      $ref: '{C}#/components/responses/Problem404'
    Problem409:
      $ref: '{C}#/components/responses/Problem409'
    Problem422:
      $ref: '{C}#/components/responses/Problem422'
    Problem429:
      $ref: '{C}#/components/responses/Problem429'
    Problem503:
      $ref: '{C}#/components/responses/Problem503'
{extra_responses}
  schemas:
    ProblemDetails:
      $ref: '{C}#/components/schemas/ProblemDetails'
{extra_schemas}
"""


def ok(schema_ref, description="OK", code="200"):
    return f"""        '{code}':
          description: {description}
          content:
            application/json:
              schema:
                $ref: '{schema_ref}'"""


def body(schema_ref):
    return f"""      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '{schema_ref}'"""


def errors(*codes):
    return "\n".join(f"        '{c}':\n          $ref: '#/components/responses/Problem{c}'" for c in codes)


def op(method, op_id, summary, tag, scopes, *, desc=None, params=(), req=None, resp=(), errs=(401, 403), public=False):
    sec = "      security: []" if public else f"      security:\n        - UserJwt: [{scopes}]"
    lines = [f"    {method}:", f"      tags: [{tag}]", f"      operationId: {op_id}", f"      summary: {json.dumps(summary, ensure_ascii=False)}"]
    if desc:
        lines.append(f"      description: {json.dumps(desc, ensure_ascii=False)}")
    lines.append(sec)
    plist = ["        - $ref: '#/components/parameters/CorrelationId'"] + [f"        - $ref: '{p}'" for p in params]
    lines.append("      parameters:\n" + "\n".join(plist))
    if req:
        lines.append(body(req))
    lines.append("      responses:")
    lines.extend(resp)
    if errs:
        lines.append(errors(*errs))
    return "\n".join(lines)


def path(p, *ops):
    return f"  {p}:\n" + "\n".join(ops)


def write(name, text):
    open(f"{CONTRACT_DIR}/{name}", "w", encoding="utf-8").write(text.rstrip() + "\n")
    print("escrito", name)


ID = "./ms-g-identity.openapi.yaml#/components/schemas"
CU = "./ms-g-customers.openapi.yaml#/components/schemas"
BK = "./ms-g-bookings.openapi.yaml#/components/schemas"
SC = "./ms-g-schedule.openapi.yaml#/components/schemas"
WH = "./ms-g-webhooks.openapi.yaml#/components/schemas"
CI = "./ms-g-check-in.openapi.yaml#/components/schemas"

# ============================================================================================================ MS.Vuelos
write("ms-vuelos.openapi.yaml", HEADER.format(
    title="MS.Vuelos — búsqueda, estado, operaciones, health, eventos y promociones (respuesta)",
    host="ms-vuelos", port=5001, version="1.0.1",
    description=indent(f"""
Microservicio de respuesta **MS.Vuelos** de EcoAirlines (Reto 2). Implementa las **{count('MS.Vuelos')} operaciones** del contrato de
Vuelos v2 cuyo `x-microservice` es `MS.Vuelos` (D32). Las rutas se **referencian** desde `vuelos-openapi-v2.yaml`: son
idénticas al contrato por construcción. No tiene operaciones propias: el panel de administración usa estas mismas para el
estado de vuelo, las operaciones y el acuerdo de promociones.

| Operación | Cadena en el ESB |
|-----------|------------------|
| `searchFlights`, `getSeatMap` | Enrutador → Offers (gRPC) |
| `getFlightStatus` | Enrutador → FlightStatus |
| `updateFlightStatus` | Orquestador: saga "Cambiar estado de vuelo" (D37) |
| `listFlightOperations` | Composición: Offers + FlightStatus + Schedule |
| `getHealth` | Composición, servida desde caché (< 1 s) |
| `listOutboxEvents` | Enrutador → Webhooks (`GET /events`, filtrado por partner, D40) |
| `getPromotionAgreement` | Enrutador → Schedule (`partnerId` = el del token) |
| `putPromotionAgreement` | Orquestador: saga "Guardar precios y descuento máximo" (solo `flights:admin`, que tiene nuestro ADMIN, no el partner; máximo 50 %, D35) |
{COMMON_SECURITY_TEXT}"""),
) + "security:\n  - PartnerOAuth2: []\n  - BearerAuth: []\npaths:\n" + contract_paths("MS.Vuelos") + components())

# ============================================================================================================ MS.Postventa
write("ms-postventa.openapi.yaml", HEADER.format(
    title="MS.Postventa — maletas, cambio de fecha y cancelación (respuesta)",
    host="ms-postventa", port=5003, version="1.0.1",
    description=indent(f"""
Microservicio de respuesta **MS.Postventa** de EcoAirlines (Reto 2). Implementa las **{count('MS.Postventa')} operaciones** del contrato
de Vuelos v2 cuyo `x-microservice` es `MS.Postventa`, referenciadas desde `vuelos-openapi-v2.yaml` (idénticas por
construcción). No tiene operaciones propias.

| Operación | Cadena en el ESB |
|-----------|------------------|
| `getBaggageOptions` | Composición: Bookings + Offers + PostSale (`GetBaggageOptions`) |
| `addBaggage` | Orquestador: saga "Agregar maletas" |
| `searchDateChange` | Composición: Bookings + Offers (`FindAlternatives`) + PostSale (`CreateDateChangeOffers`) |
| `confirmDateChange` | Orquestador: saga "Cambiar fecha" |
| `getCancellationQuote` | Composición: Bookings + PostSale (`CreateCancellationQuote`) |
| `cancelBooking` | Orquestador: saga "Cancelar" (`reasonCode`; con `SAGA_COMPENSATION` o `FLIGHT_CANCELLED`, sin cotización) |

**Pagos:** en el canal Booking el `payment.paymentReference` se **valida** (Booking ya cobró); en el canal web se **captura** en
la Payment API (D28). En `cancelBooking` el reembolso se **calcula** (`CALCULATED`) para Booking y se **ejecuta** (`SETTLED`)
para la web.
{COMMON_SECURITY_TEXT}"""),
) + "security:\n  - PartnerOAuth2: []\n  - BearerAuth: []\npaths:\n" + contract_paths("MS.Postventa") + components())

# ============================================================================================================ MS.Reservas
assist_params = """    BookingId:
      $ref: '{C}#/components/parameters/BookingId'
    PassengerId:
      name: passengerId
      in: path
      required: true
      schema:
        type: string
        maxLength: 20
      example: PAX-1
    IdempotencyKey:
      $ref: '{C}#/components/parameters/IdempotencyKey'
""".replace("{C}", C)
reservas_schemas = f"""    WebBookingRequest:
      type: object
      additionalProperties: false
      required: [booking]
      description: Reserva de la web con asistencia opcional por pasajero (saga "Crear reserva (+ asistencia)").
      properties:
        booking:
          $ref: '{C}#/components/schemas/BookingRequest'
        assistance:
          type: array
          maxItems: 9
          items:
            # `AssistanceRequest` + `passengerId`, declarado completo: un `allOf` con `additionalProperties: false` (el de
            # AssistanceRequest) rechazaría `passengerId` (corregido en 1.1.0, V2.12).
            type: object
            additionalProperties: false
            required: [passengerId, type]
            properties:
              passengerId:
                type: string
                maxLength: 20
              type:
                $ref: '{BK}/AssistanceType'
              needsCompanion:
                type: boolean
                default: false
              notes:
                type: string
                maxLength: 200
"""
reservas_own = "\n".join([
    path("/ecoairlines/bookings",
         op("post", "createWebBooking", "Crear una reserva desde la web, con asistencia médica opcional", "Propias (web)", "flights:book",
            desc="Misma saga que `createBooking` del contrato, más la asistencia. Canal `WEB`: el pago se captura en la Payment API.",
            params=["#/components/parameters/IdempotencyKey"], req="#/components/schemas/WebBookingRequest",
            resp=[ok(f"{C}#/components/schemas/BookingDetail", "Reserva creada y boletos emitidos", "201"),
                  ok(f"{C}#/components/schemas/BookingDetail", "Emisión en curso (TICKET_ISSUING)", "202")],
            errs=(400, 401, 403, 409, 422))),
    path("/ecoairlines/bookings/{bookingId}/assistance",
         op("get", "listAssistance", "Asistencia médica de los pasajeros de una reserva", "Propias (web)", "flights:read",
            params=["#/components/parameters/BookingId"],
            resp=[f"""        '200':
          description: Asistencia por pasajero (dato de salud; solo el dueño o un administrador)
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '{BK}/PassengerAssistance'"""], errs=(401, 403, 404))),
    path("/ecoairlines/bookings/{bookingId}/refunds",
         op("get", "listRefunds", "Reembolsos de una reserva (si se canceló)", "Propias (web)", "flights:read",
            params=["#/components/parameters/BookingId"],
            resp=[f"""        '200':
          description: Reembolsos calculados o ejecutados (V2.13, `Booking.refunds` de GraphQL); vacío si no se canceló
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '{BK}/Refund'"""], errs=(401, 403, 404))),
    path("/ecoairlines/bookings/{bookingId}/passengers/{passengerId}/assistance",
         op("put", "saveAssistance", "Pedir o cambiar la asistencia de un pasajero", "Propias (web)", "flights:book",
            params=["#/components/parameters/BookingId", "#/components/parameters/PassengerId"], req=f"{BK}/AssistanceRequest",
            resp=[ok(f"{BK}/PassengerAssistance", "Asistencia guardada")], errs=(400, 401, 403, 404, 409)),
         op("delete", "deleteAssistance", "Quitar la asistencia de un pasajero", "Propias (web)", "flights:book",
            params=["#/components/parameters/BookingId", "#/components/parameters/PassengerId"],
            resp=["        '204':\n          description: Quitada"], errs=(401, 403, 404, 409))),
])
write("ms-reservas.openapi.yaml", HEADER.format(
    title="MS.Reservas — hold, reservas, boletos, asientos, check-in y asistencia (respuesta)",
    host="ms-reservas", port=5002, version="1.2.0",
    description=indent(f"""
Microservicio de respuesta **MS.Reservas** de EcoAirlines (Reto 2). Implementa las **{count('MS.Reservas')} operaciones** del contrato
de Vuelos v2 cuyo `x-microservice` es `MS.Reservas`, referenciadas desde `vuelos-openapi-v2.yaml` (idénticas por
construcción), y **operaciones propias** bajo `/ecoairlines/...` que solo usa la web (vía GraphQL, D23): la reserva con
asistencia médica y la gestión de la asistencia.

| Operación | Cadena en el ESB |
|-----------|------------------|
| `createHold`, `getHold`, `releaseHold` | Enrutador → Offers (gRPC) |
| `listBookings`, `getBooking`, `listTickets`, `getTicket` | Enrutador → Bookings |
| `createBooking` / `createWebBooking` | Orquestador: saga "Crear reserva" (`201 CONFIRMED` o `202 TICKET_ISSUING`, D36) |
| `issueTickets` | Orquestador: saga "Emitir boletos" (idempotente, `issued: 0`) |
| `changeSeats` | Orquestador: saga "Cambiar asientos" (atómico) |
| `checkIn` | Orquestador: saga "Check-in" (48 h, boletos emitidos) |
| `listBoardingPasses` | Composición: CheckIn + FlightStatus (puerta vigente) |
| asistencia (propias) | Enrutador → Bookings (dato de salud: nunca en logs ni eventos externos) |
| `listRefunds` (propia, 1.2.0) | Enrutador → Bookings (los reembolsos de la reserva, que el contrato v2 no publica) |

**Pagos (D28):** con token de partner el `paymentReference` se **valida** (Booking ya cobró); con token de usuario se
**captura** en la Payment API.
{COMMON_SECURITY_TEXT}"""),
) + "security:\n  - PartnerOAuth2: []\n  - BearerAuth: []\ntags:\n  - name: Propias (web)\n    description: Operaciones de EcoAirlines fuera del contrato del grupo (solo vía GraphQL)\npaths:\n"
    + contract_paths("MS.Reservas") + "\n  # ----------------------------------------------------- propias (solo web, vía GraphQL)\n" + reservas_own
    + components(extra_schemas=reservas_schemas, extra_params=assist_params))

# ============================================================================================================ MS.Clientes
clientes_own = "\n".join([
    path("/oauth2/token",
         f"""    $ref: './ms-g-identity.openapi.yaml#/paths/~1oauth2~1token'"""),
    path("/ecoairlines/webhooks",
         op("get", "listOwnWebhooks", "Suscripciones del administrador con la pista del secreto (••••1234)", "Propias (web)", "flights:webhooks",
            resp=[f"""        '200':
          description: Las suscripciones del dueño con `secretHint` (los últimos 4 caracteres del secreto; V2.14). El contrato v2 no la publica
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: './ms-g-webhooks.openapi.yaml#/components/schemas/SubscriptionView'"""], errs=(401, 403))),
    path("/ecoairlines/auth/register",
         op("post", "register", "Registro público de un cliente (siempre CLIENTE)", "Propias (web)", "", public=True,
            req=f"{ID}/RegisterRequest", resp=[ok(f"{ID}/TokenResponse", "Cuenta creada y token emitido", "201")],
            errs=(400, 409, 429))),
    path("/ecoairlines/auth/login",
         op("post", "login", "Iniciar sesión (token de usuario)", "Propias (web)", "", public=True,
            req=f"{ID}/LoginRequest", resp=[ok(f"{ID}/TokenResponse", "Credenciales correctas")], errs=(400, 401, 403, 429))),
    path("/ecoairlines/customers/me",
         op("get", "getMyProfile", "Perfil del cliente con su asistencia predeterminada", "Propias (web)", "ecoairlines:profile",
            resp=[ok(f"{CU}/CustomerProfile", "Perfil")], errs=(401, 403, 404)),
         op("put", "saveMyProfile", "Crear o reemplazar el perfil del cliente", "Propias (web)", "ecoairlines:profile",
            req=f"{CU}/CustomerProfileRequest", resp=[ok(f"{CU}/CustomerProfile", "Perfil guardado")], errs=(400, 401, 403))),
])
write("ms-clientes.openapi.yaml", HEADER.format(
    title="MS.Clientes — webhooks, token de partner, registro, login y perfil (respuesta)",
    host="ms-clientes", port=5004, version="1.1.0",
    description=indent(f"""
Microservicio de respuesta **MS.Clientes** de EcoAirlines (Reto 2). Implementa las **{count('MS.Clientes')} operaciones** del contrato
de Vuelos v2 cuyo `x-microservice` es `MS.Clientes` (webhooks), referenciadas desde `vuelos-openapi-v2.yaml` (idénticas por
construcción), y además:
- **`POST /oauth2/token`** (`tokenUrl` del `PartnerOAuth2` del contrato): el gateway lo publica en `/api/v2/oauth2/token` y en el
  alias `/oauth2/token` (BKG-03). Es la misma operación de MS.G.Identity, referenciada (formato de errores OAuth2).
- **Operaciones propias** bajo `/ecoairlines/...` que solo usa la web (vía GraphQL, D23): registro, login, perfil y las
  suscripciones del administrador con la pista del secreto (1.1.0).

| Operación | Cadena en el ESB |
|-----------|------------------|
| `listWebhooks`, `createWebhook`, `deleteWebhook` | Enrutador → Webhooks (dueño de las suscripciones: `partner:<clientId>`) |
| `issuePartnerToken` | Enrutador → Identity (`POST /oauth2/token`, sin token previo) |
| `listOwnWebhooks` (propia, 1.1.0) | Enrutador → Webhooks (con `secretHint`, que `listWebhooks` quita) |
| `register`, `login` | Enrutador → Identity (públicas) |
| `getMyProfile`, `saveMyProfile` | Enrutador → Customers (solo token de usuario; un partner recibe `403`) |
{COMMON_SECURITY_TEXT}"""),
) + "security:\n  - PartnerOAuth2: []\n  - BearerAuth: []\ntags:\n  - name: Propias (web)\n    description: Operaciones de EcoAirlines fuera del contrato del grupo (solo vía GraphQL)\npaths:\n"
    + contract_paths("MS.Clientes") + "\n  # ----------------------------------------------------- token de partner y propias\n" + clientes_own
    + components(extra_responses="""    Problem429Identity:
      $ref: './ms-g-identity.openapi.yaml#/components/responses/TooManyAttempts'
"""))

# ============================================================================================================ MS.Admin
A = "ecoairlines:admin"
admin_params = f"""    Sub:
      $ref: './ms-g-identity.openapi.yaml#/components/parameters/Sub'
    ClientId:
      $ref: './ms-g-identity.openapi.yaml#/components/parameters/ClientId'
    RouteId:
      $ref: './ms-g-schedule.openapi.yaml#/components/parameters/RouteId'
    Registration:
      $ref: './ms-g-schedule.openapi.yaml#/components/parameters/Registration'
    FlightNumber:
      $ref: '{C}#/components/parameters/FlightNumber'
    BookingId:
      $ref: '{C}#/components/parameters/BookingId'
    Date:
      name: date
      in: query
      required: true
      schema:
        type: string
        format: date
    From:
      name: from
      in: query
      schema:
        type: string
        format: date-time
    To:
      name: to
      in: query
      schema:
        type: string
        format: date-time
    DateFrom:
      name: from
      in: query
      description: Desde (fecha local, inclusive)
      schema:
        type: string
        format: date
    DateTo:
      name: to
      in: query
      description: Hasta (fecha local, inclusive)
      schema:
        type: string
        format: date
    UserSearch:
      name: q
      in: query
      description: Busca en el correo y el nombre (sin distinguir mayúsculas)
      schema:
        type: string
        maxLength: 80
    RoleFilter:
      name: role
      in: query
      schema:
        $ref: './ms-g-identity.openapi.yaml#/components/schemas/RoleName'
    StatusFilter:
      name: status
      in: query
      schema:
        $ref: './ms-g-identity.openapi.yaml#/components/schemas/AccountStatus'
    Limit:
      $ref: './ms-g-identity.openapi.yaml#/components/parameters/Limit'
    Cursor:
      $ref: './ms-g-identity.openapi.yaml#/components/parameters/Cursor'
    EventType:
      name: type
      in: query
      description: Tipo corto del evento (público o interno), p. ej. `booking.confirmed`
      schema:
        type: string
        maxLength: 60
    CorrelationIdFilter:
      name: correlationId
      in: query
      description: Solo los eventos de ese proceso (X-Correlation-Id)
      schema:
        type: string
        maxLength: 100
    CorrelationIdQuery:
      name: correlationId
      in: path
      required: true
      description: X-Correlation-Id del proceso a rastrear
      schema:
        type: string
        maxLength: 100
"""
admin_schemas = f"""    SavePricesRequest:
      type: object
      additionalProperties: false
      description: Un solo «Guardar» de la pantalla «Precios por clase» (D18, D35) → saga "Guardar precios y descuento máximo".
      properties:
        prices:
          $ref: '{SC}/SaveFarePricesRequest'
        promotion:
          type: object
          additionalProperties: false
          required: [partnerId, agreement]
          properties:
            partnerId:
              type: string
              example: BOOKING_PROTOTIPO
            agreement:
              $ref: '{C}#/components/schemas/ContratoPromocionesRequest'

    PricesView:
      type: object
      additionalProperties: false
      required: [prices, promotions]
      properties:
        prices:
          $ref: '{SC}/FarePriceTable'
        promotions:
          type: array
          items:
            $ref: '{C}#/components/schemas/ContratoPromocionesResponse'

    DashboardIndicators:
      type: object
      additionalProperties: false
      required: [generatedAt, bookings, users, flightsToday]
      description: Composición "Indicadores" (Bookings + Identity + FlightStatus).
      properties:
        generatedAt:
          type: string
          format: date-time
        bookings:
          $ref: '{BK}/BookingSummary'
        users:
          $ref: '{ID}/UserSummary'
        flightsToday:
          type: integer

    ServiceHealth:
      type: object
      additionalProperties: false
      required: [service, status, checkedAt]
      properties:
        service:
          type: string
          example: ms-g-offers
        status:
          type: string
          enum: [UP, DEGRADED, DOWN]
        latency_ms:
          type: integer
        version:
          type: string
        checkedAt:
          type: string
          format: date-time

    LatencyByService:
      type: object
      additionalProperties: false
      required: [service, p50_ms, p95_ms, p99_ms, requests, errorRate]
      properties:
        service:
          type: string
        p50_ms:
          type: number
        p95_ms:
          type: number
        p99_ms:
          type: number
        requests:
          type: integer
        errorRate:
          type: number
          description: Porcentaje de respuestas 5xx en la ventana

    TraceStep:
      type: object
      additionalProperties: false
      required: [timestamp, service, operation, status, latency_ms]
      description: Una fila de `api_request_logs` (contrato v2 §6) o un span de la traza.
      properties:
        timestamp:
          type: string
          format: date-time
        service:
          type: string
        operation:
          type: string
        status:
          type: string
        latency_ms:
          type: integer
        request_id:
          type: string
        trace_id:
          type: string
        span_id:
          type: string

    CorrelationTrace:
      type: object
      additionalProperties: false
      required: [correlationId, steps]
      description: Todo lo que generó un proceso (contrato v2 §6), en orden.
      properties:
        correlationId:
          type: string
        steps:
          type: array
          items:
            $ref: '#/components/schemas/TraceStep'
        sagas:
          type: array
          items:
            type: object
            properties:
              sagaId:
                type: string
              type:
                type: string
              status:
                type: string
        events:
          $ref: '{WH}/EventHistoryPage'

    QueueStats:
      type: object
      additionalProperties: false
      required: [queue, messages, consumers]
      properties:
        queue:
          type: string
        messages:
          type: integer
        consumers:
          type: integer
        deadLetters:
          type: integer

    Alert:
      type: object
      additionalProperties: false
      required: [id, rule, severity, startedAt]
      properties:
        id:
          type: string
        rule:
          type: string
          example: servicio-caido
        severity:
          type: string
          enum: [INFO, WARNING, CRITICAL]
        service:
          type: string
        message:
          type: string
        startedAt:
          type: string
          format: date-time

    BookingIntegrationStatus:
      type: object
      additionalProperties: false
      required: [partnerId, webhooks, stock]
      description: Estado de la integración con Booking para el panel.
      properties:
        partnerId:
          type: string
        lastTokenAt:
          type: string
          format: date-time
          nullable: true
        webhooks:
          $ref: '{WH}/DeliveryStats'
        stock:
          type: object
          properties:
            lastPushAt:
              type: string
              format: date-time
              nullable: true
            pendingPushes:
              type: integer
        lastInboundEventAt:
          type: string
          format: date-time
          nullable: true

    AssistanceReadyRequest:
      type: object
      additionalProperties: false
      required: [passengerId, segmentId, ready]
      properties:
        passengerId:
          type: string
        segmentId:
          type: string
        ready:
          type: boolean
"""


def arr(ref, description="OK"):
    return f"""        '200':
          description: {description}
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '{ref}'"""


T = "Administración"
admin_paths = "\n".join([
    path("/ecoairlines/admin/indicators", op("get", "getIndicators", "Indicadores del panel", T, A, params=["#/components/parameters/DateFrom", "#/components/parameters/DateTo"], resp=[ok("#/components/schemas/DashboardIndicators")])),
    # usuarios y roles
    path("/ecoairlines/admin/users",
         op("get", "listUsers", "Listar y buscar usuarios", T, A, params=["#/components/parameters/UserSearch", "#/components/parameters/RoleFilter", "#/components/parameters/StatusFilter", "#/components/parameters/Limit", "#/components/parameters/Cursor"], resp=[ok(f"{ID}/UserList")]),
         op("post", "createUser", "Crear un usuario con rol", T, A, req=f"{ID}/CreateUserRequest", resp=[ok(f"{ID}/User", "Usuario creado", "201")], errs=(400, 401, 403, 409))),
    path("/ecoairlines/admin/users/{sub}",
         op("get", "getUser", "Detalle de un usuario", T, A, params=["#/components/parameters/Sub"], resp=[ok(f"{ID}/User")], errs=(401, 403, 404))),
    path("/ecoairlines/admin/users/{sub}/role",
         op("put", "changeUserRole", "Cambiar el rol", T, A, params=["#/components/parameters/Sub"], req=f"{ID}/ChangeRoleRequest", resp=[ok(f"{ID}/User")], errs=(400, 401, 403, 404, 409))),
    path("/ecoairlines/admin/users/{sub}/status",
         op("put", "changeUserStatus", "Bloquear o activar", T, A, params=["#/components/parameters/Sub"], req=f"{ID}/ChangeStatusRequest", resp=[ok(f"{ID}/User")], errs=(400, 401, 403, 404, 409))),
    path("/ecoairlines/admin/roles", op("get", "listRoles", "Roles con sus permisos", T, A, resp=[arr(f"{ID}/Role")])),
    # partners
    path("/ecoairlines/admin/partners",
         op("get", "listPartners", "Listar partners", T, A, params=["#/components/parameters/StatusFilter", "#/components/parameters/Limit", "#/components/parameters/Cursor"], resp=[ok(f"{ID}/PartnerList")]),
         op("post", "createPartner", "Dar de alta un partner (el secreto se muestra una vez)", T, A, req=f"{ID}/CreatePartnerRequest", resp=[ok(f"{ID}/PartnerWithSecret", "Partner creado", "201")], errs=(400, 401, 403, 409))),
    path("/ecoairlines/admin/partners/{clientId}",
         op("get", "getPartner", "Detalle de un partner", T, A, params=["#/components/parameters/ClientId"], resp=[ok(f"{ID}/Partner")], errs=(401, 403, 404))),
    path("/ecoairlines/admin/partners/{clientId}/status",
         op("put", "changePartnerStatus", "Bloquear o activar un partner", T, A, params=["#/components/parameters/ClientId"], req=f"{ID}/ChangeStatusRequest", resp=[ok(f"{ID}/Partner")], errs=(400, 401, 403, 404))),
    path("/ecoairlines/admin/partners/{clientId}/secret",
         op("post", "rotatePartnerSecret", "Generar un secreto nuevo", T, A, params=["#/components/parameters/ClientId"], resp=[ok(f"{ID}/PartnerWithSecret")], errs=(401, 403, 404))),
    # precios y promociones
    path("/ecoairlines/admin/prices",
         op("get", "getPrices", "Precios por clase y acuerdos de promociones", T, A, resp=[ok("#/components/schemas/PricesView")]),
         op("put", "savePrices", "Guardar precios y descuento máximo (un solo «Guardar»)", T, A, desc="Saga \"Guardar precios y descuento máximo\": Schedule → Offers (`PublishFarePrices`) → `pricing.changed`. Descuento máximo 0–50 %.",
            req="#/components/schemas/SavePricesRequest", resp=[ok("#/components/schemas/PricesView", "Guardado")], errs=(400, 401, 403, 422))),
    path("/ecoairlines/admin/prices/reference",
         op("get", "getReferencePrices", "Valores de referencia para «Rellenar» (no guarda)", T, A, resp=[arr(f"{SC}/FarePriceItem")])),
    path("/ecoairlines/admin/prices/history",
         op("get", "getPriceHistory", "Historial de cambios de precios", T, A, params=["#/components/parameters/Limit", "#/components/parameters/Cursor"], resp=[ok(f"{SC}/PriceChangePage")])),
    # rutas, flota y horario
    path("/ecoairlines/admin/routes",
         op("get", "listRoutes", "Rutas programadas", T, A, resp=[arr(f"{SC}/ScheduledRoute")]),
         op("post", "createRoute", "Crear una ruta (saga \"Publicar horario\")", T, A, req=f"{SC}/ScheduledRouteRequest", resp=[ok(f"{SC}/ScheduledRoute", "Ruta creada y publicada", "201")], errs=(400, 401, 403, 409, 422))),
    path("/ecoairlines/admin/routes/{routeId}",
         op("get", "getRoute", "Detalle de una ruta", T, A, params=["#/components/parameters/RouteId"], resp=[ok(f"{SC}/ScheduledRoute")], errs=(401, 403, 404)),
         op("put", "updateRoute", "Cambiar una ruta (saga \"Publicar horario\")", T, A, params=["#/components/parameters/RouteId"], req=f"{SC}/ScheduledRouteRequest", resp=[ok(f"{SC}/ScheduledRoute")], errs=(400, 401, 403, 404, 409, 422)),
         op("delete", "deleteRoute", "Dar de baja una ruta (saga \"Publicar horario\")", T, A, params=["#/components/parameters/RouteId"], resp=["        '204':\n          description: Ruta eliminada"], errs=(401, 403, 404, 409))),
    path("/ecoairlines/admin/aircraft-types", op("get", "listAircraftTypes", "Tipos de avión", T, A, resp=[arr(f"{SC}/AircraftTypeInfo")])),
    path("/ecoairlines/admin/aircraft",
         op("get", "listAircraft", "Aviones de la flota", T, A, resp=[arr(f"{SC}/Aircraft")]),
         op("post", "createAircraft", "Agregar un avión", T, A, req=f"{SC}/AircraftRequest", resp=[ok(f"{SC}/Aircraft", "Avión agregado", "201")], errs=(400, 401, 403))),
    path("/ecoairlines/admin/aircraft/{registration}",
         op("get", "getAircraft", "Detalle de un avión", T, A, params=["#/components/parameters/Registration"], resp=[ok(f"{SC}/Aircraft")], errs=(401, 403, 404)),
         op("put", "updateAircraft", "Cambiar la base de un avión", T, A, params=["#/components/parameters/Registration"], req=f"{SC}/UpdateAircraftRequest", resp=[ok(f"{SC}/Aircraft")], errs=(400, 401, 403, 404, 409)),
         op("delete", "deleteAircraft", "Retirar un avión", T, A, params=["#/components/parameters/Registration"], resp=["        '204':\n          description: Retirado"], errs=(401, 403, 404, 409))),
    path("/ecoairlines/admin/fleet-schedule",
         op("get", "getFleetSchedule", "Rotación de la flota en una fecha", T, A, params=["#/components/parameters/Date"], resp=[ok(f"{SC}/FleetSchedule")])),
    # asistencia por vuelo
    path("/ecoairlines/admin/flights/{flightNumber}/assistance",
         op("get", "listFlightAssistance", "Pasajeros con asistencia de un vuelo", T, A, desc="Composición: Bookings + FlightStatus + CheckIn.",
            params=["#/components/parameters/FlightNumber", "#/components/parameters/Date"], resp=[arr(f"{BK}/FlightAssistanceItem")])),
    path("/ecoairlines/admin/bookings/{bookingId}/assistance-ready",
         op("put", "markAssistanceReady", "Marcar que el aeropuerto confirmó la asistencia", T, A, params=["#/components/parameters/BookingId"],
            req="#/components/schemas/AssistanceReadyRequest", resp=[ok(f"{CI}/CheckInState")], errs=(400, 401, 403, 404))),
    # eventos
    path("/ecoairlines/admin/events",
         op("get", "listEventHistory", "Historial de eventos y entregas", T, A, params=["#/components/parameters/EventType", "#/components/parameters/CorrelationIdFilter", "#/components/parameters/From", "#/components/parameters/To", "#/components/parameters/Limit", "#/components/parameters/Cursor"], resp=[ok(f"{WH}/EventHistoryPage")])),
    # telemetría
    path("/ecoairlines/admin/telemetry/services", op("get", "getServicesHealth", "Salud de cada servicio", T, A, resp=[arr("#/components/schemas/ServiceHealth")])),
    path("/ecoairlines/admin/telemetry/latency", op("get", "getLatency", "Latencia y errores por servicio", T, A, desc="Datos de la plataforma de observabilidad (V2.16, D50: Prometheus, Loki, RabbitMQ y Alertmanager, por la composición del ESB). Si una pieza no responde: `503 PROVIDER_UNAVAILABLE`.", params=["#/components/parameters/From", "#/components/parameters/To"], resp=[arr("#/components/schemas/LatencyByService")], errs=(401, 403, 503))),
    path("/ecoairlines/admin/telemetry/traces/{correlationId}", op("get", "getCorrelationTrace", "Todo lo que generó un proceso, por su correlation ID", T, A, desc="Datos de la plataforma de observabilidad (V2.16, D50: Prometheus, Loki, RabbitMQ y Alertmanager, por la composición del ESB). Si una pieza no responde: `503 PROVIDER_UNAVAILABLE`.", params=["#/components/parameters/CorrelationIdQuery"], resp=[ok("#/components/schemas/CorrelationTrace")], errs=(401, 403, 404, 503))),
    path("/ecoairlines/admin/telemetry/queues", op("get", "getQueues", "Colas de RabbitMQ", T, A, desc="Datos de la plataforma de observabilidad (V2.16, D50: Prometheus, Loki, RabbitMQ y Alertmanager, por la composición del ESB). Si una pieza no responde: `503 PROVIDER_UNAVAILABLE`.", resp=[arr("#/components/schemas/QueueStats")], errs=(401, 403, 503))),
    path("/ecoairlines/admin/telemetry/alerts", op("get", "getAlerts", "Alertas activas", T, A, desc="Datos de la plataforma de observabilidad (V2.16, D50: Prometheus, Loki, RabbitMQ y Alertmanager, por la composición del ESB). Si una pieza no responde: `503 PROVIDER_UNAVAILABLE`.", resp=[arr("#/components/schemas/Alert")], errs=(401, 403, 503))),
    path("/ecoairlines/admin/telemetry/booking-integration", op("get", "getBookingIntegration", "Estado de la integración con Booking", T, A, resp=[ok("#/components/schemas/BookingIntegrationStatus")])),
])
write("ms-admin.openapi.yaml", HEADER.format(
    title="MS.Admin — panel de administración de EcoAirlines (respuesta)",
    host="ms-admin", port=5005, version="1.2.0",
    description=indent(f"""
Microservicio de respuesta **MS.Admin** de EcoAirlines (Reto 2, D14). **No implementa operaciones del contrato del grupo**:
todas sus operaciones son propias, bajo `/ecoairlines/admin/...`, y solo las usa la web (vía GraphQL, D23) con el scope
`ecoairlines:admin` (rol ADMIN). Para el **estado de vuelo**, el **panel de operaciones** y el **acuerdo de promociones** del
contrato, el panel usa las operaciones de **MS.Vuelos** (D32).

Los schemas se **referencian** desde los contratos internos de los MS.G (`ms-g-*.openapi.yaml`) y del grupo
(`vuelos-openapi-v2.yaml`), salvo los de telemetría, que son de este servicio.

| Grupo | Cadena en el ESB |
|-------|------------------|
| Usuarios, roles y partners | Enrutador → Identity (`X-Actor-Id` = `sub` del administrador) |
| Precios y promociones | Enrutador (lectura) y saga "Guardar precios y descuento máximo" |
| Rutas | Saga "Publicar horario" · flota y horario: enrutador → Schedule |
| Asistencia por vuelo · indicadores | Composición |
| Eventos | Enrutador → Webhooks (`GET /history`) |
| Telemetría | Composición → plataforma de observabilidad (OpenTelemetry) e integración con Booking |

### Seguridad
Solo **token de usuario** con el scope `ecoairlines:admin`. Un token de partner o de servicio responde `401`/`403`. Cada
cambio lleva al ESB `X-Actor-Id` = `sub` del administrador (auditoría). Mismo procesamiento que los demás MS de respuesta
(DTO, límite de peticiones, `X-Correlation-Id`, `ProblemDetails` v2).
"""),
) + "security:\n  - UserJwt: [ecoairlines:admin]\ntags:\n  - name: Administración\n    description: Panel de administración (solo vía GraphQL)\npaths:\n" + admin_paths
    + components(extra_schemas=admin_schemas, extra_params=admin_params))
