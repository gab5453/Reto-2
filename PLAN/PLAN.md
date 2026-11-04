# PLAN — Reto 2: transición de EcoAirlines a microservicios (v4: integración con Booking, contrato de Vuelos v2)

> **Estado:** decisiones D1–D25 cerradas el **20/10/2026**. El **25/10/2026** el grupo de Booking entregó el **contrato de Vuelos
> v2** (`contract/vuelos-openapi-v2.yaml` + `contract/README-vuelos-v2.md`); el plan se revisó contra él (sección 3.5) y el
> responsable cerró las decisiones **D26–D40** el mismo día, con los matices recomendados (sección 7). Las preguntas para Booking están en `HALLAZGOS.md`
> (serie **BKG**). No se ha modificado código.
> Flujo del proyecto (`CAMBIOS.md`): **propuesta → aprobación → implementación por fases → verificación → auditoría**.
> El plan se ejecuta **una fase a la vez**, con la aprobación del responsable al final de cada una. **Prioridad: todo lo que se
> vincula con Booking** (sección 6). Estado (03/11): **V2.2–V2.21 hechas**, pendientes de la auditoría de Gemini. V2.20 cerrada con **GitHub Actions diferido** (en pausa por decisión del responsable) y la PWA por probar en un teléfono real. **Hospedaje decidido: Azure.** El monolito y `dev-auth` se retiraron en V2.21. Pendiente de Booking: sus webhooks y eventos (BKG-01, BKG-15) y la entrega de credenciales (V2.14).

| Archivo de esta carpeta | Contenido |
|-------------------------|-----------|
| `PLAN.md` | Este documento: plan integrado y registro de decisiones |
| `arquitectura-microservicios-v4.png` | **Arquitectura vigente.** En rojo, lo nuevo o corregido por el contrato v2 |
| `modelo-conceptual-v4.png` | **Modelo de datos vigente.** En rojo, lo nuevo del contrato v2; en naranja, el correlation ID (corregido) |
| `scripts/arquitectura_v4.py` · `scripts/modelo_conceptual_v4.py` | Scripts (matplotlib) que generan las imágenes v4 |
| `*-v3.png` · `modelo-conceptual-v3.1-correlation-id.png` | Historial: v3 (usuarios, precios, asistencia, tarjeta, telemetría) y v3.1 (correlation ID, **corregido en v4**) |
| `*-v2.png` | Historial: primera revisión de las imágenes originales |

---

## 0. Resumen

Se parte del monolito modular actual (4 capas, 9 dominios aislados, un esquema de PostgreSQL por dominio) y se extrae, por fases y
sin romper lo que funciona, a esta arquitectura:

- **9 microservicios de gestión (MS.G)**, dueños de sus datos: Identity, Webhooks, Schedule, Offers, FlightStatus, Customers,
  Bookings, PostSale y CheckIn.
- Un **ESB** (NestJS) con *enrutador*, *orquestador de sagas*, *composición* (solo lectura) y, **nuevo en v4**, la **entrada de
  eventos de Booking** (sin duplicados).
- **5 microservicios de respuesta**: Vuelos, Clientes, Reservas, Postventa y Admin. Los 4 primeros implementan **las 30
  operaciones del contrato v2**, cada una en el microservicio que indica su `x-microservice`.
- Un **gateway**: fachada REST **`/api/v2/vuelos/*`** (la única puerta de Booking) y GraphQL en `/api/graphql` (la única puerta de
  nuestra web).
- Un **bus de eventos RabbitMQ** interno, con los eventos en formato **CloudEvents 1.0**, y una **plataforma de observabilidad**
  (OpenTelemetry).
- **MS.G.Offers** (gRPC) es servidor gRPC hacia adentro y **cliente gRPC de Booking**: le envía el stock en cada cambio.
- Una **Payment API simulada** con tarjeta, **solo para nuestra web** (canal directo). En las ventas de Booking **cobra Booking**.
- La **web** consume **solo GraphQL** y es una **aplicación progresiva (PWA)**. El sistema **funciona solo, sin Booking**.
- **Todo se despliega en la nube** (Azure u otra plataforma si hace falta).

**Requisitos del ingeniero:** al menos un servicio en **gRPC** (MS.G.Offers) y al menos uno en **SOA** (MS.G.PostSale, SOAP/WSDL);
el resto en REST. Todo el código en **TypeScript**.

**Lo que exige el contrato v2 (integración con Booking):**
1. Rutas `https://<aerolínea>/api/v2/vuelos/...`, una sola URL base; 30 operaciones (9 de ellas nuevas o nuevas en el contrato).
2. **Booking cobra**: la aerolínea recibe `paymentReference` y solo la valida; en cancelaciones **calcula** el reembolso y Booking
   lo ejecuta.
3. Seguridad en dos capas: **token de servicio OAuth2 `client_credentials`** emitido por nuestra Identity, más `X-User-Id`.
4. **`X-Correlation-Id`** que nunca cambia, propagado por HTTP, gRPC, SOAP y RabbitMQ, y devuelto en respuestas, errores y eventos.
5. Eventos **CloudEvents** firmados (HMAC-SHA256) por webhook, más un **feed de respaldo** `GET /vuelos/eventos`.
6. **Stock por gRPC hacia Booking** (`inventory.InventoryStockService`, puerto 50051) en cada cambio de asientos libres.
7. Consumir eventos de Booking: `payment.confirmed`, `payment.failed` y `package.cancelled`.
8. Nuevos: emisión de boletos aparte, cambio de varios asientos, cambio de estado de vuelo, panel de operaciones, health,
   acuerdo de promociones; máquina de estados por **asiento**; `ProblemDetails` ampliado.

**Mejoras funcionales propias (v3, se mantienen):** usuarios con un rol creados por el admin · precios por clase con «Rellenar»
(**ahora con descuento máximo para promociones, hasta 50 %**) · asistencia médica · telemetría en el panel · pago con tarjeta
(canal web) · PWA.

---

## 1. ¿Es necesaria la transición a microservicios?

**Técnicamente, no.** Lo digo con franqueza para la defensa:
- La carga es mínima (un proyecto académico), hay un solo equipo y un solo despliegue.
- El monolito ya está **preparado para separarse**: dominios aislados (lo verifica `architecture.spec.ts`), un esquema por dominio,
  fachadas (`BookingsFacade`, `HoldGatewayPort`) pensadas para volverse clientes remotos, y eventos con la forma del contrato.
- Los microservicios **agregan costos reales**: latencia de red, consistencia distribuida (sagas y compensaciones), más
  despliegues, más configuración, más puntos de falla y más dinero en la nube.

**Académicamente, sí está justificada** (decisión del responsable, D38): el objetivo del Reto 2 es **integrar tecnologías
distintas**, y eso solo tiene sentido entre procesos separados. El contrato v2 lo confirma: deja libre la arquitectura interna,
pero espera MS de respuesta, ESB, sagas, SOAP y gRPC. Por eso **todo lo que se vincula con Booking pasa a microservicios** y no se
publica el contrato v2 sobre el monolito.

| Tecnología / patrón | Dónde se demuestra |
|---------------------|--------------------|
| gRPC + Protocol Buffers | MS.G.Offers: **servidor** interno (ESB) y **cliente** de Booking (stock, `inventory.proto` del ecosistema) |
| SOA: SOAP + WSDL + XSD | MS.G.PostSale (cotizaciones de cancelación y de cambio de fecha), con `CorrelationId` en `<soap:Header>` |
| REST + OpenAPI | Contrato v2 (fachada B2B), los MS.G internos, los MS de respuesta y la Payment API |
| GraphQL | Gateway para la web (única forma de acceso de la web) |
| Mensajería asíncrona (RabbitMQ, AMQP) + AsyncAPI + **CloudEvents** | Bus interno; webhooks a Booking; eventos entrantes de Booking |
| ESB: enrutamiento, orquestación (Saga), composición y entrada de eventos | Capa 3 del diagrama |
| Saga distribuida entre organizaciones | Booking orquesta combos (LIFO) y nosotros somos un paso con compensación (`cancel`, `DELETE hold`) |
| Idempotencia y control de concurrencia | `Idempotency-Key`, `inbound_events`, asiento con cambio de estado atómico, referencia de pago única |
| Base de datos por servicio | Una base y un usuario de PostgreSQL por MS.G |
| Autenticación con roles, JWKS (RS256) y **OAuth2 client_credentials** | MS.G.Identity |
| Tokenización de tarjetas | Payment API simulada (canal web) |
| Observabilidad: OpenTelemetry, métricas, trazas, logs, alertas, **correlation ID** | Todos los servicios y el panel de administración |
| PWA: manifest + service worker | Web instalable y con modo sin conexión |
| Contenedores y nube | Docker Compose en local; despliegue completo en la nube |

**Recomendación (aceptada):** hacerla, pero **contenida**: código compartido en librerías, una plantilla de servicio, todo
levantable con un solo `docker compose up`, y migración incremental (*strangler fig*): el monolito sigue como referencia hasta que
los microservicios pasen **la suite de conformidad del contrato v2**.

---

## 2. Lo que se reutiliza del proyecto actual

La arquitectura objetivo encaja casi uno a uno con las 4 capas actuales, así que **la mayor parte del código se mueve, no se
reescribe**. El contrato v2 conserva los nombres de campos, los schemas de búsqueda, reserva, boletos y check-in y los enums de v1,
así que **la mayoría del código de dominio sirve**.

| Hoy (monolito) | Mañana (microservicios) |
|----------------|-------------------------|
| `EcoAirlines.API` (controllers, JWT/scopes, ProblemDetails, rate limit, Swagger) | **Microservicios de respuesta** y gateway (rutas `/api/v2/vuelos`) |
| `EcoAirlines.Business` — servicios que llaman a **varios** dominios (`BookingsService.create`, `CancellationService`, `CheckInService`, `DateChangeService`, `BaggageService`, `SeatChangeService`, `AdminService`) | **ESB → Orquestador** (cada método se vuelve una saga) y **Composición** (lecturas de `AdminService`) |
| `EcoAirlines.Business` — reglas de **un** dominio (`passenger-rules`, `post-sale-rules`, `HoldService`…) | Dentro de su **MS.G** |
| `EcoAirlines.DataManagement` + `DataAccess` de cada dominio | Dentro de su **MS.G**, con su propia base |
| `MockGdsService` (horario a la venta, cupos, asientos, precios) | **MS.G.Offers**; el `holder` de cada asiento pasa a **estado** (`AVAILABLE…BOARDED`) |
| `FARE_BRANDS` (`seed/network.ts`) | Valores **de referencia** de `fare_class_prices` en **MS.G.Schedule** |
| `MockPaymentApiService` (acepta cualquier `pay_…`) | Canal web: **Payment API simulada** con tarjeta. Canal Booking: **validador de referencias** en el ESB |
| `PaymentReferenceField` (campo de texto `pay_…`) | **Formulario de tarjeta** con botón «Usar tarjeta de prueba» |
| `DomainEventBus` (in-process, forma `WebhookPayload` de v1) | **RabbitMQ** con la misma interfaz `publish`/`subscribe`, en formato **CloudEvents** |
| `HttpWebhookDispatcher` (firma propia) | Entrega **CloudEvents** con `X-Webhook-Signature: sha256=…` y reintentos 1 min → 6 h |
| `IdempotencyInterceptor` + esquema `idempotency` | **ESB** (con `Idempotent-Replayed` e `IDEMPOTENCY_KEY_REUSED`) |
| `dev-auth` (rol como texto, HS256) | **MS.G.Identity**: roles en tabla, RS256 + JWKS **y clientes partner (`client_credentials`)** |
| Ventana de check-in `CHECK_IN_WINDOW_HOURS` = 48 h | Se mantiene: el contrato v2 también pide **48 h** |
| `PUT /admin/flights/{n}/status` · `PUT /bookings/{id}/seat` · emisión dentro de `POST /bookings` | `PATCH /vuelos/flights/{n}/status` · `PUT /vuelos/bookings/{id}/seats` · **`POST /vuelos/bookings/{id}/tickets`** |
| `GET /admin/flights` (ocupación) · `/admin/events` | `GET /vuelos/operaciones/vuelos` · `GET /vuelos/eventos` (contrato v2) |
| `http-metrics.store` + `/admin/observability` | **OpenTelemetry** en todos los servicios + plataforma de observabilidad |
| `contract/vuelos-graphql.yaml` | Base del **esquema del gateway GraphQL** |
| Pruebas e2e de conformidad con el contrato v1 | **Se reescriben contra el contrato v2** (fase V2.1) y se corren contra `/api/v2/vuelos` |

Cada microservicio conserva **capas internas** (entrada → reglas → repositorios → datos), como hoy, pero en pequeño.

---

## 3. Revisión de las imágenes

### 3.1 Lo que está correcto (se mantiene)

- La **división en dominios** coincide con los contextos de datos actuales y con los esquemas de PostgreSQL ya desplegados.
- Las relaciones **entre servicios solo por id** (líneas punteadas) son la regla que ya aplica el proyecto.
- **Offers en gRPC** y **dueño del inventario**: el contrato v2 lo nombra explícitamente («el dueño del inventario de asientos de la
  aerolínea, ej. MS.G.Offers») como quien dispara el stock hacia Booking.
- **PostSale en SOA**: el contrato v2 usa justamente MS.G.PostSale como ejemplo de propagación por `<soap:Header>`.
- Separar **enrutador** (un solo MS.G) de **orquestador** (varios MS.G con compensación).
- Los **4 MS de respuesta del contrato** (Vuelos, Reservas, Postventa, Clientes) coinciden con los nuestros; el quinto (Admin) es
  propio y no choca: el contrato deja libre la arquitectura interna.

### 3.2 Modelo conceptual — huecos corregidos (v2)

