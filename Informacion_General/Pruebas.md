# Pruebas — EcoAirlines Reto 2

Qué pruebas tiene el sistema, cuáles faltan y cómo correrán en **GitHub Actions** (CI/CD).
Revisado el **11/11/2026** sobre la rama `feature/v2-microservicios` (commit `3a9ec6c`).
Base teórica: *Semana 9. Pruebas de integración y contract testing*, D. Nicolalde, PUCE (material del curso; no se publica en el repositorio). En el texto se cita
como **[S9 §x]**.

> **Estado: PROPUESTA (versión 2).** Se replanteó después de leer el material de la Semana 9. Las secciones 1 a 3 describen lo
> que **ya existe** (medido). Las secciones 4 a 10 describen lo que se **propone**. Nada de eso está programado: se implementa
> solo cuando se apruebe (sección 11).

---

## 1. Diagnóstico: la pirámide hoy está al revés en el medio

**[S9 §9.1]:** muchas unitarias en la base, algunas de integración en el medio, **pocas** E2E en la cima. Según la tabla de
síntomas **[S9 Tabla 5b]**, un desequilibrio así hace que el *pipeline* sea lento y que un cambio pequeño rompa otra parte
sin que se note.

Así está hoy el sistema (contado con `vitest list`):

```
                 ┌──────────────┐
  E2E            │   ~25  (fuera del repositorio, scripts sueltos)
                 └──────────────┘
          ┌────────────────────────────┐
  Integr. │          581               │   540 por HTTP con dobles + 41 con PostgreSQL/RabbitMQ (omitidas)
          └────────────────────────────┘
                 ┌──────────┐
  Unit.          │    82    │   10 archivos
                 └──────────┘
  Contrato: 95 (estáticas) + 49 (conformidad contra un servidor)
```

**Tienes razón en preocuparte: no es una pirámide, es un rombo.** Casi todo se prueba por HTTP, arrancando el
microservicio completo. Esas pruebas dan mucha confianza, pero:
- son más lentas: toda la suite tarda ~60 s en lugar de unos pocos;
- cuando una falla, no dicen **qué función** está mal, sino solo que «el endpoint devolvió otra cosa»;
- hay ~250 funciones exportadas y ~200 métodos de servicios, y **casi ninguno tiene una prueba propia**;
- solo **1 archivo** usa *spies* (`vi.fn`). Lo demás usa *fakes* (sección 6).

**Por qué quedó así (para que lo puedas explicar):** en microservicios existe otro modelo, el **«panal» (*honeycomb*)**, que
prefiere probar cada servicio por su API, y las pruebas se escribieron con ese criterio. Es un modelo válido, pero **el curso
pide la pirámide**, y la pirámide además ayuda a encontrar errores más rápido. Por eso se replantea.

### Tres aclaraciones sobre lo que te indicaron

1. **«Por cada función debe haber una prueba».** Casi. La regla es probar **cada comportamiento**: una regla de negocio, un caso
   límite, un error. Una función con tres reglas necesita tres o más pruebas; un *getter* de una línea no necesita ninguna.
   **[S9, Preguntas frecuentes]:** «concentra el esfuerzo en unitarias»; «una regla de negocio crítica sí merece prueba, sin
   importar cuán obvia parezca».
2. **«Cada endpoint» con prueba unitaria.** Un endpoint no se prueba de forma unitaria: lo que tiene detrás sí (el servicio y
   las reglas). El endpoint completo (controlador + validación + *guards* + servicio) es una prueba de **integración**.
3. **«La mayoría de las de integración en el gateway».** En esta arquitectura el punto donde más se integra es el **ESB**:
   enruta, orquesta las sagas y compone las respuestas. El gateway integra la entrada con los 5 MS de respuesta. Las dos
   capas necesitan integración; el ESB, más.

---

## 2. Cómo se clasifica cada prueba (criterio del proyecto)

**[S9 Ejercicio 9.1]** clasifica así: (a) una función pura es **unitaria**; (b) un `TestingModule` con el servicio real y el
repositorio simulado es **integración**; (c) un `POST` a la aplicación HTTP completa es **E2E**.

El ejemplo (c) es E2E en el curso porque allí **la aplicación entera es un solo servicio**. En este sistema, un microservicio
solo es una pieza de 20. Por eso se usa este criterio, y conviene explicarlo así en la sustentación:

| Nivel | Qué levanta | Dobles permitidos | Ejemplo |
|---|---|---|---|
| **Unitaria** | Una función o una clase, **sin NestJS** o con un `TestingModule` mínimo | *Stubs* y *spies* (`vi.fn`) para **todo** lo de afuera | `priceFor()` de Offers; `BookingsService.cancel()` con el repositorio *stub* |
| **Integración** | **Un** microservicio completo (`Test.createTestingModule` + Supertest), o un repositorio contra un PostgreSQL real | *Fakes* para los **otros** servicios | `POST /bookings` en MS.G.Bookings; una saga del ESB contra MS.G falsos |
| **Contrato** | Consumidor y proveedor **por separado**, con el contrato en medio | El *mock provider* de Pact | MS.Reservas → ESB; ESB → MS.G.Bookings |
| **E2E** | **El sistema entero** (los 20 contenedores) como lo usa un cliente | Ninguno (Booking simulado, porque es externo) | Un pasajero compra en la web |

---

## 3. Lo que ya existe (medido el 11/11/2026)

| Nivel | Pruebas | Archivos | Dónde |
|---|---:|---:|---|
| Unitarias | 82 | 10 | `jwt`, `shared`, `bus`, `identity/rules`, `schedule/timetable`, `esb/journey`, `esb/transversal`, `esb/events`, `live-topics`, `web-offline` |
| Integración por HTTP (servicio + *fakes*) | 540 | 26 | Cada `services/**/test/*.spec.ts` (9 MS.G, ESB, 5 MS de respuesta, gateway, externos) |
| Integración con infraestructura real | 41 | 12 | `*/test/postgres.spec.ts`, `bus.spec.ts`: **omitidas** si no hay variables `*_TEST_DATABASE_URL` / `BUS_TEST_URL` |
| Contrato (lado proveedor, estático) | 95 | 3 | `esb/routes.spec.ts` (61), `arquitectura.spec.ts` (30), `web-graphql.spec.ts` (4) |
| Contrato contra servidor real (conformidad v2) | 49 (54 desde E2E-1, con las 5 de administrador) | 6 | `tests/conformidad-v2/`; desde E2E-1 corre en la CI contra el sistema local (`npm run e2e:conformidad`) |
| E2E (Playwright + Edge) | ~25 (8 desde E2E-1) | 7 | Antes fuera del repositorio; desde E2E-1, los 8 flujos críticos en `tests/e2e/` y en la CI |
| Web (`ecoairlines-web`) | 46 (desde PU-4) | 4 | Vitest + Testing Library + jsdom; corren en el trabajo «Web» de la CI |

**Nada corre solo en GitHub Actions:** `imagenes-v2.yml` es manual, y el flujo de la web solo se dispara en `main`, que no
existe en `gab5453/Reto-2`.

---

## 4. Pirámide objetivo

```
                    ┌───────┐
  E2E               │  ~8   │   solo los flujos críticos (Playwright)                         [S9 §9.1, 9.5b]
                    └───────┘
              ┌─────────────────┐
  Integración │      ~600       │   540 actuales + 41 con BD real (activadas) + ~20 nuevas
              └─────────────────┘
       ┌─────────────────────────────────┐
  Unit.│            ~1 000               │   82 actuales + ~900 nuevas
       └─────────────────────────────────┘
  Al costado (no es un nivel, es un control antes de desplegar):
  Contrato: 95 estáticas + 49 de conformidad + ~60 interacciones Pact nuevas            [S9 §9.2–9.3]
```

| Nivel | Al empezar (11/11) | Hoy | Objetivo | Cambio |
|---|---:|---:|---:|---|
| Unitarias | 82 | **937** (tras PU-4; 891 del backend + 46 de la web) | **~980** | **+~900** (sección 5.1) |
| Integración | 540 + 41 omitidas | 540 + 41 (en CI) | ~600 | Se activan las 41 en CI ✅; +~20 nuevas; se revisan duplicados (sección 5.2) |
| Contrato | 95 + 49 | 95 + 49 + **Pact: 11 interacciones en 5 contratos** (tras CT-1) | + Pact | Pact agregado (sección 5.3, `tests/contratos-pact`) |
| E2E | ~25 fuera del repositorio | **8** en el repositorio (tras E2E-1) | ~8 | Se reducen a los flujos críticos (sección 5.4) ✅ |

Las cantidades nuevas son **estimadas**: unas 2 a 4 pruebas por función con reglas (camino feliz, caso límite, error). Se
ajustan al escribirlas.

---

## 5. Pruebas que se proponen

### 5.1 Unitarias (~900 nuevas): la base

**Regla:** se prueba cada función o método **con comportamiento propio**: una decisión, un cálculo, una regla, un error. Lo de
afuera (repositorio, cliente HTTP, bus, reloj) se reemplaza por un *stub* o un *spy* de Vitest (`vi.fn()`, `vi.spyOn()`,
`vi.useFakeTimers()`). El archivo va **junto al código**: `src/domain/rules.ts` → `src/domain/rules.spec.ts`.

#### 5.1.1 MS de gestión: reglas de dominio (funciones puras)

