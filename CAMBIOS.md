# CAMBIOS — AppVuelos (EcoAirlines)

> **Versión 1 · actualizado el 2026-10-07.** Desde aquí comienza formalmente la **versión 1** de la página.
> Todo cambio se propone en este archivo, se aprueba y solo después se implementa. Lo que no esté aquí **no se hace**.
> Marca cada fase con ✅ (aprobada), ❌ (rechazada) o ✏️ (aprobada con cambios).
> El detalle de la versión 0 (fases 1 a 8, con resultados y desviaciones) está en git: `git show adb6c48:CAMBIOS.md`.
>
> **Estado al 07/10:** la versión 1 está **completa y en línea en Azure** (V1.N).

| Versión | Contenido | Commit |
|---------|-----------|--------|
| V1.A | División de datos por dominio | `2630915` |
| V1.C–V1.D | Arquitectura en 4 capas; cliente, administración y observabilidad | `40cf965` |
| V1.E–V1.L | Horario de 91 días y por avión, panel admin, checkout de grupo, validación de pasajeros, CRUD de rutas y flota, eventos y webhooks, dev-auth en Swagger, documentación técnica | `b41b828` |
| V1.M | PostgreSQL y preparación para Azure (workflows) | `2a8143e` |
| V1.N | Despliegue en Azure en línea | `d3ada3d` |
| **V2** | **Reto 2 — transición a microservicios** (plan y decisiones en `PLAN/PLAN.md`) | en curso |

---

## 1. Contexto y reglas de la versión 1

### Requisitos del booking (fase RDA1)
1. **Solo API REST**, tanto el backend como el frontend (el frontend consume únicamente REST). No se implementa gRPC ni GraphQL.
2. **E-commerce de aerolínea por persona**, **desplegado en la nube** (Render según la plantilla del booking; se desplegó en **Azure**, ver V1.N).
3. **Funcionamiento individual primero:** en RDA1 no hay integración entre plataformas. Se sigue el contrato para que la integración
   de RDA2 sea simple.
4. **El contrato no se modifica.** `contract/vuelos-openapi.yaml` es idéntico al de la plantilla. Las inconsistencias van a `HALLAZGOS.md`.

### Plantilla del booking (`Vuelos-Integracion-Sistemas-main`)
- Es un **ejemplo estructural**: sus endpoints devuelven `{}`. Lo obligatorio es el contrato.
- Convenciones que marca: prefijo `/api/v1`, Swagger en `/api/docs`, PostgreSQL con TypeORM, `.env` con `DATABASE_URL` y despliegue en Render.
  Las diferencias con nuestro código están en `HALLAZGOS.md` (sección PLT) y requieren decisión.

### Roles
| Rol | Quién | Responsabilidad |
|-----|-------|-----------------|
| Programador principal | Claude | Propone en este archivo, implementa lo aprobado y verifica (tipos, lint, pruebas y prueba en navegador) |
| Auditor técnico | **Gemini** | Audita contra el contrato y sus reglas (`GEMINI.md`); registra en `AUDITORIA.md` (raíz) |
| Supervisor | Responsable del proyecto | Aprueba fases, verifica el funcionamiento y decide los hallazgos con el líder de booking |

### Flujo de cada fase (desde la versión 1)
1. **Propuesta** en este archivo → 2. **aprobación** del supervisor → 3. **implementación** en una rama (`feature/...`) →
4. **verificación** (tipos, lint, unitarias, e2e de conformidad con el contrato, prueba en navegador) → 5. **auditoría de Gemini** →
6. **supervisión del funcionamiento** → 7. **commit**, Pull Request y merge a `main`, con una etiqueta de versión cuando corresponda.

---

## 2. Punto de partida: versión 0 (etiqueta `v0.1.0`, commit `adb6c48`)

| Fase | Contenido | Estado |
|------|-----------|--------|
| 1 | Swagger publicado desde el YAML del contrato (`/docs`) y conformidad de rutas | ✅ |
| 2 | JWT verificado (firma, `exp`, `iss`, `aud`, algoritmos), JWKS para producción, propiedad de holds y webhooks | ✅ |
| 3 | Helmet, CORS por lista blanca, límite de peticiones (`429`), límite y `Content-Type` del body, saneamiento, `additionalProperties`, SSRF | ✅ |
| 4 | ProblemDetails uniforme, `X-Request-Id`, logs estructurados sin datos sensibles, validación del entorno al arrancar | ✅ |
| 5 | GDS simulado: búsqueda, holds con cupos y expiración, reservas con tickets, listado, check-in, pases QR, estado de vuelo, posventa | ✅ |
| 6 | Frontend React "eco" (EcoAirlines), `dev-auth` separado, recorrido completo verificado en navegador | ✅ |
| 7 | 126 pruebas unitarias y 96 e2e; **cada respuesta se valida contra los schemas del contrato**; seguimiento de la auditoría (13/13) | ✅ |
| 8 | Monorepo publicado en `github.com/gab5453/AppVuelos` (`.gitignore`, README, revisión de secretos) | ✅ |
| — | `HALLAZGOS.md` y `HALLAZGOS2.md` fusionados y verificados contra el código (este cambio) | ✅ |

**Estado verificado al iniciar la versión 1:**
- El código cumple el contrato: 22 operaciones y todas las respuestas documentadas validadas, salvo `cancel 202`, que no se produce.
- Funciona en local.
- **Todavía no está listo para la nube:** ver los hallazgos NUBE-01 a NUBE-04.

---

## 3. Auditoría de Gemini y fases ejecutadas de la versión 1

### Seguimiento de la auditoría de Gemini (`AUDITORIA.md`, 04/10)

| Hallazgo | Severidad | Estado | Dónde se trata |
|----------|-----------|--------|----------------|
| Acoplamiento: post-sale y check-in usan el repositorio y los ports de bookings | CRITICAL | ✅ Corregido | **V1.A** (abajo) |
| Servicios de aplicación devuelven códigos HTTP (`statusCode: 201 \| 202`) | HIGH | ⏳ Pendiente | Propuesto como V1.B |
| `404` no documentado en endpoints de posventa | MEDIUM | 📋 Ya registrado | HALLAZGOS **HALL-11** (requiere cambio de contrato: lo decide el líder de booking) |
| `202` de `/cancel` documentado pero nunca producido | LOW | 📋 Ya registrado | HALLAZGOS sección 7 y prueba de conformidad (`NOT_PRODUCIBLE`) |
| `/cancel` sin `ForbidUnknownPropertiesGuard` | LOW | ⏳ Pendiente de decisión | Ver nota de V1.B |

### V1.A — División de datos por dominio — ✅ IMPLEMENTADA (04/10, rama `feature/division-datos-por-dominio`)

**Origen:** hallazgo CRITICAL de Gemini. Solicitado por el supervisor: separar ahora **qué datos pertenecen a cada dominio**, para
que al crear las bases de datos de cada microservicio sea evidente qué va en cada una. **No** se separan todavía las bases de datos
ni los procesos: sigue siendo un monolito modular, como permite RDA1.

**Diagnóstico (medido en el código antes del cambio):** `post-sale` y `check-in` **escribían directamente** en el repositorio de reservas
(5 puntos) y leían su estado interno (`booking.internal`) 19 veces. Además usaban los ports de bookings hacia el GDS y la Payment API,
y los check-ins se guardaban **dentro de la reserva**.

**Cambios:**
1. **bookings → API pública `BookingsFacade`** (`bookings/application/bookings.facade.ts`). Es la única forma en que otros dominios
   leen o modifican una reserva:
   - `findOwned`: devuelve un **`BookingSnapshot`**, una copia de solo lectura sin `ownerId`.
   - `recordBaggagePurchase`, `recordSeatAssignments`, `markChangePending`, `applyItineraryChange` y `cancel`.
   - `BookingsModule` ahora **solo exporta** `BookingsFacade` y `BookingOwnershipGuard`. El repositorio y los ports son privados.
2. **check-in, dueño de sus datos:** nuevo `CheckInRepositoryPort`, con su adaptador en memoria. Los check-ins salieron de `booking.internal`.
   Nuevo port propio hacia el GDS (`DepartureControlPort`).
3. **post-sale, con ports propios:** `PostSaleGdsPort` (inventario, asientos, horarios, tarifas, alternativas) y `PostSalePaymentPort`.
   Cancelación, cambio de fecha y maletas modifican la reserva solo mediante la fachada.
4. **Sistemas externos únicos:** la Payment API simulada pasó a `infrastructure/mock-payment/`, igual que el GDS. Así una referencia de
   pago sigue sin poder usarse dos veces, aunque la consulten dominios distintos.
5. **Código compartido sin datos (librería) en `common/`:** asignación de asientos (`common/seating`), errores de pago
   (`common/payments`) y política comercial (`common/policies`, con `MAX_EXTRA_BAGS`).
6. **Prueba de arquitectura** (`src/architecture.spec.ts`): falla si un dominio importa algo que no sea la API pública de otro, o si
   accede a su repositorio o ports. Se comprobó que detecta una violación con un archivo temporal, que luego se eliminó.
7. Cada repositorio indica en su comentario **a qué base de datos futura pertenece**.

**Mapa de propiedad de datos** (guía para crear las bases de datos de cada microservicio):

| Base de datos futura | Dominio dueño | Datos | Quién más los usa y cómo |
|----------------------|---------------|-------|--------------------------|
| `offers` | offers | Holds (oferta, tarifas, pasajeros, precio congelado, estado) | bookings, solo mediante `HoldService` (en microservicios: API de offers) |
| `bookings` | bookings | Reservas: pasajeros, asientos, maletas, tickets, historial, tarifas compradas | post-sale y check-in, solo mediante `BookingsFacade` (en microservicios: API o eventos de bookings) |
| `post-sale` | post-sale | Cotizaciones de cancelación y ofertas de cambio de fecha | Nadie |
| `check-in` | check-in | Check-ins por segmento y pasajero (los pases de abordar se derivan) | Nadie |
| `webhooks` | webhooks | Suscripciones | Nadie |
| — | search, flight-status | Sin datos propios: consultan el GDS | — |
| *Externo* | GDS | Itinerario de vuelos, inventario de cupos, mapa y asignación de asientos | Cada dominio con **su propio port** |
| *Externo* | Payment API | Pagos y referencias ya usadas | bookings y post-sale, cada uno con **su propio port** |
| *Por servicio* | transversal | Claves de idempotencia y contadores de límite de peticiones | Cada servicio la suya (o Redis compartido con prefijo) |

**Dependencias que quedan entre dominios** (verificadas por la prueba de arquitectura): `bookings → offers`, `check-in → bookings`
y `post-sale → bookings`, todas a través de la API pública.

**Verificación:** tipos ✅, lint ✅, unitarias **130/130** ✅ (+3 de arquitectura y el guard ampliado), e2e **96/96** ✅. Incluyen la
conformidad de cada respuesta con el contrato, así que el comportamiento HTTP no cambió. Build ✅. El contrato está intacto (mismo hash).

**Decisiones para revisar:**
- El guard de propiedad sigue en bookings y lo usan post-sale y check-in. En microservicios cada servicio verificaría la propiedad
  llamando a la API de bookings; hoy lo hace a través de la fachada, que es el mismo punto de corte.
- Los pases de abordar se calculan solo con los segmentos actuales de la reserva. Así un check-in de un vuelo reemplazado por un
  cambio de fecha deja de contar sin que post-sale tenga que avisar a check-in (antes se borraba desde post-sale).
- Un cambio de fecha con pago pendiente (`202`) aplica el cambio con la reserva tal como estaba al confirmarlo.
- Pendiente de commit: esperando la **auditoría de Gemini** y tu **supervisión**, según el flujo de la versión 1.

### V1.B — Propuesta (⏳ pendiente de aprobación): servicios sin detalles HTTP
*Origen: hallazgo HIGH de Gemini.*
- Los servicios devolverán un **resultado de negocio**, por ejemplo `{ outcome: 'COMPLETED' | 'PENDING' }`. Cada controller lo
  traducirá al código del contrato (`201`/`202` en reservas, `200`/`202` en maletas y cambio de fecha).
- Hallazgo LOW de `/cancel`: agregar `ForbidUnknownPropertiesGuard` **rechazaría propiedades extra que el contrato permite**, porque
  `CancelBookingRequest` no declara `additionalProperties: false`. Hoy se descartan en silencio, que es lo correcto según el contrato.
  **Recomiendo no aplicarlo** y registrarlo como respuesta a la auditoría.

### V1.C — Cambio parte 3: arquitectura en 4 capas — ✅ IMPLEMENTADA (05/10, commit `40cf965`)

**Origen:** pedido del supervisor. Un compañero del grupo de vuelos compartió su plantilla (`APIVUELOSV1DIEGOCEVALLOS-main`, solución
.NET 9). Se adopta una **estructura de 4 capas**, con el nombre EcoAirlines. No se copia su código: se reorganiza el nuestro.

**Decisión de tecnología (05/10):** se mantiene **NestJS + TypeScript**. Se conservan así la lógica ya validada contra el contrato, la
seguridad y las 226 pruebas. Pasar a .NET implicaba reescribir toda la API.

**Estructura objetivo** (equivalente a `Aerocache.sln` con sus 4 `.csproj`):

```
Reto 1/
├── package.json                  # "solución": workspaces npm de las 4 capas + scripts (build, test, lint)
├── tsconfig.json                 # compila la solución en orden (referencias entre proyectos = ProjectReference)
├── contract/vuelos-openapi.yaml  # contrato (movido sin cambios desde vuelos/contract)
├── EcoAirlines.API/              # REST: controllers, guards, middleware, auth, seguridad, Swagger, main.ts (= Program.cs)
├── EcoAirlines.Business/         # lógica de negocio: services, DTOs, reglas, excepciones
├── EcoAirlines.DataManagement/   # patrón repositorio: interfaces, repositorios y gateways a sistemas externos
├── EcoAirlines.DataAccess/       # datos: entidades, contextos de datos (= DbContext), seed y sistemas externos simulados
├── ecoairlines-web/              # frontend (antes frontend/), igual que aerocache-web
└── dev-auth/                     # autenticación de desarrollo (sin cambios)
```

**Dependencias entre capas** (las mismas referencias que los `.csproj` de la plantilla):

| Capa | Puede usar | Contenido (de dónde sale) |
|------|------------|---------------------------|
| **API** | Business, DataManagement, DataAccess | Controllers, guards y decoradores (de `modules/*/presentation`), auth, seguridad, observabilidad, filtro ProblemDetails, interceptor de idempotencia, Swagger, `main.ts` y `app.module.ts`. El módulo raíz arma las 3 capas, como `Program.cs` |
| **Business** | DataManagement, DataAccess | Services y `BookingsFacade` (de `application/`), DTOs (de `presentation/dto`), reglas de negocio (de `domain/`), `ProblemDetailsException`, validación de DTOs, asignación de asientos y tareas diferidas. `BusinessModule` = `AddBusiness()` |
| **DataManagement** | DataAccess | Interfaces de repositorios y gateways (de `domain/ports`), repositorios en memoria y adaptadores al GDS y a la Payment API (de `infrastructure/`). `DataManagementModule` = `AddDataManagement()` |
| **DataAccess** | — | Entidades (los `*Record`), **un contexto de datos por base de datos futura**, GDS y Payment API simulados, seed de la red de vuelos y tipos base del contrato (dinero, pasajeros). `DataAccessModule` = `AddDataAccess()` |

**Lo que se conserva de V1.A (división de datos):** dentro de cada capa los archivos se agrupan **por dominio** (`services/bookings`,
`repositories/check-in`, etc.). La plantilla usa un único `DbContext` y un `UnitOfWork` con todas las tablas. Aquí hay **un contexto por
base de datos futura** (offers, bookings, post-sale, check-in, webhooks, idempotencia), para no volver a mezclar los datos que separó V1.A.
El `UnitOfWork` se agregará con PostgreSQL (V1.2), uno por base de datos.

**Prueba de arquitectura ampliada:** además de las reglas por dominio de V1.A, falla si una capa usa una capa superior (por ejemplo,
DataAccess importando Business) o si un dominio accede al repositorio, la entidad o el contexto de datos de otro.

**Sin cambios:** el contrato (mismo hash), las rutas, los códigos HTTP, las respuestas y el frontend (solo cambia de carpeta).
`vuelos/CLAUDE.md` y `vuelos/GEMINI.md` pasan a la raíz **sin modificar su contenido**: sus rutas (`contract/vuelos-openapi.yaml`)
siguen siendo válidas.

**Cómo funciona cada capa como "proyecto"** (equivalencias con la plantilla .NET):

| Plantilla (.NET) | EcoAirlines (NestJS) |
|------------------|----------------------|
| `Aerocache.sln` | `package.json` raíz (`workspaces`) + `tsconfig.json` raíz (compila las 4 capas en orden con `tsc -b`) |
| `Aerocache.X.csproj` + `ProjectReference` | `EcoAirlines.X/package.json` (dependencias `@ecoairlines/...`) + `tsconfig.json` (`references`) |
| `using Aerocache.Business.Services;` | `import { ... } from '@ecoairlines/business/services/...'` |
| `DependencyInjection.AddX()` | `XModule` de NestJS en cada capa (`DataAccessModule`, `DataManagementModule`, `BusinessModule`) |
| `Program.cs` | `EcoAirlines.API/src/main.ts` + `app.module.ts` |
| `AerocacheDbContext` (uno) | Un contexto de datos por base de datos futura (`EcoAirlines.DataAccess/src/context/*.context.ts`) |
| `IGenericRepository` / `GenericRepository` | Interfaces por dominio (`DataManagement/src/interfaces/<dominio>`) y repositorios (`repositories/<dominio>`) |
| — | Gateways a sistemas externos (`DataManagement/src/gateways/<dominio>`): GDS y Payment API |

**Resultado (05/10):**
- **166 archivos movidos con `git mv`** (se conserva su historial) y sus imports reescritos de forma automática según el mapa de destino.
  Se eliminaron los 10 módulos NestJS por dominio, reemplazados por un módulo por capa.
- **Cambio de vocabulario:** los *ports* y *adapters* pasan a llamarse **repositorios** y **gateways**, como en el patrón repositorio de la
  plantilla (`HOLD_REPOSITORY_PORT` → `HOLD_REPOSITORY`, `OfferInventoryPort` → `OfferInventoryGateway`, etc.). La única excepción es
  `HoldGatewayPort`, en Business, porque comunica dos dominios (bookings → offers) y será la llamada HTTP entre microservicios.
- **Entidades separadas de las interfaces:** `HoldRecord`, `BookingRecord`, `PurchasedFare`, `CheckInRecord`, `StoredQuote` y
  `WebhookSubscriptionRecord` estaban dentro de los ports; ahora están en `DataAccess/src/entities/<dominio>`.
- **Sin duplicados:** el enum de eventos de webhooks y `HoldStatus` se definen una sola vez, en DataAccess, y los DTOs los reutilizan.
- `frontend/` → **`ecoairlines-web/`** (solo cambio de carpeta y del nombre del paquete).
- `vuelos/` desaparece. `contract/`, `CLAUDE.md` y `GEMINI.md` están en la raíz con **el mismo contenido** (blobs de git idénticos) y el
  contrato conserva su hash (`2f842515…`).
- **Scripts nuevos en la raíz:** `npm run build`, `typecheck`, `start`, `start:dev` (compila en modo watch y reinicia la API), `token`, `test`,
  `test:e2e` y `lint`.
- Documentación actualizada: `README.md`, `EcoAirlines.API/README.md` (con la sección "Arquitectura en 4 capas"; de paso se corrige
  DOC-01: 22 operaciones), `ecoairlines-web/README.md` y las rutas de `HALLAZGOS.md`.

**Verificación (05/10):**
- Tipos ✅ (4 capas + pruebas), lint ✅, build de la solución ✅ (`tsc -b` en orden DataAccess → DataManagement → Business → API).
- Unitarias **133/133** ✅: las mismas 127 de antes, más 6 de la nueva prueba de arquitectura.
- e2e **96/96** ✅, incluida la **conformidad de cada respuesta con el contrato**: el comportamiento HTTP no cambió.
- **Prueba de arquitectura con control negativo:** se crearon 4 archivos que rompían una regla cada uno (DataAccess importando
  Business, post-sale usando el repositorio de reservas, check-in usando el contexto de datos de bookings, código compartido usando un
  service de bookings). Los 4 fueron detectados, y los archivos se eliminaron.
- **API real desde `dist`** (Node resolviendo los paquetes de las capas): Swagger `200`, búsqueda `200`, hold `201`, reserva `201`, el
  asiento elegido queda ocupado en el GDS compartido, y las opciones de maletas y la cotización de cancelación responden `200`.
- **Integración de los 3 procesos:** el JWT emitido por `dev-auth` es aceptado por la API (`200`), CORS permite
  `http://localhost:5173` y `ecoairlines-web` compila y se sirve (`200`). Los procesos se detuvieron al terminar.

**Desviaciones y decisiones para revisar:**
- **Sin `UnitOfWork` ni repositorio genérico** (sí los tiene la plantilla): con datos en memoria no aportan nada, y un `UnitOfWork` con todas
  las tablas mezclaría otra vez los datos de los dominios (el CRITICAL de V1.A). Se propone agregarlos en V1.2 (PostgreSQL), **uno por base
  de datos**.
- **Sin interfaces de services en Business** (`IBookingService` en la plantilla): NestJS inyecta las clases directamente; agregarlas solo
  duplicaría las firmas.
- **Los tipos base del contrato** (dinero, pasajeros, itinerarios) viven en `DataAccess/src/common`, porque es la capa que todas las
  demás pueden usar. Es lo mismo que hace la plantilla con sus entidades.
- **`npm run start:dev`** ya no usa el CLI de Nest, que compila un solo proyecto. Ahora usa `tsc -b -w` + `node --watch` con
  `EcoAirlines.API/scripts/dev.mjs`.
- No se agregaron `Dockerfile` ni `docker-compose.yml` (la plantilla los trae): corresponden a V1.3, todavía sin aprobar.

**Pendiente:** auditoría de Gemini y supervisión del funcionamiento antes del commit, según el flujo de la versión 1.

### V1.D — Cambio parte 4: módulos de cliente y administrador + observabilidad — ✅ IMPLEMENTADA (05/10, commit `40cf965`)

**Origen:** pedido del supervisor. El contrato no cubre la administración ni el perfil del cliente, así que se agregan **módulos propios,
fuera del contrato**. Se toman los campos y las funciones de la plantilla del compañero (`APIVUELOSV1DIEGOCEVALLOS-main`), para tener la
misma forma cuando se integre con el booking. La observabilidad se basa en `Ejemplo 1/paginaCristianoRonaldo` y solo la ve un administrador.

**Regla para lo que no está en el contrato:** las 22 operaciones del contrato no cambian. Las rutas nuevas viven bajo `/admin/*` y
`/customers/*`, que el contrato no usa, y se documentan en un **anexo OpenAPI propio** (`contract/ecoairlines-extensions.yaml`) que Swagger
muestra aparte. `vuelos-openapi.yaml` no se toca, y la prueba de Swagger seguirá exigiendo que cada ruta del contrato exista.

#### 1. Lo que hay en la plantilla del compañero (análisis)

| Función | Endpoint de la plantilla | Campos | Observación |
|---------|--------------------------|--------|-------------|
| Login de administrador | `POST /admin/login` | Pide `email`, `password`. Devuelve `success`, `token`, `email`, `name`, `role` | Credenciales fijas en el código y token falso (`AEROCACHE-ADMIN-JWT-<guid>`) que **nadie verifica** |
| Panel de indicadores | `GET /admin/dashboard-stats` | `totalBookings`, `confirmedBookings`, `cancelledBookings`, `totalPassengers`, `totalRevenue`, `totalFlightsToday`, `routeStats[]` (`route`, `flightsCount`, `bookingsCount`, `totalRevenue`), `flightOccupancies[]` (`flightId`, `flightNumber`, `route`, `scheduledDeparture`, `status`, `totalSeats`, `bookedSeats`, `availableSeats`, `occupancyPercentage`), `recentBookings[]` (`BookingDetail` del contrato) | **Sin autenticación**: cualquiera lo consulta. Rutas y ocupación con valores fijos (150 asientos, 74 simulados) |
| Cambiar estado de un vuelo | `PUT /admin/flights/{flightNumber}/status` | Pide `status` (`SCHEDULED`, `BOARDING`, `DEPARTED`, `DELAYED`, `ARRIVED`, `CANCELLED`). Devuelve `FlightStatus` del contrato | Sin autenticación |
| Pasajeros de un vuelo | `GET /admin/flights/{flightNumber}/passengers` | Devuelve `PassengerItem[]` del contrato | Sin autenticación; asiento inventado si falta |
| Cliente: "Mis viajes" | Usa `GET /bookings?pnr=` del contrato | — | Sin token: cualquiera ve una reserva sabiendo el PNR |
| Cliente: cambiar asiento | `PUT /bookings/{bookingId}/seat` | Pide `passengerId`, `newSeatNumber`. Devuelve `bookingId`, `passengerId`, `seatNumber`, `message` | Fuera del contrato, sin autenticación |

La plantilla **no tiene un módulo de cliente propiamente dicho**: el cliente es quien compra y gestiona sus viajes. Los únicos campos de
persona que usa son los de `PassengerItem` del contrato (`firstName`, `lastName`, `documentType`, `documentNumber`, `nationality`,
`birthDate`, `gender`, `contact.email`, `contact.phone`).

#### 2. Lo que se propone implementar (mismos campos, con seguridad)

**Módulo administrador** (dominio nuevo `admin`, solo con token de administrador):

| Endpoint | Campos (iguales a la plantilla) | Cómo se calcula aquí |
|----------|----------------------------------|----------------------|
| `GET /admin/dashboard-stats` | Todos los de `AdminDashboardStatsDto` | Datos reales: reservas mediante `BookingsFacade` (nueva consulta de solo lectura de todas las reservas), ocupación con el inventario del GDS y estado de cada vuelo |
| `PUT /admin/flights/{flightNumber}/status` | `{ status }` → `FlightStatus` | El estado elegido queda como **ajuste operativo** del dominio flight-status (nueva tabla, BD futura `flight-status`). `GET /flights/{n}/status` del contrato lo respeta |
| `GET /admin/flights/{flightNumber}/passengers` | `PassengerItem[]` | Pasajeros de reservas confirmadas que vuelan ese vuelo, con su asiento real |
| `GET /admin/observability` | Ver punto 3 | Métricas del backend |

- **Login del administrador:** como hoy, lo hace `dev-auth` (no la API), con un usuario administrador de desarrollo
  (`admin@ecoairlines.test`). Su JWT lleva el scope propio **`ecoairlines:admin`** y `role: ADMIN`. La respuesta de `/login` agrega los
  campos de la plantilla (`email`, `name`, `role`), para que el frontend reconozca al administrador.
- **Sin token, la API responde `401`; con un token de cliente, `403`.** A diferencia de la plantilla, ningún dato de administración es público.

**Módulo cliente** (dominio nuevo `customers`, con el token del propio cliente):

| Endpoint | Campos | Para qué |
|----------|--------|----------|
| `GET /customers/me` / `PUT /customers/me` | Los mismos de `PassengerItem`, sin `passengerId` ni `passengerType` | Perfil del cliente (BD futura `customers`); el checkout lo usa para **autocompletar** al primer pasajero |
| `PUT /bookings/{bookingId}/seat` | Igual que la plantilla: `{ passengerId, newSeatNumber }` → `{ bookingId, passengerId, seatNumber, message }` | Cambio de asiento: libera el anterior y ocupa el nuevo en el GDS, con las mismas reglas que la reserva (cabina, ocupado, infante) |

"Mis viajes" ya existe con `GET /bookings` del contrato (con token: cada cliente ve solo lo suyo), así que no se duplica.

#### 3. Observabilidad (solo administrador)

Inspirada en el panel de Ejemplo 1 (rendimiento, errores, interacciones, entorno), en dos partes:

- **Backend:** el log de acceso que ya existe alimenta una memoria circular. `GET /admin/observability` devuelve peticiones por ruta y
  status, latencias (promedio y p95), errores 4xx/5xx recientes con su `X-Request-Id`, tiempo encendida y uso de memoria. **Nunca
  incluye** headers, bodies, tokens ni query strings, igual que el log actual.
- **Frontend:** un recolector como `CR7Observability` (tiempos de carga, errores de JS y promesas, recursos que fallan, clics y visibilidad
  de la pestaña), guardado **solo en el navegador** (`localStorage`). No se envía a ningún servidor.
- **Página `/admin/observabilidad`** en `ecoairlines-web`, solo para administradores. Muestra ambas partes y tiene los botones de Ejemplo 1
  (actualizar, evento de prueba, descargar el JSON y limpiar).

#### 4. Encaje en las 4 capas y en la división de datos

- **Dominios nuevos:** `admin` (sin datos propios: consulta los de otros dominios por su API pública) y `customers` (BD futura `customers`).
  flight-status pasa a tener datos propios (los ajustes operativos).
- **Dependencias nuevas entre dominios**, que la prueba de arquitectura documentará: `admin → bookings`, `admin → flight-status`.
- **Frontend:** página de administración (indicadores, vuelos con cambio de estado, pasajeros, observabilidad), perfil del cliente y
  botón "Cambiar asiento" en el detalle de la reserva.
- **Pruebas:** e2e de los endpoints nuevos (sin token `401`, token de cliente `403`, administrador `200`), cambio de asiento y prueba de
  que las 22 operaciones del contrato siguen cumpliendo sus schemas.

**Decisiones del supervisor (05/10):** ✅ aprobada. Módulo cliente = **perfil + cambio de asiento**. Las rutas propias quedan
registradas en HALLAZGOS (**EXT-01 a EXT-03**), para acordarlas con el líder de booking antes de la integración (RDA2).

#### 5. Resultado de la implementación (05/10) — ✅ IMPLEMENTADA (commit `40cf965`)

**Backend, capa por capa:**
- **DataAccess:**
  - Entidades `CustomerProfileRecord` y `FlightStatusOverride`, con contextos de datos `customers` y `flight-status` (BD futuras).
  - El GDS simulado agrega consultas operativas de solo lectura: vuelos de una fecha, "hoy" en el origen y ocupación por vuelo.
- **DataManagement:**
  - Repositorios de perfiles y de ajustes operativos.
  - `findAll` en el repositorio de reservas.
  - Gateway `FlightOperationsGateway` (vuelos del día, rutas de la red y `segmentId` de un vuelo).
- **Business:**
  - `CustomerProfileService` (dominio customers).
  - `SeatChangeService` (dominio bookings: ocupa el nuevo asiento antes de liberar el anterior, con las mismas reglas que la reserva).
  - `AdminService` (dominio admin, sin datos propios).
  - `FlightStatusService` ahora aplica el ajuste del administrador y lo registra.
  - `BookingsFacade.listAll()` (copias de solo lectura).
  - Check-in muestra en el pase el asiento vigente de la reserva.
- **API:**
  - Controllers `AdminController`, `ObservabilityController`, `CustomerProfileController` y `SeatChangeController`.
  - Scopes propios `ecoairlines:admin` y `ecoairlines:profile`.
  - Métricas HTTP (`HttpMetricsStore` + middleware): guardan el patrón de la ruta, nunca la URL real.
  - CORS permite `PUT`.
  - Swagger con selector entre el contrato y el anexo `contract/ecoairlines-extensions.yaml`.
- **dev-auth:**
  - Administrador de desarrollo `admin@ecoairlines.test` / `EcoAdmin2026`, con `role: ADMIN` y scopes `flights:read flights:webhooks ecoairlines:admin`.
  - Los clientes reciben además `ecoairlines:profile`.
  - Nadie puede registrarse como administrador.
  - `npm run token` incluye los scopes propios.

**Frontend (`ecoairlines-web`):**
- **Sesión con rol:** la sesión conoce el rol (`isAdmin`). `RequireAdmin` protege `/admin` y `/admin/observabilidad`, y el administrador ve su propio menú.
- **Mi perfil (`/mi-perfil`):** autocompleta al primer pasajero en el checkout.
- **Cambiar asiento:** nueva pestaña en el detalle de la reserva.
- **Panel de administración:** indicadores; vuelos de hoy con su ocupación, cambio de estado y pasajeros; rutas; reservas recientes.
- **Observabilidad:**
  - Métricas del backend.
  - Panel del navegador con las secciones de Ejemplo 1: rendimiento, errores JS y de promesas, recursos, clics, visibilidad y JSON.
  - Botones de Ejemplo 1: actualizar, evento de demostración, descargar JSON y limpiar.
  - El recolector (`lib/observability.ts`) guarda solo en `localStorage` y nunca registra el valor de los campos.

**Verificación (05/10):**
- Tipos ✅, lint ✅ (backend y frontend), build ✅ (solución y frontend).
- Unitarias **136/136** ✅: 133 previas + 3 del almacén de métricas.
- e2e **113/113** ✅: 96 previas + 3 de Swagger + 14 de extensiones.
  - Las 22 operaciones del contrato siguen validándose contra sus schemas.
  - Cada respuesta nueva se valida contra el anexo OpenAPI.
  - Toda ruta fuera del contrato debe estar documentada en el anexo, y el anexo no puede redefinir operaciones del contrato.
- **e2e de extensiones:**
  - Permisos: sin token 401, token de cliente 403, administrador 200.
  - Indicadores y pasajeros reflejan una reserva real.
  - El estado fijado por el administrador sale en `GET /flights/{n}/status` del contrato, y DEPARTED guarda la hora real.
  - Perfil: 404 antes de guardarlo, aislado por cliente y con validación de campos.
  - Cambio de asiento: libera el anterior; 409 si está ocupado o es de otra cabina, 422 si es de un infante, 404 si la reserva es ajena; el pase de abordar se actualiza.
  - La observabilidad no contiene PNR, tokens ni ids en las rutas.
- **Prueba de arquitectura:** dominios `customers` y `admin`, y dependencias nuevas `admin → bookings` y `admin → flight-status`, solo por API pública.
- **Procesos reales:**
  - El login de dev-auth devuelve `role` y los scopes de cada rol.
  - Panel: administrador `200`, cliente `403`, sin token `401`.
  - Perfil: el cliente lo guarda (`PUT 200`); el administrador sin ese scope recibe `403`.
  - Preflight CORS de `PUT` permitido; `/docs/extensions.json` `200`.
  - Las páginas `/admin`, `/admin/observabilidad` y `/mi-perfil` se sirven correctamente.
  - Los procesos se detuvieron al terminar.

**Desviaciones respecto a la plantilla (para revisar):**
- **Sin `POST /admin/login` en la API:** el login lo hace el servidor de autenticación (como en el resto del proyecto). La respuesta de
  `/login` incluye los campos de la plantilla (`name`, `email`, `role`) y el `access_token`, que reemplaza a su `token`.
- `PUT /admin/flights/{n}/status` y `GET /admin/flights/{n}/passengers` aceptan `?date=` (opcional, por defecto hoy en el origen),
  porque aquí cada número de vuelo opera a diario.
- `ChangeSeatRequest` agrega `segmentId` (opcional), necesario cuando la reserva tiene varios vuelos; la respuesta agrega `segmentId`.
- `scheduledDeparture` va en ISO 8601 con desfase (como el resto del contrato) y no en `dd/MM/yyyy HH:mm`.
- Los importes del panel (`totalRevenue`) son números, como en la plantilla; los del contrato siguen siendo strings decimales.

---

### V1.E — Cambio parte 5: correcciones del frontend, horario de 91 días y horario de la flota — ✅ IMPLEMENTADA (06/10, commit `b41b828`)

**Origen:** revisión del supervisor (06/10), con capturas.

**1. Correcciones del frontend (`ecoairlines-web`):**
- **Selector de pasajeros tapado:** el bloque verde del inicio (`.hero`) tenía `overflow: hidden` y recortaba el desplegable, así que
  solo se veía "Adultos". Ahora no recorta (el fondo SVG se recorta solo) y queda por encima de la sección siguiente.
- **Espacio excesivo en el login:** `.field` tiene `flex: 1 1 160px` para las filas del buscador; dentro de un contenedor en columna
  (login, paneles de la reserva), esos 160 px se volvían altura. Ahí ahora usa `flex: 0 0 auto`.
- **Fecha por defecto:**
  - La ida es **hoy** (antes hoy + 7), la vuelta hoy + 7 y el segundo tramo de multidestino hoy + 7.
  - Si la ida pasa a ser posterior a la vuelta, la vuelta se mueve sola.
  - Los calendarios no permiten fechas después de los 91 días publicados.
- **Login del administrador:** entraba al inicio en vez de `/admin`, por una carrera entre la redirección del login y la del rol.
  Ahora la página redirige según el rol.

**2. Horario generado (`EcoAirlines.DataAccess/src/seed/timetable.ts`), con las pautas del supervisor:**
- **Rutas:** directas **todos con todos** entre los 10 aeropuertos (90 rutas). Elección del supervisor: todos con todos.
- **2 vuelos diarios por ruta y sentido:** una ola de mañana (06:00–08:00) y una de noche (19:00–21:00), en hora local del origen.
  Cada destino sale 15 min después del anterior; por ejemplo, Quito → Lima a las 07:00 y a las 20:00. Son 180 vuelos por día.
- **Horario por día de la semana:** cada vuelo declara los días que opera. Hoy todos operan los 7 días, pero la estructura admite un
  horario distinto para cada día, que se repite cada semana.
- **Ventana de venta de 91 días exactos (13 semanas, múltiplo de 7):**
  - Se reserva desde hoy hasta hoy + 90.
  - Cada día que pasa entra uno nuevo con el horario de su día de la semana; por ejemplo, el martes de la semana 13 repite el horario
    de hoy martes.
  - Fuera de la ventana, la búsqueda no devuelve vuelos y el hold no se acepta.
  - Elección del supervisor: 91 días.
- **Avión según la distancia:** A220-300 (< 1 500 km), A320neo (< 4 500 km) o 787-9.
- **Números de vuelo:** cambian. `EA` + (100 + 20 × origen + 2 × destino + ola) da EA100–EA297; Quito → Bogotá es EA104 y EA105.
  La red anterior (EA200–EA503, fija en `network.ts`) se eliminó.

**3. Plan de flota (`EcoAirlines.DataAccess/src/external/gds/fleet-planner.ts`):**
- **Cómo se calcula:**
  - En cada aeropuerto y tipo de avión, el avión que queda listo (llegada + tiempo en tierra de 35, 45 o 90 min) toma la siguiente
    salida, en orden de llegada, sobre una semana que se repite.
  - Las cadenas resultantes forman ciclos. Un ciclo de `m` semanas necesita `m` aviones, así que **se agregan los aviones que hagan
    falta**: hoy son 100 (26 A220, 42 A320neo y 32 787-9).
  - Por construcción, **ningún avión está en dos lugares a la vez**.
- Un primer intento con simulación semanal no se estabilizaba (los aviones intercambiaban vuelos cada semana); se reemplazó por este
  método exacto.
- **Extensión `GET /admin/fleet-schedule?date=`:**
  - Devuelve cada avión con los vuelos que opera ese día.
  - Solo para administradores; más allá de los 91 días responde `400`.
  - Está documentada en el anexo `contract/ecoairlines-extensions.yaml`.
- **En la página de observabilidad:** nueva sección "Horario de la flota", con calendario, buscador por avión, vuelo o aeropuerto,
  resumen por tipo de avión y los vuelos de cada avión en orden.

**Verificación (06/10):**
- Tipos ✅, lint ✅ (backend y frontend), build ✅.
- Unitarias **143/143** ✅, incluidas las nuevas:
  - El plan de flota se valida durante **98 días seguidos**: cada vuelo tiene avión del tipo correcto, cada avión sale del aeropuerto
    donde aterrizó y después de su tiempo en tierra, y todos los aviones vuelan.
  - Se validan la ventana de 91 días y la repetición por día de la semana.
- e2e **115/115** ✅, con la conformidad con el contrato y 2 nuevas del horario de la flota.
- **Navegador (Edge headless, capturas):**
  - El selector de pasajeros muestra los 4 tipos sin cortarse.
  - El login quedó sin espacios vacíos.
  - El buscador propone hoy y hoy + 7, con máximo hoy + 90.
  - El administrador entra a `/admin` y ve el horario de los 100 aviones.
- **API real:**
  - Una búsqueda para hoy devuelve solo los vuelos que aún no salen.
  - El día 91 tiene vuelos y el 92 no.

**Para revisar:**
- Con rutas directas todos con todos, las conexiones siguen apareciendo, pero después de los 2 vuelos directos.
- Rutas largas sin escala (por ejemplo Cuenca → Madrid o Santiago → Madrid) existen solo porque se pidieron todos con todos.
  Comercialmente se podrían limitar.

### V1.F — Cambio parte 6: asientos vacíos, 3 clientes, horarios variados y filtro por aeropuerto — ✅ IMPLEMENTADA (06/10, commit `b41b828`)

**Origen:** pedido del supervisor (06/10). Reemplaza parte de V1.E: las olas fijas de horario y la flota de 100 aviones.

**1. Asientos sin "clientes fantasma":**
- Antes, cada vuelo nacía con un 35–74 % de asientos ocupados por pasajeros simulados.
- Ahora **los vuelos empiezan vacíos**. Solo los que salen en los **7 días siguientes al arranque de la API** tienen una ocupación
  moderada (20–49 %), para observar el mapa de asientos funcionando.
- El corte se fija al primer uso, así que un vuelo vacío **no se llena solo con el paso de los días**. Eso evitaría que un pasajero
  simulado "tome" un asiento que ya eligió un cliente real.

**2. Tres clientes de prueba** (en `dev-auth`):
- `demo@ecoairlines.test` / `EcoDemo2026` (existente).
- `maria@ecoairlines.test` / `EcoMaria2026` (María Torres).
- `luis@ecoairlines.test` / `EcoLuis2026` (Luis Andrade).
- Los tres son CUSTOMER. Se actualizaron el aviso de la página de login y los README.

**3. Horarios más variados** (`timetable.ts`):
- Las 2 olas fijas (06:00–08:00 y 19:00–21:00) se reemplazan por **2 franjas**: mañana (06:00–11:45) y tarde/noche (13:00–21:30).
- Cada franja tiene una lista de horas, y cada ruta toma una hora distinta de cada una, rotando según el aeropuerto de origen. Así hay
  salidas a lo largo de todo el día (11:00, 13:45, 14:30, 15:15, 16:00…) y **ningún aeropuerto repite hora**.
- Ejemplos desde Quito:
  - Bogotá: 07:30 y 14:30.
  - Lima: 09:00 y 16:00.
  - México: 11:00 y 19:30.
- **Flota recalculada:** 97 aviones (19 A220, 40 A320neo y 38 787-9). Sigue validada: ningún avión vuela a dos lugares a la vez.

**4. Filtro por aeropuerto en Observabilidad** (sección "Horario de la flota"):
- Nuevo selector de **aeropuerto** y de qué ver: **llegadas (destino)** por defecto, salidas o ambas.
- Muestra el resumen del aeropuerto (llegadas, salidas y aviones que pasan) y un **tablero ordenado por hora local**.
  - En las llegadas indica el origen y la hora de salida; en las salidas, el destino y la hora de llegada.
  - El tablero también indica el avión de cada vuelo.
  - La tabla de aviones se limita a los que tocan ese aeropuerto.
- El horario es **por fecha de salida**: los vuelos largos que salen ese día aparecen como llegadas de la madrugada siguiente, con
  la fecha indicada.

**Verificación (06/10):**
- Tipos ✅, lint ✅, build ✅.
- Unitarias **145/145** ✅ (+2 de ocupación simulada); e2e **115/115** ✅.
  - La prueba de "asiento ocupado" ahora usa el asiento de otro cliente, no el de un pasajero simulado.
- **API real:**
  - Un vuelo de dentro de 2 días tiene 50 de 122 asientos ocupados; uno de dentro de 30 días, 0.
  - Los 3 clientes inician sesión y sus tokens funcionan en la API.
- **Navegador:** con el administrador, el filtro Madrid → llegadas muestra sus 18 llegadas del día con origen y avión.
- **Nota:** en el puerto 4000 quedó corriendo un `dev-auth` anterior (PID 27468, iniciado a las 13:00 del 06/10), que no detuve por
  no tener certeza de su origen. Hasta reiniciarlo, ese proceso no reconoce a los dos clientes nuevos.

### V1.G — Cambio parte 7: panel admin por fecha, origen o ruta — ✅ IMPLEMENTADA (06/10, commit `b41b828`)

**Origen:** pedido del supervisor (06/10). Que el administrador vea cómo se reservan los asientos de los vuelos de cualquier día, por
punto de origen o por ruta. Por defecto, el día en que abre el panel.

**Backend:**
- **Nueva extensión `GET /admin/flights?date=&origin=&destination=`** (scope `ecoairlines:admin`):
  - Devuelve la ocupación de los vuelos de una fecha (por defecto hoy, en Quito).
  - Con `origin`, solo los que salen de ese aeropuerto; con `origin` y `destination`, los de esa ruta.
  - Valida los códigos IATA y responde `400` más allá de los 91 días publicados.
  - Documentada en el anexo OpenAPI.
- **`FlightOccupancy`** conserva los campos de la plantilla y agrega:
  - `date`: fecha local del vuelo.
  - `reservedSeats`: asientos tomados por clientes de EcoAirlines (holds vigentes + reservas).
  - `simulatedSeats`: pasajeros simulados de la primera semana.
  - Se cumple `bookedSeats = reservedSeats + simulatedSeats`.
- `GET /admin/dashboard-stats` reutiliza la misma consulta para "vuelos de hoy".

**Frontend:**
- La pestaña "Vuelos de hoy" pasa a ser **"Vuelos y asientos"** (`AdminFlightsPanel`), con filtros de **fecha** (hoy por defecto, hasta
  hoy + 90), **origen**, **destino (ruta)** y número de vuelo, más un botón "Hoy, todos".
- Resumen de la selección: vuelos, asientos tomados por clientes, simulados, libres y ocupación.
- En la tabla, las columnas "Clientes" y "Simulados" y los vuelos con clientes resaltados.
- El cambio de estado y la lista de pasajeros usan la fecha del vuelo elegido, no siempre hoy.

**Incidente durante la implementación:**
- Al agregar la ruta al anexo, un reemplazo de texto en Node interpretó la secuencia `$'` del patrón `'^[A-Z]{3}$'` como "texto
  después de la coincidencia" y duplicó partes del YAML.
- Se reconstruyó desde el último commit y se reaplicaron los cambios de V1.E y V1.G con inserciones literales. El diff final contiene
  solo lo agregado.

**Verificación (06/10):**
- Tipos ✅, lint ✅, build ✅.
- e2e **118/118** ✅ (+3), que comprueban:
  - por defecto, los 180 vuelos de hoy, con `bookedSeats = reservedSeats + simulatedSeats`;
  - filtro por origen (18 vuelos) y por ruta (2), y que una reserva a 40 días se refleja en su vuelo;
  - códigos y fechas inválidos (`400`) y token de cliente (`403`).
- **Navegador con datos reales:**
  - El administrador abre el panel en "hoy, todos los vuelos".
  - Al elegir 26/10 y Quito → Bogotá ve los 2 vuelos; el vuelo reservado aparece resaltado.
  - "Ver" muestra los pasajeros con su asiento.

### V1.H — Cambio parte 8: horario semanal fijo por avión — ✅ IMPLEMENTADA (06/10, commit `b41b828`)

**Origen:** pedido del supervisor (06/10). Los vuelos se repetían cada semana, pero no el avión que los operaba. Ejemplo:
- HC-W01 operaba EA116 UIO → MAD el martes 6/10 y EA216 LIM → MAD el martes 13/10.
- Se pidió un estándar: el mismo día de la semana, el mismo avión hace los mismos vuelos durante las 13 semanas. Además, que una ruta
  nueva se pueda crear con solo origen, destino, día y avión.

**Diseño (`EcoAirlines.DataAccess/src/seed/timetable.ts`, reescrito):**
- **`TimetableBuilder`**:
  - `addAircraft(tipo, base)` da de alta un avión y devuelve su matrícula.
  - `addFlight({ flightNumber, origin, destination, weekday, departureLocal, registration })` agrega un vuelo de un día de la
    semana con su avión. Rechaza aviones inexistentes, rutas inválidas, números de vuelo con otra ruta u hora y un vuelo con dos aviones el mismo día.
  - `build()` valida las rotaciones y lanza "Horario inválido" si algo falla.
- **`validateRotations`** recorre la semana de cada avión como un ciclo: cada vuelo sale de donde aterrizó el anterior, después
  del tiempo en tierra, y el último de la semana deja al avión listo para el primero de la siguiente.
- **Generación automática** con el mismo builder: por cada par de ciudades hay dos líneas de ida y vuelta (una con base en cada
  ciudad). Cada avión hace la ida y su vuelta; en las rutas largas se usan varios aviones que se alternan los días.
- `fleet-planner.ts` queda como una consulta del horario: la matrícula depende solo del número de vuelo y del día de la semana.
- Se mantienen 180 vuelos diarios, todos con todos, 2 por ruta, 7 días.

**Contrapartida:** la flota pasa de 97 a **149 aviones** (26 A220, 56 A320neo y 67 787-9). Cada línea tiene aviones dedicados
que vuelven a su base, en lugar de encadenar vuelos libremente.

**Frontend:** el horario de la flota vuelve a mostrar la base de cada avión y explica el horario semanal fijo.

**Verificación (06/10):**
- Tipos ✅, lint ✅, build ✅.
- Unitarias **147/147** ✅, que comprueban:
  - el mismo avión el mismo día de la semana durante 13 semanas;
  - ningún avión en dos lugares durante 98 días y que todos los aviones vuelan;
  - que el builder acepta una ruta nueva válida y rechaza superposiciones o aviones que no vuelven a su base.
- e2e **118/118** ✅.
- **API real:** HC-W01 (base UIO) hace EA281 MAD → UIO los martes 6/10, 13/10 y 29/12, y EA116 UIO → MAD los miércoles. HC-J01
  hace EA100 UIO → GYE 06:00 y EA121 GYE → UIO 14:30 todos los días.

### V1.I — Cambio parte 9: asientos y equipaje del grupo en un solo panel — ✅ IMPLEMENTADA (06/10, commit `b41b828`)

**Origen:** pedido del supervisor (06/10), con Avianca como referencia. Con varios pasajeros, elegir asientos y maletas era
incómodo: cada pasajero tenía su propio mapa y sus propios selectores dentro de su formulario.

**Frontend (solo checkout; no cambia la API ni el contrato):**
- **`pages/checkout/SeatSelectionPanel.tsx`** — "Selección de asientos":
  - una pestaña por tramo, con ✓ cuando todos tienen asiento;
  - la lista de pasajeros a la izquierda (asiento, "Quitar") y el mapa a la derecha;
  - se elige al pasajero y con un clic queda su asiento; luego pasa solo al siguiente sin asiento;
  - en el mapa, los asientos del grupo muestran las iniciales del acompañante y al tocarlos se cambia a ese pasajero;
  - botón "Siguiente tramo".
- **`pages/checkout/BaggageSelectionPanel.tsx`** — "Equipaje adicional":
  - una pestaña por vuelo, los pasajeros con lo que suma cada uno y un contador − / + (máximo 3 por vuelo);
  - lo que incluye la tarifa (artículo personal, mano y bodega, o "no incluido");
  - "Mismo equipaje para todos los vuelos" y el total de todos los vuelos.
- `SeatMapPicker` acepta `companions`, `onCompanionClick` y `showSummary` (opcionales). El cambio de asiento de
  "Mis viajes" sigue igual.
- `CheckoutPage` quita los extras de cada pasajero. El cuerpo de `POST /bookings` (`assignedSeats`, `extraBaggage`) no cambia.

**Verificación (06/10):**
- Lint ✅, build ✅.
- **Navegador con la API real** (3 adultos, UIO ⇄ GYE):
  - 3 clics en el mapa asignan 4E, 5A y 5D a cada pasajero en orden;
  - 2 + 1 maletas suman $105; con "Mismo equipaje para todos los vuelos" suman $210, y el total a pagar se actualiza;
  - la vista móvil (390 px) apila la lista y el detalle sin desbordes.

### V1.J — Cambio parte 10: documento único, edad según el tipo y columna de maletas — ✅ IMPLEMENTADA (06/10, commit `b41b828`)

**Origen:** pedido del supervisor (06/10). Al reservar 5 pasajeros LIM → BOG, se aceptaron:
- la misma cédula 5 veces;
- adultos nacidos este año.

Además, en "Mis viajes" la columna "Maletas extra" mostraba un número que se confundía con el total de maletas.

**Backend** (`EcoAirlines.Business/src/rules/bookings/passenger-identity-rules.ts` y `BookingsService.create`):
- **Edad según el tipo**, medida el día del primer vuelo:
  - adulto 15+, joven 12–14, niño 2–11;
  - el infante debe seguir teniendo menos de 2 años el día del último vuelo;
  - la fecha de nacimiento no puede ser posterior al viaje.
- **Documento:**
  - de 5 a 20 letras o dígitos (se ignoran espacios, puntos y guiones);
  - la cédula ecuatoriana (`NATIONAL_ID` + `EC`) se valida con su dígito verificador (módulo 10);
  - no puede vencer antes del último vuelo.
- **Documento único:**
  - no se repite dentro de la reserva (país + número); los nombres sí pueden repetirse (gemelos);
  - la misma persona tampoco puede estar en otra reserva activa del mismo vuelo; las reservas canceladas o fallidas no cuentan.
- Todo responde `422 VALIDATION_FAILED` con el campo en `invalidParams`, sin consumir el hold ni verificar el pago. Ver HALLAZGOS EXT-04.

**Frontend:**
- El checkout aplica las mismas reglas (`lib/passenger-validation.ts`):
  - el error aparece bajo el campo ("Este documento ya lo tiene el pasajero 1.", "Tendrá 0 años el día del vuelo…");
  - el calendario de nacimiento limita las fechas al rango de cada tipo, y la etiqueta lo dice ("15 años o más");
  - no deja pagar mientras haya errores.
- En el detalle de la reserva, la columna pasa a **"Maletas (Extra)"** con el formato `total (extra)`: las incluidas en la tarifa de cada
  vuelo más las extra pagadas. Por ejemplo, 2 incluidas + 2 extra = `4 (2)`. El infante muestra "—".

**Pruebas:**
- El helper de e2e genera un documento único por pasajero y una fecha de nacimiento acorde a su tipo.

**Verificación (06/10):**
- Tipos ✅, lint ✅ (API y web), build ✅.
- Unitarias **161/161** ✅, 14 de ellas de las reglas nuevas.
- e2e **120/120** ✅, 2 nuevas:
  - documento repetido, cédula inválida y adulto recién nacido responden 422; gemelos con distinto documento, 201;
  - la misma persona en otra reserva del mismo vuelo responde 422, y tras cancelar la primera ya puede reservar.
- **Navegador:** 2 adultos con la cédula 1350519375 y uno nacido el 01/01/2026. Aparecen los dos errores bajo los campos y el
  calendario limita a los adultos hasta el 20/10/2011.

### V1.K — Cambio parte 11: CRUD de rutas, eventos (SOA/EDA) y documentación técnica — ✅ IMPLEMENTADA (06/10, commit `b41b828`)

**Origen:** pedido del supervisor (06/10), a partir de `CRITERIOS.md`. Hay que cerrar los criterios 2 (CRUD de administración), 8 (eventos)
y 9 (documentación: arquitectura y modelo de datos).

**1. CRUD de rutas programadas (criterio 2):**
- **Horario:**
  - `timetable.ts` arma el horario a partir de **rutas programadas** (`RouteDefinition`: ida y vuelta, días y tipo de avión);
  - `generateRoutes()` crea la red base de 90 rutas;
  - `buildTimetable(routes)` asigna los aviones con `TimetableBuilder` y lanza `TimetableError` si hay conflictos.
- **GDS:** cada instancia guarda su propio horario (antes era una constante global) y `publishRoutes` lo reemplaza. Así, cada prueba
  e2e arranca con el horario base.
- **Datos:**
  - `AdminDataContext` (futura base `schedule`, tabla `scheduled_routes`) y `ScheduledRouteRepository`;
  - `FlightOperationsGateway` suma `publishRoutes`, `aircraftByRoute` y `customerSeatsOn`.
- **`AdminRoutesService`:**
  - valida aeropuertos, alcance del avión (`422`) y vuelos duplicados (`409`);
  - rechaza editar o borrar rutas con cupos vendidos o retenidos (`409`);
  - publica el horario completo en el GDS (`422` si no se puede operar), y solo entonces guarda la ruta.
  - Los números nuevos van desde EA300.
- **Endpoints** (extensión, `ecoairlines:admin`): `GET/POST /admin/routes`, `GET/PUT/DELETE /admin/routes/{routeId}`, documentados en el anexo.
- **Web:** pestaña "Rutas programadas" (`RoutesPanel`):
  - filtro por aeropuerto y formulario con origen, destino, horas, días y avión (automático o elegido);
  - las rutas creadas aparecen primero;
  - "Editar" y "Dar de baja" se deshabilitan si la ruta tiene pasajeros.
  - La pestaña anterior "Rutas" pasa a llamarse "Ventas por ruta".

**2. Eventos de dominio y webhooks (criterio 8):**
- **Bus interno** `DomainEventBus` (código compartido de Business):
  - `publish` / `subscribe`;
  - los consumidores corren después de responder y un fallo no rompe la operación;
  - historial de los últimos 100 eventos con sus entregas.
- **Publicadores (9 eventos del contrato):**
  - `booking.confirmed`, `booking.ticket_issuing`, `booking.ticket_issued` (al crear la reserva o al confirmar un pago pendiente);
  - `booking.changed` (cambio de fecha o de asiento), `booking.baggage_added`, `booking.cancelled` (con `refundAmount`), `booking.checked_in`;
  - `flight.cancelled` y `flight.schedule_changed` (estado de vuelo fijado por el administrador y CRUD de rutas).
- **Dueño de la reserva:** `BookingsFacade.eventSubject` lo entrega solo para publicar. El snapshot de la reserva sigue sin `ownerId`,
  como exige su prueba.
- **`WebhookDeliveryService`:**
  - escucha el bus;
  - entrega los `booking.*` solo a las suscripciones del dueño y los `flight.*` a todas;
  - repite la política anti-SSRF antes de enviar.
- **`HttpWebhookDispatcherGateway`:**
  - POST con `X-EcoAirlines-Event`, `X-EcoAirlines-Delivery` y `X-EcoAirlines-Signature` (`t=…,v1=HMAC-SHA256(secret, "t.cuerpo")`);
  - 3 intentos ante red, `429` o `5xx`;
  - 5 s por intento, sin seguir redirecciones.
- **Variable `WEBHOOK_DELIVERY`:** `http` o `log`. Por defecto, `log` en pruebas; se valida al arrancar.
- **Panel:** `GET /admin/events` (extensión) y la sección "Eventos de dominio y webhooks" en Observabilidad.
- **Corrección OBS-1:** la URL de un webhook debe ser `http(s)://` en todos los entornos (`400`). Antes, en desarrollo, se aceptaba
  `no-es-url`.

**3. Documentación (criterio 9):**
- **`ARQUITECTURA.md`:**
  - componentes, capas y dominios, secuencia de la compra, rutas programadas, eventos y seguridad;
  - **modelo de datos** entidad-relación con 9 bases por dominio.
  - Son 6 diagramas Mermaid.
- **`EVENTOS.md`:**
  - catálogo de los 12 eventos (productor, momento, datos, consumidores, estado), formato, firma con código de verificación,
    reintentos, cómo probarlo y evolución (*outbox*, broker, microservicios);
  - 2 diagramas.
- **`AUDITORIA.md`:** se marca como histórica, con una tabla del estado real de cada hallazgo. El HIGH (V1.B) sigue pendiente.
- **Otros documentos actualizados:** `CRITERIOS.md` (2, 8 y 9 pasan a ✅), `README.md`, `EcoAirlines.API/README.md`, `HALLAZGOS.md`
  EXT-01 y `PRUEBASSW.md`.

**Verificación (06/10):**
- Tipos ✅, lint ✅ (API y web), build ✅.
- Unitarias **168/168** ✅. Las nuevas cubren:
  - rutas programadas en `fleet-planner.spec.ts`;
  - el bus de eventos (orden, aislamiento de un consumidor que falla, historial).
- e2e **130/130** ✅. Las nuevas son:
  - `admin-routes.e2e-spec.ts`: búsqueda, flota y estado de vuelo ven la ruta nueva; validaciones `400`/`409`/`422`; edición; baja;
    bloqueo con pasajeros;
  - `events.e2e-spec.ts`: un suscriptor local verifica la firma HMAC, el filtrado por dueño, `flight.*` a todos, 3 reintentos ante
    `503`, `/admin/events` y la URL sin esquema.
- **Los 8 diagramas Mermaid** se dibujaron sin errores con mermaid 11.
- **Navegador con la pila completa:**
  - se creó la ruta GYE ⇄ MDE (EA300/EA301, avión HC-J27) y quedó primera en la lista;
  - un A220 a Madrid muestra el error de alcance;
  - una reserva, su cancelación y un vuelo cancelado llegaron a un suscriptor externo (4 eventos `DELIVERED`, firma
    `t=…,v1=…`) y aparecen en Observabilidad.

**Pendiente:**
- Base de datos real (criterio 5): las rutas y los webhooks siguen en memoria.
- Despliegue (criterio 1).
- Eventos `hold.expired`, `booking.failed` y `booking.ticket_failed`: diseñados en `EVENTOS.md`.

### V1.L — Cambio parte 12: dev-auth desde Swagger y CRUD de la flota — ✅ IMPLEMENTADA (06/10, commit `b41b828`)

**Origen:** preguntas del supervisor (06/10):
- dónde se guardan los clientes;
- por qué no se pueden crear desde Swagger;
- cómo darse permisos en Swagger;
- si se deben poder agregar aviones.

Se decidió:
- **Swagger:** puede llamar a dev-auth sin que la API gane lógica de autenticación.
- **Flota:** CRUD de aviones.
- **Tipos de avión:** solo consulta, porque definen el mapa de asientos.

**1. dev-auth en Swagger (solo desarrollo):**
- `dev-auth/openapi.yaml` documenta `POST /register`, `POST /login` y `GET /health`, con ejemplos: cliente, administrador y contraseña
  incorrecta.
- La API lo publica como tercer documento del selector (`/docs/dev-auth.json`), con `servers` = `DEV_AUTH_URL` (por defecto
  `http://localhost:4000`). En producción no se publica.
- "Try it out" llama directamente a dev-auth desde el navegador:
  - el CORS de dev-auth admite por defecto `http://localhost:3000`;
  - la CSP de `/docs` agrega `connect-src` a dev-auth fuera de producción.
- **La API no gana rutas ni lógica de autenticación**: el contrato delega el registro y el login a un servidor OAuth2 externo.

**2. CRUD de la flota:**
- **Horario** (`timetable.ts`):
  - `buildTimetable(routes, fleet)` recibe la flota registrada;
  - una ruta puede indicar `aircraft` (sus aviones, en orden), que deben ser del tipo de la ruta, tener base en el origen y alcanzar
    para los días (si no, `TimetableError` dice cuántos hacen falta);
  - con `autoAddAircraft` agrega los que falten;
  - un avión sin vuelos ya no es error: queda disponible;
  - las matrículas nuevas no repiten las existentes.
  - El reparto de días se separó en `planRoundTrips` (cuántos aviones hacen falta) y `assignRoundTrips` (con cuáles).
  - Se exportan `AIRCRAFT_MAX_ROUTE_KM` y `REGISTRATION_PREFIX`.
- **Datos:**
  - `AdminDataContext.aircraft` (futura tabla `aircraft`) y `AircraftRepository`;
  - las rutas guardan sus aviones (`ScheduledRouteRecord.aircraft`, futura tabla `route_aircraft`);
  - la red base arranca con sus 149 aviones y las rutas con sus aviones fijos. La reconstrucción da el mismo horario: hay una prueba
    que lo comprueba.
- **`SchedulePublisher`:** publica en el GDS rutas y flota en cada cambio (`422` si no se puede operar) y guarda en la flota los aviones
  que el horario agregó solos.
- **`AdminFleetService`:**
  - `GET /admin/aircraft-types` (asientos por cabina, alcance, tiempo en tierra, cuántos hay);
  - `GET/POST /admin/aircraft`: la matrícula es la siguiente libre del tipo, p. ej. HC-J27;
  - `GET/PUT/DELETE /admin/aircraft/{registration}`: cambiar base o retirar, solo si no opera rutas (`409`).
- **Rutas** (`POST/PUT /admin/routes`) aceptan `aircraft` (matrículas):
  - el tipo se deduce del primer avión si no se indica;
  - al editar sin elegir, se conservan los aviones que siguen sirviendo y se agregan los que falten.
- **Web:**
  - pestaña **"Flota"** (`FleetPanel`): tarjetas por tipo, registro, filtros por base y tipo, "solo disponibles", cambiar base y
    retirar (deshabilitado si el avión opera rutas);
  - en "Rutas programadas", el formulario muestra los aviones del tipo con base en el origen y su estado (disponible, N rutas,
    esta ruta) para elegirlos;
  - si no se elige ninguno, se asignan solos.
- **Documentación:** anexo OpenAPI (rutas nuevas, schemas `Aircraft`, `AircraftTypeInfo`, campo `aircraft`), `ARQUITECTURA.md` (tablas
  AIRCRAFT y ROUTE_AIRCRAFT), `CRITERIOS.md`, `PRUEBASSW.md` (token desde dev-auth en Swagger y casos de flota), `HALLAZGOS.md` EXT-01 y
  `EcoAirlines.API/README.md`.

**Verificación (06/10):**
- Tipos ✅, lint ✅ (API y web), build ✅.
- Unitarias **173/173** ✅. Las 5 nuevas cubren:
  - la red base reconstruida es idéntica;
  - avión elegido y avión libre;
  - avión compartido entre dos rutas (válido si encaja, `TimetableError` si se superpone);
  - aviones insuficientes, de otra base, de otro tipo o inexistentes;
  - matrículas sin repetir.
- e2e **137/137** ✅, con 7 nuevas:
  - `admin-fleet.e2e-spec.ts` (5): tipos y flota base; alta con HC-N57; ruta con el avión elegido; bloqueos `409`; errores `422`; aviones
    automáticos;
  - `swagger.e2e-spec.ts` (2): el documento de dev-auth y la CSP en desarrollo, y su ausencia en producción.
- Diagramas Mermaid: 8/8 se dibujan.
- **Navegador:**
  - desde Swagger, `POST /login` de dev-auth respondió `200` con el token, y con contraseña incorrecta `401`;
  - en el panel se registró HC-J27 (A220, UIO) y se creó UIO ⇄ CUE eligiéndolo: "Ruta creada… con HC-J27".

### V1.M — Cambio parte 13: PostgreSQL y preparación para Azure — ✅ IMPLEMENTADA (06/10, commit `2a8143e`)

**Origen:** pedido del supervisor (06/10): subir el proyecto a Azure con la web, la API, PostgreSQL y dev-auth
(`DESPLIEGUE_AZURE.md`). También cierra el criterio 5 (base de datos) y los hallazgos NUBE-01 a NUBE-04.

**1. PostgreSQL (criterio 5):**
- **Tablas** (`DataAccess/src/database`):
  - `PersistentTable` se usa como un `Map`: los repositorios no cambian y las lecturas son en memoria;
  - con `DATABASE_URL`, cada `set`/`delete` se escribe en PostgreSQL, en orden, en `<esquema>.<tabla>` (`id text`, `data jsonb`,
    `updated_at`);
  - `DatabaseService` crea esquemas y tablas, carga las filas al arrancar, aplica los datos iniciales si la tabla está vacía y espera
    las escrituras pendientes al apagar.
  - Sin `DATABASE_URL`, todo sigue en memoria (desarrollo y pruebas).
- **Esquemas:** un esquema por base de datos del diseño: `bookings`, `offers`, `post_sale`, `check_in`, `customers`, `flight_status`,
  `webhooks`, `idempotency`, `schedule` (rutas y flota), más `gds` y `payment` para los sistemas externos simulados. En total
  15 tablas.
- **Sistemas simulados:** el GDS persiste cupos, asientos asignados y el inicio de la ocupación simulada, para que tras un reinicio
  coincidan con las reservas. La Payment API persiste las referencias usadas. Al arrancar, `SchedulePublisher` vuelve a publicar
  el horario guardado.
- **Decisión:** cada agregado es un documento JSONB (reserva con pasajeros y boletos, hold con sus selecciones…). La memoria es
  la copia de trabajo, así que la API corre como **una sola instancia**.
- **Fechas:** `revive` convierte de nuevo a `Date` los campos de fecha que JSON guarda como texto (holds, cotizaciones,
  idempotencia).
- Driver: `pg` (sin ORM).

**2. dev-auth en la nube:**
- con `DATABASE_URL` guarda las cuentas en `auth.users` (se cargan al arrancar y cada registro se guarda antes de responder);
- los usuarios de prueba tienen un `sub` fijo derivado del correo, así sus reservas siguen siendo suyas tras un reinicio;
- `ADMIN_PASSWORD` cambia la clave del administrador;
- en Azure (`WEBSITE_SITE_NAME`) se niega a arrancar sin un `AUTH_JWT_SECRET` propio de al menos 32 caracteres.

**3. Swagger en la nube:**
- con `PUBLIC_API_URL`, el overlay también funciona en producción: servidor público y esquema de token para Authorize;
- el documento de dev-auth usa `DEV_AUTH_URL`, y la CSP de `/docs` admite esa URL;
- ambas variables se validan al arrancar (http(s), y https en producción).

**4. Web:** `public/staticwebapp.config.json`, para que una recarga en una ruta interna devuelva `index.html`, más cabeceras de
seguridad.

**5. GitHub Actions:**
- `azure-static-web-apps-….yml`: compila con Node 24, lint y las URLs públicas (`VITE_*`), y sube `dist`.
- `deploy-api.yml`:
  - `npm ci`, tipos, lint, unitarias y e2e;
  - `npm prune --omit=dev` y paquete con `node_modules` (enlaces de los workspaces copiados), el `dist` de las 4 capas y los
    contratos;
  - `azure/webapps-deploy`.
- `deploy-auth.yml`: `npm ci --omit=dev` y despliegue de `dev-auth`.
- Cada flujo corre solo si cambió su parte.

**Verificación (06/10):**
- Tipos ✅, lint ✅ (API y web), build ✅.
- Unitarias **174/174** ✅ (+1: validación de `PUBLIC_API_URL` y `DEV_AUTH_URL`).
- e2e **137/137** ✅ en memoria, más **`persistence.e2e-spec.ts`** con PostgreSQL 16 en Docker (`TEST_DATABASE_URL`):
  - se crean avión, ruta, reserva con asiento, perfil y webhook;
  - se apaga la API y se vuelve a levantar;
  - todo sigue: la reserva, el asiento ocupado en el GDS, la ruta a la venta, el avión en servicio, el perfil, el webhook, y la
    referencia de pago usada se rechaza.
- **dev-auth con PostgreSQL:** un cliente registrado y el usuario de prueba inician sesión tras reiniciar con el **mismo `sub`**;
  registrar el mismo correo responde `409`. Sin base sigue en memoria; en Azure sin secreto propio se niega a arrancar.
- **Paquete de la API simulado como en GitHub Actions** (60 MB, sin TypeScript) y ejecutado con `NODE_ENV=production` y las
  variables de Azure: conecta con PostgreSQL (15 tablas, 90 rutas y 149 aviones cargados), Swagger con la URL pública y token, CSP
  con dev-auth, y la búsqueda responde.

**Configuración en Azure:** hecha el 07/10 (ver V1.N).

### V1.N — Despliegue en Azure — ✅ EN LÍNEA (07/10, commit `d3ada3d`)

- **Recursos** (Azure for Students, región Brazil South):
  - Static Web Apps (web);
  - App Service B1 con dos apps (`ecoairlines-api-gv` y `ecoairlines-auth-gv`, Node 24);
  - PostgreSQL Flexible Server B1ms (`ecoairlines-db-gv`).
- **Despliegue continuo:** los tres workflows de GitHub Actions de V1.M, con los perfiles de publicación como secretos del
  repositorio.
- **Incidente:** la API y dev-auth respondían 503 sin registros visibles.
  - Causa: **no existía la base `ecoairlines`** en el servidor (Azure solo crea `postgres`, `azure_maintenance` y `azure_sys`),
    y los registros de aplicación estaban apagados.
  - Se creó la base. Al reiniciar, la API creó sus 15 tablas y cargó la red base, y dev-auth creó `auth.users`.
- **404 "(sin ruta)" en Observabilidad:** se comprobó con una petición marcada (`X-Request-Id`) que corresponde a visitas a la raíz
  de la API o a la sonda de arranque de Azure (`/robots933456.txt`). No es un error de la aplicación.
- **Verificación en la nube:**
  - login con CORS desde la web;
  - API con token de dev-auth;
  - búsqueda;
  - Swagger con la URL pública;
  - 16 tablas en PostgreSQL;
  - compra y panel admin desde la web pública.
- **Documentación:** `DESPLIEGUE_AZURE.md` (URLs, aviso del paso 2.5, registros de aplicación, problemas frecuentes),
  `CRITERIOS.md` (criterio 1 ✅, 9/9) y `README.md` (sección "En línea").

---

## 4. Plan de la versión 1 — estado final (07/10)

> Plan original del 05/10, con lo que ocurrió con cada fase.

### V1.0 — Saneamiento del entorno y la documentación — ✅ Hecho
- Los procesos que ocupaban los puertos ya no corrían (OPS-01 y OPS-03 resueltos).
- "25 operaciones" → **22** en `EcoAirlines.API/README.md` (V1.C).
- `GEMINI.md` y la nueva `AUDITORIA.md` en la raíz, hechos por el supervisor (DOC-02).

### V1.1 — Alineación con la plantilla y la ruta base — ⏳ Pendiente de decisión del grupo
- Sigue abierta (PLT-01, PLT-02): falta que el líder de booking decida el prefijo (`/flights/v1` o `/api/v1`) y la ruta de Swagger.
- Cuando se decida: prefijo global configurable y ajuste del frontend, las pruebas y los README. Las pruebas de conformidad garantizan
  que nada se rompa.

### V1.2 — Persistencia en PostgreSQL — ✅ Hecho en V1.M (con cambios)
- PostgreSQL con `DATABASE_URL`, como la plantilla, pero con el driver `pg` en lugar de TypeORM.
- Cada contexto es un esquema y cada agregado un documento JSONB. Los repositorios no cambiaron (ver V1.M y PLT-03).
- En las pruebas sigue el modo en memoria; una prueba e2e verifica la persistencia con PostgreSQL real.

### V1.3 — Preparación del despliegue — ✅ Hecho en V1.M (con cambios)
- **Swagger:** usable en la nube con `PUBLIC_API_URL` y `SWAGGER_ENABLED`, más el documento de dev-auth.
- **Autenticación:** dev-auth desplegado aparte, con secreto propio y `ADMIN_PASSWORD` (NUBE-03).
- **Despliegue:** GitHub Actions hacia Azure en lugar de `Dockerfile`/`render.yaml`. La guía de variables está en
  `DESPLIEGUE_AZURE.md`.

### V1.4 — Despliegue y verificación en la nube — ✅ Hecho en V1.N (Azure en lugar de Render)
- La API, PostgreSQL, dev-auth y la web están en línea en Azure.
- Verificado con las URLs públicas: Swagger y "Try it out", el recorrido completo en el navegador y CORS.
- Las URLs están en el README.

### V1.5 — Frontend en Vue — ❌ Cancelado (decisión del supervisor, 07/10)
- El frontend se mantiene en React: está completo, verificado y desplegado.

### V1.6 — Mejoras opcionales — ✅ Parcialmente hecho
- ✅ Emisión real de eventos de webhooks: V1.K (bus interno, 9 eventos, firma HMAC y reintentos).
- ⏳ Resolver los `HALL` que el líder de booking decida (`HALLAZGOS.md`, sección 6).
- ⏳ Propuesta V1.B (servicios sin códigos HTTP, hallazgo HIGH de la auditoría): sigue pendiente de aprobación.

---

## 5. Restricciones permanentes

- **No modificar** `contract/vuelos-openapi.yaml`, `CLAUDE.md` ni `GEMINI.md` sin autorización explícita (desde V1.C están en la raíz).
- No subir secretos reales al repositorio: las variables sensibles se configuran en el proveedor de la nube.
- Toda desviación respecto al plan aprobado se registra en la fase correspondiente de este archivo.

---

## 6. Versión 2 — Reto 2: transición a microservicios

> Iniciada el **2026-10-20**. El plan completo, las fases (V2.0–V2.21) y el registro de decisiones (D1–D40) están en
> [`PLAN/PLAN.md`](PLAN/PLAN.md). Los diagramas vigentes son `PLAN/modelo-conceptual-v4.png` y
> `PLAN/arquitectura-microservicios-v4.png`. Cada fase se registra aquí al completarse.
> **25/10/2026:** el grupo entregó el **contrato de Vuelos v2** (`contract/vuelos-openapi-v2.yaml`), nueva fuente de verdad.

### V2.0 — Decisiones y preparación — ✅ HECHA (20/10)
- **Qué se pidió:** analizar el modelo conceptual y la arquitectura objetivo, proponer un plan de migración a microservicios
  (requisito del ingeniero: al menos un servicio gRPC y uno SOA) y agregar mejoras: usuarios con rol, precios por clase editables,
  asistencia médica, telemetría en el panel, pago con tarjeta y web progresiva.
- **Cómo se hizo:** revisión del proyecto completo; plan en `PLAN/PLAN.md` con tres iteraciones de diagramas (v2: huecos
  corregidos; v3: mejoras y correcciones de la revisión del responsable).
- **Decisiones:** D1–D25 cerradas por el responsable (sección 7 del plan). Entre ellas: Offers en gRPC y dueño del inventario,
  PostSale en SOAP, ESB en NestJS, todo en TypeScript, RabbitMQ, prefijo `/api`, web solo por GraphQL, un rol por usuario,
  contratos nuevos por microservicio sin tocar los existentes, todo desplegado en la nube.
- **`CLAUDE.md`:** reescrito para el Reto 2 con autorización del responsable (20/10). Las reglas del Reto 1 que siguen vigentes
  (contrato del grupo intacto, `ownerId` desde el JWT, solo `paymentReference`, idempotencia, `ProblemDetails`) se conservaron.
- **Verificación:** plan revisado y aprobado por el responsable. No se modificó código.
- **Revisión por el contrato v2 (25/10):**
  - **Qué se pidió:** analizar el contrato de Vuelos v2 de Booking, actualizar el plan, corregir lo que chocara y generar la v4 de
    los diagramas.
  - **Cómo se hizo:** revisión CV-01…CV-23 (sección 3.5 del plan); diagramas `-v4` con sus scripts en `PLAN/scripts/`; preguntas
    al grupo en `HALLAZGOS.md` (sección 8, serie `BKG`); `CLAUDE.md` ajustado al contrato v2 con autorización del responsable.
  - **Decisiones:** D26–D40 cerradas por el responsable, con los matices recomendados. Entre ellas: solo `/api/v2/vuelos` (sin
    v1), Booking cobra y la aerolínea valida la referencia, token de partner `client_credentials`, `X-Correlation-Id` separado de
    `X-Request-Id` (corrige la v3.1), solo roles CLIENTE y ADMIN, Offers envía el stock a Booking por gRPC, sin duplicados
    (idempotencia + sagas + asiento atómico), descuento máximo de promociones ≤ 50 % definido por el admin, y todo lo vinculado
    con Booking pasa primero a microservicios.
  - **Verificación:** plan y diagramas revisados por el responsable. No se modificó código.

### V2.1 — Contratos por microservicio — ✅ APROBADA (25/10)
- Ver `PLAN/PLAN.md`, fase V2.1 (11 pasos).

#### Paso 1 — `contract/ms-g-identity.openapi.yaml` v1.1.0 — ✅ escrito (25/10), pendiente de revisión
- **Qué se pidió:** actualizar el contrato de Identity (escrito el 20/10, v1.0.0) para el contrato v2: token de partner y scopes
  nuevos.
- **Cómo se hizo:**
  - **`POST /oauth2/token`** (OAuth2 `client_credentials`, RFC 6749 §4.4) con `client_secret_basic` o `client_secret_post`,
    `scope` opcional (subconjunto) y errores en el formato estándar de OAuth2 (`invalid_client`, `invalid_scope`…), único
    endpoint sin `ProblemDetails` porque es lo que esperan las librerías OAuth de los clientes.
  - **Partners:** `GET/POST /partners`, `GET /partners/{clientId}`, `PUT /partners/{clientId}/status` y
    `POST /partners/{clientId}/secret` (rotar). El secreto lo genera el servicio y se muestra una sola vez. `clientId` =
    `salesChannel.partnerId` (p. ej. `BOOKING_PROTOTIPO`). Un partner nunca tiene `flights:admin` ni `ecoairlines:*`.
  - **Tokens:** claim `token_use` (`user` o `partner`); el de partner tiene `sub = clientId` y no tiene `role`.
  - **Scopes de ADMIN:** se agregan `flights:ops` y `flights:admin`. Sin rol OPS (D30).
  - **Trazabilidad:** `X-Correlation-Id` y `X-Request-Id` en todas las operaciones; `ProblemDetails` v2 (`instance`,
    `correlation_id`, `timestamp`); `UNAUTHENTICATED` pasa a `UNAUTHORIZED`, el código del contrato v2.
  - `UserStatus` pasa a llamarse `AccountStatus` (lo usan usuarios y partners); `Health` agrega `latency_ms` para el health
    del contrato v2.
- **Verificación:** `npx @redocly/cli@2.11.0 lint` → **válido**; 4 advertencias de estilo del conjunto recomendado (sin 4xx en
  `/health` y la JWKS, licencia sin URL, servidor `localhost`), que no aplican a un contrato interno.

#### Paso 2 — contratos de los MS.G REST — ✅ escrito (25/10), pendiente de revisión
- **Qué se pidió:** los contratos internos de Customers, Webhooks, Schedule, FlightStatus, Bookings y CheckIn.
- **Cómo se hizo:**
  - Seis archivos nuevos en `contract/` (`ms-g-<servicio>.openapi.yaml`), uno por MS.G, a partir del código del monolito
    (entidades, reglas, `ecoairlines-extensions.yaml`) y de las sagas de `PLAN/PLAN.md` §4.2: cada operación es un paso de
    saga, una ruta del enrutador o una fuente de la composición, con su compensación cuando la saga la necesita.
  - Los schemas que también existen en el contrato del grupo se **referencian** (`./vuelos-openapi-v2.yaml#/…`), no se copian.
  - **Hallazgo de diseño:** las sagas que disparan los eventos de Booking no tienen usuario, así que el ESB no puede reenviar
    un token de usuario. Se propone **D41**: token de servicio del ESB + `X-Owner-Id` / `X-Actor-Id`. Identity pasa a
    **v1.2.0** (cliente de semilla `ECOAIRLINES_ESB`; sus operaciones de administración usan el token del ESB y `X-Actor-Id`).
  - Sin duplicados (D34) en los contratos: `bookingId` generado por el ESB, `claim` de referencia de pago de uso único,
    emisión con `issued: 0`, `ALREADY_CANCELLED` tratado como éxito, check-in que no se repite.
- **Verificación:** `npx @redocly/cli@2.11.0 lint` → **los 7 contratos válidos** (con las referencias externas resueltas);
  solo advertencias de estilo (`/health` sin 4xx, licencia sin URL, servidor `localhost`).

#### Pasos 3 y 4 — `contract/ms-g-offers.proto` y `contract/booking-inventory.proto` — ✅ escritos (25/10), pendientes de revisión
- **Qué se pidió:** el contrato gRPC de Offers y la copia del proto de stock de Booking.
- **Cómo se hizo:**
  - `ms-g-offers.proto` (paquete `ecoairlines.offers.v1`, puerto 50061): `CatalogService`, `HoldService`, `InventoryService` y
    `PublishingService`, con 20 RPCs que cubren el enrutador, cada paso de saga de §4.2 y la composición. Mensajes con la forma
    de los schemas del contrato v2 (importes como texto, fechas RFC 3339).
  - Inventario en dos niveles: **conteos por estado** por segmento y cabina (los cupos que hoy reserva el monolito) y **estado
    de cada asiento asignado** (lo nuevo del contrato v2), con actualizaciones condicionales para que un asiento no se venda dos
    veces (D34).
  - El envío de stock a Booking queda documentado en el `.proto` (D33): no es una RPC de Offers, sino una llamada de Offers como
    cliente a `booking-inventory.proto`.
  - `booking-inventory.proto`: copia del §9 del contrato v2 con un comentario de origen al inicio.
- **Verificación:** `buf build` compila los dos; `buf lint` (reglas `STANDARD`, salvo `FILE_LOWER_SNAKE_CASE` por D24) sin
  errores, después de dar a cada RPC su propio mensaje de entrada y de salida; `@grpc/proto-loader` carga los 5 servicios; la
  copia de Booking es idéntica línea por línea al contrato.

#### Paso 5 — `contract/ms-g-post-sale.wsdl` + `ms-g-post-sale.xsd` — ✅ escritos (25/10), pendientes de revisión
- **Qué se pidió:** el contrato SOA de PostSale (requisito del ingeniero: al menos un servicio SOA).
- **Cómo se hizo:**
  - XSD con los tipos (importes con 2 decimales, enumeraciones del contrato v2, `PostSaleFault` con los campos de
    `ProblemDetails`) y WSDL 1.1 SOAP *document/literal* que lo importa: 8 operaciones, cada una con su `SOAP Fault` y las
    cabeceras `CorrelationId` y `RequestId` en la petición y en la respuesta (contrato v2 §6).
  - Reglas tomadas del monolito (`CancellationService`, `DateChangeService`, `BaggageService`): vencimiento de 15 min, máximo
    10 ofertas de cambio, máximo 3 maletas extra, cálculo de reembolso y de diferencia de tarifa.
  - Nuevo por el contrato v2: `CalculateCompensationRefund` (cancelación sin cotización por `FLIGHT_CANCELLED` o
    `SAGA_COMPENSATION`, D37) y `ReleaseDateChangeOffer` (compensación). `QUOTE_EXPIRED` pasa de `409` a `410`.
- **Verificación:**
  - `lxml`: el XSD es un esquema válido; de 6 mensajes de ejemplo, los 4 correctos se aceptan y los 2 inválidos se rechazan
    (`reasonCode` no permitido, importe con 3 decimales).
  - Librería `soap` 1.1.6: el cliente generado del WSDL describe las 8 operaciones; un servidor levantado con el mismo WSDL
    responde `ValidateBaggagePurchase` (70,00 USD por 2 maletas), devuelve la cabecera `CorrelationId` sin cambios y, al
    pasar el límite, un `soap:Fault` con `BAGGAGE_LIMIT_EXCEEDED`, `status` 422 y el `correlationId`.

#### Paso 6 — `contract/payment-api.openapi.yaml` — ✅ escrito (25/10), pendiente de revisión
- **Qué se pidió:** el contrato de la Payment API simulada con tarjeta (solo canal web, D7 y D28).
- **Cómo se hizo:**
  - Modelo **autorizar → capturar** de las pasarelas reales, en lugar de "cobrar y después verificar" (ajuste del plan §4.8):
    el navegador tokeniza y **autoriza** con la clave pública; el ESB **captura** el monto exacto en el paso `pago*` de la saga,
    lo que marca la referencia como usada una sola vez; si la saga falla antes de capturar se **anula**, y después, se
    **reembolsa**.
  - Dos claves (pública `pk_test_…` para el navegador, secreta `sk_test_…` para el ESB): es un sistema externo, no usa el token
    de D41.
  - Reglas de tarjeta (Luhn, marca, vencimiento, CVV), token de un solo uso, tarjetas de prueba (`GET /test-cards` para el
    botón de la web), idempotencia, rechazo como resultado (`DECLINED` con `declineCode`) y no como error.
  - Diagramas v4: la línea del ESB a la Payment API dice "capturar (monto exacto, una vez)"; en el modelo, `payments.status` y
    `used_references` (orden y fecha de captura).
- **Verificación:** `npx @redocly/cli@2.11.0 lint` → válido (3 advertencias de estilo); las 5 tarjetas de prueba cumplen Luhn y
  la regla de marca del contrato.

#### Paso 7 — contratos de los 5 microservicios de respuesta — ✅ escritos (25/10), pendientes de revisión
- **Qué se pidió:** los contratos de MS.Vuelos, MS.Reservas, MS.Postventa, MS.Clientes y MS.Admin, repartiendo las 30
  operaciones del contrato v2 según su `x-microservice`.
- **Cómo se hizo:**
  - Las operaciones del contrato del grupo se **referencian por ruta** (`$ref` a `vuelos-openapi-v2.yaml#/paths/…`) en lugar de
    copiarse: son idénticas por construcción y, si el grupo cambia el contrato, los MS lo siguen sin editar nada. Antes se
    comprobó que cada una de las 24 rutas tiene todas sus operaciones en un mismo `x-microservice`.
  - Operaciones propias (solo vía GraphQL, D23) bajo `/ecoairlines/...`, con los schemas de los contratos de los MS.G:
    Reservas (reserva web con asistencia y gestión de la asistencia), Clientes (registro, login, perfil y `POST /oauth2/token`
    de Identity), Admin (usuarios, partners, precios y descuento máximo, rutas, flota, asistencia, eventos, indicadores y
    telemetría con búsqueda por correlation ID y estado de la integración con Booking).
  - Cada contrato documenta la seguridad (token de partner o de usuario, rechazo del token de servicio, dueño desde el token)
    y la cadena del ESB de cada operación.
  - Generados con `contract/tools/generar_ms_respuesta.py`.
- **Verificación:** `npx @redocly/cli@2.11.0 lint` → los 5 válidos (solo advertencias de estilo);
  `contract/tools/verificar_operaciones_v2.py` (resuelve todas las referencias y compara) → **30/30** operaciones una sola
  vez, en su `x-microservice` (9 Vuelos, 12 Reservas, 6 Postventa, 3 Clientes) y con definición idéntica a la del contrato.

#### Paso 8 — `contract/gateway.graphql` — ✅ escrito (25/10), pendiente de revisión
- **Qué se pidió:** el SDL completo del gateway GraphQL, la única entrada de la web (D23).
- **Cómo se hizo:**
  - Se parte del SDL de `contract/vuelos-graphql.yaml` (sin modificar ese archivo) y se **extiende sin romperlo**: se conservan
    todos sus tipos, queries, mutations y la suscripción `bookingEvents`.
  - Lo nuevo del contrato v2: estado por asiento (`Seat.status`, `SeatStatus`), `ttlMinutes` del hold, `issueTickets`,
    `changeSeats`, `updateFlightStatus` y `flightOperations` (con `FLIGHTS_OPS`), reembolso en la cancelación, puerta y demora
    en el estado de vuelo, nuevos códigos de error y de eventos. El secreto de los webhooks se devuelve **enmascarado** (en v2 es
    `writeOnly`), sin cambiar el tipo.
  - Lo propio: registro, login, perfil, asistencia médica (en el checkout y en la reserva) y todo el panel de administración
    (usuarios, partners, precios y descuento máximo, rutas, flota, asistencia por vuelo, eventos, indicadores y telemetría).
  - El encabezado documenta transporte, seguridad (solo tokens de usuario), idempotencia v2, errores `ProblemDetails` v2 y
    pagos; cada campo indica con `→ MS.<servicio> <operationId>` qué operación del MS de respuesta lo resuelve.
- **Verificación** (`contract/tools/verificar_gateway_graphql.cjs`, `graphql` 16.9.0):
  - `buildSchema` → válido: 30 queries, 31 mutations, 176 tipos.
  - `findBreakingChanges` contra la base del Reto 1 → **0 cambios incompatibles**; 31 cambios aditivos (valores nuevos de
    enums y 2 campos de entrada opcionales).
  - Las 71 referencias `→ MS.<servicio> <operationId>` existen en los contratos de los MS de respuesta.

#### Paso 9 — `contract/events.asyncapi.yaml` — ✅ escrito (25/10), pendiente de revisión
- **Qué se pidió:** el contrato de los eventos: bus interno, salientes a Booking y entrantes de Booking.
- **Cómo se hizo:**
  - AsyncAPI **3.0.0**, generado con `contract/tools/generar_events_asyncapi.py` (no se edita a mano).
  - **Eventos públicos (15):** los del enum `VuelosEventName` del contrato v2; sus payloads **referencian** los schemas
    CloudEvents del grupo (`EventBookingConfirmed`, `EventFlightStatusChanged`…) con el formato de schema OpenAPI, así son
    iguales por construcción. Los 4 sin schema propio en el contrato (`ticket_issuing`, `ticket_failed`, `flight.cancelled`,
    `flight.schedule_changed`) usan `CloudEventBase` del contrato más su `data`.
  - **Eventos internos (9):** `schedule.published` (lleva los vuelos, D4), `pricing.changed`, `user.*`, `partner.*` y
    `booking.assistance_requested` (sin el tipo de asistencia: no lleva datos de salud). `type` en `ec.ecoairlines.internal.*`.
  - **Canales:** bus interno RabbitMQ (exchange topic `ecoairlines.events`, routing key = nombre corto, outbox, colas por
    consumidor y dead letter), entrega de webhooks a Booking (firma, reintentos y filtro D40), puente opcional al bus
    `booking.events`, reintentos diferidos del ESB (TTL + DLX) y entrada de `payment.confirmed`, `payment.failed` y
    `package.cancelled` por AMQP o por webhook firmado (canal por confirmar, BKG-01; propuesta registrada en `HALLAZGOS.md`).
  - Un `correlationId` de AsyncAPI apunta a `$message.payload#/correlationid` en todos los CloudEvents.
- **Verificación** (`contract/tools/verificar_events_asyncapi.mjs`, `@asyncapi/parser` 3.4.0 + `@asyncapi/openapi-schema-parser`):
  - Documento válido: **0 errores, 0 avisos**; 31 canales, 56 operaciones, 28 mensajes con payload resuelto y con
    `correlationid` (salvo la tarea interna `esb.deferred`, que lo lleva como campo propio).
  - Los públicos son exactamente los 15 de `VuelosEventName` y están los 3 que consume la aerolínea.
  - Hallazgo de herramienta: el plugin de schemas OpenAPI modifica en el lugar los schemas compartidos y falla cuando dos
    mensajes referencian el mismo; el verificador le pasa una copia de cada schema (cada mensaje validado por separado ya
    pasaba).

#### Paso 10 — suite de conformidad v2 (`tests/conformidad-v2`) — ✅ escrita (25/10), pendiente de revisión
- **Qué se pidió:** la suite que deben pasar los microservicios antes de integrarse con Booking (meta de V2.2–V2.14).
- **Cómo se hizo:**
  - **Caja negra:** llama por HTTP a `CONFORMANCE_BASE_URL` (gateway local, monolito o URL pública), sin levantar la
    aplicación; credenciales del partner (`CONFORMANCE_CLIENT_ID`/`SECRET` → `POST /oauth2/token`) y token de ADMIN opcional.
  - El cliente llama a cada operación **por su `operationId`**: método, ruta y cabeceras obligatorias (`Idempotency-Key`,
    `X-Device-Fingerprint`) salen del contrato. Cada respuesta se valida con Ajv contra `vuelos-openapi-v2.yaml` (status
    documentado, Content-Type, schema) y contra las reglas transversales: `X-Correlation-Id` sin cambios (§6),
    `correlation_id` y `timestamp` en `ProblemDetails` (§11), `Location` en los `201`.
  - 48 pruebas por microservicio (Vuelos, Reservas, Postventa, Clientes) y transversales: casos correctos y de error
    (idempotencia y `IDEMPOTENCY_KEY_REUSED`, referencia de pago reutilizada y `AMOUNT_MISMATCH` — D34 —, recursos de otro
    usuario → `404`, emisión idempotente `issued: 0`, `ALREADY_CANCELLED`, `SAGA_COMPENSATION` sin cotización, descuento
    > 50 % → `422` — BKG-12 —, transición inválida de estado de vuelo, partner sin `flights:admin` → `403`). Las pruebas que
    modifican datos solo crean holds y reservas propios, o vuelven a guardar los valores vigentes.
  - **Cobertura:** cada llamada registra "operación + status"; al final se informa la cobertura y se falla si alguna de las 30
    operaciones quedó sin probar.
  - **Autoverificación** (6 pruebas, corre siempre, sin red): 30 operaciones repartidas 9/12/6/3, Ajv compila todos los
    schemas de respuesta, los ejemplos del contrato cumplen sus schemas y cada operación tiene al menos una prueba.
  - `npm run test:conformidad-v2`; `tests/` agregado al lint y a la verificación de tipos de las pruebas.
- **Verificación:** autoverificación **6/6**; las 48 pruebas en vivo se omiten sin `CONFORMANCE_BASE_URL` (todavía ningún
  servidor implementa el contrato v2; la primera ejecución real será en V2.13). Lint sin advertencias. Tipos: **0 errores en la
  suite**; `tsc -p tsconfig.spec.json` informa 16 errores **que ya existían** en pruebas del monolito (imports
  `@ecoairlines/*` que no resuelven), idénticos con y sin este cambio.
  **Corrección (V2.2):** esos 16 errores desaparecen al compilar la solución completa (`tsc -b`): venían de un `dist/` del
  monolito desactualizado (sus pruebas importan `@ecoairlines/*` desde `dist/`), no del código.

### V2.2 — Base común — ✅ HECHA (25/10), pendiente de auditoría y aprobación
- **Qué se pidió:** la base de todos los microservicios (PLAN.md §6, V2.2): workspaces, librería compartida, plantilla de
  servicio, Docker Compose con PostgreSQL (una base y un usuario por servicio), RabbitMQ, el Collector y `booking-simulado`, y la
  prueba de arquitectura.
- **Cómo se hizo:**
  - **Workspaces** nuevos: `packages/*` y `services/{gestion,respuesta,externos}/*`. El monolito no se tocó (sigue como
    referencia): lo que pasa a `shared` se **copió y adaptó** al contrato v2.
  - **`packages/shared` (`@ecoairlines/shared`):** correlation ID (`X-Correlation-Id` sin cambios + `X-Request-Id` por salto,
    contexto con AsyncLocalStorage y propagación por HTTP, gRPC, AMQP y SOAP — D31); `ProblemDetails` v2 (excepción, filtro con
    `instance`, `correlation_id` y `timestamp`, códigos del contrato v2); logs JSON con los campos de `api_request_logs` y
    redacción de datos sensibles; `/health` con dependencias y límite de 800 ms por chequeo; OpenTelemetry (trazas por OTLP/HTTP,
    activo solo con `OTEL_EXPORTER_OTLP_ENDPOINT`, fuera del índice para iniciarse antes que NestJS); CloudEvents y firma
    HMAC-SHA256 de webhooks; dinero (con descuento y comparación al centavo), conteo de pasajeros y aeropuertos; tipos del
    contrato v2 generados con `openapi-typescript` (`npm run generate:contract -w packages/shared`).
  - **Plantilla de servicio:** `EcoServiceModule.forRoot({ name, version, healthChecks })` + `configureService(app)`: cada
    servicio la importa en lugar de copiar código (correlación, log por petición, logger JSON, filtro de errores y
    `ValidationPipe` estricto con `forbidNonWhitelisted`).
  - **`services/externos/booking-simulado`** (primer servicio con la plantilla): recibe webhooks CloudEvents y **verifica la
    firma**, deduplica por `id`; servidor gRPC `inventory.InventoryStockService` de `booking-inventory.proto` (valida
    `item_id`, fecha, hora y unidades); emite `payment.*` y `package.cancelled` firmados hacia la aerolínea (vía de BKG-01).
  - **`infra/`:** `docker-compose.yml` (postgres 17.11, rabbitmq 4.1.8, otel-collector-contrib 0.162.0, booking-simulado),
    script de bases por servicio con `REVOKE` (ningún usuario entra a la base de otro ni a `postgres`), configuración del
    Collector (exporter `debug`, borra cabeceras sensibles), Dockerfile común de dos etapas (usuario sin privilegios),
    `.env.example`, `.dockerignore` y `.gitattributes` (LF en scripts de contenedores).
  - **Prueba de arquitectura v2** (`tests/arquitectura-v2`): entre paquetes solo `@ecoairlines/shared`; `shared` no depende de
    servicios; nadie depende del monolito; un MS.G no nombra a otro; hacia Booking solo Offers, Webhooks y el ESB. Cada regla
    tiene un caso sintético que demuestra que detecta la violación.
  - Versiones elegidas con al menos ~2 semanas de publicadas: OpenTelemetry 0.223 (no la 0.300, de hace 5 días), gRPC 1.14,
    imágenes estables (no `nightly`).
  - Comandos: `npm run test:v2` (config `vitest.config.v2.ts`, con decoradores legacy y metadatos), `npm run infra:up` /
    `infra:down`.
- **Verificación:**
  - `tsc -b` (solución completa) sin errores; `tsc -p tsconfig.spec.json` **0 errores**; lint sin advertencias.
  - Pruebas v2: **41/41** (21 de `shared`: plantilla en una app NestJS real, correlación, ProblemDetails, health, logs,
    CloudEvents, dinero; 11 de `booking-simulado`; 9 de arquitectura). Monolito: **174/174** unitarias, sin cambios.
  - `docker compose up`: postgres, rabbitmq y booking-simulado **healthy**; 11 bases creadas; `offers_svc` entra a `offers` y
    es **rechazado** en `bookings` y `postgres`.
  - Una petición con `X-Correlation-Id: corr-verificacion-v22` vuelve con la misma cabecera, su span llega al **Collector**
    con el atributo `correlation_id` y el servicio `booking-simulado`, y su log JSON trae `correlation_id`, `request_id`,
    `trace_id`, `operation`, `status` y `latency_ms`.
  - Desde fuera de Docker: `PushStockUpdate` por gRPC → `success` (guardado con su `x-correlation-id`); webhook firmado → 204;
    firmado con otro secreto → 401.
  - Hallazgos durante la verificación (corregidos): el build de la imagen reveló dependencias que los paquetes usaban sin
    declarar porque las instalaba el monolito (`typescript`, `@types/express`, `class-transformer`); quedaron declaradas en
    cada paquete, así cada servicio es independiente.
- **Pendiente:** auditoría de Gemini (`GEMINI.md`) y aprobación del responsable.

### V2.3 — MS.G.Identity — ✅ HECHA (25/10), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.3: migrar `dev-auth`; `users`, `roles`, `role_scopes` con semilla CLIENTE y ADMIN;
  `partner_clients` y `POST /oauth2/token` con el partner Booking; firma RS256 y JWKS; reglas de §4.10.
- **Cómo se hizo** (`services/gestion/ms-g-identity`, contrato `contract/ms-g-identity.openapi.yaml`):
  - **Capas:** `domain/` (modelo y reglas puras), `repositories/` (interfaz + PostgreSQL + memoria con el mismo
    comportamiento), `services/` (cuentas, partners, tokens, semilla), `http/` (DTO, guards, controladores).
  - **Tablas** (base `identity`, usuario `identity_svc`): `roles`, `role_scopes`, `users` (un solo `role_id`, `status`,
    `created_by`, `updated_by`, `last_login_at`) y `partner_clients` (`scopes`, `secret_hash`, `secret_rotated_at`,
    `last_token_at`). Se crean al arrancar.
  - **Migración de dev-auth:** mismo `scrypt` con sal propia (ahora asíncrono, en formato `scrypt$sal$hash`) y los mismos
    usuarios de prueba con el **mismo `sub`** (sus reservas siguen siendo suyas). Los tres clientes demo solo se siembran en
    local; en producción solo con `SEED_DEMO_USERS=true`. El administrador y el partner Booking se siembran siempre, y en cada
    arranque se reaplican `ADMIN_PASSWORD` y `BOOKING_CLIENT_SECRET`.
  - **Tokens RS256** con `kid` (huella RFC 7638) de los tres tipos del contrato: usuario (login y registro), partner
    (`client_credentials`) y servicio del ESB (`ECOAIRLINES_ESB`, `ecoairlines:internal`, D41; solo de configuración, nunca
    aparece en `/partners`). La JWKS publica la clave vigente y la anterior durante una rotación (`IDENTITY_PREVIOUS_PUBLIC_KEY`).
    En `shared` se agregaron `signJwt`, `verifyJwt` (solo RS256, valida `iss`, `aud`, `exp`, `token_use`), `RemoteJwks` (para los
    demás servicios) y `ServiceTokenGuard`.
  - **OAuth2:** `client_secret_basic` y `client_secret_post` (las dos a la vez → `invalid_request`), errores con el formato de
    RFC 6749 §5.2 (`invalid_request`, `invalid_client` con `WWW-Authenticate` si fue por Basic, `unsupported_grant_type`,
    `invalid_scope`), `Cache-Control: no-store`, cuerpo solo `application/x-www-form-urlencoded`. Inexistente, secreto malo o
    bloqueado responden igual.
  - **Administración** (usuarios, partners, roles): solo con el token de servicio del ESB **y** un `X-Actor-Id` que sea un ADMIN
    **activo en la base** (un admin bloqueado deja de poder operar aunque su token siga vigente). Los secretos de partner
    (32 bytes base64url) se muestran una sola vez; rotar invalida el anterior de inmediato.
  - **Reglas:** registro siempre CUSTOMER (un campo `role` se rechaza); correo en minúsculas y sin espacios; mismo 401 para
    correo inexistente y contraseña incorrecta (y mismo tiempo: se deriva scrypt también sin usuario); `ACCOUNT_BLOCKED` solo con
    la contraseña correcta; `CANNOT_MODIFY_SELF`; `LAST_ADMIN`; un partner nunca tiene `flights:admin` ni `ecoairlines:*`;
    10 intentos por minuto por IP (login, registro) o por `client_id` (token) → 429 con `Retry-After`.
  - **Docker Compose:** servicio `ms-g-identity` en `127.0.0.1:4001` con su base; `.env.example` con sus variables.
- **Errores encontrados y corregidos durante la fase** (para aprender de ellos):
  - **Carrera en `LAST_ADMIN`:** contar los admins y luego cambiar eran dos pasos; dos admins que se bloquean a la vez veían
    "hay 2" y quedaban 0. Ahora "contar y cambiar" es atómico (`changeUser`: en PostgreSQL una transacción con
    `pg_advisory_xact_lock`). Probado con dos bloqueos simultáneos en memoria y contra PostgreSQL real.
  - **Actualización perdida:** el login guardaba el registro completo para poner `lastLoginAt` y podía deshacer un bloqueo
    hecho mientras verificaba la contraseña; lo mismo `lastTokenAt` con un partner bloqueado o con el secreto rotado. Ahora cada
    operación actualiza solo sus columnas (`touchLastLogin`, `touchPartnerToken`, `patchPartner`).
  - **Contrato propio inválido:** `PartnerWithSecret` era `allOf: [Partner, {clientSecret}]`, pero `Partner` tiene
    `additionalProperties: false`, así que **ninguna** respuesta podía cumplirlo. Redocly no lo detecta; lo detectó la prueba que
    valida cada respuesta con el contrato. Se declaró como objeto completo (`ms-g-identity.openapi.yaml` 1.2.1).
  - `ADMIN_PASSWORD` exigía 16 caracteres como los secretos de máquina, pero es una contraseña humana: ahora mínimo 8, como
    `Password` del contrato (la clave por defecto de dev-auth tiene 12).
  - Una cabecera Basic con un `%` mal codificado daba 500; ahora `invalid_client`.
  - La prueba de arquitectura (regla 5) marcaba a Identity por `BOOKING_CLIENT_SECRET`, aunque Identity **autentica** a Booking
    sin hablarle. La regla ahora busca marcas de comunicación (`BOOKING_*_URL`, `_HOST`, `_PORT`, `_GRPC`, `_STOCK`, `_EVENTS`,
    `_WEBHOOK`…), con casos sintéticos para ambos lados.
- **Verificación:**
  - `tsc -b` sin errores; `tsc -p tsconfig.spec.json` 0 errores; lint sin advertencias; Redocly válido.
  - Pruebas v2: **102/102 (más 4 omitidas sin base)** (Identity: 43 HTTP, cada respuesta validada con el contrato, + 9 de reglas; 4 de integración con
    PostgreSQL que se activan con `IDENTITY_TEST_DATABASE_URL`, y pasaron 4/4 contra el contenedor).
  - Contenedor: arranca **healthy** con `database: up`; sin la clave en `NODE_ENV=production` **se niega a arrancar** (visto con
    la imagen antes de poner `NODE_ENV: development` en el compose local). Login de María → 200 con
    `X-Correlation-Id: corr-verificacion-v23`, cuyo span llegó al Collector con `service.name = ms-g-identity`. Token de
    `BOOKING_PROTOTIPO` → `token_use = partner` con sus 6 scopes y **sin `flights:admin`**; secreto incorrecto → 401
    `invalid_client`. Token del ESB + `X-Actor-Id` del admin → `/users/summary`; sin `X-Actor-Id` → 403. Las contraseñas se
    guardan como `scrypt$…`; `offers_svc` no puede entrar a la base `identity`.
- **Pendiente:**
  - Auditoría de Gemini y aprobación del responsable.
  - Las trazas de consultas a PostgreSQL llegan con V2.16 (hoy solo HTTP).
  - Con el login a través del ESB, el límite por IP depende de `X-Forwarded-For`: Identity confía en él solo si viene de la red
    interna (`TRUST_PROXY`, por defecto loopback y redes privadas). El ESB (V2.9) deberá reenviarlo.

### V2.4 — MS.G.Schedule — ✅ HECHA (25/10), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.4: rutas, `route_aircraft`, flota y tipos de avión con la construcción y validación del
  horario; `fare_class_prices` y `price_changes`; `promotion_agreements` (0–50 %, rutas, cabinas, vigencia) con la forma
  `ContratoPromocionesResponse`.
- **Cómo se hizo** (`services/gestion/ms-g-schedule`, contrato `contract/ms-g-schedule.openapi.yaml`):
  - **Motor de horario migrado, no reescrito:** `seed/timetable.ts` del monolito se copió a `src/domain/timetable.ts` con
    cambios mínimos (datos de aviones desde `shared`, errores con código). Sus **15 pruebas** del monolito
    (`fleet-planner.spec.ts`) se migraron y pasan igual: es la prueba de que la copia se comporta como el original.
  - **Reglas** de `AdminRoutesService` y `AdminFleetService` (`src/domain/rules.ts`), con los códigos del contrato:
    `ROUTE_HAS_SOLD_SEATS` (con `soldSeats` que el ESB trae de Offers), `ROUTE_ALREADY_EXISTS`, `UNKNOWN_AIRPORT`,
    `AIRCRAFT_RANGE_EXCEEDED`, `NOT_ENOUGH_AIRCRAFT` (con cuántos faltan), `AIRCRAFT_NOT_IN_FLEET`, `AIRCRAFT_MISMATCH`,
    `TIMETABLE_CONFLICT`, `AIRCRAFT_IN_SERVICE`, `MULTIPLIER_OUT_OF_RANGE`, `PROMOTION_DISCOUNT_OUT_OF_RANGE`.
  - **Tablas** (base `schedule`, usuario `schedule_svc`): `scheduled_routes`, `route_aircraft`, `aircraft`,
    `fare_class_prices`, `price_changes`, `promotion_agreements` y `schedule_meta` (versión del horario). La red base del
    monolito (90 rutas, 149 aviones, `source = NETWORK`) y los precios de referencia se siembran solo si la base está vacía.
  - **Sin duplicados (D34):** todo cambio de rutas o flota pasa por `changeSchedule`, que en PostgreSQL es una transacción con
    `pg_advisory_xact_lock`: dos rutas creadas a la vez no reciben los mismos números de vuelo ni el mismo avión. Los precios
    se guardan todo o nada (`SELECT … FOR UPDATE`), con una fila de historial por cambio real.
  - **Horario:** `GET /timetable` (hasta 92 días, con `departureAt`/`arrivalAt` en la hora local de cada aeropuerto y la
    matrícula) y `GET /fleet-schedule`. El horario semanal se guarda en caché y se reconstruye solo si cambió
    `schedule_meta.version`, así varias réplicas siguen consistentes.
  - **Acuerdo de promociones (D35):** un solo descuento máximo de 0 a 50 %; las rutas habilitadas deben operarse, las cabinas
    existir en la flota y la vigencia no haber pasado. `PUT` reemplaza el acuerdo completo.
  - **En `shared`:** `domain/aircraft.ts` (tipos de avión, mapas de cabina, alcance, tiempo en tierra; también lo usará Offers),
    `JwksTokenVerifier` (verifica el token del ESB con la JWKS de Identity, cuya URL llega por `IDENTITY_JWKS_URL` para no
    nombrar a otro MS.G en el código) y el decorador `@ActorId()` (400 si falta `X-Actor-Id`).
  - **Pruebas de contrato compartidas:** el validador de Identity se generalizó a `tests/support/openapi-contract.ts` (resuelve
    las referencias a `vuelos-openapi-v2.yaml`). La regla 1 de arquitectura admite que **solo** los `test/` de un servicio lo
    importen (caso sintético: desde `src/` sigue siendo una violación).
  - **Docker Compose:** `ms-g-schedule` en `127.0.0.1:4004`.
- **Errores del contrato propio corregidos** (`ms-g-schedule.openapi.yaml` 1.0.0 → 1.1.0):
  - La compensación "borrar → crear" de la saga habría recreado la ruta con **otros** números de vuelo (otro `routeId`) y
    Offers ya no la reconocería. Se agregó `POST /routes?restoreRouteId=` para restaurarla con su identificador.
  - `ROUTE_ALREADY_EXISTS` decía "ya hay una ruta entre esos aeropuertos", lo que rechazaría la propia red base (dos rutas por
    par de ciudades). La regla real, la del monolito, es "el mismo vuelo duplicado": mismo origen, destino y hora.
  - Faltaban los códigos `AIRCRAFT_NOT_IN_FLEET`, `AIRCRAFT_MISMATCH` y `TIMETABLE_CONFLICT`, el 400 de los `DELETE` (p. ej.
    sin `soldSeats`) y el 422 `UNKNOWN_AIRPORT` en el alta y el cambio de un avión.
- **Verificación:**
  - `tsc -b` sin errores; `tsc -p tsconfig.spec.json` 0 errores; lint sin advertencias; Redocly válido.
  - Pruebas v2: **156/156** (Schedule: 15 del motor + 37 HTTP con cada respuesta validada contra el contrato). Integración con
    PostgreSQL (`SCHEDULE_TEST_DATABASE_URL`, en un esquema temporal que se borra): **5/5**, incluidas dos rutas creadas en
    transacciones simultáneas, el ROLLBACK y los precios todo o nada. Las de Identity siguen 4/4.
  - Contenedor: **healthy** con `database: up`; sembró 90 rutas y 149 aviones. Con un **token real del ESB emitido por
    Identity**: rutas, flota y horario responden; sin token → 401; con el token de Booking → 403. Hoy: 180 vuelos (p. ej.
    EA280 MAD→UIO `06:00+01:00` → `11:25-05:00`, HC-W06). Horario de 92 días: 4 MB en ~0,5 s. Crear UIO–GYE → 201
    `EA300-EA301` con un avión nuevo `HC-J27` y el mismo `X-Correlation-Id` (llegó al Collector). Multiplicador 11 → 422
    `MULTIPLIER_OUT_OF_RANGE`; descuento 51 → 422 `PROMOTION_DISCOUNT_OUT_OF_RANGE`; acuerdo de 12 % guardado con la forma
    del contrato v2. `identity_svc` no puede entrar a la base `schedule`.
- **Pendiente:**
  - Auditoría de Gemini y aprobación del responsable.
  - **Decisión a confirmar:** no se siembra un acuerdo de promociones; hasta que el administrador lo guarde,
    `GET /vuelos/promociones/contrato` responderá 404 a Booking (el contrato v2 lo permite).
  - Publicar a Offers (`PublishTimetable`, `PublishFarePrices`) y emitir `schedule.published` / `pricing.changed` son pasos de
    las sagas del ESB (V2.10).

### V2.4 (ajuste del 25/10) — red de prueba con un avión y acuerdo inicial "sin promociones"
- **Qué se pidió:** el responsable aprobó V2.4 y pidió (1) que el acuerdo con Booking empiece en 0 % ("sin promoción") en vez
  de responder 404, y (2) arrancar con **un solo avión con su horario** para las pruebas; en la nube el administrador agregará
  más vuelos.
- **Cómo se hizo:** `src/domain/seed-network.ts`: HC-N01 (A320neo, base UIO) todos los días con EA100 UIO 07:00 → GYE, EA101
  GYE 09:00 → UIO, EA102 UIO 13:00 → BOG y EA103 BOG 16:30 → UIO (Bogotá es internacional: sirve para la regla de pasaporte de
  V2.6; y hay conexión GYE → UIO → BOG). El módulo valida el horario al cargarse. `PromotionsService.seedWithoutPromotions`
  crea `permite_promociones: false, 0 %` para `BOOKING_PROTOTIPO` solo si no existe (`updated_by` NULL en la semilla). La red
  del monolito (90 rutas) sigue en `timetable.ts` para las pruebas del motor. En la base local se borraron las tablas de
  Schedule (solo tenían datos sembrados) para que se sembrara la red nueva.
- **Verificación:** Schedule 52/52 y 5/5 con PostgreSQL; el contenedor arrancó con "Red de prueba sembrada (postgres): 2 rutas,
  1 avión".

### V2.5 — MS.G.Offers — ✅ HECHA (25/10), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.5: servidor gRPC según `ms-g-offers.proto`; búsqueda, mapa con estado, holds (TTL 5–30),
  inventario por estado y alternativas; cambio de estado atómico; `PublishTimetable`, `PublishFarePrices`, `ValidateHold`,
  `CloseFlightSales`; barrido de holds y outbox `hold.*`; cliente gRPC de Booking con reintentos y `stock_sync`.
- **Cómo se hizo** (`services/gestion/ms-g-offers`):
  - **Los 20 RPC del proto** (Catalog, Hold, Inventory, Publishing) más `grpc.health.v1.Health` (paquete oficial
    `grpc-health-check` 2.1.0), en el puerto 50061; HTTP solo para `/health`. Cada llamada exige el token de servicio del ESB,
    toma o crea `x-correlation-id` y lo devuelve con su `x-request-id`; los errores van con el código gRPC de la tabla del proto
    y el `ProblemDetails` serializado en el trailer `x-problem-details-bin`. Se usó `@grpc/grpc-js` directamente (como
    `booking-simulado`) en vez de `@nestjs/microservices`: da control directo sobre la metadata y los trailers.
  - **Migrado del monolito** (`MockGdsService`, `gds-ids.ts`, `HoldService`): identificadores reconstruibles, conexiones
    (escala 1–10 h, sin rodeos), fórmula de precios, mapa de asientos con características, reglas del hold. Los vuelos ahora son
    la copia publicada por Schedule y los multiplicadores la copia `fare_prices` (D35).
  - **Sin duplicados (D34):** `inventory` guarda los cupos por estado con `CHECK (ocupados ≤ total)`; cada movimiento es un
    `UPDATE … WHERE quedan suficientes`. Los asientos están en `booking_seats` con índice único (segmento, asiento) → `SEAT_TAKEN`.
    Los cambios de estado de un hold son condicionales (`WHERE status = 'HELD'`): no se libera, vence ni consume dos veces.
    `ConsumeHold` es idempotente por `booking_id` y las operaciones de saga por `saga_id` (`saga_results`).
  - **Stock a Booking (D33):** cada cambio de cupos deja en `stock_sync`, **en la misma transacción**, el valor absoluto de esa
    cabina; `StockSyncService` lo envía en segundo plano a `PushStockUpdate` con `x-correlation-id`, y si falla reintenta con
    espera creciente (1 s … 60 s). Un envío solo se marca hecho si el valor no cambió mientras viajaba (`version`). Un vuelo con
    la venta cerrada se informa con 0.
  - **Outbox:** `hold.created` y `hold.expired` como CloudEvents en la tabla `outbox` (el relé al bus llega en V2.11). Barrido de
    holds vencidos cada 30 s.
  - `scripts/dev/publicar-horario.mjs` hace, **solo en desarrollo y hasta V2.10**, lo que harán las sagas del ESB: lee el horario,
    los precios y el acuerdo de Schedule y los publica en Offers.
  - Docker Compose: `ms-g-offers` (HTTP 4005 — en V2.8 pasó a 4009 —, gRPC 50061) con `BOOKING_GRPC_ADDRESS=booking-simulado:50051`.
- **Errores encontrados y corregidos durante la fase:**
  - `ReserveSeats` y `AutoAssignSeats` cambiaban el estado del asiento sin mover su cupo: un check-in con asiento automático
    habría dejado el asiento `CHECKED_IN` y el cupo contado como `TICKETED` (ocupación falsa). Ahora todo cambio de estado de un
    asiento mueve también su cupo, en la misma transacción.
  - Pruebas mal aisladas: la del barrido adelantaba el reloj 16 min y vencía los holds de otras pruebas (el servicio hacía lo
    correcto). Ahora usa un hold de 5 min y adelanta 6.
- **Verificación:**
  - `tsc -b` y `tsc -p tsconfig.spec.json` sin errores; lint sin advertencias.
  - Pruebas v2: **182/182** (Offers: 25 con un cliente gRPC real y un Booking falso que se apaga). Con PostgreSQL real
    (`OFFERS_TEST_DATABASE_URL`, esquema temporal): **5/5** — 10 holds simultáneos por 12 cupos de Business → exactamente 6
    ganan, sin sobreventa; liberar el mismo hold 3 veces a la vez devuelve sus cupos una vez; dos reservas por el mismo asiento →
    una `SEAT_TAKEN` y la otra intacta; 6 asientos automáticos simultáneos, todos distintos. Total con base real: 14/14.
  - **Verificación del plan, punto por punto:** dos holds simultáneos por los últimos cupos → uno gana y el otro
    `OFFER_NO_LONGER_AVAILABLE` (la oferta ya no tiene cupo); por el mismo **asiento** → `SEAT_TAKEN`. `availableSeats` = cupos
    `AVAILABLE` (162 → 160 tras un hold de 2; el infante no ocupa asiento). Tras un hold, booking-simulado recibió el stock nuevo
    (160) con el mismo `x-correlation-id`. Con booking-simulado **apagado** el hold se creó, el envío quedó pendiente con
    reintentos y llegó (157) cuando volvió.
  - Contenedores: 368 vuelos publicados (4 diarios × 92 días) y 736 stocks iniciales enviados; con el token real del ESB:
    búsqueda UIO→BOG, conexión GYE→UIO→BOG, sin token → `UNAUTHENTICATED`, token de Booking → `PERMISSION_DENIED`.
    `schedule_svc` no puede entrar a la base `offers`.
- **Pendiente:**
  - Auditoría de Gemini y aprobación del responsable.
  - Relé del outbox a RabbitMQ (V2.11) y trazas gRPC/PostgreSQL (V2.16).
  - El plan pedía "dos holds por el último asiento → `SEAT_TAKEN`"; en el diseño del proto un hold toma **cupos** (sin asiento) y
    el asiento se elige al reservar: el choque por cupos responde `OFFER_NO_LONGER_AVAILABLE` y el choque por el mismo asiento,
    `SEAT_TAKEN`. Las dos cosas están probadas.

### V2.6 — MS.G.Bookings y MS.G.CheckIn — ✅ HECHA (25/10), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.6: Bookings con sus endpoints internos (reemplazan a `BookingsFacade`), emisión separada e
  idempotente (`issued: 0`), los 8 estados, canal de venta, `payment_records` (referencia única), reembolsos, reservas por
  vuelo y `passenger_assistance`; CheckIn que exige boletos emitidos, pases con grupo, puerta y código de barras, y
  `assistance_ready`.
- **Cómo se hizo:**
  - **`services/gestion/ms-g-bookings`** (los 20 endpoints de `ms-g-bookings.openapi.yaml`). La reserva es un agregado que se
    guarda completo (`bookings.data`, jsonb); lo que debe ser único en todo el sistema tiene su índice único, dentro de la
    misma transacción: PNR, `hold_id` (un hold no se usa en dos reservas: `HOLD_ALREADY_CONSUMED`), `payment_records`
    (una referencia de pago una sola vez, D34) y `passenger_documents (segmento, documento)` (un documento una sola vez por
    vuelo: `PASSENGER_ALREADY_ON_FLIGHT`). La asistencia (dato de salud) va en su propia tabla y solo la ven el dueño y el
    administrador (nunca un paso de saga sin usuario).
  - **Migrado del monolito:** `passenger-rules.ts`, `passenger-identity-rules.ts` (edades, cédula ecuatoriana con dígito
    verificador, documento vigente, documento no repetido) y `booking-records.ts` (PNR sin caracteres ambiguos, e-tickets),
    con los códigos del contrato v2 (`INFANT_WITHOUT_ADULT`, `DOCUMENT_EXPIRED`, `PASSPORT_REQUIRED_INTERNATIONAL`,
    `PASSENGER_COUNT_MISMATCH`…).
  - **Idempotencia de cada paso de saga:** crear (mismo `bookingId` → la existente; otro hold → `BOOKING_ID_CONFLICT`), claim
    (misma referencia y `sagaId` → el registro), emitir (`issued: 0`), fallar (ya `FAILED` → 200), cancelar (ya cancelada →
    `ALREADY_CANCELLED` con el resultado original en `detail`), liberar referencia (idempotente; 409 si ya está en una reserva
    confirmada). Fallar y cancelar liberan los documentos de los vuelos.
  - **`services/gestion/ms-g-check-in`**: check-in por pasajero y segmento (todos o ninguno; segundo intento → 409
    `CHECK_IN_NOT_AVAILABLE`, el reintento de la misma saga devuelve lo mismo), pases en **PDF417 con código IATA BCBP real**
    (60 caracteres: nombre, PNR, ruta, vuelo, día juliano, cabina, asiento, secuencia), grupo de abordaje (A = Business y
    asistencia; Economy de atrás hacia adelante), posición por vuelo sin repetir (candado por segmento), puerta, asistencia
    lista y compensación por `sagaId`.
  - Docker Compose: `ms-g-bookings` (4006) y `ms-g-check-in` (4007).
- **Errores del contrato propio corregidos** (`ms-g-bookings.openapi.yaml` 1.0.0 → 1.1.0; el de CheckIn no cambió):
  - `PassengerAssistance` y `CreateBookingCommand.assistance` eran `allOf` sobre `AssistanceRequest`, que tiene
    `additionalProperties: false`: ninguna respuesta de asistencia podía cumplirlos (el mismo error de V2.3). Ahora son objetos
    completos.
  - Faltaba cómo pasar la asistencia a `READY`, aunque CheckIn dice que "el ESB actualiza luego el estado en Bookings": se
    agregó `PUT /bookings/{id}/passengers/{pid}/assistance/status`.
  - Bookings no tenía cómo saber quién hizo check-in, y lo necesita para `CUTOFF_PASSED`: `PUT /seats` con
    `reason = CHECK_IN_AUTO` ahora marca a esos pasajeros y segmentos (documentado).
  - Faltaba el código de "fallar" una reserva emitida (`BOOKING_NOT_CANCELLABLE`) y el choque de documento en un cambio de
    fecha (`PASSENGER_ALREADY_ON_FLIGHT`).
- **Error encontrado y corregido:** el reintento **simultáneo** de "Crear reserva" (el ESB reintenta mientras la primera
  petición todavía no confirmó) respondía `409 BOOKING_ID_CONFLICT` en vez de la reserva existente. Lo detectó la prueba de
  concurrencia contra PostgreSQL: al chocar el `INSERT`, ahora se relee la reserva (ya visible en READ COMMITTED) y se devuelve.
- **Verificación:**
  - `tsc -b` y `tsc -p tsconfig.spec.json` sin errores; lint sin advertencias; Redocly válido.
  - Pruebas v2: **220/220** (Bookings 26 y CheckIn 10, cada respuesta validada contra su contrato). Con PostgreSQL real
    (esquemas temporales): **6/6** — la misma referencia desde 5 sagas a la vez se registra una vez; dos reservas con el mismo
    documento en el mismo vuelo → una gana y la otra no deja nada a medias (ROLLBACK); el mismo `bookingId` dos veces a la vez →
    una sola reserva; 8 check-ins simultáneos → posiciones 1–8 sin repetir; el mismo pasajero dos veces → un check-in.
  - **Verificación del plan:** una referencia repetida se rechaza (`422 PAYMENT_REFERENCE_INVALID`, probado en memoria, con
    PostgreSQL y en el contenedor). **La asistencia no aparece en logs:** la prueba enciende el log de peticiones y el logger
    JSON, captura stdout y stderr durante altas, cambios y errores de asistencia, y no encuentra ni el tipo ni las notas; en
    los contenedores, con la nota `NOTA-SECRETA-SALUD-V26`, tampoco aparece en los logs de Docker.
  - **Contenedores, de punta a punta** (haciendo de ESB, con el token real y un mismo `X-Correlation-Id`): búsqueda y hold
    (Offers) → validar pasajeros → claim de una referencia `PAY-…` (repetida en otra saga → 422) → `ConsumeHold` (asiento
    automático) → reserva `TICKET_ISSUING` canal `BOOKING` → `BOOKED → TICKETED` y emisión (`CONFIRMED`, e-ticket `999…`;
    repetir → `issued: 0`) → `TICKETED → CHECKED_IN`, check-in y `CHECK_IN_AUTO` → pase PDF417
    `M1ANDRADE/LUIS        EN2DDXZ UIOGYEEA 0100 299Y004C0003 100`, grupo A (asistencia), puerta B2 → asistencia después del
    check-in → `409 CUTOFF_PASSED`. Los 10 spans de la operación llegaron al Collector con el mismo correlation id.
- **Pendiente:**
  - Auditoría de Gemini y aprobación del responsable.
  - Encadenar estos pasos en las sagas del orquestador (V2.10); hasta entonces el flujo se probó llamando a cada servicio.
  - `booking.assistance_requested` y los eventos de reserva los publica el ESB (V2.9–V2.11).

### V2.7 — MS.G.PostSale (SOAP) — ✅ HECHA (25/10), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.7: servidor SOAP con las 8 operaciones, cabeceras `CorrelationId` y `RequestId` y
  `SOAP Fault`.
- **Cómo se hizo** (`services/gestion/ms-g-post-sale`; contrato `ms-g-post-sale.wsdl` + `.xsd` **sin cambios**):
  - SOAP 1.1 document/literal con la librería `soap` **1.13.3** (la 1.14.0 tenía 13 días; se usó una de más de dos semanas),
    montada en la misma app NestJS en `/soap/post-sale`; el WSDL se publica en `?wsdl` y el XSD que importa, al lado
    (`/soap/ms-g-post-sale.xsd`), así un cliente se construye solo desde la URL. `/health` como los demás servicios.
  - **Cabeceras SOAP:** `CorrelationId` (sin cambios) y `RequestId` propio en cada respuesta. La librería arma las cabeceras de
    respuesta antes de ejecutar la operación, así que ahí se decide el contexto y la operación corre con ese correlation id.
  - **Errores:** `soap:Fault` (`soap:Client` de negocio o datos, `soap:Server` en `INTERNAL_ERROR`) con
    `detail/types:PostSaleFault` (`code`, `status` HTTP que debe responder el ESB, `title`, `correlationId`, `timestamp`,
    `invalidParam`). Sin token o con uno inválido → Fault `UNAUTHORIZED` (HTTP 401); token que no es del ESB → `FORBIDDEN` (403).
  - **Reglas** (`src/domain/rules.ts`, puras): cotización (reembolsable → total; no reembolsable → solo impuestos y la base es
    penalidad; vence en 15 min; solo lo no volado), compensación sin cotización (`FLIGHT_CANCELLED` → 100 % sin penalidad, D37;
    `SAGA_COMPENSATION` → sin penalidad **solo si el acuerdo B2B permite promociones y está vigente**, como dice el contrato v2),
    ofertas de cambio (diferencias con signo, cargo × pasajeros con asiento, saldo a favor no reembolsado, combinaciones de
    ida y vuelta, máximo 10, vencen en 15 min) y maletas (máximo 3 por pasajero e itinerario).
  - **Uso único:** una cotización y una oferta de cambio se consumen una sola vez (`SELECT … FOR UPDATE`); el mismo `sagaId`
    puede repetirlo; otra saga u otra reserva → `NOT_FOUND` (409); vencida → `QUOTE_EXPIRED` / `CHANGE_OFFER_EXPIRED` (410).
    `ReleaseDateChangeOffer` solo libera lo que tomó esa saga.
  - Docker Compose: `ms-g-post-sale` en `127.0.0.1:4008`.
- **Errores encontrados y corregidos durante la fase:**
  - La librería entrega `xs:date` y `xs:dateTime` como objetos `Date`; con `String(...)` el servidor leía la vigencia del acuerdo
    como `"Wed Jan 01"` y un acuerdo **vencido** pasaba por vigente (un combo se habría reembolsado sin penalidad). Ahora las
    fechas se convierten a ISO. Lo detectó la prueba del acuerdo vencido.
  - `CalculateCompensationRefund` con el mismo `sagaId` en paralelo devolvía resultados distintos (cada llamada calculaba el
    suyo aunque solo se guardaba uno). Ahora, después de guardar, se relee el resultado ganador. Una prueba mía era demasiado
    floja y aceptaba ese caso; se endureció (4 llamadas simultáneas → el mismo `quoteId`).
  - Pruebas: mi cálculo esperado del porcentaje estaba mal (114,50 / 214,50 = 53,38, no 53,37), y los elementos con
    `maxOccurs` llegan siempre como lista.
- **Verificación:**
  - `tsc -b` y `tsc -p tsconfig.spec.json` sin errores; lint sin advertencias.
  - Pruebas v2: **237/237** (PostSale: 16 con un **cliente SOAP real** construido desde el `?wsdl` publicado). Con PostgreSQL
    real (`POST_SALE_TEST_DATABASE_URL`, esquema temporal): **3/3** — 5 sagas consumen la misma cotización a la vez → una sola la
    usa; consumir, liberar y volver a consumir una oferta de cambio entre transacciones; compensación idempotente en paralelo.
  - **Verificación del plan:** pruebas con cliente SOAP ✔; el WSDL se publica en `?wsdl` ✔ (200, `application/xml`, el cliente
    se construye desde ahí con las 8 operaciones); `FLIGHT_CANCELLED` sin cotización exonera la penalidad ✔ (119,50 de 119,50);
    `SAGA_COMPENSATION` la exonera con el acuerdo B2B vigente ✔ — y **no** la exonera si el acuerdo no permite promociones,
    porque así lo dice el contrato v2.
  - Contenedor, con el token real del ESB: cabeceras SOAP con el mismo `CorrelationId` y un `RequestId` propio; consumir la
    cotización desde otra saga → Fault `NOT_FOUND` / 409 con el correlation id; 3 + 2 maletas → `BAGGAGE_LIMIT_EXCEEDED` / 422;
    sin token → 401. Los spans llegaron al Collector con el correlation id.
- **Pendiente:**
  - Auditoría de Gemini y aprobación del responsable.
  - **Decisión a confirmar:** con el acuerdo inicial con Booking ("sin promociones", 0 %), la cancelación de un **combo**
    (`package.cancelled` → `SAGA_COMPENSATION`) cobra la penalidad de las tarifas no reembolsables (devuelve solo impuestos).
    El contrato v2 lo permite ("si así lo permite el acuerdo B2B"), pero quizá no es lo que se espera de un combo que falló.
  - Llamar a PostSale desde las sagas del ESB (V2.10) y traducir el Fault a ProblemDetails.

### V2.7 (ajuste del 25/10) — D42: el combo cancelado siempre sin penalidad
- **Qué se pidió:** el responsable eligió la opción b: un combo de Booking que falla (`SAGA_COMPENSATION`) se reembolsa al 100 %
  sin penalidad, sin mirar el acuerdo de promociones.
- **Cómo se hizo:** `compensationWaived` ya no consulta el acuerdo; `partnerAgreement` sigue en el XSD (opcional, sin cambio de
  estructura) y se documentó que ya no cambia el resultado. Decisión **D42** en PLAN.md §7.
- **Verificación:** PostSale 20/20; en el contenedor, `SAGA_COMPENSATION` con el acuerdo actual (sin promociones) → 119,50 de
  119,50, penalidad 0, exonerada.

### V2.8 — MS.G FlightStatus, Webhooks y Customers — ✅ HECHA (25/10), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.8: FlightStatus (overrides, transiciones válidas, historial, proyección); Webhooks
  (suscripciones, entrega CloudEvents firmada, reintentos 1 min → 6 h, `event_log` con cursor, feed, filtro D40); Customers
  (perfil + `default_assistance`).
- **Cómo se hizo:**
  - **Bus interno (en `shared`, `bus/amqp.ts`, amqplib 2.2.0):** exchange `ecoairlines.events` (topic, durable) y routing key =
    nombre del evento, como dice `events.asyncapi.yaml`; cada servicio tiene su cola durable. El `correlationid` va en las
    propiedades AMQP y el dueño del hold o la reserva en la cabecera `x-owner-id`. Es el mínimo para consumir y publicar; los
    reintentos con espera y la cola de fallidos llegan en V2.11.
  - **`ms-g-flight-status`** (puerto 4005): consume `schedule.published` (cola `flight-status.schedule-published`) y arma la
    proyección `scheduled_flights` — nunca llama a Schedule (D4); idempotente por el `id` del evento; publicar una ruta solo
    reemplaza sus vuelos. Tabla de transiciones del contrato (`INVALID_STATUS_TRANSITION`), DELAYED con hora posterior y
    `delayMinutes`, CANCELLED con motivo, horas reales al salir y llegar, historial, y la compensación `revert` (solo el último
    cambio vigente, `CHANGE_NOT_LATEST`; idempotente). Los cambios de un mismo vuelo se serializan (candado por vuelo y fecha).
  - **`ms-g-webhooks`** (puerto 4003): consume TODO el bus (cola `webhooks.events`, `#`), guarda `event_log` (deduplicado por
    `id`) y crea una entrega por cada suscriptor permitido por **D40**: un partner recibe `hold.*`/`booking.*` solo de su canal
    (`x-owner-id` = `partner:<clientId>:…`) y `flight.*` siempre; un ADMIN, todo lo público; los internos, nunca. Entrega:
    `POST` del CloudEvent (sin el dueño), `X-Webhook-Signature` HMAC-SHA256 y `X-Correlation-Id`, éxito = 2xx en < 5 s,
    reintentos a 1 min, 5 min, 30 min, 2 h y 6 h y luego `EXHAUSTED`. Cada entrega se "toma" con un plazo de 30 s
    (`FOR UPDATE SKIP LOCKED`): dos réplicas no envían la misma. Los secretos se guardan cifrados (AES-256-GCM). Contra SSRF,
    en producción solo `https` y hosts que resuelven a direcciones públicas (también al entregar). Feed de respaldo con cursor
    `after`, historial del administrador (con internos; `booking.assistance_requested` sin datos) y estadísticas.
  - **`ms-g-customers`** (puerto 4002): un perfil por dueño (`PUT` crea 201 o reemplaza 200), un dueño partner → 403 y la
    asistencia predeterminada nunca en los logs.
  - **Offers:** su HTTP local pasó de 4005 a **4009** (el 4005 es de FlightStatus en su contrato; el choque fue un error mío de
    V2.5) y su outbox guarda el dueño del hold, para que el relé de V2.11 lo publique como `x-owner-id`.
  - `scripts/dev/publicar-horario.mjs` publica también `schedule.published` en el bus (hasta que lo haga la saga del ESB).
  - Docker Compose: los tres servicios con su base y el bus. Solo en local, `WEBHOOKS_ALLOW_PRIVATE_URLS=true` permite suscribir
    `http://booking-simulado` (en la nube no se define y rige la regla estricta).
- **Errores de contratos propios corregidos:**
  - `CustomerProfile` era el mismo `allOf` imposible de V2.3 y V2.6 (`ms-g-customers.openapi.yaml` 1.0.0 → 1.1.0). Esta vez se
    revisaron **todos** los contratos con un script: no queda ningún otro.
  - `events.asyncapi.yaml` no decía cómo sabe Webhooks de qué canal es un evento (el CloudEvent público no lleva el dueño, y no
    debe: es el cuerpo que recibe Booking). Se agregó la cabecera AMQP `x-owner-id` en `hold.*` y `booking.*` (generador
    actualizado; el parser oficial de AsyncAPI lo valida: 0 errores, 28 mensajes).
- **Errores encontrados y corregidos durante la fase:**
  - El validador de contrato de las pruebas exigía `secret` en las respuestas: en OpenAPI una propiedad `writeOnly` solo es
    obligatoria al enviarla. El validador ahora aplica esa regla.
  - En `WebhooksService` leí un evento por su `seq` recorriendo el historial por páginas; se reemplazó por `eventBySeq` en el
    almacén.
  - Pruebas mías mal planteadas: en FlightStatus supuse que ganaría la cancelación, pero `BOARDING → CANCELLED` también es
    válida; la prueba ahora comprueba la invariante real (el historial es una cadena: cada cambio parte del estado del
    anterior, y solo una cancelación).
- **Verificación:**
  - `tsc -b` y `tsc -p tsconfig.spec.json` sin errores; lint sin advertencias; Redocly y el parser de AsyncAPI válidos.
  - Pruebas v2: **266/266** (FlightStatus 10, Webhooks 11 con un receptor que verifica la firma, Customers 4). Con PostgreSQL
    real: **26/26** en los 8 servicios (nuevas: 4 `PATCH` simultáneos → historial en cadena y una sola cancelación; el mismo
    evento 4 veces → un registro y una entrega; dos réplicas toman entregas a la vez → cada una una sola vez).
  - **Verificación del plan, en los contenedores:** una transición inválida da `409 INVALID_STATUS_TRANSITION`
    ("No se puede pasar de DELAYED a ARRIVED."); **booking-simulado verificó la firma** de cada webhook (rechaza con 401 las
    firmas malas) y recibió la reserva de Booking y el cambio de vuelo; **la reserva de la web no se le entregó** (ni por webhook
    ni en el feed) y el dueño no aparece en el cuerpo. El webhook llevó el mismo `X-Correlation-Id`.
  - Además: FlightStatus armó la proyección desde el bus (4 vuelos por día; `health` con base y bus `up`); `revert` volvió a
    SCHEDULED; Customers creó (201), reemplazó (200) y rechazó a un partner (403) sin escribir la asistencia en los logs.
- **Pendiente:**
  - Auditoría de Gemini y aprobación del responsable.
  - V2.11: relé de los outbox (Offers, ESB) al bus, reintentos con espera y cola de fallidos.
  - Publicar `flight.status_changed` y calcular las reservas afectadas lo hace el ESB (V2.10).

### V2.9 — ESB: enrutador, composición, transversal y entrada de eventos — ✅ HECHA (25/10), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.9: clientes REST, gRPC y SOAP hacia los 9 MS.G y la Payment API con errores en ProblemDetails v2;
  enrutador y composición (health con caché < 1 s, operaciones, indicadores, asistencia, historial); transversal (idempotencia v2,
  validador de referencias de Booking, correlation ID); entrada de eventos de Booking con `inbound_events` (canal según BKG-01).
- **Cómo se hizo** (`services/esb`, puerto local **4000**, base `esb`):
  - **Contrato nuevo `contract/esb.openapi.yaml` 1.0.0** (API primero): el plan no decía cómo llaman los MS de respuesta al ESB.
    Propuesta **D43** (pendiente de aprobación): `/router/<servicio><ruta del MS.G>` para los MS.G REST, `POST /router/offers/<Rpc>`
    para Offers (mapeo JSON de proto3), `/composition/...` y la entrada de eventos. Redocly: válido.
  - **Clientes:** token de servicio del ESB (`client_credentials` contra Identity, en memoria, renovado antes de vencer, una sola
    petición aunque lo pidan muchas a la vez y renovado si un MS.G lo rechaza); REST; **gRPC** (Offers, con el `ProblemDetails` del
    trailer `x-problem-details-bin`: `HOLD_EXPIRED` sigue siendo 410 `HOLD_EXPIRED`); **SOAP** (PostSale: el WSDL se lee una vez y
    cada llamada usa su propio cliente, así las cabeceras `CorrelationId`/`RequestId` no se mezclan entre llamadas simultáneas; el
    `soap:Fault` vuelve a su `code` y `status`); **Payment API** (clave secreta `sk_test_…`, captura, anulación y reembolso; la usan
    las sagas de V2.10). Todos con plazo de 4 s (menor que los 5 s de Booking) y **circuit breaker** por MS.G (5 fallas → abierto
    10 s → una llamada de prueba). Un MS.G que no responde → `503 PROVIDER_UNAVAILABLE` con `Retry-After`.
  - **Enrutador:** tabla cerrada de 48 rutas REST (la del §4.2) + 5 RPC de Offers (`Search`, `GetSeatMap`, `CreateHold`, `GetHold`,
    `ReleaseHold`). Una prueba comprueba que cada ruta existe en el contrato del MS.G con su `operationId`, que ninguna es un paso de
    saga y que `x-esb-routes` del contrato es exactamente la tabla del código. Otra ruta del mismo servicio → 404/405; un segmento
    `..` (también `%2e%2e`) → 404, para que la URL no se normalice hacia una ruta que no está en la tabla. Las respuestas de los MS.G
    (también sus ProblemDetails) se devuelven tal cual.
  - **Idempotencia (D6):** `idempotency_claims` (24 h) por dueño + clave, con `request_hash`. Misma clave y cuerpo → respuesta
    guardada con `Idempotent-Replayed: true`; otro cuerpo → `409 IDEMPOTENCY_KEY_REUSED`; mientras la primera sigue en curso, las
    demás esperan y repiten su respuesta (nunca se ejecuta dos veces a la vez); un 5xx no se guarda. En PostgreSQL es una sola
    sentencia atómica (`INSERT … ON CONFLICT … DO UPDATE … WHERE` vencida o abandonada).
  - **Validador de referencias de Booking:** formato `PAY-BKP-AAAAMMDD-NNNNNN` con fecha real y no futura (configurable con
    `BOOKING_PAYMENT_REFERENCE_PATTERN` mientras Booking responde BKG-02) y monto exacto si llega (`AMOUNT_MISMATCH`).
  - **Composición:** health del nodo con la forma del contrato v2 (`VuelosHealthResponse`), calculado en segundo plano cada 5 s y
    servido desde caché: `DOWN` (503) si cae la base del ESB, Identity, Offers o Bookings (sin ellos no se vende a Booking),
    `DEGRADED` si cae otra pieza; panel de operaciones (Offers + FlightStatus: asientos por estado y cabina, ocupación, holds, check-in
    abierto 48 h antes, alertas y paginación); indicadores (Bookings + Identity + FlightStatus); asistencia por vuelo (FlightStatus +
    Bookings, solo con `X-Actor-Id`); salud por servicio e integración con Booking (Identity + Webhooks + Offers + eventos entrantes).
    El historial de eventos y entregas es una ruta del enrutador (`GET /router/webhooks/history`), como dice MS.Admin.
  - **Entrada de eventos de Booking (D34):** por **webhook** firmado (`POST /integraciones/booking/eventos`, HMAC sobre los bytes
    exactos) y por **AMQP** (exchange `booking.events`, cola `ecoairlines.esb.booking-inbound`), las dos vías de BKG-01. Cada
    CloudEvent se guarda por su `id` (`inbound_events`); uno repetido responde `202 duplicate: true` y no se procesa. Un trabajador
    lo procesa con el mismo `correlationid` (con varias réplicas, cada evento lo toma una sola: `FOR UPDATE SKIP LOCKED`):
    `payment.confirmed` → Offers `BOOKED → TICKETED` → Bookings emite → `booking.ticket_issued`; `payment.failed` → Offers libera →
    Bookings `FAILED` → `booking.failed`. Solo reservas **del canal Booking** y con **su** referencia de pago. Error de negocio →
    `REJECTED`; MS.G caído → `RETRY` (5 s, 30 s, 2 min, 10 min, 30 min y luego cada hora; nunca se descarta). `package.cancelled`
    queda en `WAITING_SAGA` hasta la saga "Cancelar" de V2.10.
  - Docker Compose: el ESB con su base, el bus interno y, en local, el "bus de Booking" simulado en nuestro RabbitMQ;
    booking-simulado envía sus eventos al ESB (`AIRLINE_EVENTS_URL`).
- **Decisiones que tomé y deben revisarse:**
  - **D43** (interfaz del ESB, arriba).
  - `POST /oauth2/token` pasa por el enrutador **sin** el token del ESB: el MS de respuesta (V2.12) convertirá el `Basic` del
    partner en `client_id`/`client_secret` en el cuerpo (`client_secret_post`, que Identity ya acepta), porque su propio
    `Authorization` es el token de servicio con el que llama al ESB. Al principio lo diseñé reenviando el `Authorization` del
    llamador, y eso no podía funcionar: lo corregí antes de terminar.
  - El panel de operaciones **no consulta Schedule**: el avión y los asientos ya están en Offers (copiados del horario publicado).
    La asistencia por vuelo **no consulta CheckIn**: el esquema del panel no lleva datos de check-in. El plan nombraba esas fuentes;
    si se quiere otro dato de ellas, se agrega.
  - "Marcar asistencia lista" no está en el enrutador: el contrato de CheckIn dice que después el ESB actualiza Bookings (dos MS.G
    en orden), así que va con las sagas de V2.10.
- **Errores encontrados y corregidos durante la fase:**
  - El reintento por token rechazado se habría disparado también con un 401 de negocio (`INVALID_CREDENTIALS` del login, que se
    habría enviado dos veces): ahora solo con `UNAUTHORIZED`.
  - `..` en la ruta llegaba como 405 en vez de 404 (no llegaba al MS.G, pero el código era incorrecto).
  - booking-simulado inventaba referencias `PAY-BKP-SIM-…`, que no cumplen el formato del contrato: ahora usa el formato real.
  - `events.asyncapi.yaml` aún decía "sin penalidad según el acuerdo" para el combo cancelado (contradice D42): corregido en el
    generador (solo cambió esa línea).
  - Pruebas mías mal planteadas: un `expect` dentro del Offers falso, datos de ejemplo que no cumplían `PassengerAssistance` y
    `DeliveryStats` (el validador de contrato lo detectó), y el nombre del puerto del WSDL en el servidor SOAP de prueba.
  - Dos pruebas pesadas de fases anteriores (Schedule recorre toda la ventana de venta; Identity genera dos claves RSA) pasaban
    los 5 s con la suite completa y Docker encendido. Pasan solas; se les dio un límite explícito de 30 s.
- **Verificación:**
  - `tsc -b` y `tsc -p tsconfig.spec.json` sin errores; lint sin advertencias; Redocly válido (`esb.openapi.yaml`).
  - Pruebas v2: **367/367** (ESB 100: enrutador, idempotencia, gRPC, composición validada contra su contrato, entrada de eventos,
    clientes SOAP/Payment API/token, circuit breaker y la tabla de rutas contra los contratos). Con PostgreSQL real, ESB **4/4**:
    8 peticiones simultáneas con la misma clave → 1 se ejecuta; el mismo evento 4 veces → 1 registro; dos réplicas → cada evento
    una sola vez.
  - **Verificación del plan, en los contenedores (★):** el mismo `payment.confirmed` llegó **tres** veces (booking-simulado por
    webhook, el reintento del webhook y por AMQP en `booking.events`): **un** registro en `inbound_events` (`PROCESSED`, 1 intento),
    los otros dos `duplicate`, **un** boleto emitido, **una** emisión en el historial de Bookings y **un** `booking.ticket_issued`
    (Webhooks lo registró con el `correlationid` de Booking).
  - Además: health `HEALTHY` en 4–8 ms con las 12 dependencias; `CreateHold` repetido con la misma clave → mismo hold e
    `Idempotent-Replayed`, con otro cuerpo → 409; un paso de saga por el enrutador → 405; firma mala → 401; otra referencia de pago
    para la misma reserva → `REJECTED PAYMENT_REFERENCE_INVALID`; operaciones, indicadores e integración con Booking con datos
    reales. El `correlationid` del pago aparece en los logs del ESB, Bookings y Offers y en 5 spans del Collector.
- **Pendiente:**
  - Auditoría de Gemini y aprobación del responsable (incluida **D43**).
  - V2.10: el motor de sagas con `saga_log` (los pasos de "Emitir boletos" y "Pago fallido" pasan a él), "Cancelar" para
    `package.cancelled` (los que quedaron `WAITING_SAGA`) y "marcar asistencia lista".
  - V2.11: **outbox** del ESB. Hoy el ESB publica después de cada paso: si el bus fallara justo entre la emisión y la publicación,
    el reintento vería los boletos ya emitidos y no volvería a publicar `booking.ticket_issued`. El outbox lo resuelve.
  - V2.12: clientes de servicio propios para cada MS de respuesta en Identity (hoy el ESB acepta cualquier token de servicio).

### V2.10 — ESB: orquestador (11 sagas) — ✅ HECHA (25/10), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.10: `saga_log` y motor de pasos con compensación; las 11 sagas de §4.2. Verificación: cada saga
  en su camino feliz y con un fallo simulado en cada paso; el combo de Booking (hold → reserva → `SAGA_COMPENSATION`) deja el
  inventario como estaba; cancelar un vuelo con 3 reservas deja 3 reembolsos calculados, los asientos liberados y el stock en 0.
- **Cómo se hizo** (`services/esb/src/sagas`; contrato `esb.openapi.yaml` 1.0.0 → **1.1.0**):
  - **Motor (`engine.ts`) y `saga_log`:** cada saga tiene su `sagaId` y guarda cada paso con su resultado.
    - Si un paso falla **antes del punto sin retorno**, se compensan los pasos hechos en orden inverso y vuelve el error del paso.
    - La compensación de cada paso se registra **antes** de ejecutarlo (estado `STARTED`): si el paso falla por plazo vencido
      (no se sabe si el MS.G lo hizo) o la réplica se cae a la mitad, también se deshace. Por eso cada compensación es segura
      aunque el paso no haya ocurrido.
    - **Después del punto sin retorno** (p. ej. "Cancelar" después de PostSale) un MS.G caído no compensa: la saga se reintenta
      hacia adelante (2 s, 10 s, 30 s, 2 min, 10 min, 30 min). Un error de negocio ahí no se arregla reintentando: queda
      `FAILED` (revisión). Una compensación rechazada por una regla también deja `FAILED`; una con el MS.G caído queda
      `COMPENSATING` y se reintenta.
    - Un **trabajador de recuperación** retoma las sagas abandonadas (réplica caída, plazo de 60 s vencido) con el mismo
      `sagaId`: los pasos hechos devuelven su resultado guardado y no se repiten (`FOR UPDATE SKIP LOCKED`: dos réplicas no
      retoman la misma).
    - Cada llamada a Offers usa un `sagaId` derivado por operación (Offers guarda el resultado por `sagaId`: la compensación
      no puede usar el mismo que el paso).
    - Los eventos se publican en el último paso con un `id` derivado del `sagaId`: si la saga se reanuda, Webhooks descarta el
      repetido.
  - **Plazo de Booking:** si la saga no termina en 4,5 s se responde `202` (`TICKET_ISSUING` en "Crear reserva",
    `CANCELLATION_PENDING` en "Cancelar") y la saga sigue en segundo plano. `GET /sagas/{id}` muestra su estado sin su entrada
    (datos personales y de salud), solo a su dueño o a un administrador.
  - **Las sagas** (`/sagas/...`, con `Idempotency-Key`): Crear reserva (+ asistencia), Emitir boletos, Pago fallido, Cambiar
    asientos, Check-in, Cancelar, Cambiar fecha, Agregar maletas, Cambiar estado de vuelo, Guardar precios y descuento máximo,
    Publicar horario; además **Marcar asistencia lista** (pendiente de V2.9: CheckIn y luego Bookings).
  - **Pagos (`pago*`):** canal Booking → valida la referencia y su uso único (no cobra); canal web → captura en la Payment API y,
    si la saga falla, reembolso o anulación. **Reembolso:** canal Booking `CALCULATED`; web `SETTLED`.
  - **Consultas de postventa** (Bookings + PostSale): cotización de cancelación, opciones de maletas y búsqueda de cambio de
    fecha. En la búsqueda, el ESB guarda los itinerarios de cada oferta (`change_offers`) para la confirmación.
  - **Eventos de Booking:** `payment.confirmed` y `payment.failed` pasan al motor; `package.cancelled` ejecuta "Cancelar" con
    `SAGA_COMPENSATION` si el combo es el de la reserva. Los guardados en `WAITING_SAGA` (V2.9) se procesan solos.
  - `POST /sagas/timetable/publish` publica toda la ventana y los precios: reemplaza a `scripts/dev/publicar-horario.mjs`.
- **Decisiones que tomé y deben revisarse:**
  - Cambiar asientos no cobra si no llega un monto (los asientos de EcoAirlines no tienen precio); si el canal envía un monto,
    se valida y se registra el pago.
  - Cambiar fecha ignora `assignedSeats` del contrato (no dice de qué pasajero es cada asiento): los asientos nuevos los asigna el
    check-in.
  - `affectedBookingIds` de `flight.status_changed` lleva solo las reservas del canal Booking (D40: los ids de la web no salen).
  - Con descuento de promoción, la tarifa guardada en la reserva es la cobrada (el reembolso nunca supera el cobro).
- **Errores encontrados y corregidos:**
  - **MS.G.PostSale** no compensaba una reserva `TICKET_ISSUING` (un combo puede fallar antes de emitir los boletos): ahora
    `CalculateCompensationRefund` acepta `TICKET_ISSUING`, `CHANGE_PENDING` y `CANCELLATION_PENDING` (la cotización del cliente
    sigue exigiendo `CONFIRMED`). XSD documentado.
  - **Dos cancelaciones simultáneas** de la misma reserva: la segunda tomaba el `ALREADY_CANCELLED` de Bookings como un
    reintento propio y publicaba otro `booking.cancelled`. Ahora solo es suyo si el reembolso guardado es el suyo (su `refundId`
    sale del `sagaId`); si no, termina sin publicar.
  - **Logs de PostSale sin `correlation_id` (viene de V2.7):** el log de peticiones leía el contexto al terminar la respuesta y
    la librería `soap` la termina fuera de él; ahora se toma al llegar (librería compartida). Además el ESB manda el correlation
    id también en la cabecera HTTP de las llamadas SOAP. En V2.7 había comprobado la cabecera SOAP, no los logs.
  - Mío en el diseño: al principio la compensación se registraba DESPUÉS del paso, y un paso hecho en el MS.G pero no guardado
    (caída a la mitad) no se habría deshecho. Lo corregí antes de probar (estado `STARTED`).
  - Errores de mis pruebas, que detectó el validador de contrato: datos falsos sin campos obligatorios, un id fijo de reserva
    cuando el ESB lo genera, y un plazo de prueba menor que la demora simulada. En la verificación real, mi generador de cédulas
    a veces daba un tercer dígito ≥ 6 (inválido): Bookings lo rechazó y la saga quedó compensada sin tocar nada, como debe.
- **Verificación:**
  - `tsc -b` y `tsc -p tsconfig.spec.json` sin errores; lint sin advertencias; Redocly válido (`esb.openapi.yaml` 1.1.0).
  - Pruebas v2: **412/412** (sagas 43: camino feliz de cada saga y **un fallo en cada paso** con la lista exacta de
    compensaciones en orden inverso; respuestas validadas contra el contrato; reanudar RUNNING y COMPENSATING; plazo de 5 s;
    idempotencia; cancelaciones simultáneas). Con PostgreSQL real: ESB **7/7** (saga_log, dos réplicas retomando sagas, change
    offers) y PostSale 3/3.
  - **Verificación del plan en los contenedores (★):**
    - **Combo de Booking:** inventario ECONOMY antes 162 libres → con la reserva 161 (1 `TICKETED`) → tras `package.cancelled`
      (booking-simulado) 162; el stock enviado a Booking igual (162 → 161 → 162). Reembolso `CALCULATED` del 100 %, sin
      penalidad.
    - **Vuelo cancelado con 3 reservas:** las 3 `CANCELLED` con reembolso `CALCULATED` 104,00, penalidad 0; Offers 162 libres y
      la venta cerrada; **stock a Booking 0**; el vuelo ya no aparece en la búsqueda; `flight.status_changed` y `flight.cancelled`.
  - Además, con los servicios reales: crear reserva (201 en ~90 ms), cambiar asiento, maletas, check-in con su pase (BCBP de 60
    caracteres), un segundo check-in → 409, cambio de fecha, cotización y cancelación del cliente (24,00 de reembolso, 80,00 de
    penalidad), cancelar otra vez → 409; con **Offers apagado**, cancelar → `202 CANCELLATION_PENDING` en 4 s y la saga terminó
    sola al volver Offers (2 intentos, sin repetir PostSale). El correlation id aparece en los logs del ESB y de los 5 MS.G
    usados; ningún documento de pasajero en los logs.
- **Pendiente:**
  - Auditoría de Gemini y aprobación del responsable (incluida **D43**).
  - V2.11: outbox del ESB y de Offers con relé al bus, reintentos con espera y cola de fallidos (la publicación de eventos
    todavía es directa; un id derivado evita duplicados, pero un evento puede perderse si el bus falla justo en ese paso).
  - V2.15: Payment API real (el canal web está probado contra una Payment API falsa); el pago `PENDING` responde hoy 409
    `PAYMENT_NOT_AUTHORIZED` y en V2.15 pasará a `202` con reintento diferido.

### V2.11 — Eventos con RabbitMQ — ✅ HECHA (26/10), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.11: exchange, colas durables, reintentos y *dead letter*; *outbox* en el ESB y en Offers;
  consumidores Webhooks y FlightStatus; eventos nuevos del contrato v2 y los propios. Verificación: los eventos internos y de
  salud no salen a Booking; cada CloudEvent lleva el `correlationid` del proceso.
- **Cómo se hizo:**
  - **Bus (`packages/shared/src/bus/amqp.ts`):**
    - Publicación con **confirmación del broker** (`publish` resuelve cuando RabbitMQ guardó el mensaje).
    - Por cada cola de consumidor, 4 colas de espera (`<cola>.retry.1s/5s/30s/2m`, TTL fijo cuyo *dead letter* devuelve el
      mensaje SOLO a esa cola, sin duplicarlo en los otros consumidores) y, al **5.º intento**, la cola de fallidos `<cola>.dlq`
      por el exchange `ecoairlines.dlx`, con el motivo, la routing key original y la hora. Un mensaje ilegible va directo a la
      de fallidos. El consumidor escribe una línea de **ALERTA**.
    - **Reconexión automática:** si RabbitMQ se cae o se reinicia, cada servicio se reconecta solo (1 s, 2 s, 5 s, 10 s y luego
      cada 30 s) y vuelve a declarar sus colas y consumidores.
  - **Outbox (`packages/shared/src/bus/outbox.ts`, un relé común):** toma los pendientes con un plazo (dos réplicas no publican
    el mismo), los publica en orden y los marca solo después de la confirmación; si el bus falla, quedan pendientes. Entrega "al
    menos una vez": los consumidores deduplican por `id`.
    - **Offers:** su outbox existía desde V2.5 pero nadie lo publicaba: `hold.created` y `hold.expired` **no llegaban a Booking**.
      Ahora tiene su relé (`BUS_URL`, obligatoria en producción); al arrancar publicó los 33 `hold.created` acumulados.
    - **ESB:** sus eventos (sagas, compensaciones, eventos de Booking y enrutador) van a la tabla `outbox` de la base `esb`, por
      su `id` estable: guardarlo dos veces no lo duplica. Cierra el pendiente de V2.10 (un evento podía perderse si el bus
      fallaba en ese paso).
  - **Reintentos diferidos del ESB (`esb.deferred`, TTL + dead letter, como dice el plan):** cuando una saga queda pendiente se
    publica una `DeferredTask` en la cola de espera de su demora (`esb.deferred.wait.2s` … `.30m`); al vencer, llega a
    `esb.deferred` y el ESB retoma esa saga en ese momento. El sondeo de `saga_log` queda como respaldo.
  - **Eventos nuevos:**
    - Propios, desde el enrutador y solo si la escritura salió bien (una respuesta repetida por idempotencia no publica):
      `user.created`, `user.role_changed`, `user.blocked`, `partner.created`, `partner.blocked`, `partner.secret_rotated` (nunca
      con el secreto) y `booking.assistance_requested` (`REQUESTED` / `REMOVED`, nunca el tipo ni las notas).
    - Compatibilidad con v1: `flight.schedule_changed` (al pasar a `DELAYED`) y `booking.ticket_issuing` (solo cuando "Crear
      reserva" responde `202`).
    - Con esto, los **15** eventos públicos del contrato del grupo tienen productor. Una prueba lo comprueba leyendo el código:
      cada evento que se produce existe en `events.asyncapi.yaml` con su misma visibilidad, y ninguno público se inventa.
  - **Contratos:** `events.asyncapi.yaml` (generador) documenta la topología real: colas de espera, cola de fallidos, cabeceras y
    colas diferidas, con los 12 tipos de saga. El parser oficial lo valida: 0 errores, 0 avisos. `esb.openapi.yaml` 1.1.0 →
    **1.1.1** (`X-Owner-Id`).
- **Errores encontrados y corregidos:**
  - **El ESB rechazaba las suscripciones de webhooks de Booking (viene de V2.9):** exigía `partner:<clientId>:<usuario>`, y una
    suscripción es del partner completo (`partner:BOOKING_PROTOTIPO`, como la guarda Webhooks). Lo encontró la verificación en los
    contenedores.
  - **La cola de FlightStatus tenía otro nombre que el contrato** (`flight-status.schedule-published` en vez de
    `flight-status.schedule`; error mío de V2.8). Se corrigió y se borró la cola vieja de RabbitMQ.
  - **Mío en el bus:** al volver de un reintento, el mensaje llega con la cola como routing key, y en la cola de fallidos se
    perdía la del evento. Lo detectó la prueba con RabbitMQ real; ahora se guarda en `x-original-routing-key`.
  - **Mío en el diseño:** al principio el bus no se reconectaba. Con RabbitMQ reiniciado, los consumidores habrían quedado muertos
    y el outbox no habría podido publicar nunca. Lo corregí antes de levantar los contenedores.
  - Un evento de Booking que llegaba por AMQP (`booking.events`) se confirmaba y se perdía en silencio si la base del ESB estaba
    caída: ahora se reintenta y, agotado, va a la cola de fallidos (un evento de Booking nunca se pierde).
  - Errores de mis pruebas y scripts: cerrar la conexión antes de que saliera el mensaje, mal leído el formato del simulador, un
    escáner que no veía la visibilidad fijada una vez para todo un archivo, un import dinámico lento. Dos pruebas nuevas con
    PostgreSQL real tardan < 1 s solas pero pasaban los 5 s con la suite completa y Docker encendido (comprobé que no eran
    conexiones agotadas: 18 de 100); tienen un límite de 30 s.
- **Verificación:**
  - `tsc -b` y `tsc -p tsconfig.spec.json` sin errores; lint sin advertencias; Redocly y el parser de AsyncAPI válidos.
  - Pruebas v2: **439** (+ bus con RabbitMQ real 3/3: 5 intentos y luego la cola de fallidos con sus cabeceras; el reintento no
    duplica en otros consumidores; un mensaje ilegible va directo). Con PostgreSQL real: los dos outbox con dos réplicas a la vez.
  - **Verificación del plan, en los contenedores (★):**
    - Booking suscrito a los 15 eventos públicos. Con un mismo correlation id se hizo un hold de Booking, un hold de la WEB, una
      reserva de Booking, un pedido de asistencia, un usuario nuevo, guardar precios y una demora de vuelo. **Booking recibió**
      `hold.created` (el suyo), `booking.confirmed`, `booking.ticket_issued`, `flight.status_changed` y `flight.schedule_changed`.
      **No recibió** el hold de la web ni ningún interno (`user.created`, `pricing.changed`, `booking.assistance_requested`
      quedaron en el historial con 0 entregas). Ni datos de salud, ni contraseñas, ni el dueño interno en los webhooks.
    - **10 de 10** eventos en `event_log` con el `correlationid` del proceso.
  - Además:
    - **RabbitMQ apagado:** una reserva se creó igual (201 CONFIRMED); quedaron 2 eventos en el outbox del ESB y 1 en el de
      Offers. Al encender el broker, todos los servicios se reconectaron solos, los outbox quedaron en 0 y Booking recibió
      `hold.created`, `booking.confirmed` y `booking.ticket_issued` de ese proceso.
    - Un mensaje ilegible en el bus terminó en `webhooks.events.dlq` con su línea de ALERTA.
- **Pendiente:**
  - Auditoría de Gemini y aprobación del responsable (incluida **D43**).
  - V2.16: la alerta de la plataforma de observabilidad por mensajes en las colas de fallidos y el panel de colas
    (`getQueues` de MS.Admin); hoy queda la línea de ALERTA en el log.
  - El puente opcional al bus del ecosistema (`booking.events`, routing `vuelos.<evento>`): solo si el grupo lo pide (BKG-01).

### V2.12 — Microservicios de respuesta (5) — ✅ HECHA (26/10), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.12: MS.Vuelos, MS.Reservas, MS.Postventa, MS.Clientes y MS.Admin según
  `contract/ms-*.openapi.yaml`; tokens de usuario y de partner (JWKS), scopes, DTOs exactos al contrato v2, `ProblemDetails` v2
  y rate limit. Verificación: pruebas de `auth` y `security` adaptadas; sin token de partner, `X-User-Id` se ignora; el partner
  recibe `403` en `PUT /promociones/contrato`.
- **Cómo se hizo:**
  - **Kit común (`packages/shared/src/respuesta/`):** cada MS declara solo sus *handlers*; el resto sale del contrato.
    - `contract.ts` carga el contrato del MS (con sus `$ref` al del grupo) y arma la tabla de operaciones. Al arrancar se
      comprueba que los *handlers* y las operaciones coinciden exactamente (ni falta ni sobra ninguna).
    - Orden de cada petición: ruta del contrato (`405` si el método no existe) → token (JWKS de Identity, RS256) y scopes →
      rate limit → saneo y validación con Ajv (parámetros, cabeceras y cuerpo, con los `default` del contrato) → *handler* →
      **proyección** de la respuesta: se quita lo no declarado y lo `writeOnly` (en el cuerpo que se reenvía, lo `readOnly`).
    - `principal.ts`: el **dueño sale del token** (D29). Usuario → `sub`. Partner → `partner:<clientId>:<X-User-Id>`; sin
      `X-User-Id`, la huella del dispositivo (el contrato la llama "respaldo de propiedad") → `partner:<clientId>:fp:<huella>`;
      sin ninguna, `400`. `X-User-Id` sin token de partner se ignora. El actor (`X-Actor-Id`) solo existe para un usuario ADMIN.
    - Errores: `ProblemDetails` v2 con `instance` = la ruta pública. Un `code` propio que no está en el enum del contrato pasa a
      `type: urn:ecoairlines:problema:<CODE>` y `code` queda en el genérico de su status.
    - Seguridad HTTP: helmet (CSP `default-src 'none'`), CORS cerrado, límite de cuerpo 100 kb, JSON mal formado → `400`, claves
      `__proto__`/`constructor`/`prototype` y caracteres de control rechazados, rate limit por dueño (300/min; búsqueda 30;
      mapa de asientos 60).
    - `esb-client.ts`: cliente del ESB con su token de servicio, `X-Owner-Id`, `X-Actor-Id`, `Idempotency-Key`, correlación,
      plazo por llamada y *circuit breaker*. `sagas.ts`: si el ESB responde `202` con `sagaId`, se consulta la saga y se devuelve
      lo que dice el contrato (resultado, error o pendiente).
  - **Los 5 MS (`services/respuesta/`, puertos 5001–5005):** traducen el contrato público a las rutas del ESB (D43) y no
    conocen a los MS.G (regla 6 nueva de la prueba de arquitectura: sin `ms-g-*`, gRPC, SOAP, AMQP ni PostgreSQL en su `src/`).
    MS.Clientes publica `POST /oauth2/token` (convierte el Basic del partner a `client_secret_post`; errores en formato OAuth2).
    Las 4 operaciones de observabilidad de MS.Admin responden `503` hasta V2.16 (documentado en su contrato).
  - **D44 (nueva, pendiente de aprobación):** cada MS de respuesta tiene su cliente en Identity (`ECOAIRLINES_MS_VUELOS` …
    `ECOAIRLINES_MS_ADMIN`, solo por *seed*, secreto `MS_<NOMBRE>_CLIENT_SECRET`). Su token lleva el scope `ecoairlines:esb`:
    el ESB lo acepta y los MS.G lo rechazan (solo aceptan al ESB).
  - **D45 (nueva, pendiente de aprobación):** `PATCH /vuelos/flights/{n}/status` con token de partner (`flights:ops`) → `403`:
    la auditoría exige un actor ADMIN.
  - **ESB:** composición nueva `GET /composition/bookings/{id}/boarding-passes` (dueño en Bookings, pases de CheckIn y puerta
    actual de FlightStatus); se quitó la ruta del enrutador que daba los pases sin comprobar el dueño.
  - **Contratos:** `ms-vuelos`, `ms-postventa`, `ms-clientes` 1.0.1; `ms-reservas` 1.1.0; `ms-admin` 1.1.0 (filtros y
    paginación de listas, `503` de observabilidad); `esb.openapi.yaml` 1.2.0; `ms-g-identity.openapi.yaml` 1.3.0 (D44). Redocly
    válido; `verificar_operaciones_v2.py` 30/30.
  - Docker: los 5 servicios en `infra/docker-compose.yml` (dependen del ESB e Identity sanos); secretos en `infra/.env.example`.
- **Errores encontrados y corregidos:**
  - **Contrato (mío, V2.1):** `WebBookingRequest.assistance` usaba `allOf` con un schema `additionalProperties: false` y
    rechazaba `passengerId`. Mismo error en el contrato del ESB. Corregido en los dos generadores.
  - **Seguridad:**
    - `HoldRequest` no cierra propiedades y Offers prefiere un `ownerId` del cuerpo: un partner podía crear un hold a nombre de
      otro. MS.Reservas arma el cuerpo campo por campo, con el dueño del token.
    - Cancelar con `SAGA_COMPENSATION` o `FLIGHT_CANCELLED` daba el 100 % de reembolso a cualquiera. Ahora `FLIGHT_CANCELLED`
      → `400` para todos (lo usa solo la saga) y `SAGA_COMPENSATION` solo con token de partner.
    - Los pases de abordar del enrutador no comprobaban el dueño → composición (arriba).
  - **El ESB se caía** si PostgreSQL tardaba en responder: los ciclos de fondo (salud, entrada de eventos, recuperación de
    sagas, relé del outbox) dejaban una promesa rechazada sin capturar. Corregido con pruebas de regresión.
  - **Webhooks y FlightStatus se caían al arrancar** si RabbitMQ se estaba reiniciando (`getaddrinfo ENOTFOUND rabbitmq`): la
    reconexión de V2.11 solo cubría conexiones ya abiertas. Ahora `EventBus.connect` reintenta la primera conexión hasta 60 s.
  - **Míos en los MS:** la proyección quitaba lo `writeOnly` también del cuerpo enviado (se perdía el `secret` del webhook);
    el dueño de partner sin `X-User-Id` era `partner:<clientId>` y Bookings lo rechaza; MS.Clientes pedía el token de partner al
    ESB **sin** su token de servicio (confundí los dos saltos: el que va sin token es ESB → Identity). Las pruebas unitarias no
    lo veían porque el ESB falso no revisa la autenticación; lo encontró la suite de conformidad.
  - **Suite de conformidad (mía, V2.1):** generaba cédulas sin dígito verificador válido y referencias de pago con letras;
    exigía `secret` (`writeOnly`) en la respuesta del webhook; y esperaba `409/410` para una oferta de cambio inexistente,
    cuando el contrato también documenta `404` (lo que responde la saga del ESB).
- **Verificación:**
  - `tsc -b` y `tsc -p tsconfig.spec.json` sin errores; lint sin advertencias.
  - Pruebas v2: **527** pasan (38 omitidas, las de bases y broker reales). De ellas, 89 de los MS de respuesta, con `auth` y
    `security` adaptadas de `EcoAirlines.API`.
  - **Suite de conformidad contra los 5 MS en Docker** (con un proxy de prueba que reparte `/api/v2` por MS; el gateway es
    V2.13): **54/54**, **30/30 operaciones**, 57 combinaciones operación+status.
  - **Verificación del plan, en los contenedores (★):**
    - Partner en `PUT /vuelos/promociones/contrato` → **403**.
    - Un usuario que manda `X-User-Id: usr-conformidad` ve **0** reservas; el partner con ese mismo usuario ve 8.
    - El token de un MS de respuesta (`ecoairlines:esb`) contra MS.G.Bookings → **403** "Solo el ESB puede llamar a este servicio".
- **Pendiente:**
  - Auditoría de Gemini y aprobación del responsable (incluidas **D44** y **D45**, la huella como respaldo del dueño, el `type`
    `urn:` para códigos propios y la restricción de los motivos de cancelación).
  - V2.13: el gateway reemplaza el proxy de prueba. V2.16: observabilidad de MS.Admin.

### V2.13 — Gateway: `/api/v2/vuelos` + GraphQL — ✅ HECHA (26/10), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.13: fachada REST `/api/v2/vuelos/*` con token de partner y Swagger en `/api/docs`; GraphQL en
  `/api/graphql` según `gateway.graphql`. Verificación: la suite de conformidad v2 pasa completa contra el gateway en local,
  más pruebas GraphQL.
- **Cómo se hizo (`services/gateway`, puerto 8080 en el contenedor y 8088 en el host):**
  - **Fachada REST:**
    - Tabla cerrada armada desde los contratos de los 5 MS: las **30 operaciones** del contrato v2, cada una hacia el MS de su
      `x-microservice`, más `POST /api/v2/oauth2/token` y el alias `/oauth2/token` (BKG-03). Al arrancar se compara con
      `vuelos-openapi-v2.yaml`: si falta, sobra o cambia de MS una operación, el gateway no arranca. Las operaciones propias
      (`/ecoairlines/...`) no se publican en REST (D23).
    - En las operaciones protegidas verifica el token con la JWKS (usuario o partner; sin token, inválido, vencido o de
      servicio → `401` con `WWW-Authenticate`). Los scopes y el dueño los decide el MS, que vuelve a verificar el token.
    - `X-Correlation-Id` se crea si no llega, nunca se cambia y va en toda respuesta; `X-Request-Id` es nuevo en cada salto.
    - Cabeceras en lista cerrada en los dos sentidos: no viajan cookies ni cabeceras internas.
    - Límite de búsquedas por `X-Device-Fingerprint` (`429` con `Retry-After`). No hay límite global por IP en el gateway:
      todo Booking llega desde pocas IP, y ese límite ya lo pone cada MS por dueño.
    - Si el MS no responde: `503 PROVIDER_UNAVAILABLE` con `Retry-After` (plazo y circuit breaker por MS).
  - **Swagger** en `/api/docs`, con el contrato v2 tal cual y, solo en memoria, este gateway como primer servidor. CSP propia
    para Swagger; el resto responde con `default-src 'none'`.
  - **GraphQL** (`@nestjs/graphql` 14.0.3 + Apollo Server 5.5.1, esquema primero con `contract/gateway.graphql`):
    - Cada campo llama a la operación REST de su MS (las 72 flechas `→ MS.X operación` del contrato), con el token del
      usuario; nada llama al ESB ni a un MS.G (regla 7 nueva de la prueba de arquitectura).
    - Solo tokens de usuario: uno de partner o de servicio → `UNAUTHENTICATED`. Sin token en una operación protegida, HTTP
      `401`; un error de negocio, HTTP `200` con `errors`.
    - Directivas: `@auth(scopes)` exige todos los scopes; `@constraint` valida argumentos e inputs con nombres de GraphQL
      (`input.passengers.adults`); `@idempotent` comprueba al arrancar que la mutation tenga `idempotencyKey: UUID!`, que se
      envía como `Idempotency-Key`. Al arrancar se exige además que cada campo raíz tenga resolver y `@public` o `@auth`.
    - Errores: el ProblemDetails v2 en `extensions`, con `code` del enum `ProblemCode`. `UNAUTHORIZED` se llama
      `UNAUTHENTICATED`, y un código propio publicado en `type: urn:ecoairlines:problema:X` (V2.12) recupera su nombre
      (p. ej. `EMAIL_ALREADY_REGISTERED`). Un error no controlado sale como `INTERNAL_ERROR` sin detalles.
    - Escalares validados (`UUID`, `Date`, `DateTime`, `IataCode`, `Decimal`, `URL`…); profundidad máxima 10; complejidad
      máxima 1000 (una lista con `limit` multiplica); introspección solo en desarrollo; sin la página de pruebas (carga
      scripts de un CDN); protección CSRF de Apollo.
    - Pagos de la web: siempre `provider: AIRLINE_DIRECT` (D28). Cancelar desde la web: siempre `CUSTOMER_REQUEST`.
  - **D46 (nueva, pendiente de aprobación):** quién verifica qué. El gateway verifica el token (REST: usuario o partner;
    GraphQL: solo usuario) y lo **reenvía** al MS de respuesta, que lo vuelve a verificar y saca el dueño de él. El gateway no
    tiene token de servicio propio.
  - **D47 (nueva, pendiente de aprobación):** la suscripción `bookingEvents` (graphql-ws en `/api/graphql`) consulta cada 3 s
    el feed `GET /vuelos/eventos` de MS.Vuelos con el token del usuario. Así el gateway no se conecta al bus y la web ve
    exactamente lo mismo que el feed. Sin token de usuario la conexión no se abre; si el token vence, termina con
    `UNAUTHENTICATED`.
  - **Cambios fuera del gateway que la fase necesitaba:**
    - Identity: el token de usuario lleva el claim `email` (la query `me` no llama a ningún servicio). Contrato 1.4.0.
    - MS.Reservas: operación propia `listRefunds` (`Booking.refunds` de GraphQL): los reembolsos los guarda Bookings y el
      contrato v2 no los publica. Contrato 1.2.0.
    - `gateway.graphql` 1.1.0: `refunds → MS.Reservas listRefunds`; el `secret` de un webhook se devuelve siempre como
      `••••••••` (el contrato v2 no lo devuelve nunca, ni parcial).
    - Docker: `gateway` en `infra/docker-compose.yml` (depende de los 5 MS sanos) y `TRUST_PROXY=1` en los 5 MS, que ahora están
      detrás del gateway. En el host el gateway queda en **8088** (`GATEWAY_HOST_PORT`): Windows reserva el 8080 (`http.sys`).
- **Errores encontrados y corregidos:**
  - **Seguridad (viene de V2.8/V2.12): un CLIENTE veía en `GET /vuelos/eventos` los eventos públicos de TODOS los canales**,
    incluidas las reservas de Booking con su PNR y su dueño. Webhooks daba "todo lo público" a cualquier dueño que no fuera
    partner (pensado para la suscripción de un ADMIN), y el feed acepta tokens de usuario con `flights:read`. Ahora un usuario
    solo lee los eventos de sus reservas; un ADMIN todo lo público si el ESB envía `X-Actor-Id` = su `sub` (MS.Vuelos lo
    envía). `ms-g-webhooks.openapi.yaml` 1.1.0. Lo encontré al diseñar la suscripción; con el gateway público habría quedado
    expuesto en Internet. En Docker, un cliente nuevo ve solo el `hold.created` de su hold.
  - **Míos en el gateway:** el resolver de la suscripción devolvía el objeto `{ bookingEvents }` en vez del evento; las
    pruebas de profundidad y complejidad no probaban lo que decían (campos inexistentes; una consulta de ~500 puntos). Los
    encontraron las propias pruebas.
  - **Míos en el entorno:** un `\b` de una expresión regular quedó como carácter de control al escribirlo con un script (ya
    me había pasado en V2.12; ahora reviso todos los archivos); un comando quedó esperando entrada.
  - **Dependencias:** `@apollo/server` traía `@graphql-tools/*` del 15/10 (menos de 2 semanas): se fijan las del 07/09 como
    dependencias directas del gateway (`overrides` de npm no las aplicaba). `es-module-lexer` 3.0.4 (15/10, de OpenTelemetry,
    viene de V2.11) pasa a 3.0.3. Quedan dos paquetes recientes solo de desarrollo (`@redocly/openapi-core` y
    `uri-js-replace`, de `openapi-typescript`), que no entran en las imágenes.
  - **Pruebas que fallaban al azar con la suite completa** (CPU saturada con un worker por núcleo): plazos de `beforeAll`,
    el plazo de saga de 1 s en `sagas.spec` (ahora 2,5 s), el health < 1 s de MS.Vuelos y el límite de Identity. La suite v2
    usa ahora la mitad de los núcleos (tarda 42 s en vez de 48–55 s) y `hookTimeout` de 30 s; la prueba de Identity tiene
    20 s. Con estos ajustes, 4 corridas seguidas de la suite completa en verde.
  - **graphql 16 en vitest:** el código fuente tomaba la entrada ESM y las dependencias la CJS (dos copias de graphql). Alias
    en `vitest.config.v2.ts` a la CJS (en producción Node siempre usa la CJS).
- **Verificación:**
  - `tsc -b` y `tsc -p tsconfig.spec.json` sin errores; lint sin advertencias; Redocly válido; `verificar_gateway_graphql.cjs`:
    SDL válido, 0 cambios incompatibles con la base del Reto 1, 72 referencias `→ MS.X` existentes.
  - Pruebas v2: **581** (38 omitidas, las de bases y broker reales). Del gateway, 49: REST 21, GraphQL 25 y la suscripción
    por WebSocket 3.
  - **★ Suite de conformidad v2 contra el gateway en Docker (`http://localhost:8088/api/v2`): 54/54, 30/30 operaciones.**
  - **Pruebas GraphQL contra Docker (24 comprobaciones):**
    - registro, `me`, búsqueda con huella, hold, `hold` ajeno → `NOT_FOUND` y liberar el hold;
    - reserva web → `PROVIDER_UNAVAILABLE` hasta la Payment API (V2.15), con el mensaje de la saga;
    - `EMAIL_ALREADY_REGISTERED`; partner o sin token → `401`; cliente en una consulta de admin → `FORBIDDEN`;
    - 11 consultas de administración en una sola petición; `telemetry.queues` → `503` hasta V2.16;
    - suscripción de un cliente abierta y sin eventos ajenos; la de un partner, rechazada; Swagger con el contrato.
- **Pendiente:**
  - Auditoría de Gemini y aprobación del responsable (incluidas **D46** y **D47**, el claim `email`, `listRefunds`, el secreto
    enmascarado y el puerto 8088 en el host).
  - V2.14: el gateway en la nube con HTTPS. V2.15: la Payment API (la reserva web). V2.17: la web usa este GraphQL.

### V2.13 (ajuste del 26/10) — aprobaciones y pista del secreto de los webhooks
- **Aprobado por el responsable:** D46, D47, el claim `email` en el token de usuario y la operación `listRefunds`.
- **Pedido:** mostrar los últimos 4 caracteres del secreto de un webhook. **Aclaración:** quien ve esa pantalla es nuestro
  administrador (GraphQL); Booking entra por REST con el contrato v2, donde `secret` es `writeOnly` y no se devuelve, y ese
  contrato no se modifica. Por eso la pista existe solo en la web.
- **Cómo se hizo:**
  - MS.G.Webhooks devuelve `secretHint` (los últimos 4 caracteres del secreto, que guarda cifrado para firmar las entregas):
    `ms-g-webhooks.openapi.yaml` 1.2.0 (`SubscriptionView`).
  - MS.Clientes: operación propia `GET /ecoairlines/webhooks` (`listOwnWebhooks`, solo token de usuario con
    `flights:webhooks`) con la pista; `GET /vuelos/webhooks` del contrato v2 la quita (proyección al schema). `ms-clientes`
    1.1.0.
  - Gateway: `webhookSubscriptions` usa `listOwnWebhooks` y muestra `••••1234`; `registerWebhook` toma la pista del secreto que
    se acaba de registrar. `gateway.graphql` 1.1.0 (comentarios).
- **Verificación:** pruebas de Webhooks, MS.Clientes y gateway (72); en Docker la web muestra `••••9f3a`, el REST v2 no trae
  ni el secreto ni la pista y `/api/v2/ecoairlines/webhooks` no se publica (404).

### V2.14 — Nube para la ruta de Booking + integración real — 🟡 NUBE LISTA (26/10); la integración real espera a Booking
- **Qué se pidió:** PLAN.md §6, V2.14: desplegar en la nube todo lo que usa Booking con al menos 1 réplica (D39) y URL pública
  HTTPS; salida gRPC de Offers hacia `booking.epn.edu.ec:50051` y entrega de webhooks a Booking; entregar a Booking la URL y
  las credenciales. Verificación: la conformidad v2 pasa contra la URL pública; Booking ve el nodo en verde y completa una
  compra, un combo cancelado y una cancelación con el mismo `X-Correlation-Id`. **Límite del responsable:** US$90 de crédito
  Azure for Students, sin excederse, y preguntar antes de crear cualquier recurso con costo.
- **Decisiones (aprobadas por el responsable el 26/10):** **D48**, una VM ARM `B2pls_v2` en North Central US con el mismo
  `docker-compose` y HTTPS de Caddy, que reemplaza la recomendación de Azure Container Apps de D8 (US$100–130/mes con réplicas
  fijas); apagado automático a las 23:00 de Ecuador; limpieza del Reto 1. Costos consultados en la API pública de precios de
  Azure; la suscripción solo permite 5 regiones y no ofrece B2s en ellas.
- **Cómo se hizo:**
  - **Archivos nuevos:**
    - `infra/cloud/docker-compose.cloud.yml`: override del compose probado en local. Agrega Caddy (80/443), todo en
      `production`, sin el simulador de Booking (perfil `simulador`), gRPC de Booking real, webhooks solo a destinos `https`
      públicos, sin introspección de GraphQL y `restart: unless-stopped`.
    - `infra/cloud/Caddyfile`: publica solo el gateway (`/api/*`, `/oauth2/*`, `/health`) y la entrada firmada de eventos
      de Booking. El resto da 404, y los registros no guardan cabeceras (tokens).
    - `infra/cloud/cloud-init.yaml`: Docker, Compose y 2 GB de swap.
    - `scripts/cloud/generar-env.mjs`: secretos propios, nunca los de desarrollo; no sobrescribe el archivo.
    - `scripts/cloud/desplegar.sh`: paquete de 688 KB sin `node_modules` ni secretos, por SSH; compila en la VM.
    - `scripts/cloud/publicar-horario.{sh,mjs}`: la saga del ESB, ejecutada dentro de la VM.
  - **Azure (con la confirmación del responsable antes de cada recurso con costo):**
    - grupo `rg-ecoairlines-reto2`, VM, disco SSD de 32 GB, IP estática con nombre DNS, NSG y apagado automático;
    - certificado de Let's Encrypt válido hasta el 24/01/2027 (Caddy lo renueva).
  - **Limpieza del Reto 1 (ahorro ≈US$29/mes):**
    - plan B1 → F1;
    - respaldo `pg_dump` de la PostgreSQL del Reto 1, con restauración probada (16 tablas, 0 errores), y borrado del servidor;
    - borrado de `rg-vuelos-prod`.
- **Errores y hallazgos:**
  - **BKG-13 (nuevo, 🔴):** `booking.epn.edu.ec` **no resuelve en el DNS público**. El stock gRPC no puede llegar a Booking:
    hay 736 envíos pendientes que se reintentan en segundo plano (D33), con CPU casi nula. Hay que pedirles la dirección
    pública.
  - La red de la PUCE bloquea el SSH de salida al puerto 22: la VM escucha también en el **2222**, solo desde la IP del
    responsable, y la regla del 22 se borró. El clasificador de seguridad me impidió, con razón, abrir el 22 a cualquier
    origen para diagnosticarlo.
  - **Míos en los comandos:**
    - concatenación de cadenas de PowerShell en el respaldo (el primer intento no generó el archivo);
    - GNU tar leía `C:` como un host remoto (se agregó `--force-local`);
    - comillas en una consulta SQL.
    - Ninguno afectó a los datos: el respaldo se verificó antes de borrar.
  - El correo de Let's Encrypt se quitó: es opcional, y no se envía el correo del responsable a un servicio externo sin que
    lo pida.
- **Verificación:**
  - **★ Suite de conformidad v2 contra la URL pública (`https://ecoairlines-reto2.northcentralus.cloudapp.azure.com/api/v2`),
    con las credenciales reales de la nube: 54/54, 30/30 operaciones.**
  - Las 24 comprobaciones GraphQL de V2.13, contra la nube: todas bien, incluida la suscripción por `wss://`.
  - `GET /api/v2/vuelos/health` → `HEALTHY` (12 dependencias `UP`); HSTS y CSP; el ESB no se publica (404); un evento sin
    firma en `/integraciones/booking/eventos` → `401`.
  - 368 vuelos publicados. VM con 1,6 GiB de memoria libre, CPU tranquila y disco al 27 %.
- **Pendiente (depende de Booking):**
  - BKG-13 y BKG-06 (dirección y forma del stock); BKG-01 (por dónde nos envían `payment.*` y `package.cancelled`).
  - Entregar a Booking, **por un canal privado**, la URL base, `BOOKING_CLIENT_SECRET` y `AIRLINE_EVENTS_SECRET`
    (`infra/cloud/.env`; ver DESPLIEGUE_AZURE.md).
  - La verificación con Booking: el nodo en verde en su panel, y una compra, un combo cancelado y una cancelación con el mismo
    `X-Correlation-Id`.
  - Auditoría de Gemini y aprobación de la fase.

### V2.15 — Payment API simulada con tarjeta (canal web) — ✅ HECHA (26/10), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.15: `services/externos/payment-api` según `payment-api.openapi.yaml` (tokenizar, autorizar,
  capturar, anular, reembolsar; tarjetas de prueba). Verificación: cada tarjeta de prueba, tarjetas inválidas y referencias
  reutilizadas o con otro monto. **D49 (aprobada):** en la misma VM de la nube, publicada por Caddy en `/payment-api/`
  (US$0).
- **Cómo se hizo (`services/externos/payment-api`, puerto 4010 en local):**
  - Es un **sistema externo** (como Stripe): no usa los tokens de Identity ni pasa por el gateway.
    - Claves propias: `pk_test_…` (`X-Api-Key`, el navegador) y `sk_test_…` (`Bearer`, el ESB).
    - Se comparan en tiempo constante, en un *guard* que corre ANTES de validar el cuerpo: sin clave no se informa el formato.
    - La clave pública en una operación del ESB → `401`.
  - **Tarjetas** (`domain/cards.ts`, funciones puras):
    - validación: Luhn, marca (Visa, Mastercard, Amex), vencimiento futuro y CVV de 3 o 4 dígitos;
    - las 5 tarjetas de prueba del plan;
    - se guardan **solo** marca, últimos 4, vencimiento y el resultado de prueba. El número y el CVV no salen de la petición.
  - **Pagos** (`domain/payments.ts`): estados calculados al leer, sin temporizadores. La tarjeta pendiente pasa a
    `AUTHORIZED` a los 30 s y una autorización vence a los 30 min (configurables para las pruebas).
    - Captura por el **monto exacto** y **una sola orden** (`ALREADY_CAPTURED`; repetir con la misma orden es idempotente).
    - Anular es idempotente y, si ya está capturado, responde `409`.
    - Reembolsos parciales y totales, nunca por más de lo capturado.
  - **Datos** (`repositories/payments.store.ts`): memoria o PostgreSQL (base `payment`: `payment_methods`, `payments`,
    `used_references`, `refunds`, `idempotency_keys`).
    - Toda transición de un pago o de un token corre en una transacción con `SELECT … FOR UPDATE`.
    - La `Idempotency-Key` se reserva antes de ejecutar y se libera si la operación falla.
  - Límite de 20 intentos por minuto por IP en tokenizar y autorizar; CORS solo para la web; `Cache-Control: no-store`; en
    producción exige base y claves propias (rechaza las de desarrollo).
  - **Docker:** servicio `payment-api` (127.0.0.1:4010). El ESB recibe `PAYMENT_API_URL` y `PAYMENT_API_SECRET_KEY` y
    espera a que esté sana. En la nube: `NODE_ENV=production`, claves propias en `infra/cloud/.env` (`generar-env.mjs` ya las
    genera) y la ruta `handle_path /payment-api/*` en Caddy.
- **Errores encontrados y corregidos (por la prueba de punta a punta con la Payment API real):**
  - **Seguridad (ESB, V2.10): una referencia de pago ajena provocaba el reembolso de la compra original.** Al reutilizar un
    `paymentReference` ya capturado por otra orden, la captura fallaba (`ALREADY_CAPTURED`). La compensación del paso
    consultaba el pago y, al verlo `CAPTURED`, lo **reembolsaba entero**, sin comprobar que lo hubiera capturado esa saga.
    Ahora solo se reembolsa si `orderId` = `sagaId`. Las pruebas de V2.10 no lo veían porque su Payment API falsa no
    devolvía el `orderId`; ahora sí, y hay una prueba del caso.
  - **Contrato (ESB, V2.10):** al capturar y al reembolsar, el ESB mandaba el monto de la reserva con `baseFare` y `taxes`. El
    `MoneyAmount` de la pasarela es `additionalProperties: false`, así que **toda compra web fallaba** con `400`. Ahora el
    adaptador manda solo `currency` y `total`; hay prueba de regresión.
  - **Mensaje (ESB):** una tarjeta rechazada respondía «reintente en unos segundos», el texto de la pendiente. Ahora solo la
    pendiente pide reintentar; la rechazada o vencida pide otra tarjeta.
  - **Míos:**
    - el primer controlador validaba el cuerpo antes de la clave (corregido con el *guard*);
    - en local el contenedor arrancaba en producción y rechazaba las claves de desarrollo (en local queda en `development`,
      como Identity);
    - el script de punta a punta usaba el mismo pasajero en todas las reservas: Bookings lo rechazaba antes del pago y una
      comprobación pasaba por el motivo equivocado.
- **Verificación:**
  - Payment API: 27 pruebas contra su contrato:
    - cada tarjeta de prueba y cada tarjeta inválida (Luhn, marca, vencida, CVV);
    - token reutilizado, vencido o inexistente;
    - captura con otro monto, otra orden o un pago pendiente, rechazado o vencido;
    - anular, y reembolsos parciales, totales y excesivos;
    - idempotencia, claves, límite por IP, CORS y producción;
    - **el número y el CVV no aparecen en respuestas, datos ni logs**.
  - 3 con PostgreSQL real: de 6 capturas simultáneas cobra una; los reembolsos simultáneos nunca superan lo capturado; la
    clave idempotente la reserva una sola petición.
  - ESB: +5 pruebas (montos del contrato, referencia ajena sin reembolso, mensajes pendiente, rechazada y vencida).
  - `tsc` y lint sin errores; pruebas v2: **615** (41 omitidas, las de bases y broker reales).
  - **★ Compra web de punta a punta en Docker** (navegador → Payment API; GraphQL → gateway → MS → ESB): 13 de 13 bien.
    - tarjeta 4242 → `COMPLETED` y `CONFIRMED`, captura del monto exacto con `orderId` = `sagaId` y el mismo
      `X-Correlation-Id`;
    - la referencia en otra reserva → rechazada sin tocar la compra original;
    - otro monto → `AMOUNT_MISMATCH`, y la autorización queda `VOIDED`;
    - rechazada → sin reserva;
    - pendiente → `PAYMENT_NOT_AUTHORIZED`, y a los 30 s se confirma;
    - cancelar → reembolso `SETTLED` en la pasarela (`PARTIALLY_REFUNDED` por la penalidad) y visible en `Booking.refunds`.
  - Conformidad v2 contra el gateway local: 54/54 (el canal Booking no cambió).
  - **★ En la nube (D49, sin recursos nuevos):** la compra web de punta a punta contra
    `https://ecoairlines-reto2.northcentralus.cloudapp.azure.com` (Payment API en `/payment-api/`, claves propias): 13 de 13
    bien; la conformidad v2 contra la URL pública sigue en 54/54; la clave de desarrollo se rechaza (`401`).
  - **Mío en el despliegue:** el Caddyfile se monta como archivo y, al reemplazarlo, Caddy seguía con el anterior (la ruta
    nueva daba 404). `desplegar.sh` ahora recrea Caddy en cada despliegue.
- **Pendiente:** auditoría de Gemini y aprobación. La web (V2.17) usará la Payment API con la clave pública; `CORS_ORIGINS`
  de la nube se completa cuando la web tenga URL (V2.20).

### V2.16 — Plataforma de observabilidad — 🟡 VERIFICADA EN LOCAL (02/11): falta desplegarla en la nube
- **Qué se pidió:** PLAN.md §6, V2.16: métricas, trazas, logs, alertas y tableros (`infra/observability`); las alertas del
  plan; telemetría en el panel vía la Composición con búsqueda por correlation ID. Verificación: una compra de Booking se
  encuentra por su `X-Correlation-Id` y se ve como una sola traza. **D50 (aprobada):** la misma pila en local y en la VM,
  Grafana público con contraseña, retención de 7 días, US$0.
- **Hecho:**
  - `packages/shared`: el SDK de OpenTelemetry exporta también **métricas** (cada 15 s) y **logs** (cada línea JSON, con
    sus campos como atributos), e instrumenta **gRPC** y **`fetch`** (`@opentelemetry/instrumentation-undici@0.33.0`).
  - Métricas de negocio `ecoairlines_*` (`telemetry/metrics.ts`): sagas terminadas por tipo y estado, entregas de webhooks,
    dependencias de cada `/health`, estado del nodo de Booking y stock pendiente de enviar.
  - Pila en `infra/observability/` y en los dos compose: OTel Collector → Prometheus v3.15.0 (+ RabbitMQ por cola),
    Alertmanager v0.34.1, Tempo 3.1.0, Loki 3.7.8 y Grafana 13.2.3 (tableros «Servicios» y «Negocio» versionados). En la nube
    Grafana queda en `/grafana/` con `GRAFANA_ADMIN_PASSWORD` de `infra/cloud/.env`.
  - 12 alertas (`promtool` sin errores): servicio caído, Collector sin datos, latencia, errores, nodo DOWN y DEGRADED, cola
    creciendo, mensajes en la cola de fallidos, sagas fallidas y compensadas, stock sin enviar y webhooks agotados.
  - ESB: `ObservabilityClient` (Prometheus, Loki, RabbitMQ, Alertmanager) y 4 operaciones de Composición
    (`telemetry/latency`, `traces/:correlationId`, `queues`, `alerts`); MS.Admin las usa (antes respondían 503). Contratos
    `esb.openapi.yaml` 1.3.0 y `ms-admin.openapi.yaml` 1.2.0 (Redocly válido).
- **Verificado en local:** una compra REST como Booking con un `X-Correlation-Id` fijo se encuentra en el panel con sus pasos
  en 7 servicios y su saga `CREATE_BOOKING`; latencia de 15 servicios; colas de RabbitMQ; alertas; métricas `ecoairlines_*`
  en Prometheus.
- **Error encontrado (de V2.2):** **cada salto de una compra empezaba una traza nueva.** Los servicios se llaman con `fetch`
  (undici) y `HttpInstrumentation` no lo ve: nunca se propagaba `traceparent`. Tempo lo mostró (cada traza tenía un solo
  span y ninguno de cliente). Se agregó la instrumentación de undici (la 0.34.0 tenía 6 días: se usó la 0.33.0, de 20 días).
- **Verificación final (02/11), con las 18 imágenes recompiladas de a una (≈15 min, sin errores) y los 26 contenedores arriba:**
  - **★ Una compra de Booking es una sola traza** que cruza gateway → MS.Reservas → ESB → MS.G.Offers (gRPC) → MS.G.Bookings, y
    su `trace_id` es el mismo en los logs y en Tempo.
  - **Error encontrado: el salto gRPC seguía fuera de las trazas.** Los servicios son ESM y la instrumentación de gRPC se
    engancha a `require`, por donde un `import` no pasa: `GrpcInstrumentation` estaba registrada pero nunca parcheaba.
    `startTelemetry` ahora carga `@grpc/grpc-js` con `require` después de arrancar el SDK.
  - **Alerta real:** al detener MS.G.CheckIn, `ServicioCaido` (crítica) llegó a Alertmanager a los 103 s y se vio en el panel.
    Las 12 reglas están sanas.
  - **Grafana:** `401` sin contraseña; tableros «Servicios» e «Integración y negocio»; Prometheus, Loki y Tempo conectados.
  - Latencia de 11 servicios en el panel, colas y métricas `ecoairlines_*`.
  - Memoria: ≈2,7 GiB recién arrancado (se estimaba ≈1,7): en la VM de 4 GiB queda justo.
- **Pendiente:** desplegar en la VM (US$0, D50) y comprobar `/grafana/` y la memoria; se hará cuando se decida dónde se hospeda
  todo (`PASOS_FINALES.md`). DESPLIEGUE_AZURE.md y auditoría.
- **Recursos (26/10):** al recompilar las 20 imágenes a la vez, Docker llegó a ≈6,8 GB en la laptop (15,7 GB) y su motor se
  cayó (`rpc error: EOF`). En reposo el sistema usa ≈1,7 GiB (la observabilidad ≈0,7). Se limitó WSL a 6 GB y 6 núcleos
  (`.wslconfig` del usuario), se compila de a una imagen y, mientras se trabaja en la web, la observabilidad y el Booking
  simulado quedan detenidos. El consumo y las opciones de hospedaje están en `PASOS_FINALES.md`.

### V2.17 — Web: migración completa a GraphQL y pago con tarjeta — ✅ HECHA (26/10), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.17: cliente GraphQL en lugar de `api/endpoints.ts` y `api/extensions.ts`; login contra
  Identity y menú según el rol; formulario de tarjeta con «Usar tarjeta de prueba» en reserva, maletas, asientos y cambio de
  fecha. Verificación: recorrido completo en el navegador; en la pestaña Red, la web solo llama a `/api/graphql` y a la
  Payment API. **D51 (aprobada):** cliente propio con `fetch` y una prueba que valida los documentos contra el esquema.
- **Cómo se hizo (`ecoairlines-web`):**
  - `api/client.ts`: el cliente GraphQL (D51). Convierte el ProblemDetails de `errors[].extensions` al `ApiError` que ya
    usaban las pantallas (con `retryAfter` y el `X-Correlation-Id` como código de soporte).
  - `api/operations.ts` (cliente) y `api/admin.ts` (administración): las mismas funciones que antes, con su documento
    GraphQL. Donde el esquema difiere poco (rotación de la flota, eventos) se adapta ahí para no reescribir las pantallas.
    Se borraron `endpoints.ts`, `extensions.ts`, `PaymentReferenceField.tsx` y la selección de maletas del checkout.
  - **Login:** `login`/`register` por GraphQL (MS.Clientes → Identity); el token sigue solo en memoria. El menú y el acceso a
    las páginas de administración salen de los **scopes** del token (`ECOAIRLINES_ADMIN`); el gateway los verifica igual.
  - **Pago con tarjeta** (`components/CardPayment.tsx`, `api/payments.ts`):
    - la tarjeta va del navegador a la Payment API con la clave **pública**: tokenizar y luego autorizar;
    - a GraphQL solo llega `paymentReference`; se autoriza el monto que el ESB capturará: el precio congelado del hold, las
      maletas (precio × cantidad) o la diferencia del cambio de fecha;
    - «Usar tarjeta de prueba» carga las tarjetas de `GET /test-cards`;
    - una tarjeta rechazada pide otra; si la operación falla por otro motivo, el reintento **reutiliza la misma
      autorización** (la petición GraphQL sale idéntica y su `idempotencyKey` no choca);
    - los datos de la tarjeta se borran al terminar y nunca se guardan ni se registran.
  - El **cambio de asiento** no tiene costo en EcoAirlines (`changeSeats` solo cobra si llega un monto), así que no pide
    tarjeta. Usa `changeSeats` del contrato v2 (atómico) en lugar de la extensión de un asiento.
  - Admin: indicadores por canal (`adminIndicators`); vuelos con `flightOperations` (asientos por estado, holds, check-in,
    alertas) y cambio de estado con motivo al cancelar; rutas, flota y rotación; eventos (`eventHistory`); observabilidad con
    `telemetry` (salud, latencia, colas, alertas; si la pila de V2.16 está apagada lo dice y muestra la salud igual). Sin
    listado de reservas ni de pasajeros por vuelo: el esquema no los tiene (la asistencia por vuelo llega en V2.18).
  - Mensajes nuevos para los códigos del contrato v2, de la cuenta y de la pasarela. Un `INVALID_CREDENTIALS` (401) ya no
    se muestra como «tu sesión expiró».
- **Errores del backend encontrados por el recorrido (corregidos):**
  - **ESB (V2.10): una reserva con infante fallaba siempre** (`PASSENGER_COUNT_MISMATCH`). El ESB le quitaba los infantes a
    la lista que manda a Offers, y Offers la compara con el desglose del hold, infantes incluidos. Ahora van todos.
  - **ESB (V2.10): los asientos elegidos al comprar se ignoraban** (mandaba `requestedSeats: []`; el contrato los trae en
    `assignedSeats`). Ahora se respetan; afecta también a Booking. Prueba de regresión.
  - **ESB (V2.15): la tarjeta pendiente no funcionaba como dice el plan** («la reserva responde 202 y se confirma después»):
    la captura fallaba al instante y la compensación **anulaba** la autorización. Ahora el paso de captura espera a que la
    pasarela autorice (consulta cada 3 s, hasta `PAYMENT_PENDING_WAIT_MS` = 45 s, menos que el lease de 60 s) y captura. Dos
    pruebas nuevas.
  - **ESB (V2.10/V2.12): choque de plazos.** El ESB esperaba a la saga 4,5 s antes del `202` y el cliente de los MS de
    respuesta corta también a 4,5 s: el `202` llegaba tarde y se veía `503`. `SAGA_DEADLINE_MS` baja a 3,5 s (sigue dentro de
    los 5 s de Booking).
  - **Gateway:** la página de 50 vuelos de `flightOperations` pasaba el límite de complejidad (1451 > 1000). La web pide de
    a 30.
  - **Abierto (BKG-14):** las maletas extra enviadas al crear la reserva no se agregan ni se cobran; se preguntó a Booking.
    La web ya no las ofrece en el checkout (se compran desde «Mis viajes»).
- **Web y tarjeta pendiente:** como el contrato REST de «crear reserva» no tiene un `202` sin reserva, MS.Reservas responde
  `503 PROVIDER_UNAVAILABLE` con `Retry-After` mientras la saga sigue (V2.12). La web lo trata así: muestra «Estamos
  confirmando tu pago con el banco» y reintenta la MISMA petición con la misma clave hasta tener la reserva.
- **Míos:** el primer `authorizeCard` reutilizaba la `Idempotency-Key` con un token de tarjeta nuevo (la pasarela habría
  respondido `IDEMPOTENCY_KEY_REUSED`); un aviso del checkout leía un estado viejo de React; el script del recorrido
  recargaba la página y perdía la sesión (que vive en memoria, a propósito).
- **Verificación:**
  - `tests/arquitectura-v2/web-graphql.spec.ts` (4 pruebas): todos los documentos de `operations.ts` y `admin.ts` son
    válidos contra `gateway.graphql`; la Payment API recibe la clave pública y el número de tarjeta solo al tokenizar; ningún
    archivo de la web hace `fetch` fuera de `api/client.ts` y `api/payments.ts`, ni nombra una URL REST del sistema.
  - ESB: +3 pruebas (infante y asientos a Offers; pendiente que se autoriza; pendiente que vence).
  - `typecheck`, `lint` y `build` de la web sin errores; pruebas v2: **625** (41 omitidas, las de bases y broker reales).
    Conformidad v2 contra el gateway local: 49 de 49 (5 omitidas: piden el token de administrador).
  - **★ Recorrido completo en Microsoft Edge** (`playwright-core` 1.64.0 en el scratchpad, sin descargar navegadores): 23 de
    23 bien:
    - registro y menú de cliente;
    - compra con infante y asiento elegido: tarjeta «Rechazada» (pide otra) y luego «Aprobada (Visa)» → confirmada con el
      mismo asiento;
    - postventa: maletas con Mastercard, cambio de asiento y cambio de fecha; check-in fuera de plazo con mensaje claro;
    - tarjeta «Pendiente»: la web avisa, espera y la reserva queda confirmada;
    - Mis viajes, perfil y estado de vuelo;
    - administrador: indicadores, vuelos del día, rutas, ventas por ruta y observabilidad;
    - **★ pestaña Red:** solo `POST localhost:8088/api/graphql` y `localhost:4010` (`/test-cards`, `/payment-methods`,
      `/payments`). Sin errores de JavaScript.
  - **Observación abierta:** en una de cuatro corridas, el registro falló una vez porque el ESB esperó 4 s una respuesta de
    Identity que nunca llegó a Identity (sin rastro en sus logs). No se repitió; se vigila al terminar V2.16 (puede estar
    relacionado con el Collector apagado y la instrumentación nueva de `fetch`).
- **Pendiente:** auditoría de Gemini y aprobación. La web en la nube (`CORS_ORIGINS`, URL) es de V2.20.

### V2.18 — Web: pantallas nuevas — ✅ HECHA (02/11), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.18 y §4.9. Cliente: asistencia, estado de boletos y cambio de varios asientos. Admin: Usuarios,
  Partners, Precios y promociones, Operaciones (con cambio de estado de vuelo), Asistencia y Telemetría. Verificación: cada
  pantalla probada con un CLIENTE y un ADMIN. Sin decisiones nuevas: todo existía ya en `gateway.graphql`.
- **Cómo se hizo (`ecoairlines-web`):**
  - **Cliente:**
    - asistencia médica: «Necesita asistencia médica» por pasajero en el checkout, predeterminada en el perfil (se propone al
      pasajero 1) y panel «Asistencia» en la reserva para ver, pedir, cambiar o quitar;
    - «Estado de los boletos» en el detalle, con cada tramo;
    - «Cambiar asientos»: reutiliza el selector del checkout y cambia varios a la vez con `changeSeats` (todos o ninguno).
  - **Admin:** barra propia del portal (`RequireAdmin`) con 8 secciones.
    - **Usuarios:** filtros, crear, cambiar rol, bloquear y activar.
    - **Partners:** alta con permisos, bloqueo y rotación; el secreto se muestra una vez y solo vive en el estado de la pantalla.
    - **Precios y promociones:** multiplicadores, «Rellenar», vista previa, historial y acuerdo con Booking; un solo «Guardar».
    - **Operaciones:** detalle por cabina y estado de asiento; solo ofrece las transiciones válidas; puerta, horas estimadas y
      motivo; aviso antes de cancelar. Sale del Panel.
    - **Asistencia:** por vuelo y fecha, con «Marcar lista».
    - **Telemetría:** búsqueda por correlation ID, integración con Booking, salud, latencia, colas y alertas. Cada parte se
      consulta por separado: si una falla, las otras se ven. El backend sale de Observabilidad, que conserva eventos, rotación
      y navegador.
- **Errores encontrados:**
  - **Gateway (V2.13): el acuerdo de promociones se atribuía a la aerolínea.** Se usaba `proveedor_codigo` como `partnerId`, y
    ese campo es el código de EcoAirlines. La pantalla no encontraba el acuerdo, mostraba el formulario vacío y **el siguiente
    «Guardar» lo pisaba con valores en blanco**. `promotionAgreement(partnerId)` respondía `null`. La prueba no lo veía porque su
    dato falso ponía al partner en ese campo. Ahora MS.Admin añade `partnerId` (`ms-admin.openapi.yaml` 1.3.0,
    `PartnerPromotionAgreement`; el contrato de Booking no cambia). **Lo detectó la captura de pantalla, no el recorrido:** este
    daba OK porque solo miraba el mensaje de éxito. Se agregaron comprobaciones.
  - **Web:** el panel de asientos heredaba el ancho de `.panel-form` y cortaba la columna F del mapa (también visto en la captura).
- **Míos:** la primera versión del recorrido no era repetible (cancelar un vuelo es definitivo): ahora usa fechas por corrida.
- **Verificación:**
  - **★ Recorrido en Microsoft Edge con un CLIENTE y un ADMIN: 48 de 48 bien** (`recorrido218.mjs`, en el scratchpad). Destacan:
    - un CLIENTE ve «Acceso restringido» y el gateway responde `FORBIDDEN` aunque salte la web;
    - una cuenta bloqueada no ingresa (`ACCOUNT_BLOCKED`) y el admin no puede bloquearse a sí mismo;
    - al rotar el secreto de un partner, el nuevo sirve y el anterior da `401`; bloqueado, no obtiene token;
    - el acuerdo guardado se ve en la pantalla, sobrevive a un segundo «Guardar» y Booking lo lee por la API de vuelos;
    - cancelar un vuelo vendido reembolsa sus reservas;
    - la compra se encuentra por correlation ID en Telemetría;
    - en la pestaña Red solo aparecen `/api/graphql` y la Payment API.
  - **★ Dato de salud:** una nota única escrita en perfil y checkout no aparece en 3.573 líneas de logs de Docker ni en Loki.
    Tempo no se pudo revisar así (la consulta de texto libre responde `400`).
  - Regresión de V2.17: 23 de 23. **Falla intermitente sin explicar:** en una corrida, justo después de otro recorrido, el clic
    en «Pagar» agotó el tiempo; repetido sin cambios, pasó.
  - `tests/arquitectura-v2/web-graphql.spec.ts` valida todos los documentos nuevos contra `gateway.graphql`.
  - `typecheck`, `lint` y `build` sin errores; pruebas v2: **625** (41 omitidas); conformidad v2 local: 49 de 49 (5 omitidas: piden
    el token de administrador). `ms-admin.openapi.yaml` válido en Redocly.
- **Pendiente:** auditoría de Gemini y aprobación. El generador de contratos de MS de respuesta vive fuera del repositorio: el
  cambio de `ms-admin.openapi.yaml` se hizo directo en el YAML.

### V2.19 — Web progresiva (PWA) — ✅ HECHA (02/11), pendiente de auditoría y aprobación
- **Qué se pidió:** PLAN.md §6, V2.19 y §4.9: `vite-plugin-pwa` con manifest, iconos y service worker; caché sin conexión de pases y
  «Mis viajes»; nada sensible en caché. Verificación: auditoría PWA de Lighthouse; con el modo avión, el pase ya visto se abre.
- **Cómo se hizo (`ecoairlines-web`):**
  - `vite-plugin-pwa` 2.0.0 (30 días): manifest en español, modo `standalone`, iconos 192, 512, *maskable* y Apple, generados del
    logo. Precaché de la aplicación con *fallback* de navegación, que excluye lo que en la nube comparte dominio (`/api`,
    `/payment-api`, `/grafana`, `/integraciones`). **Sin `runtimeCaching`:** ninguna respuesta de la API llega a la caché.
  - **D52: copia local mínima** (`src/lib/offline-trips.ts`). El service worker no puede servir un pase: GraphQL va por POST y sin
    conexión no hay sesión. Se guarda lo mínimo para abordar (ver PLAN.md, D52), por usuario. «Salir» lo borra, vencer la sesión no,
    y los vuelos se purgan un día después de salir.
  - Página `/sin-conexion`, sin sesión ni llamadas a servicios; sin conexión, las rutas privadas llevan ahí y no al login. Aviso
    «Sin conexión» con enlace en cualquier página. `BoardingPassCard` es el mismo pase en línea y sin conexión.
  - **Versión nueva:** se pregunta antes de actualizar (`registerType: 'prompt'`), porque recargar cerraría la sesión.
  - Al abrir «Check-in y pases» sin haber hecho check-in, el ESB responde `409 BOARDING_PASS_NOT_AVAILABLE`, que la web mostraba
    como error; ya no.
- **Error grave encontrado: la observabilidad apagada hacía fallar login y registro.** Era la «observación abierta» de V2.17, y
  se reprodujo aquí.
  - **Causa:** con el Collector detenido, cada exportación de telemetría ocupa 5 s un hilo de libuv resolviendo `otel-collector`
    (`EAI_AGAIN`). Node trae 4 hilos, que también usan las demás búsquedas DNS y `scrypt`: resolver `ms-g-identity` pasó de **1 ms a
    10 s** y MS.Clientes se rendía a los 5 s. Solo la primera petición tras un rato era lenta, por eso parecía azar.
  - **Error mío:** yo recomendé detener el Collector en `PASOS_FINALES.md`, y mi hipótesis de V2.17 (la instrumentación de `fetch`)
    era incorrecta. **Importa en producción:** si el Collector se caía, las ventas se degradaban.
  - **Corrección:** `UV_THREADPOOL_SIZE: 16` en los 18 servicios Node de `docker-compose.yml` (la nube lo hereda al combinar los dos
    archivos). Medido con el Collector apagado: `ms-g-identity` resuelve en 1 ms con 4 búsquedas atascadas, y 14 registros con
    pausas de 8 s tardaron menos de 0,5 s, sin fallos. No se conoce otra causa de la «falla intermitente» del clic en «Pagar» de
    V2.18: pudo ser esta, pero no se comprobó.
- **Míos:** `TaskStop` no mata el Vite hijo: el servidor de desarrollo siguió ocupando el 5173 y el primer recorrido probó la versión
  sin service worker; en móvil, el script esperaba un botón dentro del menú plegado; en la regresión, el cambio de fecha falló porque
  el recorrido de V2.18 había cancelado ese vuelo (la web dijo bien «No hay vuelos disponibles»).
- **Verificación:**
  - **★ Lighthouse 11.7.1 con Edge: PWA 100**, Accesibilidad 100 y Buenas prácticas 100 (la categoría PWA se retiró en la 12; se usó
    en el scratchpad, no es dependencia del proyecto).
  - **★ Recorrido en Edge con vista móvil, contra la versión de producción: 22 de 22 bien** (`recorrido219.mjs`):
    - compra de un vuelo de mañana y check-in reales; instalable, con service worker activo;
    - **★ modo avión:** la aplicación abre tras recargar, «Mis viajes» lleva a lo guardado, y el pase abre con su QR;
    - la caché solo tiene archivos de la aplicación; en el almacenamiento no hay token, documento, teléfono ni tarjeta;
    - la versión nueva pregunta antes de actualizar; «Salir» borra lo guardado.
  - `tests/arquitectura-v2/web-offline.spec.ts` (6 pruebas): campos guardados, separación entre usuarios, purga, borrado y que el
    service worker no tenga `runtimeCaching`.
  - **Regresión con los 26 contenedores:** V2.16 (traza única con gRPC) bien; V2.17, 23 de 23; V2.18, 48 de 48.
  - `typecheck`, `lint` y `build` sin errores; pruebas v2: **631** (41 omitidas); conformidad v2 local: 49 de 49 (5 omitidas: piden el
    token de administrador).
  - `npm audit`: 0 en producción; 11 en herramientas de desarrollo (entre ellas una alta de `launch-editor` en Vite, solo en
    `npm run dev`). No se tocaron.
- **Pendiente:** auditoría de Gemini y aprobación de D52. Probar la instalación en un teléfono real requiere HTTPS: queda para V2.20.

### V2.20 — Nube: todo lo demás — ✅ HECHA (03/11), pendiente de auditoría; GitHub Actions diferido

Sin decisión de hospedaje escrita, se usó lo que ya existe y es portable (el mismo `docker compose` sirve en cualquier servidor): la
VM de D48 y la Static Web App Free. No se creó ningún recurso. Costo de la sesión: ≈46 min de VM (≈US$0,03); quedó desasignada.

**Desplegado en la VM:** todo el código hasta V2.19, con la observabilidad de D50: 26 contenedores (Caddy, Payment API, gateway, 5 MS,
ESB, 9 MS.G, PostgreSQL, RabbitMQ, Collector, Prometheus, Alertmanager, Tempo, Loki y Grafana) y `CORS_ORIGINS` con el origen de la web.

**Corregido al desplegar:**
- **`desplegar.sh` no recreaba el Collector.** Su configuración se monta como archivo: el contenedor siguió con la de V2.14 (solo
  `debug`), nada llegaba a Prometheus, Tempo ni Loki y `CollectorSinDatos` estaba activa. Ahora recrea todo lo que monta archivos.
- **El gateway tardó ~3 min en sanar tras compilar** (VM burstable sin CPU, swap en 1 GiB): Compose abortaba antes de recrear Caddy, que
  seguía con el Caddyfile viejo (Grafana en 404). `docker-compose.cloud.yml` le da `start_period: 5m`. El `exit 0` del primer
  despliegue era del `echo` de la verificación, no del script: el log sí mostraba el error.

**Verificación en la URL pública:**
- Nodo `HEALTHY`; CORS acepta el origen de la web y rechaza otro (400); Prometheus y ESB 404; Grafana 401 sin contraseña.
- `verify_v216.mjs` 9/9: compra de Booking con token de partner (201), y UNA traza que cruza gateway → MS.Reservas → ESB → Offers (gRPC)
  → Bookings en Tempo; panel de telemetría con latencia, colas, alertas y métricas de negocio.
- **Alerta real:** con `ms-g-post-sale` detenido, `ServicioCaido` disparó a los 74 s, visible por la API de Grafana con contraseña; el
  nodo pasó a `DEGRADED` y volvió a `HEALTHY` con 0 alertas activas al levantarlo.
- `recorrido219.mjs` 20/20 con el build de producción servido en local contra la nube (registro, tarjeta, check-in, pase con QR en modo
  avión, «Salir»). **Edge sin CORS** en esta prueba: la nube solo autoriza el origen de la web publicada. Las 2 comprobaciones de
  versión nueva reescriben `sw.js` y no aplican aquí.

**Memoria y carga:** 2,2 GiB en uso + ≈0,9 GiB de swap de 3,8 GiB; `/vuelos/health` tardó 0,5–3,3 s y la carga llegó a 14 en 2 vCPU
los primeros 40 min. Causas: compilar en la VM y `unattended-upgrades` (parches de Ubuntu al encender tras días apagada; escribió
varios GB y seguía activo al terminar). No se midió la VM en reposo sin esos dos efectos. Se recomienda encenderla al menos 1 h antes
de una prueba con Booking, cuyo timeout es de 5 s.

**GitHub Actions (en pausa por decisión del responsable, 02/11):** sin decisión de hospedaje, el sistema se mantiene en la VM y compila allí. `.github/workflows/imagenes-v2.yml` queda escrito, sin ejecutar y solo con ejecución manual. Prueba el monorepo y compila por servicio solo lo que
cambió, en amd64 y arm64, hacia GHCR. El workflow de la web pasa a las URLs del gateway y la Payment API. Solo se simuló la elección de
servicios (esb → 1; packages/shared → 18; documentación → 0). `actionlint` no corrió: Docker Hub agotó el tiempo.

**03/11 — Stock a Booking por REST (D53) y hospedaje en Azure.**
- **Decisión del responsable:** cada equipo hospeda lo suyo; nos quedamos en Azure (la VM de D48). Booking publicó en Azure
  `POST https://booking-core-api.azurewebsites.net/api/v2/inventory/stock`; nuestro `service_id` es **`NODE_VUE_EQ5`** (el responsable
  escribió `NODE_VUE__EQ5`; se tomó como error de tipeo del formato `NODE_VUE_EQ1` y es configurable con `BOOKING_SERVICE_ID`).
- **Offers** envía por REST cuando existe `BOOKING_STOCK_URL` (los 5 campos de Booking, `X-Correlation-Id`, vale solo con
  `success: true`, mismos reintentos); el gRPC de D33 queda como alternativa. El stock de vuelos que ya salieron no se envía y queda
  cerrado. El simulador recibe lo mismo por REST, y en local es el camino por defecto. Resuelve BKG-06 y BKG-13; queda BKG-15 (los
  webhooks de Booking, «en unos días»).
- **Pruebas:** `ms-g-offers/test/stock-rest.spec.ts` (6) y el REST del simulador; `test:v2` 638 pasan, 41 omitidas. Hubo 2 fallos
  intermitentes por carga (identity, web-graphql) que pasaron al repetir.
- **Verificación con Booking real:** un envío a mano con los datos del primer pendiente respondió `success: true`, «Stock sincronizado
  exitosamente… EA100-BUSINESS: 12 unidades», `source: HTTP_REST`. Tras desplegar, los **736 pendientes desde el 26/10 quedaron
  cerrados en menos de 1 h, sin errores**: 672 enviados y 64 de vuelos pasados cerrados sin enviar.
- **El despliegue volvió a fallar** por la misma causa del 02/11, que solo se había corregido en el gateway: 4 MS de respuesta
  tardaron en sanar, Compose abortó y **el gateway quedó sin arrancar (API pública caída unos minutos)**. Se levantó a mano.
  Corrección de raíz: los 19 servicios con healthcheck tienen `start_period: 5m` en la nube. Además, este despliegue recompiló
  todo porque el 02/11 se borró la caché de compilación para liberar disco.

**03/11 — Web publicada** por el responsable en la Static Web App Free (`https://nice-hill-090e19c10.1.azurestaticapps.net`, reemplaza la
del Reto 1) con `swa deploy`, que el clasificador de permisos no dejó ejecutar a Claude. `recorrido219.mjs` **20/20 en la URL
pública con CORS activo**: manifest, service worker, compra con tarjeta, check-in, pase con QR en modo avión, «Salir» borra; rutas
profundas (`/mis-viajes`) 200 y cabeceras de seguridad presentes.

**Pendiente:**
1. ~~Publicar la web~~ (hecho el 03/11). en la Static Web App: el build está listo, pero el sistema de permisos rechazó el despliegue a producción y lo
   decide el responsable. Reemplaza la web del Reto 1, que ya no funciona.
2. Subir el commit al repositorio nuevo `Reto-2`, que pidió el responsable (GitHub no admite espacios en el nombre).
3. Probar la instalación de la PWA en un teléfono real y repetir el recorrido en la URL pública, con CORS activo.

### V2.21 — Documentación, defensa y cierre — ✅ HECHA (03/11), pendiente de la auditoría final de Gemini

**Cierre de V2.20 (decisión del responsable, 03/11):** se da por cerrada con **GitHub Actions diferido**. El workflow por servicio
(`imagenes-v2.yml`) queda escrito y en pausa; mientras tanto se compila en la VM. Si se activa con el repositorio privado, los
runners ARM de GitHub no son gratis (la VM es ARM).

**Documentación nueva de la versión 2** (la de la versión 1 se movió a `historico/reto1/`: ARQUITECTURA, EVENTOS, CRITERIOS,
PRUEBASSW, AUDITORIA y el README anterior):
- `ARQUITECTURA.md`: vista general, componentes con puertos y bases, tecnologías y contratos, flujos (compra de Booking, compra web,
  cancelación de vuelo), datos, observabilidad, seguridad, despliegue y estructura. Diagramas Mermaid.
- `EVENTOS.md`: CloudEvents, exchanges y colas reales de RabbitMQ, catálogo, webhooks a Booking (firma y reintentos 1 min → 6 h),
  eventos entrantes (4 capas contra duplicados) y stock REST (D53).
- `CRITERIOS.md`: cada requisito del ingeniero, del contrato v2 y de las mejoras propias, con evidencia y estado (✅/🟡). Lo 🟡:
  webhooks y eventos de Booking en real, entrega de credenciales, PWA en teléfono, GitHub Actions y auditorías.
- `DEFENSA.md`: checklist (encender la VM 1 h antes, apagarla al final), demostración de 7 pasos con comandos, preguntas probables y
  limitaciones.
- `README.md` reescrito para la versión 2. `CLAUDE.md`, `GEMINI.md` (verificación sin el monolito) y `DESPLIEGUE_AZURE.md`
  actualizados. **Corregido un consejo peligroso** de `DESPLIEGUE_AZURE.md` §10: borrar el grupo `rg-ecoairlines` borraría también
  la web del Reto 2; ahora indica borrar solo las dos apps del monolito.
- Los datos se verificaron contra el código: puertos del Compose, exchanges y colas, tipos de evento, reintentos, rutas del
  simulador. Se corrigió en el camino la versión de PostgreSQL (17) y una instrucción obsoleta: en local el horario se publica con
  `scripts/cloud/publicar-horario.mjs` dentro del ESB (`scripts/dev/publicar-horario.mjs` es anterior a V2.10).

**Retiro del monolito y `dev-auth`** (con `git rm`: todo sigue en el historial, commit `7cdd384`):
- Borrados `EcoAirlines.API`, `.Business`, `.DataManagement`, `.DataAccess`, `dev-auth`, los workflows `deploy-api.yml` y
  `deploy-auth.yml`, y `vitest.config.ts`, `vitest.config.e2e.ts` y `vitest.shared.ts`.
- `package.json` (v2.0.0): sin los workspaces ni los scripts del monolito; `npm test` corre las pruebas del Reto 2. `tsconfig.json`,
  `tsconfig.spec.json`, `.dockerignore` y `package-lock.json` sin referencias (4 entradas `extraneous` quitadas a mano; `npm ci
  --dry-run` y `npm ls` limpios). Comentarios del código que decían «como hoy `EcoAirlines.API`» pasados a pasado.
- **No se tocaron** los contratos de `contract/` (algunos lo mencionan como historia) **ni los recursos de Azure** del Reto 1: las
  dos App Service F1 siguen publicadas (gratis, sin base). Borrarlas es irreversible y lo decide el responsable.

**Verificación:** `npm run typecheck` y `npm run lint` limpios; `npm test` 637 pasan, 41 omitidas y 1 intermitente de tiempo
(`ms-vuelos`, health < 1 s) que pasa sola (18/18).

**Pendiente:** auditoría final de Gemini (V2.2–V2.21); PWA en un teléfono real; webhooks y eventos de Booking (BKG-01, BKG-15);
entrega de credenciales.

**03/11 — Usuarios de prueba en la nube (a pedido del responsable).** El responsable no podía entrar como administrador: en la
nube Identity corre en producción, no crea los clientes de prueba y el administrador tenía una contraseña aleatoria (V2.14). Por ser
un proyecto académico, pidió las claves conocidas. Sin cambiar código: `docker-compose.cloud.yml` pasa `SEED_DEMO_USERS` a Identity
(por defecto `false`) e `infra/cloud/.env` fija `ADMIN_PASSWORD=EcoAdmin2026` y `SEED_DEMO_USERS=true`. Verificado por la API pública:
los 4 inician sesión (`ADMIN` y 3 `CUSTOMER`) y el administrador lista los usuarios. **Riesgo aceptado por el responsable:** cualquiera
que lea el README puede entrar como administrador en la nube (crear partners, cambiar precios, cancelar vuelos).

**04/11 — Diagramas v5** (`PLAN/arquitectura-microservicios-v5.png`, `PLAN/modelo-conceptual-v5.png`, scripts en `PLAN/scripts/*_v5.py`).
La v4 (25/10) era el diseño previo a implementar; la v5 dibuja lo que hay en el código.
- **Arquitectura:** en rojo lo de D41–D53: tokens de servicio (ESB y MS de respuesta), enrutador con tabla cerrada, sagas con plazo de 3,5 s y
  cola diferida, Payment API (navegador autoriza, ESB captura) en la VM, stock a Booking por REST con `NODE_VUE_EQ5`, entrada de eventos por
  `POST /integraciones/booking/eventos`, gateway que verifica y reenvía el token y suscripciones graphql-ws, PWA con copia local mínima,
  observabilidad propia (12 reglas de alerta) y una sección nueva de **despliegue** (VM + Caddy + Static Web App).
- **Modelo de datos:** sacado de los `CREATE TABLE` de cada servicio. En rojo lo que cambió respecto del diseño: la reserva es **un documento
  JSONB** (la v4 dibujaba 10 tablas), `booking_seats` en lugar de `seats`, inventario con **contadores por estado** y un `CHECK` contra la
  sobreventa, y tablas nuevas: `hold_segments`, `promotion_rules`, `saga_results`, `booking_segments`, `passenger_documents`,
  `applied_events`, `assistance_ready`, `change_offers`, `schedule_meta`, y `refunds` e `idempotency_keys` en la Payment API. La telemetría
  se dibuja como lo que es: la pila de Prometheus, Tempo, Loki y Alertmanager, no tablas.

### PLAN_Observabilidad · O-1 — Reservas y detalle en el panel — ✅ HECHA (08/11), pendiente de auditoría

Para revisar una venta (como la DHV47T que pidió Booking el 08/11) sin entrar a Swagger ni a la base. Plan:
`PLAN/PLAN_Observabilidad.md` (decisiones D-O1 a D-O6). Solo lectura (D-O4); no cambia la lógica de negocio ni los contratos del grupo.

**Backend (contratos propios, cambios aditivos):**
- **MS.G.Bookings 1.2.0:** filtro `reference` en `GET /bookings` (solo con `X-Actor-Id`): PNR (sin importar mayúsculas), orden de Booking
  (`salesChannel.partnerOrderId`) o referencia del pago de la reserva, exactos; con índices nuevos sobre el JSONB. Para el administrador
  cada ítem trae canal, partner, orden, salida, pasajeros, reembolso total y creación; el detalle agrega `payments` (las referencias
  registradas en `payment_records`). El dueño no cambia: ni el filtro ni los campos nuevos le llegan.
- **MS.Admin 1.4.0:** `listAdminBookings` y `getAdminBooking` por el enrutador del ESB (las rutas ya existían).
- **Gateway GraphQL:** `adminBookings(filter, limit, cursor)` y `adminBooking(bookingId)` con tipos propios (`AdminBooking`,
  `AdminBookingSummary`…): el tipo `Booking` no sirve porque sus sub-recursos validan que el usuario sea el dueño. La asistencia médica
  NO pasa al navegador: solo `passengersWithAssistance` (ids).

**Web:** `/admin/reservas` (búsqueda por PNR, orden o pago; estado, canal y fechas en la URL; «Ver más» por cursor) y
`/admin/reservas/:bookingId` (página propia, D-O1): resumen, **liquidación** (cobrado − reembolsado = neto), itinerario y asientos,
pasajeros con el documento enmascarado y «Mostrar documentos» (D-O2), boletos, pagos registrados, historial y «Copiar resumen para
Booking». «Reservas» en el menú del panel. Funciones en `src/lib/admin-bookings.ts`.

**Verificación:**
- Pruebas: Bookings (28, 2 nuevas), MS.Admin (11, 2 nuevas), gateway (26, 1 nueva); `web-graphql.spec` valida las dos operaciones nuevas
  contra el esquema. Suite completa 642 pasan; 1 intermitente de la Payment API (no se tocó) pasó al repetir (27/27). Typecheck, lint
  (0 avisos) y build limpios.
- **Contra la base real** (la prueba de PostgreSQL necesita una base): `DHV47T`, `dhv47t`, `ORD-BKP-7B5BADB7C0` y
  `PAY-BKP-20261107-030453` devuelven solo DHV47T; una referencia inexistente, lista vacía. La primera consulta tras desplegar dio
  `PROVIDER_UNAVAILABLE` (VM con carga 17 después de compilar); las siguientes, 0,3–0,7 s.
- **Recorrido en Edge** contra la nube (build de producción en local, sin CORS solo en la prueba): **19/19**. Liquidación de DHV47T:
  59,00 + 20,85 = 79,85 cobrado, −20,85 de reembolso (REF-1545C35F, lo ejecuta Booking), neto 59,00; documento `1******675`; el resumen
  copiado trae orden, pago, reembolso y neto; ningún dato de asistencia en las respuestas.
- Despliegue: compiló las 18 imágenes (la librería compartida cambió en V2.21) en ≈1 h; esta vez **ningún servicio abortó** gracias al
  `start_period` del 03/11.

**Pendiente:** publicar la web (el responsable, con `swa deploy`) y la fase O-2 (historial con sagas y eventos).

### PLAN_Observabilidad · O-2 — Historial de la reserva y enlace a la traza — ✅ HECHA (08/11), pendiente de auditoría

**Qué agrega:** en el detalle de una reserva, un **historial** que une sus cambios, las **sagas** que la tocaron (tipo, estado, pasos
y su correlation ID) y los **eventos** que generó con **cada entrega a Booking** (estado, HTTP, intentos, próximo reintento). Cada saga
tiene «Ver la traza», que abre Telemetría ya buscada.

**Backend (contratos propios, aditivos):**
- **MS.G.Webhooks 1.3.0:** filtro `subject` (el `bookingId`) en `GET /history`, con índice.
- **ESB 1.4.0:** `SagaFilter.bookingId` (`input->>'bookingId'`, con índice: todas las sagas de una reserva lo reciben) y la
  composición `GET /composition/bookings/{bookingId}/timeline`. **Nunca** devuelve la entrada ni el resultado de una saga (datos
  personales y de salud): solo tipo, estado, fechas, error y nombre/estado de cada paso.
- **MS.Admin 1.5.0:** `getAdminBookingTimeline`. **GraphQL:** `AdminBooking.timeline` (se resuelve solo si la web lo pide).

**Arreglo de paso — la búsqueda por correlation ID de Telemetría ya no funcionaba en la nube.** Loki recorría 7 días: con una semana de
logs tarda **~24 s** en la VM (1 día: 7 s) y el ESB corta a los 3 s → «Loki no está disponible». El 02/11 funcionaba porque había pocos
logs. Ahora la traza acepta un **rango** (`from`/`to`) en GraphQL → MS.Admin → ESB → Loki: con 40 minutos responde en **0,2 s** (de
punta a punta, 0,5–0,6 s). «Ver la traza» manda la ventana de la saga (±10 min); la búsqueda manual de Telemetría elige «Últimas 3
horas» (por defecto), 24 horas o 7 días (lento). El correlation ID y el rango viajan en la URL.

**Verificación:** Webhooks 13 pruebas (1 nueva), ESB 37 (1 nueva + rango), MS.Admin 12 (1 nueva + rango), gateway 26 (+ timeline y
rango); suite completa **646 pasan**, 41 omitidas; typecheck, lint (0 avisos) y build limpios. Contra la nube: el historial de DHV47T
trae 3 sagas (crear, check-in, cancelar) y 4 eventos; **recorrido en Edge 23/23** (4 nuevos de O-2), incluida la traza de `corr-e2e`
(139 pasos en 10 servicios) desde «Ver la traza».

**Notas de operación:** justo después de cada despliegue la VM queda saturada unos minutos: el login y Loki (que reconstruye su índice
al recrearse) responden `PROVIDER_UNAVAILABLE` hasta que se calma; luego todo responde en < 1 s.

**Hallazgo (BKG-16, ver HALLAZGOS.md):** el historial mostró que **Booking registró su webhook el 04/11**
(`https://booking-core-api.azurewebsites.net/api/v2/webhooks/vuelos`) y que **rechaza con HTTP 400 todas nuestras entregas** (49
agotadas tras 6 intentos). No se probó su endpoint: el sistema de permisos bloqueó escribir en un sistema externo; hay que preguntarle a
Booking qué valida.

### PLAN_Observabilidad · O-3 — Reportes, liquidación con Booking y tarjetas del panel — ✅ HECHA (08/11), pendiente de auditoría

**Qué agrega:** la pantalla **Reportes** (`/admin/reportes`, período en la URL, por defecto los últimos 30 días): totales (vendidas,
cobrado, reembolsado, neto y por canal), **ventas por día** (barras web/Booking), **ventas por ruta** y la **liquidación con Booking**
reserva por reserva (PNR, orden de Booking, referencia de pago, estado, cobrado, reembolsado, neto) con fila de total y **«Exportar
CSV»** (D-O3: coma, punto decimal, BOM para Excel, fila TOTAL; `liquidacion-booking-{desde}-a-{hasta}.csv`). Cada fila abre el detalle
de la reserva. En el **Panel**, las tarjetas existentes enlazan a Reservas filtrada (todas / web / Booking) y a Usuarios, y hay tres
nuevas: «Reembolsos pendientes de Booking», «Neto de Booking este mes» (abren Reportes del mes) y «Estado del sistema» (abre Telemetría).

**Backend (contratos propios, aditivos; solo lectura, D-O4):**
- **MS.G.Bookings 1.3.0:** `GET /reports/sales?from&to` (`getSalesReport`, esquema `SalesReport`). Días en hora de Ecuador (UTC−5),
  máximo 366 días, `from ≤ to`. Excluye reservas fallidas y pendientes de pago; lo cobrado es la suma de los pagos registrados y el neto,
  cobrado − reembolsado. Reembolsos pendientes = los `CALCULATED` que debe ejecutar Booking.
- **ESB 1.4.0:** ruta nueva en la tabla cerrada `bookings GET /reports/sales` (48 rutas).
- **MS.Admin 1.6.0:** `GET /ecoairlines/admin/reports/sales`. **GraphQL:** `adminSalesReport(from, to)` y sus tipos.

**Arreglo de paso:** la marca BOM del CSV se escribe como `String.fromCharCode(0xfeff)`: escrita como escape, las herramientas de edición
la convertían en un carácter invisible dentro del código fuente.

**Verificación:** prueba de Bookings «★ cuadra» (la suma del reporte es igual a la suma de las reservas conocidas, por canal, por día y
en la liquidación) y de validación del rango; pruebas nuevas en MS.Admin y gateway; suite completa **651 pasan**, 41 omitidas;
typecheck, lint y build limpios. Contra la nube (01/11–08/11): 30 reservas, cobrado **2.823,00**, reembolsado **583,80**, neto
**2.239,20** = web 159,70 + Booking 2.079,50; liquidación con Booking de 28 reservas (cobrado 2.663,30 − 583,80 = 2.079,50), 25
reembolsos pendientes por 583,80; DHV47T aparece con su orden `ORD-BKP-7B5BADB7C0`, 79,85 / −20,85 / 59,00. **Recorrido en Edge
`recorrido_o3`: todo OK** (tarjetas y sus enlaces, cuadre fila a fila contra el total, contenido exacto del CSV, enlace al detalle);
el recorrido de O-1/O-2 sigue 23/23.

**Nota:** justo después del despliegue la tarjeta «Estado del sistema» mostró 1/12 arriba (la VM aún arrancando); minutos después,
12/12 y el nodo `HEALTHY`.

**Pendiente:** publicar la web (el responsable, con `swa deploy`) y la fase O-4 (Telemetría que se refresca sola y Eventos con enlaces).

### PLAN_Observabilidad · O-4 — Telemetría que se refresca sola y bitácora con la tabla nueva — ✅ HECHA (08/11), pendiente de auditoría

**Qué agrega:**
- **Telemetría** se actualiza sola **cada 15 s solo con la pestaña visible**; al volver a la pestaña se actualiza enseguida. Muestra
  la hora de la última actualización y una casilla «Actualizar sola» para pausarla. No pide una ronda nueva si la anterior sigue en
  curso (la VM tarda justo después de un despliegue). La búsqueda por correlation ID no se repite sola.
- **Bitácora** (componente `EventsPanel`, que se ve en la página Observabilidad): tabla nueva con momento, evento, **reserva** (PNR,
  enlace al detalle), **canal** (Booking con su orden, o web), **correlation ID** (enlace a Telemetría con la traza buscada en ±10 min
  alrededor del evento) y la entrega a cada suscriptor (estado, HTTP, intentos, destino; las agotadas en rojo). **Filtros** por tipo
  (con sugerencias), días (hora de Ecuador) y correlation ID.
- La página **Observabilidad** no cambió (D-O5): solo el componente de la bitácora que ya mostraba.

**Backend:** solo el contrato propio `contract/gateway.graphql`: `eventHistory` acepta `type` y `correlationId` (aditivo; MS.Admin y
Webhooks ya los aceptaban). Se despliega solo el gateway.

**Verificación:** prueba nueva del gateway (los filtros llegan a MS.Admin; un tipo inválido se rechaza); suite completa **652 pasan**, 41
omitidas; typecheck, lint y build limpios. **Recorrido en Edge `recorrido_o4`: todo OK** — se refresca sola con la pestaña visible;
con la pestaña oculta, **0 consultas en 32 s**; al volver, se refresca enseguida; pausa; filtro `booking.cancelled` del 07/11 al 08/11
→ 2 eventos (DHV47T y F6YTMA, canal Booking con su orden, `corr-e2e`, «Agotado (HTTP 400) · 6 intentos»: BKG-16); filtro por
`corr-e2e` → 12 eventos, todos de ese proceso; la reserva abre su detalle y el correlation ID abre la traza (139 pasos en 10
servicios). Los recorridos de O-1/O-2 y O-3 siguen todo OK.

**Con esto el PLAN_Observabilidad queda completo (O-1 a O-4).** Pendiente: publicar la web (el responsable, con `swa deploy`), la
auditoría y el commit.

### PLAN_Correccion · C-1 — Web: sesión al recargar, reserva cancelada y textos — ✅ HECHA (08/11), pendiente de auditoría

Primera fase de `PLAN/PLAN_Correccion.md`: los errores de la prueba de usuario que se arreglan solo en la web. Decisiones del
responsable: D-C1 (sesión), D-C2 (asiento opcional al reservar, cambiable hasta el check-in) y D-C3 (ingresos netos, va en C-2).

- **Sesión (error 1, D54):** el token se guarda también en `sessionStorage` (`AuthContext.tsx`). Recargar o abrir una URL en la
  misma pestaña mantiene la sesión; cerrar la pestaña, vencer el JWT o «Salir» la borran. Nunca en `localStorage`.
- **Banner (error 3):** «¡Reserva confirmada!» solo sale si la reserva está `CONFIRMED`. Tras cancelar, cambiar o hacer check-in se
  borra el estado `justBooked` del historial del navegador.
- **Tramo anulado (error 4):** si el boleto está anulado o reembolsado, sus tramos dicen «Anulado» o «Reembolsado» (`couponStatus`).
  El estado del cupón es del contrato del grupo (`PENDING, ISSUED, FAILED`) y no se modificó. El detalle del administrador no
  mostraba el estado de los tramos: no tenía el problema.
- **Reembolso visible (error 5):** el detalle pide `refunds` (ya existía en GraphQL para el cliente) y una reserva cancelada muestra
  la tarjeta «Reembolso»: lo devuelto, la penalidad retenida y el estado en palabras.
- **Asiento (error 7, D-C2):** el comportamiento se queda (asignación automática al confirmar). Se corrigió el texto del pago: «si no
  eliges, te asignamos uno al confirmar. Puedes cambiarlo hasta hacer el check-in». El detalle lo recuerda.
- **Semilla:** «Sin cambios; si cancelas, solo se devuelven los impuestos» (era «Sin cambios ni reembolso», y sí se devuelven los
  impuestos).

**Verificación:** typecheck y lint limpios; `web-graphql.spec.ts` valida la consulta nueva contra el esquema; suite completa **652
pasan**, 41 omitidas. **Recorrido en Edge `recorrido_c1` contra la nube: todo OK** (14 comprobaciones):
- F5 y URL directa mantienen la sesión; el token está en `sessionStorage` y no en `localStorage`; una pestaña nueva pide ingresar;
  «Salir» la borra.
- `FFT8J6` (cancelada), aunque se llegue con el estado del pago: sin banner; tramo «EA302 · asiento 4A · Anulado»; reembolso
  $31,80, penalidad $132,00, «Acreditado a tu tarjeta».
- `X3J2U7` (confirmada): el banner sí sale; el texto del asiento; sin tarjeta de reembolso.

No cambia el backend: para verlo en la nube basta con publicar la web. **Siguiente: C-2** (motivo en el historial, ingresos netos y
bloqueo después del check-in).

### PLAN_Correccion · C-2 — Motivo en el historial, ingresos netos y bloqueo después del check-in — ✅ HECHA (08/11), pendiente de auditoría

- **Motivo de cancelación (error 6):** MS.G.Bookings guarda en el historial el motivo que escribió el cliente y el código en español:
  «Reserva cancelada a pedido del cliente: «Cambio de planes».» (antes: «Reserva cancelada (CUSTOMER_REQUEST).»). Otros códigos:
  «por cancelación del vuelo», «por Booking (paquete cancelado)», «por otro motivo». El motivo no va a los logs.
- **Ingresos netos (error 8, D-C3):** `summary()` de Bookings usa la misma regla que el reporte de ventas (función común
  `chargedRows`): ingresos = cobrado − reembolsado de toda reserva cobrada (no FAILED ni pendiente de pago). Una cancelada aporta la
  penalidad retenida. Los impuestos de los ingresos son los de las reservas vigentes. «Ingresos por ruta» usa la misma regla. La
  tarjeta del panel pasa a «Ingresos netos» con la explicación.
- **Después del check-in nada se modifica (D55):**
  - ESB: `assertNotCheckedIn` consulta MS.G.CheckIn en el primer paso de las sagas de cancelar (salvo `FLIGHT_CANCELLED` y
    `SAGA_COMPENSATION`), cambiar fecha y agregar maletas, antes de consumir la cotización o cobrar → `409 CUTOFF_PASSED`.
  - Bookings repite la regla en `applyCancellation`, `applyDateChange` y `applyBaggage`. El asiento y la asistencia ya estaban
    bloqueados.
  - Web: con pases de abordar, el detalle deja solo «Check-in y pases» y avisa «Ya hiciste check-in: tu reserva ya no se puede
    modificar». El mensaje de `CUTOFF_PASSED` decía «El check-in ya cerró…», que no correspondía a ningún uso del código: corregido.
  - Se bloquea toda la reserva (no por tramo), como se dejó escrito en el plan.
- `PLAN.md`: **D55** registrada y **AR-02** precisado (el check-in asigna asiento solo a quien no lo tiene).

**Verificación:** pruebas nuevas en Bookings (motivo; ingresos +119,50 al vender y +25,00 tras cancelar con 94,50 devueltos;
D55 con maletas, fecha y cancelación bloqueadas y la cancelación por vuelo permitida) y en el ESB (D55 en las tres sagas, sin
consumir la cotización ni cobrar; el paso nuevo entra en los «fallo en cada paso»); suite completa **658 pasan**, 41 omitidas;
typecheck y lint limpios. Desplegado en la VM. **Contra la nube** (`compra_c2.mjs`, dos compras con la cuenta demo por la API, como
la web):
- `VSFDHF`: check-in → cancelar responde `CUTOFF_PASSED` y la reserva sigue `CONFIRMED`.
- `M6DDSN`: cancelada con el motivo «Cambio de planes» → el historial lo muestra.
- Ingresos del panel **$4.966,00** = neto del reporte de ventas del año ($6.094,70 − $1.128,70).
- **Recorrido en Edge `recorrido_c2`: todo OK** (con check-in solo queda la pestaña de pases; sin check-in, las 6; el motivo en el
  historial; «Ingresos netos» en el panel). `recorrido_c1` sigue todo OK.

**Nota de operación:** el primer intento de compra, justo después del despliegue, falló con `PROVIDER_UNAVAILABLE` (la VM aún
saturada). No quedó reserva; la autorización del pago vence sola a los 30 minutos. El segundo intento, minutos después, funcionó.

Para verlo en la web hay que publicarla. **Siguiente: C-3** (día de la vuelta y tiempo en tierra en Rutas).

### PLAN_Correccion · C-3 — Rutas: día de la vuelta y tiempo en tierra — ✅ HECHA (08/11), pendiente de auditoría

El «error» de la ruta a Madrid no era de validación: el EA304 llega el jueves 12:25 y el EA305 sale el **viernes** 13:00 (24 h 35 min
en tierra), porque a las 13:00 del jueves el 787-9 no cumple sus 90 minutos. La lista solo mostraba «Mié» y las horas, y eso se leía
como 35 minutos.

- **MS.G.Schedule 1.2.0** (contrato propio, aditivo): cada ruta trae `inbound.weekdays` (y `outbound.weekdays`), `returnDelayDays`,
  `groundMinutes` y `turnaroundMinutes`. Se calculan con `routeReturn`, la misma cuenta que usa el horario: `returnDelayOf` se
  extrajo de `planRoundTrips`, así que no hay dos cálculos que puedan diferir.
- **Gateway:** `RouteLeg.weekdays` y `ScheduledRoute.returnDelayDays/groundMinutes/turnaroundMinutes` (opcionales).
- **Web (Rutas programadas):**
  - la vuelta dice «2 días después · en tierra en MAD: 24 h 35 min» (resaltado cuando no es el mismo día);
  - la columna de días separa «Ida: Mié» y «Vuelta: Vie»;
  - el formulario explica los mínimos en tierra (A220 35, A320neo 45, 787-9 90 min);
  - el mensaje al guardar dice cuándo sale la vuelta y cuánto tiempo queda el avión en tierra.
  - **Cambio respecto al plan:** el aviso sale al guardar y no antes. La web no conoce los husos horarios y calcularlo ahí duplicaría
    las reglas del horario.

**Verificación:** prueba de Schedule (UIO ⇄ MAD, 787-9, mié 19:00 / 13:00 → vuelta el viernes, 2 días, 1.475 min en tierra, mínimo
90; una ruta del mismo día → 0 días; la lista trae lo mismo); suite completa **659 pasan**, 41 omitidas; typecheck, lint y
validación de las consultas de la web limpios. Desplegado en la VM. **Contra la nube:** `EA304-EA305` devuelve vuelta `FRI`, 2 días,
1.475 min, mínimo 90. **Recorrido en Edge `recorrido_c3`: todo OK**; `recorrido_c1` y `recorrido_c2` siguen todo OK. El primer
intento del recorrido, justo después del despliegue, encontró el panel con «Un servicio necesario no está disponible» (la VM aún
saturada); minutos después pasó entero.

**Con esto el PLAN_Correccion queda completo (C-1 a C-3).** Pendiente: publicar la web (el responsable, con `swa deploy`), la
auditoría y el commit.

### PLAN_Provincias · P-1 — Red nacional: las 24 provincias del Ecuador — ✅ HECHA (08/11), pendiente de auditoría

Pedido del responsable: una red más local, con la capital de cada provincia disponible para crear rutas (haya o no aeropuerto),
y rutas desde Quito a todas. Decisiones D-P1 (códigos), D-P2 (capitales **y** aeropuertos reales fuera de la capital) y D-P3
(rutas diarias desde Quito, ida y vuelta el mismo día) en `PLAN/PLAN_Provincias.md`.

- **Catálogo (`packages/shared`):** 24 ciudades nuevas (21 capitales + Manta, Santa Rosa y Salinas), con provincia, coordenadas y
  huso horario. Galápagos es UTC−6. Las 7 capitales sin aeropuerto usan un código propio (GDA, AZG, RBA, IBR, BHO, STE, SDT, ZMR) y
  su nombre dice «(simulado)». Ecuador queda con 27 ciudades; la red, con 34.
- **MS.G.Schedule:** la red «todos con todos» de las pruebas del motor (`generateRoutes`) usa `BASE_NETWORK_AIRPORTS`, los 10
  originales: su numeración de vuelos y sus franjas solo alcanzan para ~10 aeropuertos. La red real no se toca.
- **Web:** `data/airports.ts` con las mismas ciudades, y el componente `AirportOptions`. Los 10 selectores de aeropuertos
  (buscador, flota, rutas, vuelos, horario de la flota) agrupan «Ecuador» (con la provincia: «Guaranda (GDA) · Bolívar») e
  «Internacional».
- **Contratos:** sin cambios (el del grupo solo exige 3 letras).

**Rutas en la nube (D-P3):** 24 rutas Quito → cada ciudad nueva (`rutas_provincias.mjs`, por la API de administración), diarias.
La ida sale desde las 06:00 cada 20 minutos y la vuelta 3 h después (EA308–EA355). Todas vuelven el mismo día, con 115 a 145
minutos en tierra. Cada ruta agregó su A220-300 con base en Quito (HC-J04, HC-J06 a HC-J28). Quito ⇄ Galápagos: 1.255 km, 2 h 05 de
vuelo.
- El primer intento, justo después del despliegue, falló entero: el ESB no respondía a tiempo y se abrió el circuito hacia
  Schedule. Una ruta (Esmeraldas) se creó igual en segundo plano. El segundo intento, con la VM ya estable y 5 s entre rutas,
  creó las otras 23.
- **Hallazgo:** los intentos fallidos dejaron **dos aviones sin ruta (HC-J03 y HC-J05)**. Cuando una creación de ruta se deshace
  por timeout, la ruta se anula pero los aviones que agregó quedan en la flota (disponibles, sin vuelos). No afecta la operación;
  se pueden dar de baja desde «Flota».
- **Stock a Booking:** los vuelos nuevos generaron ~6.900 envíos de stock pendientes. Salen en serie, uno por uno, con reintento
  espaciado. Booking verá las ciudades nuevas; conviene avisarles.

**Verificación:** prueba nueva de Schedule (Quito → Guaranda con código propio y Quito → Galápagos con la llegada en hora local
UTC−6); la prueba de la red «todos con todos» ahora se arma con los 10 originales; suite completa **660 pasan**, 41 omitidas;
typecheck y lint limpios. **Recorrido en Edge `recorrido_p1` contra la nube: todo OK** (buscador agrupado con 27 + 7 ciudades;
«Guaranda (GDA) · Bolívar»; búsquedas Quito → Galápagos y Quito → Guaranda con vuelo directo; panel con las 24 rutas, Quito ⇄
Zamora diaria y del mismo día). `recorrido_c1` sigue todo OK.

### PLAN_Telemetria_Asientos · T-1 — Asiento tomado: SEAT_TAKEN antes de cobrar (pedido de Booking) — ✅ HECHA (09/11), pendiente de auditoría

Pedido de Booking: (a) en `POST /vuelos/bookings`, si un asiento de `assignedSeats` ya está tomado, `409`
`application/problem+json` con `"code": "SEAT_TAKEN"`, sin crear la reserva, y lo mismo en nuestro e-commerce **antes de cobrar**;
(b) en el mapa de asientos, todo lo vendido con su estado e `isAvailable: false`.

**Lo que ya cumplía (verificado en la nube antes de cambiar nada):** el 409 `SEAT_TAKEN` problem+json sin crear la reserva para
Booking (`seat_taken_booking.mjs`), y el mapa de asientos por REST (15A del EA304 del 11/11 `TICKETED`/`false`, 320 `AVAILABLE`).
**Lo que no:** en el canal web la saga capturaba el cobro antes de validar el asiento y luego lo reembolsaba.

**Cambios:**
- **`ms-g-offers.proto` (propio, aditivo):** `ValidateHoldRequest.requested_seats`.
- **MS.G.Offers:** `validate()` revisa cada asiento pedido: que el segmento sea del hold, que el asiento exista, que sea de la
  cabina comprada (`SEAT_CABIN_MISMATCH`), que no esté repetido y que **no esté tomado** (`SEAT_TAKEN`). No ocupa nada: la toma
  atómica sigue al consumir el hold. `SEAT_TAKEN` ahora con el formato que sugiere Booking: `title: "Asiento no disponible"`,
  `detail: "El asiento 15A del segmento EA304-20261111 ya fue tomado."` (y `invalidParams` como antes).
- **ESB:** la saga «Crear reserva» pasa los asientos pedidos a `ValidateHold`, su primer paso, **antes** del pago y del reclamo de
  la referencia.
- **Web:** ante `SEAT_TAKEN`, el pago quita ese asiento de la selección, vuelve a pedir el mapa (`refreshKey` en `SeatMapPicker`)
  y conserva el cupo retenido. Mensaje: «Ese asiento ya lo tomó otro viajero. Lo quitamos de tu selección y actualizamos el
  mapa: elige otro y vuelve a confirmar».

**Verificación:** pruebas nuevas en Offers (tomado → `SEAT_TAKEN` con título y detalle; libre pasa y la revisión no lo ocupa;
otra cabina, repetido e inexistente se rechazan; el mapa muestra el vendido `BOOKED`/`false`) y en el ESB (con el asiento tomado la
saga se detiene en `offers ValidateHold`: ni captura, ni reembolso, ni reclamo de la referencia de Booking); suite completa **662
pasan**, 41 omitidas; typecheck y lint limpios. Desplegado en la VM. **Contra la nube:**
- **Booking (REST):** `409`, `application/problem+json`, `"title":"Asiento no disponible"`, `"code":"SEAT_TAKEN"`, `"detail":"El
  asiento 15A del segmento EA304-20261111 ya fue tomado."`; el hold se liberó (204).
- **Web (`seat_taken_web.mjs`):** el pago `pay_W0Fz5TO5cmbATCIFl045` quedó `AUTHORIZED` (**nunca capturado**) y `createBooking`
  respondió `SEAT_TAKEN`. La autorización vence sola.
- **Recorrido en Edge `recorrido_t1`: todo OK** (con `SEAT_TAKEN` simulado en el navegador para no ocupar un asiento real): el
  mensaje, el 21A quitado de la selección, el mapa pedido de nuevo y la página sigue en el pago.

**Nota de operación:** el primer despliegue falló por SSH: la regla `allow-ssh-2222` del NSG solo permitía 157.100.190.27 y la IP
de hoy era 157.100.143.28. Con autorización del responsable se **agregó** la IP (la regla admite las dos; SSH sigue cerrado al
resto de internet).

### PLAN_Telemetria_Asientos · R-1 — Retrasos de un vuelo (pedido de Booking) — ✅ HECHA (09/11), pendiente de auditoría

Pedido: el administrador indica **cuánto** se atrasa un vuelo y eso se ve en su estado y su nueva hora; solo cambia **ese vuelo de
esa fecha**. Decisiones D-T9 (en minutos), D-T10 (avisar y «retrasar también» opcional, nunca en cadena) y D-T11 (check-in hasta la
salida estimada).

**Cambios:**
- **MS.G.FlightStatus 1.1.0:**
  - con una salida estimada nueva, la **llegada estimada se corre lo mismo** (antes quedaba la programada);
  - `DELAYED → SCHEDULED` **quita el retraso** y borra las horas estimadas;
  - `GET /flights/{n}/delay-impact?date&delayMinutes` (solo consulta): nueva salida y llegada, y el **siguiente vuelo del mismo
    avión** (por matrícula, ese día o los 2 siguientes; el 787 a Madrid vuelve 2 días después). Con el tiempo en tierra de su tipo,
    dice si llega (`conflict`) y cuántos minutos habría que atrasar ese otro vuelo (`suggestedDelayMinutes`).
- **Arreglo de paso: las horas estimadas y reales salían en UTC** (`…T14:40:00Z`). La web y Booking mostraban 14:40 en vez de
  09:40, porque el contrato usa la hora local del aeropuerto (`…-05:00`). Ahora FlightStatus las devuelve siempre con el desfase
  del aeropuerto (`atOffsetOf`), también las ya guardadas.
- **ESB 1.5.0:** composición `GET /composition/flights/{n}/delay-impact`: el impacto del avión más las **reservas afectadas** y
  quiénes quedan con menos margen que el de la búsqueda (conexión 60 min, vuelta 120 min). La saga de **check-in** deja abierto un
  vuelo `DELAYED` hasta su salida estimada; pasada la hora programada, solo abre los retrasados (la ida ya volada no bloquea la
  vuelta).
- **MS.Admin 1.7.0** `getFlightDelayImpact` · **GraphQL** `flightDelayImpact`.
- **Web:**
  - **Operaciones → «Retrasado»** pide los **minutos** (15 min a 2 h u otro) y muestra la **vista previa**: nueva salida y
    llegada (con el día cuando cambia), si el avión llega a su siguiente vuelo (si no, la casilla **opcional** «Retrasar también
    EA325 40 min»), cuántas reservas y pasajeros afecta y quiénes quedan con poco margen. «Quitar el retraso» vuelve a la hora
    programada. El detalle del vuelo muestra el retraso vigente.
  - El **cliente** ve «Tu vuelo EA304 está retrasado 30 min. Nueva salida 19:30 (era 19:00) · nueva llegada jue, 12 nov 12:55»
    en su reserva; el **administrador**, en el detalle de la reserva (`FlightDelayNotice`).
  - El texto del check-in decía «cierra 60 minutos antes»; la saga cierra a la hora de salida: corregido.

**Verificación:** pruebas nuevas en FlightStatus (impacto con y sin conflicto, siguiente vuelo al día siguiente, llegada
recalculada, quitar el retraso, hora UTC devuelta en local), ESB (composición con conexión justa y vuelta holgada; check-in de un
retrasado abierto hasta la estimada y cerrado sin retraso), MS.Admin y gateway; suite completa **668 pasan**, 41 omitidas;
typecheck y lint limpios. Desplegado en la VM. **Recorrido en Edge `recorrido_r1` contra la nube: todo OK:**
- EA324 Quito → Loja, 1 h: el avión llega a EA325; 2 h: avisa que HC-J13 estaría listo a las 12:20 y ofrece «retrasar también».
- **Retraso real** del EA304 del 11/11 (30 min, reserva demo X3J2U7): Booking lo ve por REST (`DELAYED`, `delayMinutes: 30`,
  `19:30:00-05:00`, llegada `12:55:00+01:00`); la vuelta EA305 sigue a tiempo; el cliente ve el aviso en su reserva.
- Al final se **quitó** el retraso: el vuelo quedó `SCHEDULED`, como estaba.

El recorrido encontró dos errores, ya corregidos: las horas en UTC y el campo de minutos con `step=5`, que hacía que el navegador
rechazara 30.

**Booking:** ve el retraso consultando `GET /vuelos/flights/{n}/status`. Los webhooks `flight.status_changed` y
`flight.schedule_changed` ya se publican, pero su endpoint los rechaza con HTTP 400 (BKG-16): hay que pedirles que lo revisen.

### PLAN_Telemetria_Asientos · P-1 — Precios editables: tarifa base y precio exacto por ruta — ✅ HECHA (09/11), pendiente de auditoría

Pedido del responsable: poder corregir precios desde «Precios y promociones», con el **dato de referencia del precio por km**, y
escribir el **precio exacto de los 4 paquetes** (Semilla, Brote, Bosque, Dosel) de una ruta (D-T12). Antes, la tarifa de un adulto
en un vuelo era `(35 + 0,085 × km) × multiplicador`, con 35 y 0,085 **fijos en el código** de Offers; solo se editaban los
multiplicadores.

**Cambios:**
- **MS.G.Schedule 1.3.0** (dueño de los precios):
  - tablas `pricing_settings` (cargo fijo, precio por km, precios por ruta) y `pricing_changes` (historial: quién, cuándo, de cuánto
    a cuánto);
  - `GET /pricing` y `PUT /pricing` (estado completo, todo o nada). Una ruta con precio exacto lleva los 4 paquetes; una ruta que
    se agrega o cambia debe existir en el horario. Por defecto 35 y 0,085: nada cambió hasta editar.
- **ESB 1.6.0:**
  - la saga **«Guardar precios»** suma el tipo `pricing` (`PUT /sagas/pricing`): mezcla lo vigente con lo que cambia, guarda en
    Schedule y publica a Offers; si Offers falla, **compensa** volviendo al estado anterior. Ruta de lectura nueva
    `GET /router/schedule/pricing` (49 rutas).
  - `PublishFarePrices` lleva la tarifa base y los precios por ruta.
- **MS.G.Offers** (`ms-g-offers.proto`, aditivo: `pricing`, `route_prices`):
  - guarda la copia (`pricing_settings`);
  - cotiza cada vuelo con `(cargo fijo + precio por km × km) × multiplicador`, o con el precio exacto del paquete en esa ruta (ida
    y vuelta de la misma ruta);
  - con los valores por defecto el cálculo es el mismo de antes, operación por operación;
  - los holds y las reservas ya creados conservan su precio.
- **MS.Admin 1.8.0** y **GraphQL:** `PricesView.pricing` y `SavePricesInput.pricing` (tarifa base y/o una ruta; `prices` vacío
  quita el precio exacto).
- **Web «Precios y promociones»:** panel **«Tarifa base y precio por ruta»** con:
  - el cargo fijo y el precio por km;
  - una ruta a elegir que muestra **cuánto cuesta cada paquete en dólares** por fórmula, con su cabina (Semilla, Brote y Bosque en
    Economy; Dosel en Business);
  - el precio exacto de los 4 paquetes, con un aviso si se aleja mucho de la fórmula, y «Quitar precio exacto»;
  - los últimos cambios.

**Verificación:** pruebas nuevas en Schedule (valores por defecto, guardar con historial, guardar lo mismo no deja historial,
quitar la ruta, validaciones), Offers (fórmula con otro cargo y precio por km; el precio exacto solo para ese paquete; un
publicador sin `pricing` conserva la copia; volver a 35/0,085 da lo de antes), ESB (estado completo a Schedule, copia a Offers,
quitar una ruta, compensación si Offers falla), MS.Admin y gateway; suite completa **673 pasan**, 41 omitidas; typecheck y lint
limpios. Desplegado. **Recorrido en Edge `recorrido_p1p` contra la nube: todo OK:**
- la pantalla mostró Quito ⇄ Loja por fórmula US$73 / 98 / 131 / 233, **igual** que la búsqueda real;
- con el precio exacto 70 / 95 / 125 / 220, la búsqueda pública (la de Booking) cobró eso en Quito → Loja y Loja → Quito; Quito →
  Guayaquil siguió con la fórmula;
- subir el precio por km a 0,10 subió Semilla Quito → Guayaquil de 59 a 63 sin mover Loja;
- al final se volvió a 0,085 y se quitó el precio exacto: **todos los precios quedaron como antes**.

**Error encontrado por el recorrido (corregido):** el panel tenía sus propios `<form>` dentro del `<form>` de la página. HTML no los
admite anidados: los botones enviaban el «Guardar» de los multiplicadores y no se guardaba nada. Ahora son botones normales.

### PLAN_Telemetria_Asientos · T-2 — Búsqueda por correlation ID con ventana automática — ✅ HECHA (09/11), pendiente de auditoría

Problema: Loki no indexa el `correlation_id`; filtra línea por línea todo el rango (1 día ~7 s, 7 días ~24 s en la VM) y el ESB le
da 3 s. Buscar sin acotar fallaba con «Loki no está disponible», aunque las sagas y los eventos del proceso sí existían.

**Cambios:**
- **ESB 1.7.0** (`composeCorrelationTrace`): primero busca lo rápido —sagas (`saga_log`) y eventos (Webhooks), por índice— y con sus
  horas arma la ventana de Loki: del primero al último **±10 min** (máx. 24 h). Sin sagas ni eventos, las **últimas 3 h**. Un
  rango explícito (`from`/`to`, el del historial de una reserva) se respeta.
- **Si Loki tarda**, ya no se pierde todo: vienen las sagas y los eventos con `stepsError` («La búsqueda tardó demasiado: prueba
  con un rango más corto.»). Sin nada más, `503` con ese mismo detalle. No abre ningún circuito: el ESB responde con su
  ProblemDetails (el `EsbClient` de MS.Admin no lo cuenta como falla) y el ESB no pone circuito ante Loki.
- **MS.Admin 1.9.0 y GraphQL:** `CorrelationTrace.window { from to source }` (`RECORDS`, `RANGE`, `DEFAULT`) y `stepsError`.
- **Web «Telemetría»:** se quitó el selector de 3 h / 24 h / 7 días; la página dice dónde buscó («según sus sagas y eventos») y
  avisa si faltan los pasos.

**Verificación:** pruebas nuevas en el ESB (ventana de sagas y eventos ±10 min; sin registros, 3 h y el 404 lo dice; Loki lento →
sagas con el aviso, y 503 si no hay nada más), MS.Admin y gateway; suite **675 pasan**, 41 omitidas; typecheck y lint limpios
(se corrigió además un tipo en una prueba de Offers de P-1). Desplegado. **Recorrido en Edge `recorrido_t2` contra la nube:**
`corr-f488627d-…` encontró sus **9 pasos sin elegir rango** en una ventana de 20 min, en **282–378 ms**. Justo después del
despliegue (VM cargada) Loki tardó más de 3 s y la página mostró el aviso con las sagas: el comportamiento esperado.

### PLAN_Telemetria_Asientos · M-1 — Aeropuertos administrables — ✅ HECHA (10/11), pendiente de auditoría

Pedido del responsable: agregar aeropuertos desde el panel. Antes eran una **constante del código** (`AIRPORTS` de
`packages/shared`): sumar uno exigía cambiar el código y desplegar todo.

**Diseño:** el dueño es **MS.G.Schedule** (tabla `airports`, sembrada con los 34 de siempre solo si está vacía: un aeropuerto
borrado no vuelve). `AIRPORTS` pasa a ser el **catálogo de cada proceso**: arranca con la semilla y se actualiza con lo que le
llega, así las ~20 lecturas `AIRPORTS[code]` (reglas de rutas, motor del horario, distancias, «¿es internacional?») no cambiaron.
Se respeta «un MS.G no llama a otro»: el catálogo viaja por el ESB.
- **Schedule 1.4.0:** `GET/POST /airports`, `GET/PUT/DELETE /airports/{code}`. El código (3 letras) no se edita (D-T6). Con rutas
  o aviones con base ahí: no se borra y no cambian país, coordenadas ni huso (`409 AIRPORT_IN_USE`, el detalle dice qué lo usa);
  se **desactiva** y una ruta nueva hacia él da `422 AIRPORT_INACTIVE` (las que ya tiene siguen; la compensación que restaura una
  ruta borrada sí puede usarlo). Huso en múltiplos de 15 min; país ISO de 2 letras.
- **ESB 1.8.0:** 5 rutas nuevas del enrutador (54). Su catálogo se mantiene al día: lo pide a Schedule al arrancar y cada 60 s
  (`AIRPORT_SYNC_MS`), lo actualiza en el acto cuando pasa una escritura de aeropuerto que salió bien, y la saga «Publicar horario»
  lo vuelve a pedir y se lo manda a Offers. Si Schedule no responde, se queda con el que tenía: nunca falla una operación por esto.
- **Offers** (`ms-g-offers.proto`, aditivo: `PublishTimetableRequest.airports`): guarda la copia (`airport_catalog`) y la carga al
  arrancar, para las distancias de cada vuelo y de las conexiones.
- **MS.Vuelos 1.1.0:** operación propia pública `GET /ecoairlines/airports` (no es del contrato del grupo: allí los aeropuertos son
  solo códigos). **MS.Admin 1.10.0:** alta, cambio y baja. **GraphQL:** `airports` (pública), `createAirport`, `updateAirport`,
  `deleteAirport` y los códigos `AIRPORT_IN_USE`, `AIRPORT_ALREADY_EXISTS`, `AIRPORT_INACTIVE`, `AIRPORT_NOT_FOUND`.
- **Web:** pide el catálogo al arrancar (espera hasta 1,5 s; si tarda, arranca con la lista de respaldo y los selectores se
  actualizan solos). Los selectores muestran solo los activos (en una ruta o un avión que ya usa uno desactivado, se conserva).
  Pestaña nueva **«Aeropuertos»** en el panel: catálogo con buscador y su uso (rutas y aviones), agregar, editar (con rutas o
  aviones, país, coordenadas y huso bloqueados), activar/desactivar y borrar (solo si no se usa).

**Verificación:** pruebas nuevas en Schedule (los 34; crear, ruta desde Quito, en uso no se mueve ni se borra, desactivado no admite
rutas nuevas y su ruta sigue en el horario, borrar sin uso; validaciones), ESB (el enrutador actualiza el catálogo en alta, cambio
y baja; un rechazo no lo cambia; la saga manda los 35 a Offers), Offers (un vuelo a un aeropuerto nuevo se cotiza con su
distancia), MS.Vuelos, MS.Admin y gateway; suite **690 pasan**, 41 omitidas; typecheck y lint limpios. Desplegado. **Recorrido en
Edge `recorrido_m1` contra la nube: todo OK:**
- los 34 aeropuertos siguen activos y Quito → Loja cuesta lo mismo (73 / 98 / 131 / 233);
- se creó «Jipijapa (JPJ)» desde el panel y una ruta Quito ⇄ Jipijapa (EA356/EA357, con un A220 nuevo HC-J29);
- la búsqueda pública (la de Booking) y el buscador de la web la encuentran (Semilla US$59);
- en uso, cambiar su latitud dio `AIRPORT_IN_USE` y no aparece «Borrar»; desactivado salió del buscador y su ruta siguió a la venta;
- al final se dio de baja la ruta, se retiró HC-J29 y se borró JPJ: **34 aeropuertos y 33 aviones, como antes**.

**Errores del recorrido (corregidos en el script, no en la aplicación):** selectores ambiguos («Destino» también coincidía con
«Salida de la vuelta») y revisar el buscador antes de que llegara el catálogo de la API; la web ahora marca
`<html data-airports="api">` cuando lo tiene. Una primera corrida dejó la ruta, el avión y el aeropuerto de prueba en la nube: se
quitaron a mano por GraphQL.

### PLAN_Telemetria_Asientos · M-2 — Tipos de avión administrables — ✅ HECHA (10/11), pendiente de auditoría

Pedido del responsable: agregar tipos de avión desde el panel. Antes eran 3 tipos **fijos del código** (`AIRCRAFT_TYPES` y sus
tablas de asientos, alcance, tiempo en tierra y prefijo en `packages/shared`).

**Diseño (como M-1):** el dueño es **MS.G.Schedule** (tabla `aircraft_types`, sembrada con los 3 de siempre solo si está vacía).
Lo de `shared` pasa a ser el **catálogo de cada proceso** (semilla + `registerAircraftTypes`), así las lecturas de siempre
(`AIRCRAFT_LAYOUTS[tipo]`, `TURNAROUND_MINUTES[tipo]`, `aircraftFor(km)`) no cambiaron.
- **Ficha de un tipo:** nombre (clave, no se edita), prefijo `HC-` + una letra (único), alcance en km o sin límite, tiempo en tierra
  y **Business y Economy siempre (D-T8)**, cada una con sus asientos y su configuración por fila: Business 2-2, 1-2-1 o 2-2-2;
  Economy 2-3, 3-3, 2-4-2 o 3-3-3 (las de los 3 tipos de siempre están incluidas). Filas = asientos ÷ asientos por fila
  (exacto, si no `400`); Business desde la fila 1, Economy a continuación, con la primera fila de más espacio y la del medio de
  emergencia.
- **D-T7:** un tipo con aviones o rutas no cambia ni se borra (`409 AIRCRAFT_TYPE_IN_USE`); sin ellos se edita y se borra.
- **Elección por distancia:** el de menor alcance que cubre la ruta, entre todos los del catálogo (antes, los 3 fijos).
- **Schedule 1.5.0:** `POST /aircraft-types`, `PUT/DELETE /aircraft-types/{aircraftType}` (nombre codificado en la ruta);
  `AircraftTypeInfo.cabins` (distribución de cada cabina); `AircraftType` ya no es un enum; un tipo desconocido da
  `422 UNKNOWN_AIRCRAFT_TYPE`; cada vuelo del horario lleva su `turnaroundMinutes`.
- **ESB 1.9.0:** 3 rutas nuevas del enrutador (57). La saga «Publicar horario» pide los tipos a Schedule y se los manda a Offers.
- **Offers** (`ms-g-offers.proto`, aditivo: `PublishTimetableRequest.aircraft_types`): guarda una copia **acumulada** (nunca quita un
  tipo: un vuelo con ventas de un tipo ya borrado sigue teniendo su mapa) y la carga al arrancar. El mapa de asientos se guarda en
  caché por la ficha del tipo, no por su nombre.
- **FlightStatus:** cada vuelo guarda su tiempo en tierra (columna nueva, llega en `schedule.published`); el impacto de un retraso
  lo usa (los vuelos publicados antes de M-2 usan el de la semilla).
- **MS.Admin 1.11.0 y GraphQL:** `createAircraftType`, `updateAircraftType`, `deleteAircraftType`, `AircraftTypeInfo.cabins` y los
  códigos `AIRCRAFT_TYPE_IN_USE`, `AIRCRAFT_TYPE_ALREADY_EXISTS`, `AIRCRAFT_TYPE_NOT_FOUND`, `UNKNOWN_AIRCRAFT_TYPE`.
- **Web:** pestaña nueva **«Tipos de avión»** (agregar con aviso de filas incompletas y total de asientos; editar y borrar solo sin
  aviones). «Rutas programadas» calcula el tipo automático con el catálogo (antes con 1 500 y 4 500 km fijos).

**Verificación:** pruebas nuevas en Schedule (los 3 de siempre con su distribución; crear, la ruta corta lo elige y le agrega
aviones HC-E, el horario lleva su tiempo en tierra; con aviones no cambia ni se borra; validaciones), Offers (cupos y mapa de un
tipo nuevo, 1-2-1 en Business), FlightStatus (el retraso usa el tiempo en tierra del vuelo), ESB (la saga manda los tipos; el
enrutador reenvía el nombre codificado), MS.Admin y gateway; suite **701 pasan**, 41 omitidas; typecheck y lint limpios.
Desplegado. **Recorrido en Edge `recorrido_m2` contra la nube: todo OK:**
- los 3 tipos siguen iguales (122 / 174 / 321 asientos);
- se creó «Embraer E195-E2» desde el panel (avisó que 110 en 2-4-2 no son filas completas; con 112, «14 filas de 8»);
- una ruta nueva Quito ⇄ Esmeraldas lo eligió sola (menor alcance) con un avión nuevo HC-E01;
- la búsqueda pública (la de Booking) vendió los 4 paquetes con 112 cupos en Economy y 12 en Business, y su mapa de asientos tiene
  las filas 4–17 con 8 por fila (A C D E F G H K);
- con aviones, cambiarlo dio `AIRCRAFT_TYPE_IN_USE`; el impacto de un retraso usó sus 30 min en tierra;
- al final se dio de baja la ruta, se retiró HC-E01 y se borró el tipo: **3 tipos, 33 aviones y 30 rutas, como antes**.

**Incidente del despliegue:** la VM (2 núcleos, 4 GB) se saturó al reconstruir todas las imágenes (cambió `shared`): carga de 46,
sin SSH ni API unos minutos y el script terminó con `esb unhealthy`. Los contenedores se recuperaron solos (todos sanos) y la carga
volvió a menos de 3 en ~20 min; no hizo falta reiniciar nada.

### PLAN_Telemetria_Asientos · T-3 — Grafana en tiempo real: el mapa del sistema — ✅ HECHA (10/11), pendiente de auditoría

Pedido del responsable: ver en un grafo cómo se llaman los servicios y cómo viaja un proceso (D-T1: Tempo + Grafana, sin Jaeger).

**Cambios (solo infraestructura de observabilidad; ningún servicio cambió):**
- **Tempo 3.1:** `metrics_generator` con los procesadores `service-graphs` (aristas cliente → servidor emparejando los spans de
  cada llamada) y `span-metrics` (peticiones, errores y duración por servicio y operación), escritos en Prometheus por remote write.
  En modo monolítico el distribuidor se los pasa en el mismo proceso (Tempo 3: sin Kafka). La configuración se probó antes en un
  contenedor descartable en la VM (arrancó con el módulo `metrics-generator`).
- **Prometheus:** `--web.enable-remote-write-receiver` (recibe en `/api/v1/write`).
- **Grafana:** el origen de datos Tempo con `serviceMap` (Prometheus), `nodeGraph` y el filtro `correlation_id` en la búsqueda.
- **Tablero nuevo «EcoAirlines — Mapa del sistema en vivo»** (se refresca cada 15 s):
  - grafo de servicios: cada nodo con su latencia promedio y peticiones/s, cada flecha una dependencia; en rojo la proporción de
    errores;
  - tabla de aristas (desde, hacia, peticiones/min, errores/min, p95);
  - peticiones por segundo que recibe cada servicio;
  - **trazas de un correlation ID** (caja `X-Correlation-Id`, TraceQL `{ span.correlation_id = "…" }`): al abrir una traza se ven su
    cascada y su grafo de nodos.

**Verificación en la nube:** una compra de prueba real con el cliente demo (`compra_t3.mjs`: reserva GLTP3W confirmada y luego
cancelada) generó **18 aristas reales** en Prometheus (`traces_service_graph_request_total`), entre ellas
gateway → ms-reservas → esb → ms-g-bookings / ms-g-offers / payment-api / ms-g-post-sale. **Recorrido en Edge `recorrido_t3`
(Grafana): todo OK** — el grafo dibuja gateway, ms-reservas, esb, ms-g-bookings, ms-g-offers y payment-api; la tabla de aristas
tiene tasas reales; la búsqueda por el correlation ID de la compra encontró su traza en Tempo (gateway POST, 2,28 s).

**Lo que mostró el mapa (para saber leerlo):**
- Los errores que marcó justo después del despliegue eran los chequeos de salud del ESB a los MS.G que se estaban reiniciando y el
  feed `/vuelos/eventos` con 503 en esos minutos: ruido del reinicio, no fallas.
- Las flechas MS.G → ms-g-identity son la descarga de la JWKS para validar tokens (infraestructura, no una llamada de negocio entre
  MS.G).
- PostgreSQL y RabbitMQ no aparecen como nodos: sus llamadas no tienen spans propios.

**Errores del recorrido (corregidos en el script):** los nombres de los nodos del grafo de Grafana son texto HTML, no SVG; la consulta
a Tempo tardaba más que la espera con la VM cargada; y una revisión «pasaba» porque el título del panel ya tenía el correlation ID.
`compra_c2.mjs` tenía una fecha fija ya pasada: se hizo `compra_t3.mjs`.

### PLAN_Telemetria_Asientos · T-4 — Vista «Recorrido» y mapa del sistema en vivo — ✅ HECHA (10/11), pendiente de auditoría

Pedido del responsable (D-T2): ver en el panel propio, en un grafo, cómo viaja un proceso de servicio en servicio, con un punto que
avanza nodo a nodo, y un mapa del sistema en vivo.

**Cambios:**
- **ESB 1.10.0:**
  - `GET /composition/telemetry/journeys/{correlationId}`: busca en **Tempo** con TraceQL (`{ span.correlation_id = "…" }`) dentro de
    la ventana de sus sagas y eventos (como T-2), trae hasta 20 trazas y las convierte en el **recorrido** (`composition/journey.ts`,
    función pura): nodos por capa (cliente, gateway, MS de respuesta, ESB, MS de gestión, externos) y **saltos** en orden de tiempo
    (el span cliente de quien llama con el span servidor que provocó en el otro servicio; lo que entra desde fuera sale del nodo
    «cliente»).
  - **Sin datos personales:** solo servicio, operación, estado y tiempos. La operación es método + ruta sin query y con los
    identificadores cambiados por `{id}` (el recorrido dice QUÉ se llamó, nunca A QUÉ registro: la referencia de un pago o el id de
    una reserva no salen). Los atributos de los spans (IP del cliente, agente…) no se copian.
  - `GET /composition/telemetry/system-map`: aristas de los últimos 5 min (peticiones y errores por minuto, p95) de las métricas del
    grafo de servicios de T-3.
  - Tempo con plazo propio de 8 s para esta consulta (solo del panel); MS.Admin espera 12 s al ESB para ella (el gateway, 15 s).
- **MS.Admin 1.12.0 y GraphQL:** `telemetry.journey(correlationId, from, to)` (sin trazas: `null`) y `telemetry.systemMap`.
- **Web (SVG propio, sin librerías nuevas):**
  - **«Recorrido»** en «Telemetría» (al buscar un correlation ID) y en el **historial de la reserva** («Ver el recorrido» en cada
    saga; se pide recién al abrirlo). Reproductor: Reproducir/Pausa, al inicio, barra de pasos y velocidad (0,5× a 4×); el punto
    recorre cada arista en el orden real; la lista de saltos dice +tiempo desde el inicio, servicio → servicio, operación, duración y
    si falló; elegir un salto lleva el reproductor ahí.
  - **«Mapa del sistema en vivo»** en «Telemetría»: el grafo por capas con el grosor según el tráfico y en rojo las conexiones con
    errores; se actualiza cada 15 s con la pestaña visible (en T-5, empujado por el servidor); también como tabla.

**Verificación:** pruebas nuevas — `journey.spec` (saltos en orden con su capa, cliente → gateway, gRPC, servicio sin trazas, sin la
IP ni el correo; ids enmascarados), ESB (búsqueda en Tempo con la ventana de las sagas, 404 sin trazas, 403 sin administrador; mapa
con peticiones, errores y p95), MS.Admin y gateway; suite **709 pasan**, 41 omitidas; typecheck y lint limpios. Desplegado.
**Recorrido en Edge `recorrido_t4` contra la nube** con una compra de prueba (RSUR2B, luego cancelada):
- el recorrido dibuja cliente, gateway, MS.Reservas, ESB, MS.G.Bookings, MS.G.Offers, MS.G.Identity y la Payment API; 13 saltos en
  una traza (512 ms); al reproducir, el punto se mueve y avanza los 13 saltos en orden; elegir uno en la lista lleva ahí; las
  operaciones salen como `POST /payments/{id}/capture`, `GET /bookings/{id}`;
- el mapa en vivo dibuja las conexiones activas y se actualiza cada 15 s (5 consultas seguidas, todas 200);
- el historial de la reserva muestra el recorrido de su saga.

**Lo que se corrigió en el camino:**
- **Datos de pago en las operaciones** (encontrado en la nube): la primera versión mostraba `/payments/pay_…/capture` y el UUID de la
  reserva. Ahora se enmascaran (`maskIds`, con prueba).
- **Tempo lento con la VM cargada** (recién desplegada): el recorrido de la reserva dio 503 con el plazo de 3 s; ahora 8 s / 12 s.
- **Traza recién hecha:** Tempo tarda un minuto o dos en dejarla buscable; el aviso lo dice («vuelve a buscarlo»).
- Del script: en SVG no hay `innerText` (se usa `textContent`); a 4× el recorrido termina antes de pulsar «Pausa».

### PLAN_Telemetria_Asientos · T-5 — Telemetría en tiempo real por WebSocket — ✅ HECHA (10/11), pendiente de auditoría

Decisión del responsable (D-T13): además del refresco cada 15 s, el panel recibe los cambios empujados por el servidor.

**Cambios:**
- **Gateway** (GraphQL, sin protocolo nuevo: las suscripciones `graphql-ws` que ya existían):
  - `traceProgress(correlationId)`: al suscribirse llega lo que ya hay; después, cada vez que hay pasos nuevos, el recorrido completo
    y cuáles son los nuevos. `liveSystemMap`: el mapa cada vez que cambia. Solo `ECOAIRLINES_ADMIN`.
  - `graphql/live-topics.ts`: un **tema** por clave (`journey:<id>`, `system-map`) que consulta a MS.Admin **solo mientras hay
    suscriptores** (cada 2 s el recorrido, cada 10 s el mapa; `LIVE_TRACE_POLL_MS`, `LIVE_MAP_POLL_MS`), **una sola vez para todos**
    los suscriptores del tema, y se detiene al irse el último. Un **token vencido** termina esa suscripción con `UNAUTHENTICATED`;
    MS.Admin caído se reintenta; un proceso sin trazas todavía (404) sigue esperando.
- **Web:** cliente mínimo propio del protocolo `graphql-transport-ws` en `api/client.ts` (el único punto de acceso al gateway; sin
  dependencias nuevas) y el hook `useLiveSubscription`. «Recorrido» y «Mapa del sistema en vivo» muestran «● En vivo»; los pasos
  nuevos aparecen sin recargar (aunque el proceso no existiera al abrir la vista) y sin reiniciar el reproductor. **Respaldo:** si
  el WebSocket no conecta o se corta, vuelven al refresco cada 15 s, lo avisan («Actualización cada 15 s: sin conexión en vivo») y
  reintentan conectar cada 30 s.
- **Atraso de origen (medido):** Tempo 3 tardaba **31 s** en dejar buscar una traza nueva (excluye los últimos 30 s,
  `query_end_cutoff`, y espera 5 s sin spans, `max_trace_idle`). Con `query_end_cutoff: 1s`, `max_trace_idle: 2s`,
  `flush_check_period: 1s` y un lote propio de trazas de 0,5 s en el Collector (`batch/trazas`; métricas y logs siguen cada 2 s):
  **~4 s** (tres mediciones de 4,0 a 4,2 s). No son los «~1–2 s» que estimaba el plan.

**Verificación hasta ahora:** pruebas nuevas del gateway (`live-topics.spec`: sin suscriptores no consulta; dos suscriptores comparten
una consulta por vuelta; al irse el último se detiene; solo los saltos nuevos; 404 sigue esperando y 503 se reintenta; el mapa solo
si cambia; token vencido → `UNAUTHENTICATED` y los demás siguen; por WebSocket real: el recorrido y el mapa llegan, la consulta va con
el token del administrador, un cliente recibe `FORBIDDEN` sin que se consulte nada); los documentos de suscripción de la web validados
contra `gateway.graphql`; la regla de arquitectura (ningún acceso a la red fuera de `api/client.ts`) se cumple; suite **715 pasan**,
41 omitidas; typecheck y lint limpios. Desplegado. **Recorrido en Edge `recorrido_t5` contra la nube: todo OK:**
- se abrió «Recorrido» de un correlation ID que todavía no existía: «● En vivo», esperando el proceso;
- una compra real con ese ID (AJVDG8, luego cancelada): **los pasos aparecieron solos, sin recargar, 2,3 s después de confirmada la
  reserva**, y siguieron llegando hasta 52 saltos en 6 trazas (búsqueda, hold, pago, reserva, boletos, cancelación; 14 nodos: los MS
  de respuesta, el ESB, los MS.G, la Payment API y la API de Booking);
- ninguna consulta de refresco del recorrido ni del mapa mientras había conexión en vivo; el mapa cambió empujado por el servidor;
- con el WebSocket bloqueado (`routeWebSocket`), el mapa avisó «Actualización cada 15 s: sin conexión en vivo» y siguió con el refresco
  (3 consultas en ~35 s). En ese momento, con la VM atendiendo la compra y dos navegadores, una de las consultas falló junto con otros
  paneles de la página (colas, alertas, integración con Booking): un tropiezo de la plataforma, no del respaldo, que se reintentó solo.

**Con esto el PLAN_Telemetria_Asientos queda completo (T-1 a T-5).**

### Incidente 09–10/11 — Booking: 503 intermitentes y la reserva 9M2XWF — ✅ ATENDIDO (10/11)

**Reporte de Booking:** la búsqueda y el hold fallaban de forma intermitente (`503 El ESB no respondió a tiempo`), una cancelación
respondió 502, y su reserva de prueba **9M2XWF** quedó activa «porque el servidor no respondió al cancelar».

**Diagnóstico (con datos):**
- **Los 503 caen en las ventanas de los despliegues** (Prometheus, 5xx por media hora): 9/11 19:13–20:43 (T-1, R-1, P-1), 23:13
  (T-2), 10/11 00:43 (M-1), 02:13–02:43 (M-2, T-3) y 03:43–04:43 (T-4, T-5). Sin desplegar, del 8/11 20:13 al 9/11 19:13: **un solo**
  503. La peor ventana (20:26–20:44, despliegue de P-1) coincidió con las pruebas de Booking.
- **Causa:** la VM (Standard_B2pls_v2, 2 vCPU, 4 GB, 26 contenedores) vive al borde de la memoria y usa el swap. Al compilar las
  imágenes en la VM (y cualquier cambio de `packages/shared` recompila las 18), el disco se satura (presión de E/S de hasta 73 %,
  carga 30–47) y el ESB no responde dentro de los 4,5 s de los MS de respuesta. Los créditos de CPU **no** se agotaron (~30).
- **Agravante permanente:** los 18 servicios Node se revisaban cada 10 s con `node -e fetch(…)`, es decir, ~2 procesos Node nuevos
  por segundo (50–70 MB cada uno) aun sin desplegar.
- **9M2XWF no quedó activa por un fallo:** se creó bien (20:20:09), **Booking le hizo check-in** (20:20:22) y sus dos cancelaciones
  (20:20:25 y 21:44:18) respondieron **409 `CUTOFF_PASSED` en < 0,1 s** (regla D2: después del check-in no se modifica nada). En Loki
  esas peticiones no tienen ningún 502; si lo vieron, vino de otro tramo.

**Arreglos:**
- **Chequeos de salud livianos** (`infra/docker-compose.yml`, los 18 servicios Node): `wget` de Alpine en lugar de un proceso Node,
  cada **30 s** (antes 10), con `start_interval: 5s` durante 60 s al arrancar. Aplicado en la VM.
- **Cancelación de administrador** (excepción a D2, pedida por el responsable): MS.Admin 1.13.0
  `POST /ecoairlines/admin/bookings/{bookingId}/cancel` con un **motivo obligatorio** (5–200 caracteres) y GraphQL
  `adminCancelBooking(bookingId, reason)`. Usa la saga «Cancelar» con `SAGA_COMPENSATION` (la vía con que EcoAirlines ya cancela las
  reservas de un vuelo cancelado): sin cotización ni regla del check-in, reembolso completo sin penalidad, asientos liberados (Offers
  los libera en cualquier estado) y `booking.cancelled` a Booking; el motivo queda en el historial. **No toca el ESB.**
- **Despliegue acotado:** se compilaron solo `ms-admin` y `gateway` (~3 min) y se recrearon los contenedores (~4 min), en lugar del
  despliegue completo (~20 min de degradación).
- **9M2XWF cancelada** con esa vía el 10/11 a las 04:59 (vuelo de las 07:00): estado `CANCELLED`, evento `booking.cancelled` emitido.

**Verificación:** pruebas nuevas (MS.Admin: la saga recibe `SAGA_COMPENSATION`, el motivo y el administrador; motivo corto → 400; un
cliente → 403. Gateway: la mutación va a MS.Admin; un cliente → `FORBIDDEN`); suite **717 pasan**, 41 omitidas; typecheck y lint
limpios. En la VM: todos los servicios `healthy` con el chequeo nuevo; health 200 en ~0,3 s; la presión de E/S bajó de 63–73 % a ~1 %.

**«No se pudo conectar con el servidor» en la web (y el 502 de Booking):** mientras el gateway se reinicia, quien responde es
Caddy, con un 502 vacío y **sin cabeceras CORS**: el navegador lo bloqueaba y la web mostraba un falso «sin conexión»; Booking veía
un 502 sin explicación. **Arreglo** (`infra/cloud/Caddyfile`, `handle_errors 502 503 504`): ahora responde **503 con `Retry-After: 10`**,
como error GraphQL en `/api/graphql` (la web muestra «El servicio no está disponible en este momento: reintenta en unos segundos») y
como ProblemDetails `PROVIDER_UNAVAILABLE` en el resto del API (Booking), con CORS solo para el origen de la web (`WEB_ORIGIN`, el
mismo `CORS_ORIGINS` del gateway). Probado con un Caddy descartable en la VM sin acceso al gateway (los tres casos: web, Booking y
un origen ajeno sin CORS) y aplicado recreando solo Caddy (segundos).

**Pendiente (propuesto, sin aplicar):**
- Límite de memoria de Node por servicio (`--max-old-space-size`) para que la VM deje de usar el swap.
- No recompilar las 18 imágenes en cada despliegue (compilar solo lo que cambió) y desplegar en horarios acordados con Booking.
- Que la cotización de cancelación avise `CUTOFF_PASSED` tras el check-in (hoy responde 200 y recién la cancelación dice que no).
- Una VM de 8 GB resolvería la memoria de raíz, pero sube el costo (decisión del responsable).

### 10/11 — La búsqueda por correlation ID en «Telemetría» tumbaba la VM — ✅ CORREGIDO Y DESPLEGADO (10/11)

**Reporte del responsable:** al buscar un correlation ID en «Telemetría», los servicios «se apagaban».

**Diagnóstico (medido):** no se caían (0 reinicios, sin OOM): la VM se quedaba esperando al disco. Cada consulta del «Recorrido»
(T-4) buscaba en Tempo y traía **hasta 20 trazas completas en paralelo**, y Tempo partía cada una en 50 trabajos; la suscripción en
vivo (T-5) **repetía eso cada 2 s** mientras la página estaba abierta, aunque el proceso fuera viejo. Cinco consultas seguidas: Tempo
de 630 a **860 MB**, la presión de disco al **99 %** y 4 de las 5 consultas con 503 (8–13 s).

**Arreglos:**
- **Tempo** (`tempo.yaml` y `GOMEMLIMIT: 450MiB`): 4 consultas a la vez (antes 20), 20 trabajos por búsqueda (antes 1000), 4 partes por
  traza (antes 50), 100 en cola (antes 2000) y 50 MB de trazas en memoria (antes 250). Probado en un contenedor descartable en la VM.
- **ESB:** el recorrido trae **hasta 10 trazas, una por una** (antes 20 en paralelo).
- **Gateway:** `traceProgress` consulta **cada 5 s** (antes 2).
- **Web:** el recorrido se sigue en vivo **solo si el proceso todavía no aparece o empezó hace menos de 15 min**; uno viejo muestra
  «Proceso terminado: no se sigue en vivo» y no consulta nada más.
- **`scripts/cloud/desplegar-parcial.sh`:** compila solo los servicios indicados y recrea solo la configuración indicada (minutos, en
  lugar de los ~20 del despliegue completo).

**Verificación:** suite **717 pasan**, 41 omitidas; typecheck y lint limpios. Desplegado por el responsable con
`desplegar-parcial.sh` (esb, gateway y tempo). **La misma medición de las 5 consultas seguidas:**

| | Antes | Después |
|---|---|---|
| Consultas que respondieron | 1 de 5 (4 con 503) | **5 de 5** |
| Tiempo por consulta | 8–13 s | **0,4–1,1 s** |
| Memoria de Tempo | 630 → 860 MB | **195 → 293 MB** |
| Presión de disco (avg10) | 99 % | **~9 %** |

`recorrido_t5` otra vez en Edge (compra real con la vista en vivo abierta, mapa empujado, WebSocket cortado → respaldo): todo OK y la
VM quedó en Tempo 290 MB, presión ~12 %, carga 1,1 y los 19 servicios sanos. **Costo aceptado:** los primeros pasos llegan a los
**~9,5 s** (antes 2,3 s) por consultar cada 5 s y con menos paralelismo. Un proceso de hace más de 15 min muestra «Proceso terminado:
no se sigue en vivo», hace una sola consulta y no abre suscripción (verificado).


### 11/11 — Información general, plan de pruebas y diagramas v6

- **Carpeta `Informacion_General/`** (solo lo vigente): `Pruebas.md` (plan de pruebas y CI/CD según la Semana 9 del curso, con las
  decisiones P-1 a P-9), `Patron_Diseño_Arquitectura.md` (estilo, arquitectura, patrones y diseño) y los diagramas v6. El material
  de la Semana 9 queda solo en local (`.gitignore`). Nada programado todavía: las pruebas y el `ci.yml` se implementan por fases aprobadas (CI-1, PU-1…).
- **Diagramas v6** (`PLAN/arquitectura-microservicios-v6.png`, `PLAN/modelo-conceptual-v6.png`, scripts `PLAN/scripts/*_v6.py`; copia
  en `Informacion_General/`). En rojo, lo nuevo desde la v5: tablas `airports`, `aircraft_types`, `pricing_settings` y `pricing_changes`
  en Schedule; copias `airport_catalog`, `aircraft_type_catalog` y `pricing_settings` en Offers; `turnaround_minutes` en FlightStatus;
  grafo de servicios de Tempo en Prometheus; en la arquitectura, O-1..O-4, T-1, R-1, P-1, T-2..T-5, M-1, M-2 y los arreglos del 10/11.
  Las v2–v5 se quedan en `PLAN/` como historial.

### Pruebas · CI-1 — Integración continua con lo que ya existe — ✅ HECHA (11/11), verde en GitHub (ejecución 43105254180, commit 570a955)

- **`.github/workflows/ci.yml`** (en cada push a `feature/v2-microservicios` o `main`, en cada pull request y a mano), en orden «fail
  fast» (Semana 9 §9.5): **1. calidad** (`typecheck` + `lint`) → **2. pruebas** (`npm test`) → **3. infraestructura** (PostgreSQL 17 y
  RabbitMQ 4 como contenedores de servicio de GitHub: las 41 pruebas que hasta hoy siempre se omitían); **web** en paralelo (lint +
  build). Sin secretos: base y broker desechables. `cancel-in-progress` para no gastar ejecuciones viejas.
- **`npm run test:infra`**: solo `postgres.spec` y `bus.spec`. Todas comparten una base: cada prueba crea su esquema y lo borra.
- **`scripts/ci/sin-omitidas.mjs`**: lee el reporte JSON de Vitest y falla si alguna prueba se omitió o si no corrió ninguna, para
  que una variable mal escrita no deje la CI en verde sin probar nada.
- **Verificación local** (Docker con las mismas imágenes): tipos y lint limpios (raíz y web), `npm test` 717 pasan, `test:infra`
  **46 pasan, 0 omitidas** (las 41 nunca se habían ejecutado: todas pasan), el guardia sin variables detecta las 41 y sale con 1,
  la web compila. `imagenes-v2.yml` no cambia (se retoma en CD-1).

### Pruebas · PU-1 — Unitarias de los dominios de los MS.G — ✅ HECHA (11/11)

Primera fase para corregir la pirámide (Informacion_General/Pruebas.md §4): **325 pruebas unitarias nuevas** junto al código
(`src/domain/*.spec.ts`), sin NestJS ni base de datos; ninguna cambia código de producción.
- **Bookings** (66): cédula ecuatoriana, edad por tipo (cumpleaños el día del vuelo, 29 de febrero), infantes, documentos repetidos o
  vencidos, pasaporte internacional, asientos y maletas, PNR sin caracteres ambiguos, emisión y reemisión de boletos.
- **Offers** (58): identificadores, conexiones (escala 1–10 h, rodeos), venta 60 min antes, **precios calculados a mano** (UIO–GYE
  79,85; niño 75 %; infante 10 % sin impuestos; DOSEL × 3,2; escala −10 %; precio exacto por ruta de P-1), maletas, mapa de asientos.
- **Schedule** (59): aeropuertos (activo/inactivo), alcance por tipo, rutas duplicadas, números de vuelo, hora de llegada local,
  regreso del avión (C-3), multiplicadores, acuerdo de promociones (≤ 50 %), fechas y consultas del horario.
- **PostSale** (35): reembolso por tarifa y exoneración, cambio de fecha (diferencias, cargo, saldo a favor), maletas.
- **FlightStatus** (36), **CheckIn** (15), **Webhooks** (42), **Identity** (14): transiciones y retrasos, código IATA BCBP,
  quién recibe cada evento, SSRF, cifrado del secreto, reintentos, correo y scopes.
- **Comprobación de que las pruebas sirven:** se cambió a mano una regla en Bookings (edad), Offers (impuestos) y PostSale
  (exoneración): las pruebas fallaron en los tres casos (2, 7 y 1 pruebas) y el código se restauró desde git.
- **Suite:** 1 042 pasan (antes 717), 41 omitidas (corren en la CI); tipos y lint limpios.

### Pruebas · PU-2 — Unitarias de los servicios de los MS.G — ✅ HECHA (11/11)

**268 pruebas unitarias nuevas** de los servicios (`src/services/*.spec.ts`), con el repositorio como doble de prueba: *stubs*
(`vi.fn().mockResolvedValue`) para lo que devuelve la base y *spies* (`toHaveBeenCalledWith`, `not.toHaveBeenCalled`) para lo que el
servicio guarda, borra o libera. Ninguna cambia código de producción ni usa NestJS, base de datos o red.
- **Bookings** (71): referencia de pago de un solo uso, crear (idempotente, PNR repetido, hold usado, documento en el vuelo), quién ve
  qué (404 y no 403), fallar, emitir, asientos, maletas, cancelar (D55 tras el check-in), ingresos = cobrado − reembolsado, reporte
  por día de Ecuador y asistencia.
- **Offers** (73): crear, vencer, liberar y consumir holds (sin liberar dos veces), promociones del acuerdo, `SEAT_TAKEN` antes de
  cobrar (T-1), primer asiento libre, operaciones de saga idempotentes, publicar horario y precios, y envío de stock a Booking con
  `fetch` simulado (mensaje del contrato, espera creciente 1 s → 60 s, vuelos ya salidos).
- **Schedule** (33): precios con historial, tarifa base y precio por ruta (P-1), aeropuertos (M-1), tipos de avión (M-2), acuerdo.
- **Identity** (34): registro, login (misma respuesta para correo inexistente o clave incorrecta), límite de intentos, OAuth2
  `client_credentials` (cuerpo y Basic, scopes, ESB y MS de respuesta), alta y rotación del secreto (se guarda solo el hash).
- **PostSale** (14), **FlightStatus** (18: impacto de un retraso en el siguiente vuelo del avión, revertir), **CheckIn** (11),
  **Webhooks** (14: firma HMAC, reintentos, un 3xx no es entrega, el dueño nunca va en el cuerpo).
- **Comprobación:** tres errores introducidos a mano (liberar el pago de una reserva confirmada, liberar cupos de un hold ya
  liberado, contar un 3xx como entregado) fueron detectados; el código se restauró desde git.
- **Hallazgo menor (sin cambio):** `InventoryService.transition` y `publishFarePrices` validan antes de devolver la promesa (lanzan
  al llamarlas, no al esperar). Para quien usa `await` el efecto es el mismo; las pruebas lo cubren así.
- **Suite:** 1 310 pasan (antes 1 042), 41 omitidas (corren en la CI); tipos y lint limpios.

### Pruebas · PU-3 — Unitarias del ESB — ✅ HECHA (11/11)

**103 pruebas unitarias nuevas** del ESB, sin NestJS, base de datos ni red; ninguna cambia código de producción.
- **Motor de sagas** (`src/sagas/engine.spec.ts`, 18), con un repositorio *fake* (un Map con las mismas reglas de plazos) y sagas
  inventadas cuyos pasos son *spies*: orden de los pasos, STARTED antes de ejecutar, correlation ID, compensación LIFO (la del paso
  que falló recibe `undefined`), compensación pendiente (COMPENSATING) o rechazada (FAILED con `compensationFailed`), punto sin
  retorno (PENDING con 2 s, 10 s, 30 s… 30 min; o FAILED por error de negocio), reanudar sin repetir pasos ni compensaciones,
  `sagaId` fijo y el trabajador de recuperación.
- **Piezas del ESB** (`src/esb.units.spec.ts`, 66): tabla cerrada de rutas y segmentos con puntos, eventos internos (el secreto de un
  partner y el tipo de asistencia nunca salen), ProblemDetails, Idempotency-Key (UUID, repetición, otro cuerpo, en curso, 5xx
  libera), ventana de búsqueda por correlation ID (T-2), capas y rutas enmascaradas (T-4), catálogo de aeropuertos (M-1),
  referencia de pago de Booking y los pasos de cobro y reembolso (Booking no cobra; web autoriza, captura y reembolsa solo lo suyo).
- **Entrada de eventos de Booking** (`src/inbound/inbound.service.spec.ts`, 19): firma HMAC sobre los bytes exactos, validación del
  CloudEvent, un `id` repetido no se procesa, REJECTED por negocio y RETRY con espera creciente por disponibilidad.
- **La mutación manual encontró una prueba débil:** cambiar `status >= 500` por `> 500` en la idempotencia no hacía fallar nada (la
  prueba usaba un 503). Se agregó la prueba del borde exacto (500 se libera, 499 se guarda) y ahora la mutación se detecta.
  Las otras dos (compensación en orden directo, rechazar un MS.G caído) se detectaron a la primera.
- **Errores de las propias pruebas, corregidos:** un *spy* guarda la referencia del objeto (se usó una copia por llamada) y una
  limpieza que restauraba un catálogo ya modificado (se guarda una copia antes).
- **Suite:** 1 413 pasan (antes 1 310), 41 omitidas (corren en la CI); tipos y lint limpios.

### Pruebas · PU-4 — Unitarias de shared, gateway, externos y web — ✅ HECHA (11/11)

**159 pruebas unitarias nuevas**; ninguna cambia código de producción. Con esto termina la base de la pirámide (PU-1 a PU-4).
- **Librería compartida** (`packages/shared/src/shared.units.spec.ts`, 59): dinero en centavos (0,10 + 0,20 = 0,30), tipos de avión
  (filas desde los asientos, alcance, catálogo), aeropuertos y pasajeros, **circuit breaker** con reloj falso (abre a las 3 fallas,
  un 4xx no cuenta, MEDIO ABIERTO deja pasar UNA llamada), **token de servicio** con `fetch` simulado (Basic codificado, renovación
  60 s antes, una sola petición si piden varias), ProblemDetails, `redact`, `sanitize` (caracteres de control, `__proto__`),
  enlaces HATEOAS y `authenticate` de los MS de respuesta (token de servicio rechazado, scopes, dueño `partner:<id>:<usuario>`).
- **Gateway** (`services/gateway/src/graphql/gateway.units.spec.ts`, 28): enums de scopes y eventos, mappers (la asistencia médica
  y los secretos nunca llegan al navegador), códigos de error GraphQL, `formatError` sin filtrar mensajes internos y el límite de
  profundidad (los fragmentos no lo esquivan).
- **Payment API** (`src/domain/payments.spec.ts`, 26): Luhn, marcas, vencimiento, CVV, estados, captura idempotente por orden,
  anulación y reembolsos parciales sin pasar de lo capturado. Booking simulado no se prueba: es una herramienta de prueba.
- **Web** (46, `npm test` en `ecoairlines-web`, nuevo paso en el trabajo «Web» de la CI): **Vitest 4.1.12 + jsdom 29.1.1 +
  @testing-library/react 16.3.3 + @testing-library/dom 10.4.2** (dependencias de desarrollo, versiones exactas con más de 2 semanas;
  jsdom 30 exige Node 24.15 y la máquina local tiene 24.12; Vitest 4.1.11 tenía 2 avisos moderados que 4.1.12 corrige; quedan los 7
  avisos que ya había, entre ellos uno alto de `vite` 8.3.x, sin tocar en esta fase). Cliente GraphQL (el token nunca en la URL; un
  503 del proxy no se muestra como «sin conexión», el incidente del 10/11), WebSocket `graphql-transport-ws` con un socket falso,
  el hook en vivo (respaldo y reintento a los 30 s), el grafo del recorrido, la validación de pasajeros y la búsqueda en la URL.
- **La mutación manual encontró otra prueba débil:** si la web dejaba de enviar el token cuando no hay huella del dispositivo (casi
  todas las consultas), ninguna prueba fallaba. Se agregó la prueba. Las otras dos (circuito que abre tarde, reembolso de un
  centavo de más) se detectaron a la primera.
- **Error de las propias pruebas, aprendido:** `beforeEach(() => (spy = vi.spyOn(...)))` DEVUELVE el spy y Vitest lo usa como
  limpieza (lo llamaba al terminar cada prueba). Se usan llaves; se revisaron todos los archivos.
- **Suite:** backend 1 526 pasan (antes 1 413), 41 omitidas (corren en la CI); web 46; tipos, lint y compilación de la web limpios.

### 11/11 — Seguridad: documento general y mejoras posibles

- **`Informacion_General/Seguridad.md`** (nuevo): lo que ya protege el sistema (tokens RS256 con JWKS, tokens de servicio, scopes,
  404 para lo ajeno, scrypt, límite de intentos; tarjetas fuera de EcoAirlines y datos de salud fuera de logs y eventos; HMAC,
  SSRF, idempotencia; validación, `sanitize`, ProblemDetails, helmet, CORS y límites de GraphQL; solo Caddy público, SSH por IP,
  una base por servicio, secretos fuera del repositorio), cómo se verifica, los riesgos conocidos (usuarios de demostración
  aceptados, avisos en dependencias de desarrollo, una sola VM, la web sin CSP ni HSTS) y 8 mejoras opcionales por esfuerzo.
- **`Pruebas.md`:** fase **SEG-1** (opcional) al final del plan: S-1 (Vitest 4.1.12 en la raíz, `vite` 8.3.5 en la web), S-3
  (Dependabot y secret scanning) y S-4 (contraseña del ADMIN de demostración tras la evaluación).

### Pruebas · CT-1 — Contract testing con Pact (consumer-driven) — ✅ HECHA (11/11)

Lo que pide la Semana 9 (§9.2–9.3): cada **consumidor** declara en una prueba lo que espera, Pact genera el contrato
(`contract/pacts/<consumidor>-<proveedor>.json`, versionado en el repositorio, sin Pact Broker: decisión P-2) y cada **proveedor**
real lo verifica reproduciendo cada interacción. **@pact-foundation/pact 17.1.4** (dependencia de desarrollo; estadísticas de uso
desactivadas con `scarfSettings` y `PACT_DO_NOT_TRACK`). Primera iteración con las relaciones más críticas, 11 interacciones:
- **Todos → MS.G.Identity** `/oauth2/token` (consumidor: `ServiceTokenProvider` real): token del ESB (`ecoairlines:internal`), de
  un MS de respuesta (`ecoairlines:esb`) y secreto incorrecto (`invalid_client`).
- **ESB → MS.G.Bookings** (consumidor: `RestClient` real del ESB): leer la reserva por su dueño, 404 para otro dueño (como
  `application/problem+json`), tarifas para la postventa y registrar una referencia de pago (201).
- **MS de respuesta → ESB** `/sagas/{id}` (consumidor: `sagaOutcome` + `EsbClient` reales): saga completada, compensada (el mismo
  error del paso) y de otro dueño (404).
- **Mensajes: MS.G.Offers → MS.G.Webhooks** `hold.created` (consumidor: `WebhooksService.ingest` real; proveedor: el evento lo
  produce `HoldsService.create` real y se toma del outbox, con `x-owner-id` como en la cabecera AMQP).
- **Scripts:** `npm run test:pact` (consumidores) y `npm run test:pact:verify` (proveedores). **CI:** trabajo «4. Contratos (Pact)»:
  genera los contratos, falla si difieren de los del repositorio (un consumidor cambió sin subir su contrato) y los verifica.
- **Comprobación como en el PDF:** renombrar `pnr` en la vista de Bookings y `seatsHeld` en el evento de Offers hace fallar la
  verificación con el campo exacto («Actual map is missing the following keys: seatsHeld»); el código se restauró.
- **Limitaciones encontradas de Pact 17 (resueltas en las pruebas):** su interfaz V4 no permite un cuerpo de formulario (el
  contrato de OAuth2 usa V3) y el proxy del verificador reenvía un formulario como JSON con otro largo (Identity respondía 400;
  un `requestFilter` lo vuelve a armar). `jsonBody` impone `application/json`: un ProblemDetails declara su cabecera después.
- **Hallazgo de seguridad (corrige `Seguridad.md` del mismo día):** `npm audit --omit=dev` muestra **8 avisos en dependencias de
  PRODUCCIÓN, 6 altos** (`@nestjs/platform-express` con `body-parser` y `multer`, `follow-redirects`, `@nestjs/graphql`), no solo en
  las de desarrollo. Pact no agregó ninguno (12 antes y después). Nueva mejora **S-0** (prioridad alta): `npm audit fix` y
  `@nestjs/graphql` 14.2.0 desde el 18/11 (regla de las 2 semanas).
- **Suite:** 1 526 pasan (sin cambios: los contratos corren aparte), consumidores 11, verificaciones 5; tipos y lint limpios.

### Pruebas · E2E-1 — Flujos críticos E2E con Playwright, en la CI — ✅ HECHA (11/11)

La punta de la pirámide (Semana 9, §9.1 y ejercicio 9.5b): de los ~25 recorridos sueltos del scratchpad quedan **8 flujos
críticos** en el repositorio, con **@playwright/test 1.64.1** (14/10; la 1.65.0 es del 05/11 y no cumple las 2 semanas), contra el
sistema ENTERO levantado con docker compose y la web compilada como en producción (`vite preview`, con su service worker).
- **Pruebas (`tests/e2e/`):** E-1 compra en la web con asiento (y aparece en «Mis viajes»); E-2 dos personas y el mismo asiento
  (la otra compra va por la API mientras el navegador está en el pago: SEAT_TAKEN, se quita el asiento, elige otro y compra);
  E-3 check-in y después la cancelación bloqueada **en la web y en el servidor** (`CUTOFF_PASSED`, D55); E-4 Booking compra por la
  API REST v2 (OAuth2 → búsqueda → hold → reserva → consulta) y el administrador la ve en el panel con su orden; E-5 retraso en
  «Operaciones», Booking lo ve por REST y el pasajero en su reserva; E-6 precio exacto de una ruta y la búsqueda lo refleja (tarifa
  base exacta); E-7 el «Recorrido» de una compra por su correlation ID (saga, pasos de Loki en ≥ 3 servicios); E-8 sin conexión,
  la PWA muestra el pase de abordar guardado (con su QR).
- **Diseño:** lo que la prueba no está probando (preparar una reserva, limpiar) va por la API (`apoyo.ts`); lo que sí, en el
  navegador. **Cada prueba deja el sistema como estaba**: el administrador cancela sus reservas (`adminCancelBooking`, también las
  que tienen check-in), se libera el hold que quedó, se quita el retraso y el precio exacto. Fechas a 40+ días (la conformidad usa
  20–26) y en serie (`workers: 1`). **Candado:** `apoyo.ts` se niega a correr si la web, el gateway o la Payment API no son locales.
- **Sistema (`infra/docker-compose.e2e.yml`, `npm run e2e:up` / `e2e:down`):** todo `docker-compose.yml` menos Prometheus, Grafana y
  Alertmanager (Tempo y Loki sí: E-7 los lee). Cambios solo de prueba: límites por IP de login (10/min) y de la Payment API
  (20/min) subidos, porque todas las pruebas salen de la misma IP; y el ESB sin las URL de Prometheus y Alertmanager.
- **Conformidad v2 en la CI** (`npm run e2e:conformidad`): ahora con un token de administrador pedido en el script (nunca se
  imprime), así corren **las 54** (antes 49 y 5 omitidas); `sin-omitidas.mjs` falla si alguna se omite.
- **CI:** trabajo «5. E2E (sistema completo)», después de infraestructura, contratos y web (fail fast); Chromium de Playwright;
  si algo falla sube el reporte, las trazas y los logs de los contenedores (sistema desechable, claves de desarrollo); siempre
  apaga el sistema. En Windows usa el Edge instalado.
- **Verificación:** 8 pasan, tres corridas seguidas (~33 s cada una, sin contar la compilación); ninguna reserva nueva queda
  confirmada. Mutación a mano: si la web no quita el asiento tomado tras SEAT_TAKEN, E-2 falla en esa comprobación; se restauró.
  `npm audit` sin cambios (12, 8 de producción): Playwright no agregó avisos.
- **Hallazgos (no corregidos, fuera de esta fase):**
  1. **10 servicios se caen si PostgreSQL corta sus conexiones** (al reiniciarlo, el ESB terminó con `Exited (1)`: `pg.Pool` sin
     `pool.on('error')` emite un `'error'` sin manejar). Solo la Payment API lo maneja. En la nube `restart: unless-stopped` los
     vuelve a levantar; la corrección es una línea por servicio.
  2. En Telemetría, «Buscar» con el **mismo** correlation ID no vuelve a consultar (el ID va en la URL y no cambia): para ver
     pasos que llegaron después hay que recargar la página.
  3. Con el sistema incompleto, resolver un nombre que no existe (`prometheus`) tarda ~3,5 s dentro de Docker y retrasaba la
     consulta a Loki (plazo de 3 s); en la nube no pasa porque Prometheus existe.

### Pruebas · CI-2 — ESLint con tipos, cobertura con mínimos y arreglo del E2E en la CI — ✅ HECHA (11/11)

- **Arreglo de E2E-1 (la CI falló en «5. E2E»):** en una base NUEVA no hay ningún vuelo a la venta. La semilla de MS.G.Schedule
  solo crea las rutas en su base; los vuelos llegan a Offers con la saga «Publicar horario» del ESB, que en la nube y en local ya se
  había ejecutado alguna vez. Reproducido con un proyecto de compose aparte y volúmenes nuevos. `npm run e2e:up` ahora publica el
  horario al terminar (el mismo script de la nube, dentro del contenedor del ESB). Sobre la base nueva: conformidad 54/54 y E2E 8/8.
- **ESLint con reglas de tipos** junto a oxlint (decisión P-5): `eslint` 10.13.0, `typescript-eslint` 8.72.1
  (`recommendedTypeChecked`), `eslint-plugin-oxlint` 1.87.0 (la del oxlint 1.87 en uso). `eslint.config.mjs` + `tsconfig.eslint.json`.
  `npm run lint` = oxlint (1 s) y ESLint (10 s); `npm run lint:rapido` solo oxlint. Primera medición: 2 706 avisos, decididos regla
  por regla (tabla en `Pruebas.md` §7.1):
  - **`no-floating-promises`: 0** (el riesgo principal para las sagas). `eslint-plugin-oxlint` la apagaba porque `oxlint.json` la
    declara, y oxlint sin tipos no la aplica: se volvió a encender y se comprobó con una promesa olvidada a propósito.
  - `no-unsafe-*` (1 957) y `require-await` (271) apagadas, con el motivo en la configuración (`any` permitido por el proyecto;
    interfaces de Nest). `no-base-to-string` apagada tras revisar sus 22 casos.
  - `no-unnecessary-type-assertion`: 416 corregidas con `--fix` (solo quita `!` y `as`; `tsc`, las 1 527 pruebas y Pact siguen en
    verde, y una comparación del diff confirma que no cambió lógica). Dos `as Any` eran falsos positivos y se restauraron; 9
    imports de tipos quedaron sin uso y se quitaron.
  - **Error real encontrado:** si Booking rechazaba un stock con `detail` en forma de lista (errores de validación), el motivo
    guardado y el log decían `[object Object]`. Corregido en `stock-sync.service.ts` (+1 prueba, que falla con el código anterior).
  - Otras correcciones menores: `await Promise.all` sobre `dispose()`, `reject` con un Error, `view(this: void)`, tipos con
    predicados en lugar de `as`. El Fault de SOAP se sigue lanzando como objeto (node-soap lo exige), con un comentario.
- **Cobertura** (`npm run test:coverage`, `@vitest/coverage-v8`): línea base 86,5 % de líneas y 74,7 % de ramas; dominios 99–100 %,
  motor de sagas 96 %. Mínimos solo donde una falla cuesta dinero: dominios ≥ 95 %/85 % (líneas/ramas), motor ≥ 90 %/80 %
  (comprobado: con un mínimo de 99 % la corrida falla). En la CI, la etapa 2 mide la cobertura, escribe el resumen en la ejecución
  (`scripts/ci/resumen-cobertura.mjs`) y sube el reporte HTML.
- **Dependencias:** ESLint trae `minimatch` 10.2.6 con un aviso moderado (DoS con patrones glob; `npm audit` lo cuenta 9 veces).
  Solo de desarrollo; producción sigue en 8. La corrección (11.0.1) es una versión mayor que ESLint aún no pide: anotado en
  `Seguridad.md` (S-1).
- **Prettier: descartado** (decisión del responsable). Solo cambia el formato (no encuentra errores ni cambia la ejecución) y el
  código nunca se formateó con él: aplicarlo cambiaría 265–315 archivos sin mejorar nada que se evalúe. Se quitaron `.prettierrc`,
  `npm run format` y la dependencia, para que nadie reformatee todo por error. Se puede activar si el grupo empieza a editar mucho
  los mismos archivos.
- **Pendiente del responsable:** el *gate* de calidad es una opción de GitHub (*Settings → Branches → Required status checks*,
  S-7 en `Seguridad.md`).