| # | Hallazgo | Corrección |
|---|----------|------------|
| MC-01 | No aparece el **inventario** (cupos y asientos) | **Offers es su dueño**: `flights_for_sale`, `inventory`, `seats` |
| MC-02 | `owner_id` parece venir de `customers.profiles`, pero es el `sub` del JWT | Sale de **Identity** (`users.sub`) — ampliado en CV-05 |
| MC-03 | `scheduled_routes` N:M `aircraft` sin tabla intermedia | `route_aircraft (route_id, registration, position)` |
| MC-04 | Falta la **tarifa comprada** | `purchased_fares` en Bookings |
| MC-05 | Faltan los **cupones** de los tickets | `ticket_coupons` en Bookings |
| MC-06 | `hold_id` y `flight_number` marcados FK, pero apuntan a otro servicio | Marcados **ref** |
| MC-07 | `check_ins` sin clave primaria | PK `(booking_id, segment_id, passenger_id)` + `checked_in_at` |
| MC-08 | Webhooks no guarda historial de eventos ni entregas | `event_log` y `deliveries` |
| MC-09 | FlightStatus necesita el horario | Proyección `scheduled_flights` (evento `schedule.published`) |
| MC-10 | Cotizaciones y ofertas incompletas | `penalty_amount`, `unflown_itineraries`, `total_to_pay` |
| MC-11 | No aparecen los datos técnicos | Base propia del **ESB**: `idempotency_claims`, `saga_log`, `outbox` |
| MC-12 | No aparece la **Payment API** | Sistema **externo** simulado |

### 3.3 Arquitectura — huecos corregidos (v2)

| # | Hallazgo | Corrección |
|---|----------|------------|
| AR-01 | "Crear reserva" empezaba en Customers sin usar el perfil | Orden real: `Offers → Bookings → pago → Offers → Bookings` (Customers se quita, D13) |
| AR-02 | Check-in asigna asiento automático en Offers | `Bookings → FlightStatus → Offers → CheckIn → Bookings` |
| AR-03 | Cambiar fecha busca alternativas en Offers | `Bookings → Offers → PostSale → pago → Offers → Bookings` |
| AR-04 | Cancelar y maletas no terminaban en Bookings | Paso final `→ Bookings` |
| AR-05 | El CRUD de rutas toca Schedule y Offers | Saga "Publicar horario" |
| AR-06 | Las consultas de administración que cruzan servicios no tenían lugar | Bloque **Composición** |
| AR-07 | No aparecía quién emite el JWT | **MS.G.Identity** |
| AR-08 | No aparecía la Payment API | Conectada al ESB |
| AR-09 | La administración quedaba dentro de MS.Vuelos | **MS.Admin** (ver CV-12: las operaciones **del contrato** vuelven a MS.Vuelos) |
| AR-10 | El bus solo mostraba al ESB y a Webhooks | Offers publica `hold.*`; FlightStatus consume `schedule.published`; *outbox* |
| AR-11 | No se veía cómo entran los sistemas B2B | **Fachada REST** en el gateway — ahora `/api/v2/vuelos` |
| AR-12 | No se veía la correlación entre servicios | Correlation ID — **corregido en CV-04** |

### 3.4 Revisión de la v3

| # | Observación | Resultado |
|---|-------------|-----------|
| RV-01 | Líneas del mismo grupo con colores distintos | Corregido: cada línea conserva el color de su grupo |
| RV-02 | Los precios por clase estaban en Offers | Corregido: Schedule es el dueño; Offers guarda una copia de lectura |
| RV-03 | Las tablas de precios no estaban conectadas | Corregido: `fare_class_prices → price_changes`, `→ fare_prices` (copia), `fare_prices → fare_selections` |
| RV-04 | La flecha morada de Offers parecía invertida | No lo estaba (Offers **publica**); se aclaró con la leyenda |
| RV-05 | Un usuario tiene un solo rol (D17) | `user_roles` se reemplaza por `users.role_id` |
| RV-06 | Pago con tarjeta (D7) | Payment API simulada con tarjeta, como servicio externo aparte — en v4, **solo canal web** (CV-01) |

### 3.5 Revisión contra el contrato de Vuelos v2 (v4, 25/10/2026)

Lo que la v3 **contradecía o no cubría** del contrato v2, y cómo queda. **Obl.** = lo impone el contrato; **Resp.** = lo decidió el
responsable entre varias opciones (sección 7).

| # | Tema | Qué decía la v3 | Qué exige el contrato v2 | Cómo queda en v4 | Tipo |
|---|------|-----------------|--------------------------|------------------|------|
| CV-01 | **Pagos** | El ESB verifica toda referencia contra nuestra Payment API; las sagas tienen paso "cobro" | **Booking cobra**; la aerolínea **no vuelve a cobrar**, solo valida la referencia (`PAYMENT_REFERENCE_INVALID`, `AMOUNT_MISMATCH`). `provider`: `BOOKING_PROTOTIPO` o `AIRLINE_DIRECT` | Dos canales: Booking → **validador de referencias** (no reutilizada, monto = precio congelado); web → Payment API. El paso "cobro" pasa a "**pago\***" = validar | Obl. (D28) |
| CV-02 | **Reembolso** | Saga Cancelar con paso "reembolso" | La aerolínea **calcula** (`refund.status = CALCULATED`); **Booking ejecuta** | Canal Booking: se calcula y se registra en `refunds`; canal web: se ejecuta en la Payment API (`SETTLED`) | Obl. (D28) |
| CV-03 | **Seguridad B2B** | JWT de usuario (RS256) para todos | **Token de servicio OAuth2 `client_credentials`** de nuestro `dev-auth` + `X-User-Id`, en el que se confía solo con token de partner | Identity emite tokens de partner (`partner_clients`); el gateway acepta los dos tipos de token | Obl. (D29) |
| CV-04 | **Correlation ID** | v3.1: `correlation_id` = `X-Request-Id` = `trace_id`, nace en nuestro gateway | `X-Correlation-Id` (todo el proceso, lo crea **Booking**, nunca cambia) es **distinto** de `X-Request-Id` (un salto) | Se separan los tres; viaja por HTTP, gRPC, SOAP y AMQP; se devuelve en respuestas, `ProblemDetails` y CloudEvents | Obl. (D31) |
| CV-05 | **Dueño de la reserva** | `owner_id` = `sub` del JWT | «El dueño se toma de `X-User-Id` (reenviado por Booking) o del `sub` del token» | `owner_id` = `sub` (web) o `partner:<client_id>:<X-User-Id>` (Booking) | Obl. (D29) |
| CV-06 | **Rutas** | `/api/...` con las rutas de v1 | `/api/v2/vuelos/...` | **Solo `/api/v2/vuelos/*`**; el v1 queda reemplazado y no se implementa | Obl. + Resp. (D26, D27) |
| CV-07 | **Emisión de boletos** | La reserva emite los boletos dentro de la misma saga | `POST /bookings/{id}/tickets` aparte e idempotente; la reserva responde **201** `CONFIRMED` o **202** `TICKET_ISSUING`; también se emite al consumir `payment.confirmed` | Nueva saga **Emitir boletos**; asientos `BOOKED → TICKETED` | Obl. (D36) |
| CV-08 | **Estado por asiento** | Offers guarda solo el `holder` de cada asiento y un conteo `reserved` | `SeatStatus`: `AVAILABLE → HELD → BOOKED → TICKETED → CHECKED_IN → BOARDED`; seatmap con `status`; conteos por estado | `seats.status` (cambio **atómico**) + conteos en `inventory` | Obl. |
| CV-09 | **Stock a Booking** | No existía | gRPC `inventory.InventoryStockService` (Booking, puerto 50051) en cada hold, liberación, venta, cancelación o cambio | **MS.G.Offers** lo envía directamente (cliente gRPC), después de guardar cada cambio | Obl. + Resp. (D33) |
| CV-10 | **Eventos** | Forma `WebhookPayload` de v1 | **CloudEvents 1.0** (`type = ec.edu.epn.booking.vuelos.<evento>`, `correlationid`); firma `X-Webhook-Signature`; reintentos 1 min → 6 h; nuevos `hold.created`, `booking.seat_changed`, `flight.status_changed` | Bus interno y webhooks en CloudEvents; `event_log` con cursor para el feed | Obl. |
| CV-11 | **Eventos entrantes** | No existían | Consumir `payment.confirmed`, `payment.failed` y `package.cancelled` | **Entrada en el ESB** con idempotencia (`inbound_events`) + sagas idempotentes | Obl. + Resp. (D34) |
| CV-12 | **Dónde viven las operaciones** | Cambio de estado de vuelo y ocupación en MS.Admin | `x-microservice`: `operaciones/*`, `PATCH status`, `health`, `eventos`, `promociones` en **MS.Vuelos** | Se respeta `x-microservice`; MS.Admin queda para lo propio | Resp. (D32) |
| CV-13 | **Cambiar estado de vuelo** | Enrutador → FlightStatus (+ evento) | Valida transiciones (`INVALID_STATUS_TRANSITION`); devuelve `affectedBookings`; si es `CANCELLED`, las reservas pasan a reembolso | **Saga**. `CANCELLED` → se cierra la venta del vuelo y cada reserva se cancela con reembolso y liberación de asientos | Obl. + Resp. (D37) |
| CV-14 | **Acuerdo de promociones** | No existía | `GET/PUT /vuelos/promociones/contrato`; `discountPercentage` ≤ máximo (`PROMOTION_DISCOUNT_OUT_OF_RANGE`) | Lo define el **admin en «Precios por clase»**, máximo **50 %**; vive en Schedule; Offers recibe una copia | Obl. + Resp. (D35) |
| CV-15 | **Health del nodo** | `/health` por servicio | `GET /vuelos/health` público, **< 1 s**, 200/503, con `dependencias` | Consulta **compuesta** servida desde caché | Obl. |
| CV-16 | **Panel de operaciones** | Ocupación solo en el panel admin | `GET /vuelos/operaciones/vuelos` (scope `flights:ops`) | Consulta **compuesta**: Offers + FlightStatus + Schedule | Obl. |
| CV-17 | **Cambio de asiento** | Un asiento por llamada | `PUT /bookings/{id}/seats`, varios pasajeros, **atómico** | La saga reserva todos o ninguno | Obl. |
| CV-18 | **Cancelar** | Siempre con `quoteId` | `reasonCode` (`CUSTOMER_REQUEST`, `SAGA_COMPENSATION`, `FLIGHT_CANCELLED`, `OTHER`); `quoteId` opcional en los dos del medio; respuesta con `refund`, `ticketsVoided`, `inventoryRestoration` | PostSale admite cancelación sin cotización y penalidad exonerada (`penalty_waived`) | Obl. |
| CV-19 | **`ProblemDetails`** | Campos de v1 | + `instance`, `correlation_id`, `timestamp` y 16 códigos nuevos; `HOLD_EXPIRED` → **410** | Nueva versión en `packages/shared`; los errores gRPC/SOAP conservan el `code` | Obl. |
| CV-20 | **Idempotencia** | `Idempotency-Key` en el ESB | Reintento → **misma respuesta** con `Idempotent-Replayed: true` (un hold o reserva repetida responde **200**); body distinto → `409 IDEMPOTENCY_KEY_REUSED`; 24 h | `request_hash` y respuesta en `idempotency_claims` | Obl. |
| CV-21 | **Nube** | «Planes con escala a cero» | Booking usa **timeout de 5 s**; un arranque en frío marca el nodo `DOWN` | **Mínimo 1 réplica** en la ruta de Booking | Resp. (D39) |
| CV-22 | **Customers en la cadena de Reservas** | D13: Crear reserva no usa Customers | El contrato la muestra como cadena **sugerida** | **No es un choque**: es una sugerencia; se mantiene D13 | — |
| CV-23 | **Webhooks a Booking** | Todos los `booking.*` al dueño | El contrato define qué eventos existen; el suscriptor elige cuáles quiere | Booking recibe los eventos **de sus propias reservas** y los de vuelos; de las reservas de nuestra web solo se entera por el **stock** | Resp. (D40) |

### 3.6 Preguntas abiertas para el grupo de Booking

Registradas en **`HALLAZGOS.md`, sección 8 (serie BKG)**, con la solución que se aplica mientras el grupo responde. **El contrato
no se modifica** sin su respuesta.

| # | Pregunta | Mientras tanto |
|---|----------|----------------|
| BKG-01 | ¿Por qué canal llegan `payment.*` y `package.cancelled` (webhook hacia nosotros, RabbitMQ `booking.events` o Kafka)? | Entrada con dos vías: webhook firmado y consumidor AMQP |
| BKG-02 | ¿Cómo se valida un `paymentReference` (formato, `amount` obligatorio)? | Formato, uso único y monto cuando llega |
| BKG-03 | ¿`tokenUrl` relativa = `/api/v2/oauth2/token`? ¿Cómo se entregan las credenciales? | Ambas rutas; credenciales por canal privado |
| BKG-04 | ¿Quién llama a `PUT /promociones/contrato`? | **Resuelta internamente:** lo define nuestro admin (D35); Booking solo consulta |
| BKG-05 | Ningún endpoint lleva un asiento a `BOARDED` | Al pasar el vuelo a `DEPARTED`, `CHECKED_IN → BOARDED` |
| BKG-06 | ¿`PushStockUpdate` (absoluto) o `StreamInventoryChanges` (delta)? ¿Hora local? ¿TLS? | `PushStockUpdate`, hora local del aeropuerto de salida |
| BKG-07 | ¿Qué eventos recibe cada suscriptor? | **Resuelta internamente:** D40 |
| BKG-08 | ¿Sobre qué precio se aplica `discountPercentage`? | Monto esperado = `lockedPrice × (1 − descuento)` |
| BKG-09 | La firma del webhook no lleva marca de tiempo | Informativo; deduplicar por `id` del CloudEvent |
| BKG-10 | Inconsistencias menores (`snake_case`/`camelCase`, `additionalProperties`) | Se implementa tal cual el contrato |
| BKG-11 | `vuelos_programados_hoy`: ¿qué zona horaria? | `America/Guayaquil` |
| BKG-12 | Nuestro descuento máximo es 50 %, más estricto que el rango 0–100 del contrato | Informativo: `GET` nunca mostrará más de 50; un `PUT` con más de 50 responde `422 PROMOTION_DISCOUNT_OUT_OF_RANGE` |

---

## 4. Arquitectura objetivo (v4)

### 4.1 Microservicios de gestión (MS.G) — dueños de sus datos