| Servicio | Archivo | Funciones | Qué se prueba (ejemplos) | ~Pruebas |
|---|---|---|---|---:|
| **Bookings** | `domain/rules.ts` | 12 | `isValidEcuadorianId` (dígito verificador, 10 dígitos, provincia), `ageOn` (bebé, niño, adulto, cumpleaños el mismo día), `assertPassengers` (bebé sin adulto, documento repetido), `generatePnr` (formato, sin repetir), `issueTickets` y `reissueCoupons`, `fareOfSegment`, `unflown` | 40 |
| **Offers** | `domain/catalog.ts` | 22 | `priceFor` (fórmula, precio fijo por ruta, multiplicadores), `priceItinerary` (descuento de conexión), `isValidConnection` (mínimo y máximo entre vuelos), `isSellable` (ventana de venta), `findItineraries`, `extraBagPrice`, ids (`build…`/`parse…` de ida y vuelta), `addDays` en cambio de mes y de año | 60 |
| **Schedule** | `domain/rules.ts`, `dates.ts`, `timetable.ts` | 12 + 4 + 12 | `assertNotDuplicated`, `assertWithoutSoldSeats`, `nextFlightNumbers` (sin repetir), `assertMultipliers`, `assertPromotionTerms`; `localToUtcMs` (Ecuador y Galápagos); `salesWindow`, `operatesOn`, `routeReturn` | 60 |
| **PostSale** | `domain/rules.ts` | 8 | `refundOf` (por tarifa y por anticipación), `compensationWaived` (culpa de la aerolínea), `dateChangeOptions`, `validateBaggage` (límites) | 25 |
| **FlightStatus** | `domain/status.ts` | 4 | `applyUpdate` (transiciones permitidas y prohibidas), `isFinal`, `atOffsetOf` | 12 |
| **CheckIn** | `domain/boarding.ts` | 3 | `boardingGroup` (por cabina), `julianDay` (año bisiesto), `bcbp` (formato IATA del pase) | 10 |
| **Webhooks** | `domain/rules.ts` | 6 | `nextRetryAt` (espera creciente, tope), `assertAllowedUrl` (sin HTTP, sin IP privadas), `canReceive`, `canReadFeed` | 18 |
| **Identity** | `domain/rules.ts` | 5 | Ya hay 9; faltan `normalizeEmail` y `grantedScopes` | 6 |

#### 5.1.2 MS de gestión: servicios con el repositorio como *stub* o *spy*

Ejemplo del estilo (Vitest = Jest en la sintaxis):

```ts
// services/gestion/ms-g-bookings/src/services/bookings.service.spec.ts
const store = { findByPnr: vi.fn(), save: vi.fn(), appendOutbox: vi.fn() };          // stub + spy
const service = new BookingsService(store as unknown as BookingsStore, config);

it('cancelar una reserva con check-in hecho responde CUTOFF_PASSED y no guarda nada', async () => {
  store.findByPnr.mockResolvedValue(reservaConCheckIn);
  await expect(service.cancel('9M2XWF', actor)).rejects.toMatchObject({ problem: { code: 'CUTOFF_PASSED' } });
  expect(store.save).not.toHaveBeenCalled();                                          // spy  [S9 Ejercicio 9.4]
});
```

| Servicio | Clase (métodos) | ~Pruebas |
|---|---|---:|
| Bookings | `BookingsService` (21) | 40 |
| Offers | `HoldsService` (7), `InventoryService` (10), `StockSyncService` (4), `CatalogService` (2) | 40 |
| Schedule | `ScheduleService` (14), `PricingService` (7), `AirportsService` (6), `AircraftTypesService` (5), `PromotionsService` (3) | 50 |
| Identity | `AccountsService` (13), `PartnersService` (7), `TokensService` (5) | 40 |
| PostSale, FlightStatus, CheckIn, Webhooks, Customers | 8 + 8 + 6 + 8 + 3 métodos | 55 |

#### 5.1.3 ESB

| Qué | Archivo | Qué se prueba | ~Pruebas |
|---|---|---|---:|
| **Motor de sagas** | `sagas/engine.ts` | Un paso ya hecho no se repite; compensación en orden inverso; la compensación se registra antes del paso; después de `pointOfNoReturn()` no se compensa, se reintenta con `RETRY_DELAYS_MS` (con reloj falso); reanudar tras un reinicio | 20 |
| Pasos de las sagas | `sagas/support.ts`, `booking-sagas.ts` | `collectPayment`, `settleRefund`, `segmentsOf`, `international`, `bookingEventData`… con los clientes como *spies* | 30 |
| Enrutador | `router/routes.ts`, `route-events.ts`, `router.service.ts` | `matchRoute` (parámetros, ruta inexistente, método equivocado), `routeEvent`, `problemResponse` | 18 |
| Composición | `composition/*.ts` | `traceWindow`, `localDate`, `buildJourney`, `maskIds` (también el caso de `oauth2`), `flattenOtlp`; `CompositionService` con clientes *stub* | 30 |
| Transversal | `idempotency.service.ts`, `inbound.service.ts` | Misma clave + mismo cuerpo → misma respuesta; misma clave + otro cuerpo → 422; evento repetido → se descarta (*spy* en el manejador) | 16 |
| Clientes | `clients/*.ts` | `problemFrom` (mapeo de errores), catálogos (`applyAirportWrite`, `replaceCatalog`), token de servicio (renovar antes de vencer, con reloj falso) | 20 |