| Servicio | Protocolo | Base | Responsabilidad | Código de origen |
|----------|-----------|------|-----------------|------------------|
| **MS.G.Identity** | REST | `identity` | Registro, login, JWT (RS256), JWKS, usuarios y su rol, permisos por rol, bloqueo de cuentas, **clientes partner y token `client_credentials`** | `dev-auth/server.mjs` |
| **MS.G.Offers** | **gRPC** | `offers` | Búsqueda, mapa de asientos **con estado**, holds (**TTL 5–30 min**), inventario y **estado de cada asiento (cambio atómico)**, horario a la venta, alternativas, precios y **descuento máximo** con la copia `fare_prices`, barrido de holds vencidos; **publica `hold.created` y `hold.expired`**; **envía el stock a Booking por gRPC** | `CatalogService`, `HoldService`, `MockGdsService`, `timetable.ts`, `fleet-planner` |
| **MS.G.PostSale** | **SOAP (SOA)** | `post_sale` | Cotización de cancelación (con **penalidad exonerada** según `reasonCode`), ofertas de cambio de fecha, límite de maletas | Reglas de `CancellationService`, `DateChangeService`, `BaggageService` |
| **MS.G.Bookings** | REST | `bookings` | Reservas (8 estados), pasajeros, **emisión** de tickets y cupones (incluye `VOIDED`), historial, PNR, asistencia médica, **canal de venta**, **referencias de pago recibidas (únicas)**, **reembolsos** | `BookingsFacade`, `booking-records`, `passenger-rules`, `passenger-identity-rules` |
| **MS.G.Schedule** | REST | `schedule` | Rutas, flota, tipos de avión, horario, precios por clase e historial, **descuento máximo de promociones (≤ 50 %) y acuerdo B2B** | `AdminRoutesService`, `AdminFleetService`, `FARE_BRANDS` |
| **MS.G.FlightStatus** | REST | `flight_status` | Estado operativo, **transiciones válidas**, **puerta, hora estimada, demora y motivo**, **historial de cambios** | `FlightStatusService` |
| **MS.G.CheckIn** | REST | `check_in` | Check-in (**exige boletos emitidos**), pases (**PDF417/QR, grupo, puerta**), aviso de asistencia lista | Reglas de `CheckInService` |
| **MS.G.Customers** | REST | `customers` | Perfil del cliente (web), asistencia predeterminada | `CustomerProfileService` |
| **MS.G.Webhooks** | REST | `webhooks` | Suscripciones, consumo de eventos, entrega **CloudEvents** firmada (`X-Webhook-Signature`) con reintentos 1 min → 6 h, historial y **feed con cursor** (`GET /vuelos/eventos`) | `WebhooksService`, `WebhookDeliveryService`, `HttpWebhookDispatcher` |

**Reglas:**
- Un MS.G **nunca llama a otro MS.G**. Solo el ESB los coordina. Lo verifica una prueba de arquitectura.
- **Hacia Booking solo hablan tres piezas**: **Offers** (stock por gRPC, D33), **Webhooks** (entrega de eventos) y el **ESB**
  (entrada de eventos). Ninguna operación de un cliente espera a Booking: si Booking no responde, se reintenta después.

#### Contratos internos de los MS.G REST (V2.1, pasos 1 y 2)

Todos los MS.G REST tienen su contrato en `contract/` (validados con Redocly). Reglas comunes:
- Los llama **solo el ESB**, con su **token de servicio** (`token_use = service`, D41).
- **Quién actúa** viaja en cabeceras que solo pone el ESB: `X-Owner-Id` (dueño, D29) y `X-Actor-Id` (administrador). Nunca en
  el cuerpo.
- `X-Correlation-Id` y `X-Request-Id` en todas las operaciones; `ProblemDetails` v2.
- Los schemas que también existen en el contrato del grupo **se referencian** (`vuelos-openapi-v2.yaml#/components/schemas/…`)
  en lugar de copiarse: así son iguales por construcción.

| Servicio | Contrato | Operaciones principales |
|----------|----------|-------------------------|
| Identity | `ms-g-identity.openapi.yaml` (v1.2.0) | registro, login, `POST /oauth2/token` (partners y ESB), JWKS, usuarios, partners, roles |
| Customers | `ms-g-customers.openapi.yaml` | `GET/PUT /profile` (con `defaultAssistance`) |
| Webhooks | `ms-g-webhooks.openapi.yaml` | suscripciones, feed `GET /events` (contrato v2), historial `GET /history`, `GET /stats` |
| Schedule | `ms-g-schedule.openapi.yaml` | rutas, flota, `GET /timetable`, `GET /fleet-schedule`, precios (+ referencia e historial), `GET/PUT /promotion-agreements/{partnerId}` |
| FlightStatus | `ms-g-flight-status.openapi.yaml` | `GET /flights`, `GET/PATCH /flights/{n}/status` (transiciones), historial, `POST /status-changes/{id}/revert` |
| Bookings | `ms-g-bookings.openapi.yaml` | validar pasajeros, `claim`/liberar referencia de pago, crear y fallar reserva, emitir boletos, plan y aplicación de asientos, maletas, cambio de fecha, cancelación, reservas y asistencia por vuelo, asistencia, `GET /indicators` |
| CheckIn | `ms-g-check-in.openapi.yaml` | registrar y deshacer check-in, pases de abordar, asistencia lista, check-ins por vuelo |

#### Contrato gRPC de Offers (`contract/ms-g-offers.proto`, V2.1 paso 3)

Paquete `ecoairlines.offers.v1`, puerto **50061**. Compila con `buf build` y pasa `buf lint` (reglas `STANDARD`, salvo el nombre
del archivo, que sigue D24); cada RPC tiene su propio mensaje de entrada y de salida, para que evolucionen por separado.

| Servicio | RPCs | Lo usa |
|----------|------|--------|
| `CatalogService` | `Search`, `GetSeatMap` (asientos con `SeatStatus`), `FindAlternatives` | Enrutador · saga "Cambiar fecha" |
| `HoldService` | `CreateHold` (TTL 5–30), `GetHold`, `ReleaseHold`, `ValidateHold` (hold + **descuento** ≤ acuerdo, devuelve el monto esperado), `ConsumeHold` (`HELD → BOOKED` + asientos, idempotente por `booking_id`) | Enrutador · saga "Crear reserva" |
| `InventoryService` | `ReserveSeats` (todos o ninguno), `AutoAssignSeats`, `TransitionBookingSeats` (`BOOKED → TICKETED → CHECKED_IN → BOARDED` y vuelta), `ReserveInventory`, `ReleaseBookingInventory`, `CloseFlightSales` / `ReopenFlightSales`, `CountSoldSeats`, `GetOccupancy`, `GetStats` | Sagas · composición (operaciones, health) |
| `PublishingService` | `PublishTimetable`, `PublishFarePrices` (precios + reglas de promoción) | Sagas "Publicar horario" y "Guardar precios" |
| `grpc.health.v1.Health` | `Check`, `Watch` (estándar) | Health del contrato v2 |

- **Inventario:** conteos por estado por segmento y cabina (los **cupos**: `availableSeats` y stock de Booking) más el estado de
  cada **asiento asignado**. Todo cambio es una actualización condicional: dos clientes no pueden quedarse con el mismo asiento
  (`ALREADY_EXISTS` / `SEAT_TAKEN`). Las operaciones de saga llevan `saga_id` y se pueden repetir sin efecto doble.
- **Errores:** código gRPC + `ProblemDetails` completo en el trailer `x-problem-details-bin`; el ESB lo traduce sin perder el
  `code` del contrato.
- **Metadata:** `authorization` (token del ESB, D41), `x-correlation-id`, `x-request-id`, `x-owner-id`, `x-actor-id`.
- Librerías: `@grpc/grpc-js` + `@nestjs/microservices` (`@grpc/proto-loader` ya carga el archivo sin errores).

#### Stock hacia Booking: Offers como cliente gRPC (D33; copia exacta del proto en `contract/booking-inventory.proto`)

- El `inventory.proto` del ecosistema (sección 9 del contrato v2) se guarda **sin cambios**.
- Después de **guardar** cada cambio de asientos libres (hold, liberación, vencimiento, venta, cancelación, cambio de fecha o
  cierre de un vuelo), Offers llama a `PushStockUpdate` con `service_id = NODE_VUE_ECOAIRLINES`, `item_id = <vuelo>-<cabina>`,
  `date`, `time_slot` y `available_units` = asientos `AVAILABLE` de esa cabina (el mismo valor que `availableSeats`).
- El envío **no forma parte** de la operación del cliente: un componente de Offers lo hace en segundo plano. Si Booking no
  responde, se reintenta (`stock_sync` guarda el último valor enviado). Se manda el valor **absoluto**: si un envío se pierde,
  el siguiente corrige.
- Incluye las ventas de **todos los canales** (también nuestra web): así Booking conoce la disponibilidad real (D40).

#### Contrato SOA de PostSale (`contract/ms-g-post-sale.wsdl` + `ms-g-post-sale.xsd`, V2.1 paso 5)

SOAP 1.1 *document/literal*, escritos a mano (contrato primero). El WSDL importa el XSD y se publica en `?wsdl`.

| Operación SOAP | Para qué | Faults |
|----------------|----------|--------|
| `CreateCancellationQuote` | Cotizar la cancelación (reembolsable → total; no reembolsable → solo impuestos, la tarifa base es penalidad). Vence en 15 min | `BOOKING_NOT_CONFIRMED`, `ALREADY_CANCELLED` |
| `ConsumeCancellationQuote` | Saga "Cancelar" (`CUSTOMER_REQUEST`, `OTHER`); idempotente por `sagaId` | `NOT_FOUND` (409), `QUOTE_EXPIRED` (**410**, como el contrato v2) |
| `CalculateCompensationRefund` | Saga "Cancelar" **sin cotización**: `FLIGHT_CANCELLED` → 100 % sin penalidad (D37); `SAGA_COMPENSATION` (combo que falló) → también 100 % sin penalidad, siempre (D42) | `BOOKING_NOT_CONFIRMED` |
| `CreateDateChangeOffers` | Ofertas de cambio con `priceDifference` (máx. 10, vencen en 15 min) a partir de las alternativas de Offers | `FARE_NOT_CHANGEABLE`, `FLIGHT_ALREADY_DEPARTED` |
| `ConsumeDateChangeOffer` / `ReleaseDateChangeOffer` | Saga "Cambiar fecha" y su compensación | `NOT_FOUND` (409), `CHANGE_OFFER_EXPIRED` (410) |
| `GetBaggageOptions` | Opciones de maletas extra (máx. 3 por pasajero e itinerario) | — |
| `ValidateBaggagePurchase` | Saga "Agregar maletas": límite y monto a cobrar | `BAGGAGE_LIMIT_EXCEEDED` (422), `FLIGHT_ALREADY_DEPARTED` |

- **Cabeceras SOAP** en cada petición y respuesta: `CorrelationId` (sin cambios) y `RequestId`, como pide el contrato v2.
- **Errores:** `soap:Fault` con `detail/PostSaleFault` (`code`, `status`, `title`, `correlationId`, `timestamp`); el ESB lo traduce
  a `ProblemDetails` sin perder el `code`.
- **Autenticación:** `Authorization: Bearer` con el token del ESB (D41), en la cabecera HTTP.
- Librería: `soap` (npm) como servidor y cliente. Detalle de implementación ya comprobado: las cabeceras de respuesta se arman
  como XML con su espacio de nombres.

### 4.2 ESB (lógica de negocio, NestJS)

**Enrutador** — una petición, un MS.G, sin coordinación:

| Operación | MS.G |
|-----------|------|
| Registro, login; **token de partner**; admin: usuarios, rol, bloqueo (+ evento `user.*`) | Identity |
| Buscar vuelos, mapa de asientos **con estado**; crear, consultar y liberar hold | Offers (gRPC) |
| Admin: ver precios por clase, «Rellenar» e historial; **consultar el acuerdo de promociones** (`GET /vuelos/promociones/contrato`) | Schedule |
| Estado de vuelo (`GET`) | FlightStatus |
| Perfil del cliente (con asistencia predeterminada) | Customers |
| Suscripciones de webhooks · **feed `GET /vuelos/eventos`** | Webhooks |
| Consultar reservas y boletos; pedir o cambiar asistencia médica | Bookings |
| Pases de abordar; marcar asistencia lista | CheckIn |
| Admin: flota y tipos de avión | Schedule |

**Orquestador (sagas con compensación):**

`pago*` = **canal Booking**: validar la referencia (formato, que no se haya usado — `Bookings.claim` — y el monto); la aerolínea
**no cobra**. **Canal web**: **capturar** la autorización en la Payment API (monto exacto, una sola vez) y registrarla con
`Bookings.claim`; si la saga falla después, se compensa con un reembolso, y si falla antes de capturar, anulando la autorización.
`reembolso` = **canal Booking**: se **calcula** y se registra (`CALCULATED`); Booking lo ejecuta. **Canal web**: se **ejecuta** en la
Payment API (`SETTLED`).

| Saga | Pasos | Compensación si falla un paso |
|------|-------|-------------------------------|
| Crear reserva (+ asistencia opcional) | Offers (validar hold y **descuento ≤ máximo**) → Bookings (validar pasajeros) → pago\* → Offers (asientos `BOOKED`, consumir hold) → Bookings (crear) → **Emitir boletos** (en línea → `201 CONFIRMED`; si no termina a tiempo → `202 TICKET_ISSUING`) → eventos | Liberar asientos; si el hold ya se consumió, liberar cupos; `booking.failed` |
| **Emitir boletos** (`POST /tickets` o `payment.confirmed`) | Bookings (¿ya emitidos? → `issued: 0`) → Offers (`BOOKED → TICKETED`) → Bookings (tickets y cupones) → `booking.ticket_issued` | Asientos vuelven a `BOOKED`; `booking.ticket_failed` |
| **Pago fallido** (`payment.failed`) | Offers (liberar hold o asientos) → Bookings (`FAILED`) → `booking.failed` | Reintento |
| Cambiar asientos (varios, atómico) | Bookings (sin check-in; misma cabina; no infantes) → Offers (ocupar **todos** los nuevos, liberar los anteriores) → pago\* (si tiene costo) → Bookings → `booking.seat_changed` | Liberar los asientos nuevos |
| Check-in | Bookings (**boletos emitidos**) → FlightStatus (ventana de 48 h, no cancelado) → Offers (asiento automático, `TICKETED → CHECKED_IN`) → CheckIn → Bookings → `booking.checked_in` | Liberar asientos automáticos y devolver el estado |
| Cancelar (`reasonCode`) | Bookings → PostSale (consumir cotización, o `CalculateCompensationRefund` si es `SAGA_COMPENSATION` / `FLIGHT_CANCELLED`) → Offers (liberar asientos) → reembolso → Bookings (`CANCELLED`, boletos `VOIDED`) → `booking.cancelled` | Reintento (la cancelación no se deshace) |
| ↳ **Combo cancelado** (`package.cancelled`) | Igual que Cancelar, con `SAGA_COMPENSATION` | — |
| Cambiar fecha | Bookings → Offers (alternativas) → PostSale (oferta) → pago\* → Offers (cupos nuevos, liberar viejos) → Bookings → `booking.changed` | Liberar cupos y asientos nuevos |
| Agregar maletas | Bookings → PostSale (validar límite) → pago\* → Bookings → `booking.baggage_added` | — (el pago va al final) |
| **Cambiar estado de vuelo** (`PATCH`, D37) | FlightStatus (validar transición, guardar, historial) → Bookings (reservas afectadas) → `flight.status_changed`. Si es **`CANCELLED`**: Offers **cierra la venta** del vuelo (stock 0) → **Cancelar** cada reserva con `FLIGHT_CANCELLED` (reembolso completo, asientos liberados). Si es `DEPARTED`: asientos `CHECKED_IN → BOARDED` | Restaurar el estado anterior y reabrir la venta |
| Guardar precios **y descuento máximo** | Schedule (validar ≤ 50 %, guardar + historial) → Offers (`PublishFarePrices`, con el descuento) → `pricing.changed` | Revertir los valores en Schedule |
| Publicar horario (admin rutas) | Offers (cupos vendidos) → Schedule (validar y guardar) → Offers (`PublishTimetable`) → evento | Restaurar la ruta anterior en Schedule |

- El estado de cada saga se guarda en `saga_log` (permite reanudar o compensar tras un reinicio).
- Pagos pendientes del canal web (`202`) y emisiones pendientes: mensaje diferido en RabbitMQ (TTL + *dead letter*).
- **Cada operación respeta el timeout de 5 s de Booking**: si una saga no termina a tiempo, se responde `202` con el estado
  pendiente y se termina en segundo plano.

**Composición (solo lectura)** — varios MS.G en paralelo:

| Consulta | Fuentes |
|----------|---------|
| **Health del nodo** (`GET /vuelos/health`): estado de cada MS.G, PostgreSQL y RabbitMQ, holds activos, vuelos de hoy. Se calcula en segundo plano y se sirve **desde caché** (< 1 s) | Todos los `/health` · Offers · FlightStatus |
| **Operaciones** (`GET /vuelos/operaciones/vuelos`): asientos por estado, ocupación, holds activos, próximo vencimiento, check-in abierto, alertas | Offers · FlightStatus · Schedule |
| Indicadores: reservas, ingresos, ventas por ruta **y por canal**, usuarios por rol | Bookings · Schedule · Identity |
| Pasajeros con asistencia por vuelo | Bookings · FlightStatus · CheckIn |
| Telemetría por `correlation_id`: trazas, logs, métricas, colas, alertas | Plataforma de observabilidad (4.7) |
| Historial de eventos y entregas | Webhooks |

**Entrada de eventos de Booking (D34)** — un evento repetido nunca cobra dos veces ni vende un asiento dos veces:

| Capa | Qué evita |
|------|-----------|
| 1. **Idempotencia de entrada**: `inbound_events` guarda el `id` de cada CloudEvent recibido; si llega otra vez, se responde OK y **no se procesa** | El mismo evento procesado dos veces |
| 2. **Sagas idempotentes**: Emitir boletos devuelve `issued: 0` si ya se emitió; Cancelar devuelve el resultado anterior (`ALREADY_CANCELLED`); Pago fallido no hace nada si la reserva ya está `FAILED` | Un efecto repetido aunque el evento llegue con otro `id` |
| 3. **Referencia de pago única** (`payment_records`) | Usar el mismo pago para dos reservas |
| 4. **Asiento con cambio de estado atómico** en Offers | Que dos clientes distintos se queden con el mismo asiento (esto no lo resuelve la idempotencia, sino el control de concurrencia) |

Se procesa con el **mismo `correlationid`** del evento. Puente opcional: republicar nuestros CloudEvents en el exchange
`booking.events` o en Kafka `topic-ordenes-b2b`, si el grupo lo pide.

**Transversal en el ESB:** idempotencia (`Idempotency-Key`, 24 h, `request_hash`, `Idempotent-Replayed`), validador de
referencias de Booking y adaptador de la Payment API (web), traducción de errores gRPC/SOAP a `ProblemDetails` v2, propagación de
**`X-Correlation-Id`** (sin cambiarlo) y de `X-Request-Id` (uno por salto), y exportación de telemetría (OTLP).

### 4.3 Microservicios de respuesta

| Servicio | Operaciones del contrato v2 (según `x-microservice`) | Funciones propias (solo vía GraphQL) | Scopes |
|----------|------------------------------------------------------|--------------------------------------|--------|
| **MS.Vuelos** (9) | `search`, `seatmap`, `GET` y **`PATCH flights/{n}/status`**, **`operaciones/vuelos`**, **`health`**, **`eventos`**, **`GET/PUT promociones/contrato`** | — | público (`search`, `seatmap`, `GET status`, `health`) · `flights:read` · `flights:ops` · `flights:admin` |
| **MS.Reservas** (12) | `offers/hold` (POST, GET, DELETE), `bookings` (GET, POST), `bookings/{id}`, **`POST tickets`**, `GET tickets`, `GET tickets/{id}`, **`PUT seats`**, `check-in`, `boarding-passes` | Asistencia médica | `flights:hold` · `flights:book` · `flights:read` |
| **MS.Postventa** (6) | `baggage-options`, `baggage`, `date-change/search`, `date-change`, `cancellation-quote`, `cancel` | — | `flights:read` · `flights:book` · `flights:cancel` |
| **MS.Clientes** (3) | `webhooks` (GET, POST), `webhooks/{id}` (DELETE) | Registro, login, perfil | `flights:webhooks` · `ecoairlines:profile` |
| **MS.Admin** | — | Usuarios y roles, **partners**, precios por clase **con descuento máximo**, rutas, flota, asistencia por vuelo, telemetría y alertas, eventos, indicadores. Para estado de vuelo y ocupación **usa las operaciones de MS.Vuelos** | `ecoairlines:admin` |

Hacen lo que hoy hace `EcoAirlines.API`: verificar el token (JWKS de Identity), los scopes, validar DTOs **exactos al contrato v2**,
`ProblemDetails` v2, rate limit, y llamar al ESB. **El dueño sale del token**: `sub` (web) o `partner:<client_id>:<X-User-Id>`
(Booking); **nunca del cuerpo**. `X-User-Id` sin token de partner se ignora. Si el partner no manda `X-User-Id`, el respaldo
es la huella del dispositivo (`partner:<client_id>:fp:<X-Device-Fingerprint>`, "respaldo de propiedad" del contrato); sin
ninguna de las dos, `400`. Cada MS llama al ESB con **su propio** token de servicio (D44), nunca con el del cliente.

`PUT /vuelos/promociones/contrato` exige `flights:admin`, que **solo tiene nuestro ADMIN** (el partner no): ejecuta la misma saga
"Guardar precios y descuento máximo" que la pantalla de precios.

Los endpoints propios (usuarios, precios, asistencia, telemetría, perfil, registro y login) **no se publican en REST**: la web
los usa por GraphQL (D23). La única API REST pública es la del contrato v2.

**Contratos (V2.1, paso 7):** `contract/ms-{vuelos,reservas,postventa,clientes,admin}.openapi.yaml`. Las 30 operaciones del
contrato del grupo se **referencian por ruta** (`$ref: './vuelos-openapi-v2.yaml#/paths/…'`), así son idénticas por
construcción; las propias van bajo `/ecoairlines/...` (4 en Reservas, 5 en Clientes, 37 en Admin) y referencian los schemas
de los MS.G. MS.Clientes publica además `POST /oauth2/token` (el de Identity, referenciado). Se generan con
`contract/tools/generar_ms_respuesta.py` y se verifican con `contract/tools/verificar_operaciones_v2.py`.

### 4.4 Gateway: fachada REST del contrato + GraphQL

- **Fachada REST `/api/v2/vuelos/*`**: las **30 operaciones** del contrato v2, sin cambiar sus schemas. Swagger en
  **`/api/docs`** con `vuelos-openapi-v2.yaml`. Devuelve `X-Correlation-Id` en **toda** respuesta (también 4xx/5xx) y
  `Location` con la ruta `/api/v2/vuelos/...` en los `201`.
- **No hay `/api/v1`** (D27): el v2 conserva los schemas del v1 y lo reemplaza; mantener los dos sería duplicar.
- **Token de partner:** `POST /api/v2/oauth2/token` (y el alias `/oauth2/token`, ver BKG-03) se enruta a Identity.
- **GraphQL en `/api/graphql`**: la **única** forma en que la web accede al sistema. Esquema primero con el SDL de
  `contract/vuelos-graphql.yaml` + las extensiones, unidos en `contract/gateway.graphql`. `@nestjs/graphql` + Apollo Server.
- Reglas del contrato GraphQL: `@public` / `@auth(scopes)`, `idempotencyKey` en mutations, `ProblemDetails` en
  `errors[].extensions`, límite de profundidad y complejidad.
- Verifica los dos tipos de token con la **JWKS** de Identity; rate limit por `X-Device-Fingerprint` en `search`.
- Si no llega `X-Correlation-Id`, **lo crea** (el contrato lo permite: «si no llega, el primer servicio lo genera»).
- **Implementado en V2.13** (`services/gateway`): el token se verifica en el gateway y se reenvía al MS de respuesta (D46); la
  suscripción `bookingEvents` consulta el feed de MS.Vuelos (D47). En local se publica en el puerto **8088** del host (Windows
  reserva el 8080).

### 4.5 Bus de eventos (RabbitMQ)

- Exchange interno `ecoairlines.events` (tipo *topic*). Mensajes en **CloudEvents 1.0** (`specversion`, `type`, `source =
  /aerolineas/ecoairlines/vuelos`, `id`, `time`, `subject`, `correlationid`, `data`); propiedad AMQP `correlation_id`.
- `type` público: `ec.edu.epn.booking.vuelos.<evento>`; internos: `ec.ecoairlines.internal.<evento>`.
- Documentado con **AsyncAPI** (`contract/events.asyncapi.yaml`): internos, salientes a Booking y **entrantes** de Booking.
- Colas durables, cola de reintentos y *dead letter*; *outbox* en el ESB **y en Offers**.

**Qué recibe Booking (D40):** de **sus propias reservas** (canal Booking), todo el ciclo que el contrato define; de **los vuelos**,
los cambios de estado. De las reservas hechas en **nuestra web** no recibe eventos (son datos de nuestros clientes): se entera de la
disponibilidad por el **stock gRPC**, que incluye las ventas de todos los canales.

| Evento | Produce | Consume | ¿Sale a Booking? |
|--------|---------|---------|:----------------:|
| `hold.created` · `hold.expired` | Offers | Webhooks | Sí, de sus holds |
| `booking.confirmed` · `booking.failed` | ESB | Webhooks | Sí, de sus reservas |
| `booking.ticket_issued` · `booking.ticket_failed` (· `ticket_issuing`, compatibilidad) | ESB | Webhooks | Sí, de sus reservas |
| `booking.changed` · `booking.baggage_added` · `booking.seat_changed` | ESB | Webhooks | Sí, de sus reservas |
| `booking.cancelled` · `booking.checked_in` | ESB | Webhooks | Sí, de sus reservas |
| `flight.status_changed` (+ `flight.cancelled` · `flight.schedule_changed`, compatibilidad) | ESB | Webhooks | Sí, todos |
| `schedule.published` | ESB | FlightStatus | No (interno) |
| `booking.assistance_requested` | ESB | Webhooks (historial) | **No**: dato de salud |
| `pricing.changed` · `user.*` · `partner.*` | ESB | Webhooks (historial) | No (interno) |
| `payment.confirmed` · `payment.failed` · `package.cancelled` | **Booking** | ESB (entrada) | — (entrantes) |
| *Stock* (no es un evento del bus) | Offers | Booking, por **gRPC** | Sí, todos los canales |

### 4.6 Datos

- **Una base de datos por servicio** en el mismo servidor PostgreSQL, cada una con **su propio usuario**.
- Se mantiene la estrategia de documentos JSONB por agregado. El **modelo conceptual v4** es el modelo lógico.
- Sin `DATABASE_URL`, cada servicio funciona en memoria (pruebas).

| Base | Tablas nuevas o modificadas en la **v4** |
|------|------------------------------------------|
| `identity` | **`partner_clients`** (`client_id`, nombre, `secret_hash`, scopes, estado, `created_by`) |
| `schedule` | **`promotion_agreements`** (`partner_id`, permite, **% máximo 0–50**, rutas, destinos, cabinas, vigencia, condiciones, auditoría) |
| `flight_status` | `overrides` + puerta, hora estimada, demora y motivo; **`status_changes`** (anterior → nuevo, motivo, autor) |
| `offers` | `holds` + `channel`, `ttl_minutes`; `seats` + **`status`** y `hold_id`/`booking_id`; `inventory` + total y **conteo por estado**; `fare_prices` + **`max_discount_pct`** (copia); **`stock_sync`**; **`outbox`** |
| `bookings` | `bookings.status` (8 estados); `tickets` + `failure_reason`, `VOIDED`; **`sales_channels`**, **`payment_records`** (referencia única), **`refunds`** (`CALCULATED` / `SETTLED`) |
| `post_sale` | `cancellation_quotes.penalty_waived` |
| `check_in` | `check_ins` + `boarding_group`, `gate`, `barcode` (PDF417/QR) |
| `webhooks` | `subscriptions.owner_id` (= partner), `active`; `deliveries.next_retry_at`; `event_log` con **`seq`** (cursor) y `type` CloudEvents |
| `esb` | `idempotency_claims` + `request_hash` y respuesta; **`inbound_events`** |
| Observabilidad | **`api_request_logs`** (`correlation_id`, `request_id`, `service`, `operation`, `status`, `latency_ms`, `timestamp`); `spans` con `correlation_id` como atributo |