#### 5.1.4 Librería compartida, gateway, externos y web

| Área | Qué se prueba | ~Pruebas |
|---|---|---:|
| `shared/domain` | `money` (redondeo, suma, descuento, nunca decimales), `aircraft` (`buildCabinLayouts`, `nextRegistration`, `reaches`), `airports` (`distanceKm`), `passenger-counts` | 60 |
| `shared` técnico | `CircuitBreaker` (CERRADO → ABIERTO → MEDIO ABIERTO → CERRADO, un 4xx no cuenta), `OutboxRelay` (publica en orden, reintenta, marca como enviado), `correlation`, `problem-details`, `logging.redact`, `cloudevents` | 50 |
| `shared/respuesta` | `principal` (`authenticate`, `ownerOf`), `links`, `sagas` (`sagaOutcome`), `http-security` (`sanitize`), `proto` | 35 |
| Gateway | `graphql/mappers.ts` (25 funciones), `errors.ts`, `directives.ts` (`scopeOf`), `limits.ts` (profundidad y complejidad), `context.ts` | 70 |
| Payment API y Booking simulado | Reglas de pago (montos, estados, reembolsos), firma | 25 |
| **Web** (Vitest + Testing Library + jsdom, dependencias nuevas) | `api/client.ts` (un 503 es «no disponible», no «sin conexión»), `components/journey/layout.ts`, `lib/live.ts` con un WebSocket falso, formularios del panel | 35 |

### 5.2 Integración (~600): el medio

Las 540 actuales **se quedan**: prueban el «cableado» (*providers*, inyección, validación, *guards*, filtros), que una
unitaria no puede ver **[S9 §9.1]**. Cambios:

| Id | Qué |
|---|---|
| I-1 | **Activar en CI las 41 con PostgreSQL y RabbitMQ reales** (contenedores de servicio de GitHub Actions) |
| I-2 | **Gateway → MS de respuesta real → ESB falso**, en el mismo proceso (~10 pruebas): hoy cada lado se prueba por separado |
| I-3 | **ESB + RabbitMQ real**: un evento de un MS.G llega, se deduplica y sale como webhook (~6) |
| I-4 | **Revisión de duplicados:** cuando un caso límite quede cubierto por una unitaria, la prueba HTTP que solo probaba ese caso se puede quitar. **Solo con tu aprobación, caso por caso**; por defecto no se borra nada |

### 5.3 Contrato (nuevo: Pact, consumer-driven) [S9 §9.2–9.3]

**Lo que hay hoy es contract testing *provider-driven*:** cada respuesta se valida contra el OpenAPI del proveedor. **[S9
§9.2]** explica su límite: no sabe **qué campos usa de verdad** cada consumidor. Con Pact, el consumidor declara lo que
espera, se genera un `pact.json` y el proveedor lo verifica.

| Consumidor → Proveedor | Protocolo | ~Interacciones |
|---|---|---:|
| 5 MS de respuesta → **ESB** | REST | 30 |
| **ESB** → Identity, Schedule, Bookings, CheckIn, FlightStatus, Webhooks, Customers, Payment API | REST | 25 |
| MS.G → **ESB** (eventos por RabbitMQ) | Pact de mensajes | 6 |
| **Web** → gateway | GraphQL sobre HTTP | (opcional) |
| ESB → Offers (gRPC) y ESB → PostSale (SOAP) | — | **Se quedan con las pruebas actuales contra el `.proto` y el WSDL**: Pact para gRPC necesita un *plugin* aparte |

- **[S9, Preguntas frecuentes]:** si consumidor y proveedor son del mismo equipo, Pact vale menos, pero sigue sirviendo como
  documentación ejecutable. Aquí lo es todo menos Booking.
- **Booking** es el único consumidor de **otro equipo**. Lo ideal sería que ellos escriban su prueba de consumidor y nos pasen
  su `pact.json`. Se propone pedírselo; mientras tanto, la suite de conformidad (49) cumple ese papel contra el contrato de grupo.
- **Pact Broker:** un *broker* propio necesita PostgreSQL y otro contenedor (memoria de la VM, o costo). Propuesta: **guardar
  los `pact.json` en el repositorio** (`contract/pacts/`) y verificarlos en CI con `pactUrls`. Sin *broker* no hay
  `can-i-deploy`; en su lugar, la verificación es un **gate obligatorio** antes de desplegar (sección 8).