Lo de la v3 (`users.role_id`, `fare_class_prices`, `passenger_assistance`, Payment API…) **sigue igual**.

### 4.7 Observabilidad, telemetría y correlation ID

| Pieza | Qué hace |
|-------|----------|
| **OpenTelemetry SDK** en la plantilla de servicio y en la web | Trazas, métricas y logs (OTLP) |
| OpenTelemetry Collector | Recibe y reparte la telemetría |
| Métricas (Prometheus o Azure Monitor) | Peticiones, latencia p50/p95/p99, errores, mensajes en cola, sagas compensadas, **stock enviado a Booking** |
| Trazas (Tempo o Application Insights) | Una saga se ve paso a paso entre servicios |
| Logs (Loki o Log Analytics) | Estructurados, **con los campos de `api_request_logs` del contrato**; sin tokens, tarjetas ni datos de salud |
| Alertas | Servicio caído, latencia o errores altos, cola creciendo, sagas fallidas, **health `DOWN`**, **stock sin enviar**, **webhooks agotando reintentos** |
| Tableros (Grafana) | Versionados en el repositorio |

**Los tres identificadores (corrige la v3.1):**

| Identificador | Alcance | Quién lo crea | Se usa para |
|---------------|---------|---------------|-------------|
| `X-Correlation-Id` | **Todo el proceso de negocio** (una compra, un combo) | El gateway de **Booking**; si no llega, nuestro gateway | Reconstruir el proceso entre sistemas. **Nunca se cambia** |
| `X-Request-Id` | **Un salto** HTTP | **Cada servicio** | Un log o un error puntual |
| `trace_id` | Una traza de OpenTelemetry | El SDK | Ver la traza; lleva el `correlation_id` como atributo para buscarla |

Propagación: HTTP `X-Correlation-Id` · gRPC metadata `x-correlation-id` (también hacia Booking) · SOAP `<corr:CorrelationId>` en
`<soap:Header>` · RabbitMQ propiedad `correlation_id` + atributo `correlationid` del CloudEvent. Se devuelve en cada respuesta, en
`ProblemDetails.correlation_id` y en cada evento.

**Todo queda en la nube (D20):** la misma pila en local (Docker) y en la VM de la nube (**D50**: Prometheus, Alertmanager, Tempo, Loki y Grafana; reemplaza a Application Insights + Azure Monitor).

**En el panel de administración** (vía Composición): salud de cada servicio, latencia y errores, **búsqueda por correlation ID**,
colas, alertas y estado de la integración con Booking (último stock enviado, webhooks pendientes, eventos entrantes).

### 4.8 Pagos: dos canales

| Canal | Quién cobra | `provider` | Qué hace la aerolínea |
|-------|-------------|------------|-----------------------|
| **Booking** (B2B) | **Booking**, con su pasarela | `BOOKING_PROTOTIPO` | **No cobra.** Valida la referencia: formato, que no se haya usado (`payment_records`, `PAYMENT_REFERENCE_INVALID`) y, si llega `amount`, que sea igual al precio congelado con el descuento aplicado (`AMOUNT_MISMATCH`). En cancelaciones **calcula** el reembolso (`CALCULATED`) y Booking lo ejecuta |
| **Web propia** (directo) | **Payment API simulada** | `AIRLINE_DIRECT` | La tarjeta va del navegador a la Payment API (D7), que **autoriza**; el ESB **captura** el monto exacto en la saga. En cancelaciones el reembolso se **ejecuta** en la Payment API (`SETTLED`) |

La API de vuelos sigue recibiendo **solo `paymentReference`**: ningún servicio nuestro ve un número de tarjeta.

```
Canal web:     Navegador ──tarjeta──▶ Payment API (autoriza) ──paymentReference──▶ Navegador ──GraphQL──▶ Gateway ▶ … ▶ ESB ──captura──▶ Payment API
Canal Booking: Booking cobra ──paymentReference──▶ /api/v2/vuelos/bookings ▶ MS.Reservas ▶ ESB (valida, NO cobra) ▶ Bookings (registra)
```

**Payment API simulada (canal web, `contract/payment-api.openapi.yaml`):** modelo **autorizar → capturar** de las
pasarelas reales. El navegador usa la clave pública `pk_test_…`; el ESB, la secreta `sk_test_…` (es un sistema externo: el token
del ESB de D41 no aplica).

| Paso | Quién | Detalle |
|------|-------|---------|
| 1. Tokenizar | Navegador | `POST /payment-methods`: valida **Luhn**, **marca**, **vencimiento** y **CVV**; guarda solo marca, últimos 4 y vencimiento. El token sirve para un pago y vence en 15 min |
| 2. Autorizar | Navegador | `POST /payments` (`Idempotency-Key`): reserva el monto, no lo cobra → `AUTHORIZED`, `PENDING` o `DECLINED`. Vence en 30 min si no se captura |
| 3. Capturar | ESB (`pago*`) | `POST /payments/{ref}/capture`: cobra el **monto exacto** y marca la referencia como **usada** por la orden (`ALREADY_CAPTURED` si otra la usó) |
| 4. Anular | ESB (compensación) | `POST /payments/{ref}/void`: si la saga falla **antes** de capturar |
| 5. Reembolsar | ESB | `POST /refunds`: cancelación del canal web o compensación **después** de capturar (`SETTLED`) |

**Tarjetas de prueba** (botón **«Usar tarjeta de prueba»**):

| Número | Resultado |
|--------|-----------|
| `4242 4242 4242 4242` | Aprobada |
| `4000 0000 0000 0002` | Rechazada |
| `4000 0000 0000 9995` | Fondos insuficientes |
| `4000 0000 0000 3220` | Pendiente (la reserva responde `202` y se confirma después) |
| `5555 5555 5555 4444` | Aprobada (Mastercard) |

### 4.9 Web progresiva (PWA) y pantallas nuevas

**PWA** (`vite-plugin-pwa` + Workbox): manifest e iconos, service worker con **modo sin conexión** para pases de abordar y «Mis
viajes». **Sin** notificaciones push (D21). Nunca se guardan en caché tokens, datos de pago ni respuestas de administración. El
service worker guarda solo la aplicación; los pases y viajes van en una copia local mínima (D52).

| Pantalla | Usuario | Cambio |
|----------|---------|--------|
| Checkout (pasajeros) | Cliente | Opción **«Necesita asistencia médica»** por pasajero |
| Checkout y postventa (pago) | Cliente | **Formulario de tarjeta** con botón «Usar tarjeta de prueba» |
| Detalle de reserva | Cliente | Ver, agregar o quitar asistencia; **estado de los boletos**; **cambio de varios asientos** |
| Perfil | Cliente | Asistencia predeterminada |
| Usuarios y roles | Admin | Listar, crear, cambiar rol, bloquear o activar |
| **Partners** | Admin | Alta de Booking como partner (credenciales, scopes, bloqueo) |
| Precios por clase **y promociones** | Admin | Campos por cabina y familia, «Rellenar», vista previa, historial **y sección «Promociones con Booking»**: permitir promociones, **descuento máximo (0–50 %)**, cabinas y rutas habilitadas, vigencia y condiciones del combo. Un solo **Guardar** |
| **Operaciones** | Admin | Ocupación por vuelo y cabina con estados de asiento, holds y alertas; **cambiar estado de vuelo** (transiciones válidas, puerta, demora; al cancelar, aviso de cuántas reservas se reembolsarán) |
| Asistencia por vuelo | Admin | Pasajeros con asistencia de un vuelo y fecha |
| Telemetría | Admin | Salud, latencia, errores, **búsqueda por correlation ID**, colas, alertas, **estado de la integración con Booking** |

### 4.10 Seguridad y privacidad

- **Tres tipos de token**, todos RS256 firmados por Identity y verificados con la JWKS (el tercero es el **de servicio del
  ESB**, D41, que solo aceptan los MS.G):
  - **Usuario** (web): `sub`, `role` (CLIENTE o ADMIN) y scopes del rol.
  - **Partner** (Booking): `client_credentials`; `sub = <client_id>`, `token_use = partner`, scopes del partner. Solo con este
    token se lee `X-User-Id` (y `X-User-Roles`).
- **Roles: solo CLIENTE y ADMIN** (D17, D30). Los scopes nuevos del contrato, `flights:ops` y `flights:admin`, los recibe **ADMIN**;
  no hay rol OPS. Scopes del partner Booking: `flights:read flights:hold flights:book flights:cancel flights:webhooks flights:ops`
  (**sin** `flights:admin`: las promociones las define nuestro admin).
- El registro público crea CLIENTE; solo un ADMIN crea administradores y partners.
- **Auditoría:** `created_by`, `updated_by` y `changed_by` guardan el `sub` del administrador (o el `client_id` del partner).
- **Recursos ajenos:** una reserva de otro dueño responde `404`. Un partner no ve las reservas de la web ni las de otro partner.
- **Precios y promociones:** límites del multiplicador; descuento máximo 50 %; un descuento mayor al acuerdo se rechaza
  (`PROMOTION_DISCOUNT_OUT_OF_RANGE`); los holds conservan `locked_price`.
- **Asistencia médica:** dato de salud. No viaja en webhooks externos, ni en logs, ni en trazas.
- **Tarjetas:** nunca llegan a nuestros servicios.
- **Secretos:** el `client_secret` del partner y el `secret` de cada webhook se guardan derivados o cifrados y nunca se devuelven.

---

## 5. Estructura del repositorio propuesta

```
Reto 2/
├─ contract/
│  ├─ vuelos-openapi-v2.yaml             (SIN CAMBIOS — FUENTE DE VERDAD del grupo desde el 25/10)
│  ├─ README-vuelos-v2.md                (SIN CAMBIOS — guía del grupo)
│  ├─ booking-inventory.proto            (copia SIN CAMBIOS del inventory.proto de Booking; Offers es cliente)
│  ├─ vuelos-openapi.yaml                (SIN CAMBIOS — histórico v1.5, reemplazado por el v2)
│  ├─ ecoairlines-extensions.yaml        (SIN CAMBIOS — histórico)
│  ├─ vuelos-graphql.yaml                (SIN CAMBIOS — base del gateway)
│  ├─ ms-g-identity.openapi.yaml         ms-g-customers.openapi.yaml    ms-g-webhooks.openapi.yaml
│  ├─ ms-g-schedule.openapi.yaml         ms-g-flight-status.openapi.yaml
│  ├─ ms-g-bookings.openapi.yaml         ms-g-check-in.openapi.yaml
│  ├─ ms-g-offers.proto                  (gRPC interno)
│  ├─ ms-g-post-sale.wsdl + .xsd         (SOA)
│  ├─ ms-vuelos.openapi.yaml             ms-reservas.openapi.yaml       ms-postventa.openapi.yaml
│  ├─ ms-clientes.openapi.yaml           ms-admin.openapi.yaml          (internos: los llama el gateway)
│  ├─ payment-api.openapi.yaml
│  ├─ esb.openapi.yaml                  (interno: enrutador, composición y entrada de eventos de Booking, D43)
│  ├─ gateway.graphql                    (SDL completo de la web)
│  └─ events.asyncapi.yaml               (CloudEvents: internos, salientes y entrantes)
├─ packages/
│  └─ shared/                            ProblemDetails v2, dinero, conteo de pasajeros, tipos del contrato v2, verificador de
│                                        tokens (JWKS), X-Correlation-Id / X-Request-Id, CloudEvents, OpenTelemetry,
│                                        cliente RabbitMQ, datos maestros
├─ services/
│  ├─ gestion/   ms-g-identity · ms-g-offers (gRPC) · ms-g-post-sale (SOAP) · ms-g-bookings · ms-g-schedule
│  │             ms-g-flight-status · ms-g-check-in · ms-g-customers · ms-g-webhooks
│  ├─ esb/       enrutador · orquestador · composición · entrada de eventos de Booking · transversal
│  ├─ respuesta/ ms-vuelos · ms-reservas · ms-postventa · ms-clientes · ms-admin
│  ├─ gateway/   REST /api/v2/vuelos + GraphQL /api/graphql + Swagger /api/docs
│  └─ externos/  payment-api (simulada) · booking-simulado (solo pruebas: recibe webhooks y stock, emite payment.*)
├─ contract/tools/                      generar_ms_respuesta.py · generar_events_asyncapi.py · verificar_operaciones_v2.py · verificar_gateway_graphql.cjs ·
│                                        verificar_events_asyncapi.mjs (verificación de V2.1)
├─ tests/
│  └─ conformidad-v2/                    suite e2e del contrato v2 (las 30 operaciones), apunta a una URL base configurable
├─ ecoairlines-web/                      (solo GraphQL + PWA + pantallas nuevas)
├─ infra/
│  ├─ docker-compose.yml                 PostgreSQL, RabbitMQ, todos los servicios
│  ├─ observability/                     otel-collector, prometheus, tempo, loki, alertmanager, grafana
│  └─ azure/                             despliegue en la nube
└─ EcoAirlines.* · dev-auth              monolito actual: solo referencia hasta el cierre (no se le agrega el v2)
```

`booking-simulado` permite **seguir siendo independientes**: se prueba la integración completa sin depender del despliegue de
Booking (gRPC 50051, receptor de webhooks que verifica la firma y emisor de `payment.*` y `package.cancelled`).

Workspaces npm, TypeScript estricto, Node 24, oxlint, vitest: las mismas herramientas de hoy.

---

## 6. Fases de implementación (paso a paso)

Cada fase sigue el flujo de `CAMBIOS.md`: rama `feature/...` → tipos, lint, pruebas → prueba en navegador cuando aplique →
auditoría de Gemini → commit. **Al final de cada fase el sistema completo funciona**, y no se empieza la siguiente sin la
aprobación del responsable.

**Orden en v4 (D38):** todo lo que se vincula con Booking pasa a microservicios **antes** que el resto. Las piezas que solo usa
nuestra web (Payment API, pantallas nuevas, PWA) van después de la integración. La suite de conformidad v2 se escribe en V2.1,
desde el contrato, y es la meta de todas las fases hasta V2.14.

| Fase | Tema | Depende de | Estado |
|------|------|------------|--------|
| V2.0 | Decisiones y preparación | — | ✅ (20/10 y 25/10) |
| V2.1 | **Contratos por microservicio** + **suite de conformidad v2** | V2.0 | ✅ Aprobada (25/10) |
| V2.2 | Base común (monorepo, librería compartida, plantilla, Docker, `booking-simulado`) | V2.1 | ✅ Hecha (25/10) — pendiente de auditoría y aprobación |
| V2.3 | MS.G.Identity (usuarios, rol **y partners**) | V2.2 | ✅ Hecha (25/10) — pendiente de auditoría y aprobación |
| V2.4 | MS.G.Schedule (rutas, flota, precios **y descuento máximo**) | V2.2 | ✅ Aprobada (25/10) |
| V2.5 | MS.G.Offers (gRPC, **estado por asiento**, **stock a Booking**) | V2.4 | ✅ Hecha (25/10) — pendiente de auditoría y aprobación |
| V2.6 | MS.G.Bookings (**emisión, canal, pagos recibidos, reembolsos**, asistencia) y MS.G.CheckIn | V2.2 | ✅ Hecha (25/10) — pendiente de auditoría y aprobación |
| V2.7 | MS.G.PostSale (SOAP, **compensación sin cotización**) | V2.2 | ✅ Hecha (25/10) — pendiente de auditoría y aprobación |
| V2.8 | MS.G REST simples: FlightStatus (**transiciones**), Webhooks (**CloudEvents + feed**), Customers | V2.2 | ✅ Hecha (25/10) — pendiente de auditoría y aprobación |
| V2.9 | ESB: enrutador, composición (**health, operaciones**), transversal y **entrada de eventos de Booking** | V2.3–V2.8 | ✅ Hecha (25/10) — pendiente de auditoría y aprobación |
| V2.10 | ESB: orquestador (**11 sagas**) | V2.9 | ✅ Hecha (25/10) — pendiente de auditoría y aprobación |
| V2.11 | Eventos con RabbitMQ (CloudEvents) | V2.10 | ✅ Hecha (26/10) — pendiente de auditoría y aprobación |
| V2.12 | Microservicios de respuesta (5) | V2.9 | ✅ Hecha (26/10) — pendiente de auditoría y aprobación |
| V2.13 | Gateway: **`/api/v2/vuelos`** + GraphQL | V2.12 | ✅ Hecha (26/10) — pendiente de auditoría y aprobación |
| **V2.14** | **Nube para la ruta de Booking + integración real con Booking** ★ | V2.13 | 🟡 Nube lista (26/10, D48); integración real pendiente de Booking |
| V2.15 | Payment API simulada con tarjeta (canal web) | V2.2 | ✅ Hecha (26/10, D49) — pendiente de auditoría y aprobación |
| V2.16 | Plataforma de observabilidad | V2.2 (se completa sobre todo lo anterior) | ✅ Hecha (02/11, D50): traza única, métricas, logs, alertas y Grafana, en local y en la nube — pendiente de auditoría y aprobación |
| V2.17 | Web: migración completa a GraphQL y pago con tarjeta | V2.13, V2.15 | ✅ Hecha (26/10, D51) — pendiente de auditoría y aprobación |
| V2.18 | Web: pantallas nuevas (usuarios, partners, precios y promociones, operaciones, asistencia, telemetría) | V2.17 | ✅ Hecha (02/11) — pendiente de auditoría y aprobación |
| V2.19 | Web progresiva (PWA) | V2.17 | ✅ Hecha (02/11, D52) — pendiente de auditoría y aprobación |
| V2.20 | Nube: todo lo demás desplegado | V2.19 | ✅ Hecha (03/11, D53) — **GitHub Actions diferido** (en pausa); falta la PWA en un teléfono real |
| V2.21 | Documentación, defensa y retiro del monolito | V2.20 | ✅ Hecha (03/11) — pendiente de la auditoría final de Gemini |

### V2.0 — Decisiones y preparación ✅
1. ✅ Decisiones D1 a D25 cerradas (20/10) y D26 a D40 (25/10), registradas en la sección 7.
2. ✅ `CLAUDE.md` actualizado para el Reto 2 (20/10) y para el contrato v2 (25/10).
3. ✅ Versión 2 registrada en `CAMBIOS.md`.
4. ✅ Rama `feature/v2-microservicios` creada (20/10).
5. ✅ Preguntas para Booking registradas en `HALLAZGOS.md` (serie BKG, 25/10).

### V2.1 — Contratos por microservicio (API-first) + suite de conformidad v2
Los contratos se escriben **antes** que el código. **No se borra ni modifica** ningún contrato existente ni el del grupo.

| Paso | Contrato | Estado |
|------|----------|--------|
| 0 | Analizar `vuelos-openapi-v2.yaml`: revisión CV-01…CV-23, preguntas BKG, v4 de los diagramas, decisiones D26–D40 | ✅ 25/10 |
| 1 | `ms-g-identity.openapi.yaml` **v1.1.0**: `POST /oauth2/token` (`client_credentials`), partners (alta, bloqueo, rotación del secreto), scopes `flights:ops` y `flights:admin` para ADMIN, `token_use`, `X-Correlation-Id`, `ProblemDetails` v2 | ✅ 25/10 — Redocly: válido — pendiente de revisión |
| 2 | MS.G REST: `ms-g-customers`, `ms-g-webhooks`, `ms-g-schedule`, `ms-g-flight-status`, `ms-g-bookings`, `ms-g-check-in` (`.openapi.yaml`). Identity pasa a **v1.2.0** (token de servicio del ESB, D41) | ✅ 25/10 — Redocly: los 7 válidos — pendiente de revisión |
| 3 | `ms-g-offers.proto`: 4 servicios, 20 RPCs (estado por asiento, `TransitionBookingSeats`, `ValidateHold` con descuento, `CloseFlightSales`) | ✅ 25/10 — `buf build` y `buf lint` (STANDARD) sin errores; carga con `@grpc/proto-loader` — pendiente de revisión |
| 4 | `booking-inventory.proto` (copia exacta del de Booking) | ✅ 25/10 — idéntico línea por línea al §9 del contrato v2; compila |
| 5 | `ms-g-post-sale.wsdl` + `.xsd`: 8 operaciones, cabeceras `CorrelationId`/`RequestId`, `PostSaleFault` | ✅ 25/10 — XSD válido (lxml) y 6 mensajes de ejemplo; servidor y cliente `soap` generados del WSDL funcionan de punta a punta — pendiente de revisión |
| 6 | `payment-api.openapi.yaml`: tokenizar, autorizar, **capturar**, anular, reembolsar, tarjetas de prueba; clave pública y secreta | ✅ 25/10 — Redocly: válido; las 5 tarjetas de prueba cumplen Luhn y su marca — pendiente de revisión |
| 7 | `ms-vuelos`, `ms-reservas`, `ms-postventa`, `ms-clientes`, `ms-admin` (`.openapi.yaml`): las 30 operaciones **referenciadas** desde el contrato del grupo + operaciones propias bajo `/ecoairlines/...` | ✅ 25/10 — Redocly: los 5 válidos; `tools/verificar_operaciones_v2.py`: **30/30** una vez, en su `x-microservice` e idénticas — pendiente de revisión |
| 8 | `gateway.graphql`: SDL de la base del Reto 1 extendido con el contrato v2 y las funciones propias (30 queries, 31 mutations, 1 subscription); cada campo indica la operación del MS de respuesta que lo resuelve | ✅ 25/10 — `graphql-js`: válido; **0 cambios incompatibles** con la base (31 aditivos); 71/71 referencias a operaciones existen — pendiente de revisión |
| 9 | `events.asyncapi.yaml` (AsyncAPI 3.0): 15 eventos públicos (schemas **referenciados** del contrato), 9 internos, 3 entrantes de Booking y los reintentos diferidos; bus interno, webhooks, puente opcional y entrada de Booking por AMQP o webhook | ✅ 25/10 — `@asyncapi/parser`: 0 errores, 0 avisos; 15/15 = `VuelosEventName`; 3/3 entrantes — pendiente de revisión |
| 10 | **Suite de conformidad v2** (`tests/conformidad-v2`, `npm run test:conformidad-v2`): 54 pruebas de caja negra por HTTP contra `CONFORMANCE_BASE_URL`; cada llamada se valida contra el contrato (status, schema, `X-Correlation-Id`, `ProblemDetails`, `Location`) y se mide la cobertura de las 30 operaciones | ✅ 25/10 — autoverificación 6/6 sin servidor (incluye que las 30 operaciones tienen prueba); tipos y lint sin errores en la suite — pendiente de revisión |

- **Verificación:** cada contrato es válido con su herramienta; **las 30 operaciones del contrato v2 aparecen exactamente una vez
  entre los MS de respuesta, en el MS que indica `x-microservice`, con los mismos schemas**; la suite compila y valida sus
  propios ejemplos contra `vuelos-openapi-v2.yaml`.

### V2.2 — Base común
1. Workspaces `packages/shared`, `services/*` y `tests/*`.
2. Mover a `shared`: `ProblemDetails` v2, dinero, conteo de pasajeros, tipos del contrato v2, CloudEvents, correlation ID,
   datos maestros.
3. Plantilla de servicio NestJS: `/health`, `X-Correlation-Id` + `X-Request-Id`, logs estructurados (campos de
   `api_request_logs`), SDK de OpenTelemetry, manejo de errores.
4. `infra/docker-compose.yml` con PostgreSQL (una base y un usuario por servicio), RabbitMQ, el Collector y **`booking-simulado`**.
5. Prueba de arquitectura: ningún servicio importa código interno de otro; hacia Booking solo hablan Offers, Webhooks y el ESB.
- **Verificación:** `docker compose up` levanta todo; un servicio de ejemplo responde `/health` y su traza llega al collector
  con el `correlation_id`.

### V2.3 — MS.G.Identity (usuarios, rol y partners) — ✅ Hecha (25/10)
1. Migrar `dev-auth`: registro, login, `scrypt` y usuarios de prueba.
2. `users` (`role_id`, `status`, `created_by`), `roles`, `role_scopes`; semilla CLIENTE y ADMIN (ADMIN con `flights:ops` y
   `flights:admin`).
3. **`partner_clients`** y `POST /oauth2/token` (`client_credentials`); semilla del partner Booking.
4. Firma RS256 y `GET /.well-known/jwks.json`.
5. Reglas de 4.10.
- **Verificación:** pruebas de cada regla; un token de partner trae los scopes del partner y nunca `flights:admin`.

### V2.4 — MS.G.Schedule (rutas, flota, precios y descuento máximo) — ✅ Hecha (25/10)
1. Rutas, `route_aircraft`, flota y tipos de avión; construcción y validación del horario.
2. `fare_class_prices` y `price_changes`.
3. **`promotion_agreements`**: guardar desde la pantalla de precios (0–50 %, rutas `AAA-BBB`, cabinas, vigencia) y devolverlo
   con la forma `ContratoPromocionesResponse`.
- **Verificación:** pruebas del horario, de precios y de un descuento de 51 % → `PROMOTION_DISCOUNT_OUT_OF_RANGE`.

### V2.5 — MS.G.Offers (gRPC + stock a Booking) — ✅ Hecha (25/10)
1. Servidor gRPC según `ms-g-offers.proto`, con `x-correlation-id`.
2. Búsqueda, mapa de asientos **con estado**, holds con TTL 5–30, inventario con **conteo por estado**, alternativas.
3. **Cambio de estado de asiento atómico** (actualización condicional).
4. `PublishTimetable` y `PublishFarePrices` (con el descuento máximo); `ValidateHold`; `CloseFlightSales`.
5. Barrido de holds vencidos; `outbox` con `hold.*`.
6. **Cliente gRPC de Booking**: envío del stock en segundo plano después de cada cambio, con reintentos y `stock_sync`.
- **Verificación:** pruebas con cliente gRPC; dos holds simultáneos por el último asiento → uno gana y el otro recibe
  `SEAT_TAKEN`; `availableSeats` = asientos `AVAILABLE`; tras un hold, `booking-simulado` recibe el stock nuevo; con
  `booking-simulado` apagado, el hold igual se crea y el stock se envía cuando vuelve.

### V2.6 — MS.G.Bookings y MS.G.CheckIn — ✅ Hecha (25/10)
1. Bookings: endpoints internos (reemplazan a `BookingsFacade`), **emisión** separada (idempotente: `issued: 0`), 8 estados,
   `sales_channels`, `payment_records` (referencia única), `refunds`, reservas por vuelo.
2. `passenger_assistance`.
3. CheckIn: exige boletos emitidos; pases con grupo, puerta y código de barras; `assistance_ready`.
- **Verificación:** pruebas de cada servicio; una referencia repetida se rechaza; la asistencia no aparece en logs.

### V2.7 — MS.G.PostSale (SOAP) — ✅ Hecha (25/10)
1. Servidor SOAP con las 8 operaciones, cabeceras `CorrelationId` y `RequestId` y `SOAP Fault`.
- **Verificación:** pruebas con cliente SOAP; el WSDL se publica en `?wsdl`; `SAGA_COMPENSATION` y `FLIGHT_CANCELLED` sin
  cotización exoneran la penalidad.

### V2.8 — MS.G REST simples: FlightStatus, Webhooks, Customers — ✅ Hecha (25/10)
1. FlightStatus: `overrides` (puerta, estimada, demora, motivo), **transiciones válidas**, `status_changes`, proyección
   `scheduled_flights`.