- Librería: `@pact-foundation/pact` (funciona con Vitest).

### 5.4 E2E (~8): la punta [S9 §9.1, 9.5b]

**[S9 Ejercicio 9.5b]:** si hay muchas E2E lentas, es probable que algunas debieran ser de integración. De los ~25 recorridos
actuales quedan **solo los flujos críticos**, con Playwright Test, en `tests/e2e/` (así heredan el typecheck y el lint):

| # | Flujo crítico | Viene de |
|---|---|---|
| E-1 | Un pasajero busca, elige asiento, paga y recibe su reserva | `recorrido_c1` |
| E-2 | Dos personas toman el mismo asiento: la segunda recibe el aviso y elige otro | `seat_taken_web` |
| E-3 | El pasajero hace check-in; después la cancelación queda bloqueada | `recorrido_c2` |
| E-4 | Booking compra por la API v2 (hold → pago → reserva → consulta) | `seat_taken_booking`, compra B2B |
| E-5 | El administrador registra un retraso y el pasajero lo ve en su reserva | `recorrido_r1` |
| E-6 | El administrador cambia un precio y la búsqueda lo refleja | `recorrido_p1p` |
| E-7 | Con el correlation ID de una compra, el administrador ve su recorrido | `recorrido_t2`, `t4` |
| E-8 | La PWA muestra el pase de abordar sin conexión | `web-offline` |

Lo que sale de los otros recorridos (catálogo de aeropuertos y tipos de avión, mapa en vivo, respaldo de T-5, etc.) **ya está
cubierto por integración**, o pasa a integración. Cada E2E deja el sistema como estaba: cancela sus reservas y restaura los
precios.

**Cómo quedó (E2E-1, 11/11):**

| Archivo | Flujos | Qué atraviesa |
|---|---|---|
| `compra.e2e.ts` | E-1, E-2 | Web → gateway → MS.Reservas → ESB (saga) → MS.G → Payment API. En E-2 la otra persona compra por la API mientras el navegador está en el pago |
| `check-in.e2e.ts` | E-3, E-8 | La misma reserva (vuelo de mañana, el check-in abre 48 h antes). E-3 comprueba el bloqueo en la web **y** en el servidor (`CUTOFF_PASSED`); E-8 corta la red y lee el pase guardado |
| `booking-b2b.e2e.ts` | E-4 | API REST v2 del contrato (OAuth2, búsqueda, hold, reserva, consulta) y el panel del administrador |
| `retraso.e2e.ts` | E-5 | MS.Admin → ESB → MS.G.FlightStatus → evento → MS.G.Bookings; Booking lo ve por REST |
| `precio.e2e.ts` | E-6 | MS.Admin → ESB → MS.G.Schedule → evento de precios → MS.G.Offers |
| `recorrido.e2e.ts` | E-7 | Telemetría: sagas y eventos (ESB), pasos (Loki) y spans (Tempo) |

- **Preparar y limpiar por la API, probar en el navegador** (`apoyo.ts`): una reserva que solo es el punto de partida se compra
  por la API; la limpieza la hace el administrador (`adminCancelBooking`, que también cancela con check-in), y se quitan el retraso,
  el precio exacto y el hold que haya quedado. La limpieza nunca oculta el resultado de la prueba.
- **Nunca contra la nube:** `apoyo.ts` se niega a correr si la web, el gateway o la Payment API no son `localhost`.
- **Sistema:** `npm run e2e:up` (todo `docker-compose.yml` con `docker-compose.e2e.yml`, sin Prometheus, Grafana ni Alertmanager).
  Solo para las pruebas se suben los límites por IP del login y de la Payment API (todas salen de la misma IP; los límites tienen
  sus propias pruebas de integración) y el ESB no recibe las URL de Prometheus y Alertmanager.
- **Ejecutar:** `npm run e2e:up`, luego `npm run e2e:conformidad` (las 54) y `npm run test:e2e` (compila y sirve la web en :5173).
  En Windows usa el Edge instalado; en la CI, el Chromium de Playwright.
- **Inestables (*flaky*) [S9 §9.4], encontradas y corregidas en la causa:** E-7 fallaba a veces porque la web no repite una
  búsqueda con el mismo ID (cada reintento recarga la pantalla) y porque, sin Prometheus, una consulta del panel tardaba 3,5 s en
  fallar. Después: 8 de 8 en tres corridas seguidas (~33 s).

**Prueba de humo después de desplegar (queda para CD-1, porque corre después del despliegue):** contra la nube, **solo lectura** (health, una búsqueda, un mapa de asientos). Nunca se
compra en producción desde CI.

---

## 6. Dobles de prueba (*test doubles*) [S9 §9.4]

Qué tipo de doble usa cada prueba, con los nombres de Meszaros:

| Doble | Qué es | Dónde se usa (hoy o propuesto) |
|---|---|---|
| **Dummy** | Llena un parámetro que no se usa | Un `actor` vacío cuando la regla no lo mira |
| **Stub** | Devuelve siempre lo mismo | `vi.fn().mockResolvedValue(...)` para el repositorio (nuevo, 5.1.2); el verificador de tokens con clave fija (hoy) |
| **Spy** | Stub que además registra cómo lo llamaron | Comprobar que `save` no se llamó, o que el *outbox* recibió **un** evento (nuevo, 5.1) |
| **Mock estricto** | Falla si no se cumple una llamada esperada | El *mock provider* de Pact (5.3) |
| **Fake** | Implementación simple que funciona | Los repositorios **en memoria**, los **MS.G falsos** por HTTP del ESB, el servidor gRPC falso de Offers, Booking simulado (hoy) |

**Reglas para no caer en los errores de [S9 §9.4]:**
- **Nunca simular lo que se está probando.** Por ejemplo, no se hace un *stub* de `BookingsService` para probar `BookingsService`.
- **Limpiar los dobles entre pruebas:** `restoreMocks: true` en `vitest.config.v2.ts`, que equivale a `jest.clearAllMocks()` en cada
  `afterEach`.
- **Que los *fakes* no se desactualicen:** los MS.G falsos responden con datos que se validan contra el contrato del MS.G real
  (`expectContract`), y Pact (5.3) lo cubre desde el otro lado.

---

## 7. Herramientas

| Herramienta | Para qué | Estado |
|---|---|---|
| **Vitest 4** | Ejecutor. **[S9 Tabla 0b]** lo pone como equivalente de Jest: misma sintaxis, con soporte nativo de TypeScript y ESM (el monorepo es ESM) | En uso |
| **`@nestjs/testing`** | `Test.createTestingModule`: el «NestJS testing» que te indicaron. Ya se usa en todos los servicios | En uso |
| **Supertest** | Peticiones HTTP a la app en memoria **[S9 §9.1]** | En uso |
| **Ajv + contratos** | Valida cada respuesta contra su OpenAPI | En uso |
| **`@pact-foundation/pact`** | Contract testing consumer-driven | **Nueva** |
| **Playwright Test** | E2E en el navegador | **Nueva** en el repositorio |
| **Testing Library + jsdom** | Pruebas de la web | **Nueva** (solo en `ecoairlines-web`) |
| **`@vitest/coverage-v8`** | Cobertura **[S9 Tabla 0c]** | Instalada, falta configurarla |
| **Stryker** (`@stryker-mutator/core`) | Mutation testing **[S9 §9.5]** | **Nueva, opcional** (sección 9) |
| **ESLint + typescript-eslint** | Lint con reglas que usan los tipos | **Nueva** (sección 7.1) |
| **oxlint** | Lint rápido | En uso |

### 7.1 ESLint y oxlint

- **ESLint sí aplica:** NestJS es TypeScript, y `nest new` trae ESLint por defecto. Hoy se usa **oxlint**, que es compatible y
  50 a 100 veces más rápido, pero no tiene las reglas que necesitan los tipos.
- La regla que más importa aquí es **`no-floating-promises`**: detecta una promesa sin `await`, el error típico que deja una saga
  a medias. Sin información de tipos, oxlint no la puede aplicar bien.
- **Recomendación:** usar ESLint con `typescript-eslint` (`recommendedTypeChecked`) como linter oficial, y dejar oxlint como
  revisión rápida, con `eslint-plugin-oxlint` para no duplicar reglas.

---

## 8. CI en GitHub Actions: orden *fail fast* [S9 §9.5]

**[S9 Ejercicio 9.5 y caso integrador]:** primero lo más rápido y barato, y se detiene en el primer fallo.
Flujo nuevo: `.github/workflows/ci.yml`, en **cada push y pull request**.

```
push / pull request
  1. lint ............ oxlint + ESLint (tipos) + prettier --check + typecheck            ~2 min
  2. unitarias ....... ~980, con cobertura                                                  ~1 min
  3. integración ..... ~600 + contenedores postgres:17 y rabbitmq:4 (las 41)                ~4 min
  4. E2E ............. docker compose (sin la observabilidad) + Playwright (~8) + humo      ~12 min
  5. contrato ........ verificación Pact (proveedores) + conformidad v2 (49)               ~3 min
  ── gate: si cualquiera falla, NO se llega a desplegar ──
  6. despliegue ...... solo en la rama de producción, con aprobación manual (sección 10)
```

**Como quedó en `ci.yml` (tras E2E-1):** el contrato va **antes** del E2E, porque es más barato (Pact no levanta el sistema):

```
  1. Calidad (tipos y lint)
  2. Pruebas unitarias e integración ............... npm test
  3. Integración con PostgreSQL y RabbitMQ reales ── en paralelo ── 4. Contratos (Pact)      Web (lint, pruebas, build)
  5. E2E (sistema completo) ........................ necesita 3, 4 y Web: docker compose + conformidad v2 (54) + Playwright (8)
```