2. Webhooks: suscripciones del partner, entrega **CloudEvents** firmada, reintentos 1 min → 6 h, `event_log` con cursor, feed,
   filtro de destinatarios (D40).
3. Customers: perfil + `default_assistance`.
- **Verificación:** una transición inválida da `INVALID_STATUS_TRANSITION`; `booking-simulado` verifica la firma de cada webhook;
  un evento de una reserva de la web no se entrega a Booking.

### V2.9 — ESB: enrutador, composición, transversal y entrada de eventos — ✅ Hecha (25/10)
1. Clientes REST, gRPC y SOAP hacia los 9 MS.G y la Payment API, con traducción de errores a `ProblemDetails` v2.
2. Enrutador (4.2) y composición: **health con caché (< 1 s)**, **operaciones**, indicadores, asistencia, historial.
3. Transversal: idempotencia v2, validador de referencias de Booking, correlation ID.
4. **Entrada de eventos de Booking** con `inbound_events` (canal según BKG-01).
- **Verificación:** pruebas de cada ruta y consulta; un mismo `payment.confirmed` enviado tres veces emite los boletos **una**
  sola vez.

### V2.10 — ESB: orquestador (11 sagas) — ✅ Hecha (25/10)
1. `saga_log` y motor de pasos con compensación.
2. Las 11 sagas de 4.2 (Crear reserva, Emitir boletos, Pago fallido, Cambiar asientos, Check-in, Cancelar, Cambiar fecha,
   Agregar maletas, Cambiar estado de vuelo, Guardar precios y descuento, Publicar horario).
- **Verificación:** cada saga en su camino feliz **y con un fallo simulado en cada paso**; la saga de combos de Booking (hold →
  reserva → `cancel` con `SAGA_COMPENSATION`) deja el inventario como estaba; cancelar un vuelo con 3 reservas deja 3 reembolsos
  calculados, los asientos liberados y el stock del vuelo en 0.

### V2.11 — Eventos con RabbitMQ — ✅ Hecha (26/10)
1. Exchange, colas durables, reintentos y *dead letter*; *outbox* en el ESB y en Offers; mensajes CloudEvents.
2. Consumidores: Webhooks y FlightStatus.
3. Eventos nuevos del contrato v2 y los propios.
- **Verificación:** los eventos internos y de salud **no** salen a Booking; cada CloudEvent lleva el `correlationid` del proceso.

### V2.12 — Microservicios de respuesta (5) — ✅ Hecha (26/10)
1. MS.Vuelos, MS.Reservas, MS.Postventa, MS.Clientes y MS.Admin, según sus contratos.
2. Tokens de usuario y de partner (JWKS), scopes, DTOs exactos al contrato v2, `ProblemDetails` v2, rate limit.
- **Verificación:** pruebas de `auth` y `security` adaptadas; sin token de partner, `X-User-Id` se ignora; el partner recibe `403`
  en `PUT /promociones/contrato`.

### V2.13 — Gateway: `/api/v2/vuelos` + GraphQL — ✅ Hecha (26/10)
1. Fachada REST `/api/v2/vuelos/*`, token de partner y Swagger en `/api/docs`.
2. GraphQL en `/api/graphql` según `gateway.graphql`.
- **Verificación:** **la suite de conformidad v2 pasa completa** contra el gateway en local + pruebas GraphQL.

### V2.14 — Nube para la ruta de Booking + integración real ★ — 🟡 Nube lista (26/10)
1. Imágenes Docker y despliegue de todo lo que usa Booking (gateway, MS de respuesta, ESB, MS.G, RabbitMQ, PostgreSQL), con
   **mínimo 1 réplica** (D39) y URL pública HTTPS.
2. Salida gRPC de Offers hacia `booking.epn.edu.ec:50051` y entrega de webhooks hacia Booking.
3. Entregar a Booking la URL base y las credenciales del partner.
- **Verificación:** la suite de conformidad v2 pasa contra la URL pública; Booking ve el nodo en verde (`/vuelos/health`) y
  completa una compra, un combo cancelado y una cancelación con el mismo `X-Correlation-Id` de punta a punta.

### V2.15 — Payment API simulada con tarjeta (canal web) — ✅ Hecha (26/10)
1. `services/externos/payment-api` según `payment-api.openapi.yaml`: tokenizar, autorizar, capturar, anular, reembolsar; tarjetas de prueba. Hasta esta fase el
   canal web no funciona: el ESB no tiene Payment API y responde `503 PROVIDER_UNAVAILABLE` (no había simulador).
2. En la misma VM de la nube, publicada por Caddy en `/payment-api/` (D49).
- **Verificación:** cada tarjeta de prueba, tarjetas inválidas y referencias reutilizadas o con otro monto.

### V2.16 — Plataforma de observabilidad — ✅ Hecha (02/11), en local y en la nube
1. `infra/observability`: métricas, trazas, logs, alertas y tableros.
2. Alertas: servicio caído, latencia, errores, cola creciendo, sagas fallidas, health `DOWN`, stock sin enviar, webhooks agotados.
3. Telemetría en el panel vía Composición, con **búsqueda por correlation ID**.
- **Verificación:** una compra que viene de Booking se encuentra por su `X-Correlation-Id` y se ve como una sola traza.

### V2.17 — Web: migración completa a GraphQL y pago con tarjeta — ✅ Hecha (26/10)
1. Cliente GraphQL en lugar de `api/endpoints.ts` y `api/extensions.ts`.
2. Login contra Identity; menú según el rol.
3. Formulario de tarjeta con «Usar tarjeta de prueba» en reserva, maletas, asientos y cambio de fecha.
- **Verificación:** recorrido completo en el navegador; en la pestaña Red, la web solo llama a `/api/graphql` y a la Payment API.

### V2.18 — Web: pantallas nuevas — ✅ Hecha (02/11)
1. Cliente: asistencia, estado de boletos y cambio de varios asientos.
2. Admin: Usuarios, **Partners**, **Precios y promociones**, **Operaciones** (con cambio de estado de vuelo), Asistencia y
   Telemetría.
- **Verificación:** cada pantalla probada con un CLIENTE y un ADMIN.

### V2.19 — Web progresiva (PWA) — ✅ Hecha (02/11)
1. `vite-plugin-pwa`: manifest, iconos y service worker.
2. Caché sin conexión de pases y «Mis viajes»; nada sensible en caché.
- **Verificación:** auditoría PWA de Lighthouse (11.7.1: la categoría PWA se retiró en la 12); con el modo avión, el pase ya visto se abre.

### V2.20 — Nube: todo lo demás — ✅ Hecha (03/11); GitHub Actions diferido
1. Web, Payment API y observabilidad (Application Insights / Azure Monitor). Escala a cero solo en lo que Booking no usa.
2. GitHub Actions por servicio.
- **Verificación:** recorrido completo en las URLs públicas, con trazas y alertas visibles en la nube.

### V2.21 — Documentación, defensa y cierre — ✅ Hecha (03/11); falta la auditoría de Gemini
1. `ARQUITECTURA.md` v2, `EVENTOS.md` (CloudEvents), diagramas, `CRITERIOS.md` y guía de defensa.
2. Retirar el monolito y `dev-auth`.
- **Verificación:** auditoría final de Gemini.

---

## 7. Registro de decisiones

D1–D25: tomadas por el responsable el **20/10/2026**. D26–D40: tomadas por el responsable el **25/10/2026**, a partir del contrato
de Vuelos v2. D41: aprobada el 25/10. Cambiar una decisión requiere registrarlo aquí con fecha y motivo.