En YAML, cada etapa es un *job* con `needs:` sobre el anterior, así una falla detiene a los que siguen. La web corre en un
*job* aparte, en paralelo con 2 y 3: lint, pruebas y build.

**Gate de calidad [S9 §9.5]:** en GitHub, *Settings → Branches → required status checks*. Un pull request no se puede fusionar
si `ci` no está en verde.

**Detalles:**
- **E2E en el runner, no en la nube:** no se tocan producción ni las reservas de Booking. Se usa Booking simulado.
- **Memoria:** el runner tiene 7 GB (privado) o 16 GB (público), y el sistema sin observabilidad usa ~2–3 GB.
- **Minutos:** un repositorio público es gratis. Uno privado tiene 2 000 min/mes y cada ejecución completa usa ~25 min: el E2E
  conviene en pull requests y cada noche, no en cada push.
- **Sin secretos de producción en CI:** se usan las claves de desarrollo de `infra/docker-compose.yml`.

**Pruebas inestables (*flaky*) [S9 §9.4]:** antes de activar el gate se revisan las pruebas que miden tiempos y a veces fallan
con la máquina cargada. Se corrigen la causa o el margen; **nunca** se desactivan.

---

## 9. Cobertura y mutation testing [S9 Tabla 0c, §9.5]

- **Cobertura como alerta, no como meta.** Se publica el reporte en cada ejecución. Después de medir la línea base, se pone un
  mínimo **solo en `src/domain/` y en el motor de sagas**, donde una falla cuesta dinero. Un 100 % no significa «sin errores».
- **Mutation testing con Stryker (opcional):** una vez al mes, o a mano, sobre los módulos críticos: `money.ts`, `catalog.ts`
  (precios), `bookings/rules.ts`, `post-sale/rules.ts` (reembolsos), `engine.ts` y `circuit-breaker.ts`. Si un mutante
  sobrevive, la aserción es débil y se corrige. Es costoso, por eso **no** corre en cada push.
- **Snapshot testing: no se usa.** **[S9]** lo recomienda solo para estructuras grandes; la tabla del enrutador ya se compara
  contra su contrato publicado.

---

## 10. CD: llegar a la nube

Los runners de GitHub **no pueden entrar por SSH** a la VM, porque SSH solo se abre a tus IP (regla del proyecto). Compilar en
la VM además la satura (incidente del 09–10/11).

| Opción | Cómo | Pros | Contras |
|---|---|---|---|
| A. Manual (hoy) | `desplegar-parcial.sh` desde la laptop | Simple | Depende de la laptop y compila en la VM |
| **B. Imágenes en GitHub** | CI compila las imágenes ARM64 (`imagenes-v2.yml` ya existe) → GitHub Container Registry; la VM hace `pull` + `up -d` | La VM ya no compila; ~2 min | Hay que reactivar `imagenes-v2.yml` |
| C. B + runner en la VM | *Self-hosted runner* que **sale** hacia GitHub (no abre puertos) y despliega al aprobar | CD completo sin abrir SSH | ~150 MB de RAM; solo en ramas protegidas |

**Recomendación:** primero el CI. Después la **B**, con aprobación manual (un *environment* con revisor) y en horarios
acordados con Booking.

---

## 11. Decisiones antes de programar

| # | Pregunta | Decisión (11/11/2026) |
|---|---|---|
| P-1 | ¿Pirámide objetivo (sección 4): ~900 unitarias nuevas y E2E reducidas a ~8? | ✅ **Aprobada** |
| P-2 | ¿Pact para las relaciones internas, con los `pact.json` en el repositorio y sin *broker*? | ✅ **Aprobado** |
| P-3 | ¿Prueba de consumidor Pact de Booking? | **La hace Booking por su cuenta.** Cuando llegue su `pact.json`, se verifica y se ajusta lo necesario. Hoy no hay noticias |
| P-4 | I-4: ¿quitar pruebas HTTP duplicadas? | **Después.** Primero se crean las pruebas nuevas |
| P-5 | Linter: ¿ESLint + oxlint, solo ESLint o solo oxlint? | ✅ **Ambos** (sección 7.1). El costo es solo de desarrollo: una configuración más. Las dos herramientas son gratuitas y corren en GitHub Actions, que es gratis en un repositorio público |
| P-6 | ¿Pruebas de la web (Vitest + Testing Library)? | ✅ **Sí** |
| P-7 | ¿Stryker? | **No** (se omite). Solo se agrega si el curso lo exige |
| P-8 | ¿`Reto-2` es público o privado? | **Público** (actividad académica): runner de 16 GB, minutos gratis, runners ARM64 gratis. **Ningún secreto puede entrar al repositorio ni a los registros de CI** |
| P-9 | CD: ¿A, B o C? | ✅ **B**: GitHub compila las imágenes ARM64 y las guarda en GitHub Container Registry; la VM solo las descarga (`pull` + `up -d`) con un script que ejecuta el responsable. **C** se descarta: un runner propio en un repositorio público es un riesgo |

**Fases propuestas (cada una se aprueba antes de empezar):**

| Fase | Contenido | Resultado |
|---|---|---|
| **CI-1** ✅ 11/11 | `ci.yml` con lint, typecheck y las pruebas actuales (incluidas las 41 con infraestructura real) | Lo que existe, protegido en cada push. Verificado en local: 717 + 46 (las 41 + 5 de `bus.spec`) pasan, 0 omitidas. **Verde en GitHub** (ejecución 43105254180) |
| **PU-1** ✅ 11/11 | Unitarias de los dominios de los MS.G (5.1.1) | **325** (se estimaron ~245): Bookings 66, Offers 58, Schedule 59, PostSale 35, FlightStatus 36, CheckIn 15, Webhooks 42, Identity 14. Una mutación a mano en tres reglas (edad, impuestos, exoneración) fue detectada |
| **PU-2** ✅ 11/11 | Unitarias de los servicios de los MS.G con *stubs* y *spies* (5.1.2) | **268** (se estimaron ~225): Bookings 71, Offers 73 (holds, inventario, stock a Booking con `fetch` simulado), Schedule 33, Identity 34, PostSale 14, FlightStatus 18, CheckIn 11, Webhooks 14 (con `fetch` simulado y firma HMAC). Customers no tiene capa de servicio (lo cubren sus 4 de integración). Otra mutación a mano en tres servicios fue detectada |
| **PU-3** ✅ 11/11 | Unitarias del ESB (5.1.3) | **103** (se estimaron ~135: lo demás ya lo cubrían `journey`, `transversal`, `events` y `routes`): motor de sagas 18 (con un repositorio *fake*), enrutador, eventos internos, idempotencia, composición, catálogo y cobro/reembolso 66, entrada de eventos de Booking 19. La mutación manual encontró un borde sin probar (un 500 exacto en idempotencia) y se agregó su prueba |
| **PU-4** ✅ 11/11 | Unitarias de shared, gateway, externos y web (5.1.4) | **159** (se estimaron ~275: parte ya estaba en `shared.spec`, `service.spec` y `bus.spec`): librería compartida 59, gateway 28, Payment API 26 (Booking simulado es una herramienta de prueba: no se prueba), web 46 con Vitest + Testing Library + jsdom (cliente GraphQL y WebSocket, hook en vivo, grafo del recorrido, validación de pasajeros, búsqueda en la URL). La mutación manual encontró que la web podía perder el token sin que nada fallara; se agregó la prueba |
| **CT-1** ✅ 11/11 | Pact: consumidores, `pact.json` y verificación de proveedores (5.3) | **11 interacciones en 5 contratos** (se estimaron ~60; es la primera iteración, con las relaciones más críticas): todos → Identity `/oauth2/token` (3), ESB → Bookings (4), MS de respuesta → ESB `/sagas/{id}` (3) y el mensaje `hold.created` de Offers → Webhooks (1). Contratos en `contract/pacts/` (sin Pact Broker); trabajo «4. Contratos (Pact)» en la CI. Dos cambios que rompen (renombrar `pnr` y `seatsHeld`) fueron detectados |
| **E2E-1** ✅ 11/11 | Playwright en `tests/e2e/` con los 8 flujos y E2E en CI (5.4) | **8 flujos** (E-1 a E-8) con `@playwright/test` 1.64.1 contra el sistema completo (docker compose) y la web compilada; la conformidad v2 corre en la CI con las **54** (antes 49 y 5 omitidas). Trabajo «5. E2E (sistema completo)». Cada prueba deja el sistema como estaba. Una mutación a mano en la web (no quitar el asiento tomado) fue detectada. Tres hallazgos fuera de la fase en `CAMBIOS.md` (el principal: 10 servicios se caen si PostgreSQL corta sus conexiones) |
| **CI-2** | ESLint con tipos, Prettier, cobertura y gate de calidad | Pipeline completo |
| **CD-1** | Imágenes en GitHub y despliegue por `pull` (opción B) + humo | Despliegue sin compilar en la VM |
| **SEG-1** (recomendada) | Mejoras de seguridad: **actualizar las dependencias de producción con avisos (S-0; `@nestjs/graphql` desde el 18/11)**, Vitest y `vite` (S-1), Dependabot y secret scanning (S-3), cambiar la contraseña del ADMIN de demostración al terminar la evaluación (S-4). Detalle, riesgos conocidos y lo que ya está implementado: [`Seguridad.md`](Seguridad.md) | Avisos de seguridad de las dependencias resueltos |