| # | Tema | Decisión | Fundamento |
|---|------|----------|------------|
| D1 | Dueño del inventario | **MS.G.Offers** | Presenta los asientos al cliente; menos saltos; gRPC en las llamadas más frecuentes. **El contrato v2 lo confirma** |
| D2 | Dónde vive la búsqueda | **MS.G.Offers** | La oferta y el hold nacen de la búsqueda |
| D3 | CRUD de rutas | **Orquestador** (saga "Publicar horario") | Toca Schedule y Offers |
| D4 | Cómo conoce FlightStatus el horario | **Proyección por evento** (`schedule.published`) | Evita llamadas en cada consulta |
| D5 | Consultas que cruzan servicios | **Composición** en el ESB | No son sagas ni enrutamiento simple |
| D6 | Idempotencia | **En el ESB** | Todas las operaciones idempotentes pasan por él |
| D7 | Payment API | **Adaptador en el ESB** + **Payment API simulada con tarjeta**. **Desde D28: solo para el canal web** | La tarjeta va directo a la Payment API; la API de vuelos recibe solo `paymentReference` |
| D8 | Nube | **RabbitMQ sí.** Azure Container Apps recomendada (**desde D48: una VM con Docker Compose**, por el crédito) | Ver D39, D48 y fases V2.14 y V2.20 |
| D9 | Contrato REST para B2B | Fachada REST + **contratos por microservicio** en `contract/`, sin borrar ni modificar los existentes | **Desde D26 la fachada es la del contrato v2** |
| D10 | Base de datos | **Un servidor, una base y un usuario por servicio** | Aislamiento real con un solo costo de servidor |
| D11 | Tecnología del ESB | **NestJS** | Mismo lenguaje y herramientas |
| D12 | Lenguaje | **TypeScript** en todos los servicios | Un solo stack |
| D13 | Customers en "Crear reserva" | **Se quita** | La reserva no usa el perfil. El contrato v2 solo lo **sugiere** (CV-22) |
| D14 | MS.Admin de respuesta | **Se crea** | Volumen de funciones y scope propio (ver D32) |
| D15 | Prefijo de rutas | **`/api`** (`/api/graphql`, `/api/docs`) y **`/api/v2/vuelos`** para el contrato (D26) | Cierra el hallazgo PLT-01 |
| D16 | Identity | **MS.G.Identity** | Los roles son datos que el administrador gestiona |
| D17 | Roles por usuario | **Uno solo** (`users.role_id`): CLIENTE o ADMIN | Simplicidad y separación de funciones |
| D18 | Edición de precios | Por clase, con **«Rellenar»** y **Guardar** (desde D35, con el descuento máximo) | Agiliza sin quitar control |
| D19 | Alcance del precio | **Global por cabina y familia** | Suficiente para la entrega |
| D20 | Observabilidad | **Todo en la nube** (desde D50: pila propia en la VM) | Pedido del ingeniero |
| D21 | Notificaciones push | **No en esta entrega**; sí el modo sin conexión | Requiere un servicio adicional |
| D22 | Firma de los tokens | **RS256 + JWKS** (usuarios y partners) | Ningún servicio necesita el secreto de Identity |
| D23 | Acceso de la web | **Solo GraphQL** | Pedido del responsable |
| D24 | Nombres de los contratos | `contract/<servicio>.<formato>` | Un contrato por microservicio |
| D25 | `CLAUDE.md` | **Actualizado para el Reto 2** (20/10) y **para el contrato v2** (25/10) | Autorizado por el responsable |
| D26 | **Fuente de verdad REST** | **`contract/vuelos-openapi-v2.yaml`** (sin modificarlo). El v1 queda como histórico | Contrato oficial del grupo (25/10) |
| D27 | **`/api/v1`** | **No se implementa.** Solo existe `/api/v2/vuelos` | El v2 conserva los schemas del v1 y lo reemplaza; mantener los dos sería duplicar |
| D28 | **Pagos por canal** | Booking (`BOOKING_PROTOTIPO`): **no se cobra**, se valida la referencia y se **calcula** el reembolso. Web (`AIRLINE_DIRECT`): Payment API, reembolso ejecutado | Sección 4 del contrato; la validación exacta depende de BKG-02 |
| D29 | **Seguridad B2B y dueño** | Token de partner `client_credentials` emitido por Identity; `X-User-Id` solo con ese token; dueño = `partner:<client_id>:<X-User-Id>` | Seguridad en dos capas del contrato; el prefijo evita que choquen usuarios de dos sistemas |
| D30 | **Roles y scopes nuevos** | **Solo CLIENTE y ADMIN.** ADMIN recibe `flights:ops` y `flights:admin`; no hay rol OPS | Un rol OPS serviría para que el personal no tenga acceso total; en un proyecto académico no hace falta |
| D31 | **Correlation ID** | `X-Correlation-Id` distinto de `X-Request-Id` y de `trace_id`; se propaga sin cambios por HTTP, gRPC, SOAP y AMQP | Lo exige el contrato; corrige la v3.1, que los igualaba |
| D32 | **Dónde viven las operaciones del contrato** | Según `x-microservice`: operaciones, estado de vuelo, health, eventos y promociones en **MS.Vuelos**; MS.Admin solo lo propio | Aceptado. La verificación de V2.1 es directa |
| D33 | **Stock hacia Booking** | **MS.G.Offers** lo envía directamente como cliente gRPC, en segundo plano después de cada cambio, con reintentos (`stock_sync`) | Decisión del responsable: Offers es el servicio gRPC y el dueño del stock, así se envía en cuanto cambia. **Condición aceptada:** el envío nunca bloquea la operación del cliente |
| D34 | **Eventos de Booking sin duplicados** | Entrada en el ESB con **idempotencia** (`inbound_events`) **y** sagas idempotentes; además, referencia de pago única y asiento atómico | Decisión del responsable: no puede haber cobros dobles ni asientos duplicados. **Aceptado:** se necesitan las dos cosas, más el control de concurrencia del asiento (4.2) |
| D35 | **Promociones** | Las define el **admin en la pantalla de precios por clase**: permitir promociones, **descuento máximo 0–50 %**, cabinas, rutas y vigencia. Vive en Schedule y viaja a Offers con los precios. El partner solo consulta | Decisión del responsable. **Aceptado:** un solo % (no uno por clase) porque el contrato tiene un solo `porcentaje_descuento_maximo`; las cabinas se eligen en `cabinas_habilitadas` |
| D36 | **Emisión de boletos** | Saga aparte e idempotente; Crear reserva la ejecuta en línea (`201`) y deja `202 TICKET_ISSUING` si no termina a tiempo | Endpoint y estados del contrato |
| D37 | **Vuelo cancelado** | Saga: FlightStatus → Offers (**cierra la venta**, stock 0) → **Cancelar** cada reserva con `FLIGHT_CANCELLED`: reembolso completo (calculado o ejecutado según el canal) y asientos liberados. `DEPARTED` → `BOARDED` | Decisión del responsable (reembolso y liberación). **Aceptado:** es una saga **hacia adelante**, no una compensación; el vuelo no se vuelve a vender; en el canal Booking el reembolso se calcula y lo ejecuta Booking |
| D38 | **Orden de las fases** | **No** se publica el contrato v2 sobre el monolito. Todo lo vinculado con Booking pasa primero a microservicios (V2.2–V2.14); lo que solo usa la web va después | Decisión del responsable: objetivo académico y sistema independiente |
| D39 | **Nube y tiempo de respuesta** | **Mínimo 1 réplica** en la ruta de Booking; escala a cero solo fuera de ella | Aceptado: timeout de 5 s y health `DOWN` en arranque en frío |
| D40 | **Qué se notifica a Booking** | Webhooks: el ciclo de **sus** reservas y holds, y los cambios de vuelo. Las reservas de nuestra web **no** se notifican: Booking conoce la disponibilidad por el **stock gRPC** (todos los canales) | Decisión del responsable: Booking debe saber la disponibilidad, no todo el proceso. **Aceptado:** el stock es el canal correcto para eso y no expone datos de nuestros clientes |
| D41 | **Autenticación entre el ESB y los MS.G** | **Aprobada (25/10).** El ESB llama a los MS.G con su **token de servicio** (`client_credentials`, cliente de semilla `ECOAIRLINES_ESB`, `token_use = service`, scope `ecoairlines:internal`); el dueño y el administrador viajan en `X-Owner-Id` y `X-Actor-Id`, que solo pone el ESB. Los MS de respuesta y el gateway rechazan ese token | Hay sagas **sin usuario** (las disparan `payment.confirmed`, `package.cancelled` o un barrido): reenviar el token del usuario no alcanza. Un solo mecanismo para todo lo interno |
| D42 | **Combo cancelado** (`SAGA_COMPENSATION`) | Reembolso del **100 % sin penalidad**, siempre, sin mirar el acuerdo de promociones | Decisión del responsable (25/10, V2.7): la cancelación no la pidió el cliente sino que falló el combo de Booking. El contrato v2 lo permite ("si así lo permite el acuerdo B2B") |
| D43 | **Interfaz del ESB** (`contract/esb.openapi.yaml`) | **Aprobada (26/10).** Enrutador `/router/<servicio><ruta del MS.G>` con una **tabla cerrada** de rutas idénticas a los contratos de los MS.G (las respuestas y errores del MS.G se devuelven tal cual); Offers como `POST /router/offers/<Rpc>` con el **mapeo JSON de proto3**; `/composition/...` devuelve las formas del contrato v2 y de MS.Admin; entrada de eventos de Booking en `/integraciones/booking/eventos` (webhook firmado) y en `booking.events` (AMQP) | El plan no definía cómo llaman los MS de respuesta al ESB. Rutas idénticas a las de los MS.G = cero traducción en el enrutador y una prueba que las compara; el mapeo JSON de proto3 es el estándar para exponer gRPC por HTTP. La traducción al contrato público queda en los MS de respuesta (V2.12), como ya decía §4.3 |
| D44 | **Token de los MS de respuesta** | **Propuesta (26/10, V2.12).** Cada MS de respuesta tiene su cliente en Identity (`ECOAIRLINES_MS_VUELOS`, `_RESERVAS`, `_POSTVENTA`, `_CLIENTES`, `_ADMIN`; solo por *seed*, secreto `MS_<NOMBRE>_CLIENT_SECRET`) y su token lleva el scope `ecoairlines:esb`: lo acepta **solo el ESB**; los MS.G siguen aceptando solo al ESB (`ecoairlines:internal`) | El plan no decía con qué credencial llaman los MS de respuesta al ESB. Un cliente por MS deja saber quién llamó y revocar uno sin tocar a los otros; un scope distinto impide que un MS de respuesta se salte el ESB |
| D45 | **`PATCH /vuelos/flights/{n}/status` con token de partner** | **Propuesta (26/10, V2.12).** `403`: solo un usuario ADMIN cambia el estado de un vuelo | El contrato da `flights:ops` también al partner, pero la saga registra al actor (UUID de un usuario ADMIN) en la auditoría; un partner no tiene actor. Booking no necesita cambiar estados de vuelo |
| D46 | **Quién verifica el token en el gateway** | **Aprobada (26/10).** El gateway verifica el token con la JWKS (REST: usuario o partner; GraphQL: solo usuario) y lo **reenvía** al MS de respuesta, que lo vuelve a verificar, valida scopes y saca el dueño de él. El gateway no tiene token de servicio propio ni decide scopes en REST | Defensa en profundidad sin duplicar reglas: el rechazo temprano (401) no llega a los MS, y los scopes, el dueño y el contrato siguen en un solo lugar (los MS de respuesta, §4.3) |
| D47 | **Suscripción `bookingEvents` de GraphQL** | **Aprobada (26/10).** graphql-ws en `/api/graphql`; el gateway consulta cada 3 s el feed `GET /vuelos/eventos` de MS.Vuelos con el token del usuario y entrega solo los eventos nuevos | El gateway solo habla con los MS de respuesta (§4.4, `gateway.graphql`: «cada campo llama a un MS de respuesta»); conectarlo al bus rompería esa regla. El feed ya filtra por dueño (desde V2.13 un CLIENTE solo ve sus reservas) |
| D48 | **Nube de la ruta de Booking** (reemplaza la recomendación de ACA de D8) | **Aprobada (26/10, V2.14).** Una VM Linux **ARM `B2pls_v2`** (2 vCPU, 4 GiB) en **North Central US** con el mismo `docker-compose` (override `infra/cloud/`), PostgreSQL y RabbitMQ en contenedores y HTTPS con **Caddy + Let's Encrypt** en `ecoairlines-reto2.northcentralus.cloudapp.azure.com`. Se apaga sola a las 23:00 (Ecuador) y se enciende para las pruebas con Booking; SSH solo desde la IP del responsable (puerto 2222). Límite: el crédito Azure for Students (**US$90**) | Azure Container Apps con 1 réplica fija por servicio (D39) costaría US$100–130/mes: excede el crédito. La VM cuesta ≈US$30,60/mes encendida (≈US$6 apagada: disco e IP). La suscripción solo permite 5 regiones y no ofrece B2s en ellas; la ARM es la más barata y todas las imágenes existen para ARM. Se bajó el plan del Reto 1 a F1 y se borró su PostgreSQL (con respaldo `pg_dump`) para no gastar crédito |
| D49 | **Payment API simulada en la nube** | **Aprobada (26/10, V2.15).** `services/externos/payment-api` corre en la **misma VM** de D48 (≈70 MB, sin recursos nuevos de Azure: **US$0**) y se publica por Caddy en `https://ecoairlines-reto2.northcentralus.cloudapp.azure.com/payment-api/`, porque el navegador la llama directo con la clave pública (D7). Claves propias `pk_test_…` (navegador) y `sk_test_…` (ESB), generadas en `infra/cloud/.env` | Aprovechar lo que ya está pagado: la compra web completa se puede probar en la nube sin gastar crédito. Es un sistema externo (como Stripe): no usa los tokens de Identity ni pasa por el gateway |
| D50 | **Observabilidad en la nube** (precisa D20) | **Aprobada (26/10, V2.16).** La misma pila en local y en la nube, dentro de la VM de D48: OpenTelemetry Collector → **Prometheus** + **Alertmanager** (métricas y alertas), **Tempo** (trazas), **Loki** (logs por OTLP) y **Grafana** (tableros versionados en `infra/observability/`). Grafana público en `/grafana/` con usuario y contraseña (sin acceso anónimo). Retención de 7 días. **US$0** (~0,7 GiB más de memoria en la VM) | Application Insights es gratis hasta 5 GB/mes, pero MS.Admin necesitaría una app de Entra ID con secretos para consultarlo y en local habría otra pila. D20 («todo en la nube») se cumple igual: la pila corre en Azure |
| D51 | **Cliente GraphQL de la web** | **Aprobada (26/10, V2.17).** Un cliente propio con `fetch` (`ecoairlines-web/src/api/client.ts`, sin Apollo Client ni generación de tipos): convierte el ProblemDetails de `errors[].extensions` al mismo `ApiError` de las pantallas. Cada operación escribe su documento a mano y `tests/arquitectura-v2/web-graphql.spec.ts` los valida TODOS contra `contract/gateway.graphql` y comprueba que la web solo llame al GraphQL y a la Payment API | La web no necesita caché normalizada (cada pantalla pide lo suyo) y así no suma dependencias pesadas; la prueba contra el esquema da la misma seguridad que los tipos generados sin las ~30 dependencias de graphql-codegen |
| D53 | **Stock a Booking por REST** (precisa D33) | **Aprobada (03/11, V2.20).** Booking publicó en Azure `POST https://booking-core-api.azurewebsites.net/api/v2/inventory/stock` con `service_id` `NODE_VUE_EQ5` (fijo, asignado al equipo 5). Offers lo usa cuando existe `BOOKING_STOCK_URL`; el gRPC de D33 queda como alternativa. Mismo mensaje sin `timestamp`, valor absoluto, mismos reintentos; vale solo con `success: true`. El stock de vuelos que ya salieron no se envía | El gRPC nunca fue alcanzable (BKG-13) y Booking definió este canal para todos los equipos. El servicio de identidad de nodo (`nodo_id` del health) sigue siendo `NODE_VUE_ECOAIRLINES`: no lo pidieron |
| D52 | **Pases y viajes sin conexión** | **Aprobada (02/11, V2.19).** El service worker guarda SOLO la aplicación (sin `runtimeCaching`). Los pases y «Mis viajes» se guardan aparte, en `localStorage` (`src/lib/offline-trips.ts`), con lo mínimo para abordar: nombre, vuelo, ruta, hora, asiento, grupo, puerta y código de barras. Nunca token, documento, contacto, salud ni pago. Por usuario; «Salir» lo borra; vencer la sesión no; los vuelos pasados se purgan un día después de salir. Las versiones nuevas se instalan si el cliente lo pide | GraphQL va por POST y, sin conexión, no hay sesión (el token vive solo en memoria): la caché del service worker no puede servir un pase. El plan pide abrirlo en modo avión, así que algo debe quedar en el dispositivo: un dato personal mínimo y con vencimiento, a cambio de poder abordar sin señal. Actualizar recarga la página y cerraría la sesión, quizá en plena compra |

**Costos en la nube:** se estimarán antes de V2.14. D39 sube el costo mínimo (réplicas siempre encendidas); se puede apagar todo
entre presentaciones y acordar con Booking las ventanas de prueba.

---

## 8. Riesgos y cómo se controlan

| Riesgo | Control |
|--------|---------|
| Romper el contrato v2 al mover código | Suite de conformidad v2 (V2.1) corrida en cada fase desde V2.13 |
| Contratos por servicio que contradicen el del grupo | Verificación de V2.1: las 30 operaciones aparecen una vez, en su `x-microservice`, con los mismos schemas |
| **Booking espera la integración mientras se construyen los microservicios** (D38) | La integración va primero (V2.2–V2.14); `booking-simulado` permite probar antes de V2.14; avisar al grupo la fecha estimada |
| **Preguntas sin respuesta del grupo (BKG)** | Se aplica la solución de 3.6 y queda registrada en `HALLAZGOS.md` |
| **Timeout de 5 s de Booking** | Mínimo 1 réplica (D39), health desde caché, sagas que responden `202` si se alargan |
| **Doble cobro o referencia reutilizada** | El canal Booking nunca cobra; `payment_records` con referencia única (D34) |
| **Asiento vendido dos veces** | Cambio de estado atómico en Offers; `409 SEAT_TAKEN` al segundo (D34) |
| **Eventos de Booking repetidos** | `inbound_events` + sagas idempotentes (D34) |
| **Stock desincronizado o Booking caído** | Envío en segundo plano, valor absoluto, `stock_sync`, reintentos y alerta (D33) |
| Inconsistencia entre servicios | Sagas con compensación, `saga_log`, pruebas de fallo en cada paso |
| Eventos perdidos | *Outbox* + colas durables + feed `GET /vuelos/eventos`; el consumidor deduplica por `id` del CloudEvent |
| Un administrador se bloquea a sí mismo o deja la aerolínea sin administradores | Reglas en Identity con pruebas |
| Un precio o un descuento mal escrito | Límites (descuento ≤ 50 %), vista previa, «Rellenar», historial |
| Fuga de datos de salud, tarjetas, secretos o clientes de la web | No viajan a webhooks, logs, trazas ni caché; secretos derivados; D40 |
| Confundir el entorno de prueba con pagos reales | La web y la Payment API lo indican claramente |
| Costo de tener todo en la nube | Réplicas mínimas solo en la ruta de Booking; apagado entre presentaciones |
| Código repetido entre servicios | `packages/shared` y una plantilla de servicio |
| Alcance demasiado grande | V2.1–V2.14 dejan la integración con Booking funcionando y cumplen el requisito del ingeniero; V2.15–V2.21 completan |

---

## 9. Próximo paso

1. Enviar al grupo de Booking las preguntas **BKG-01, 02, 03, 06, 08 y 11** (`HALLAZGOS.md`, sección 8). La más urgente es
   **BKG-01** (por dónde llegan sus eventos).
2. Auditar (Gemini) y aprobar **V2.2**, **V2.3**, **V2.5**, **V2.6**, **V2.7**, **V2.8**, **V2.9**, **V2.10**, **V2.11**, **V2.12** (con **D44** y **D45**) y **V2.13** (con **D46** y **D47**; V2.4 y D43 aprobadas). Cerrar **V2.14** con Booking (BKG-01, BKG-06, BKG-13 y la entrega de credenciales). Auditar y aprobar **V2.15** (D49), **V2.17** (D51), **V2.18** y **V2.19** (D52). Desplegar **V2.16** en la nube cuando se decida con Booking dónde se hospeda todo (`PASOS_FINALES.md`). Siguiente: **V2.20 — Nube: todo lo demás**.
