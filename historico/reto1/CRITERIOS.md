# CRITERIOS — Estado del proyecto frente a la rúbrica de evaluación

Revisión del 06/10/2026 sobre la rama `feature/arquitectura-4-capas`: código, pruebas y documentación del repositorio.
Cada criterio se marca con:
- ✅ **Cumple**: hay evidencia verificable.
- 🟡 **Parcial**: hay avance, pero un evaluador estricto podría marcarlo "No cumple".
- ❌ **No cumple todavía**.

La rúbrica es binaria (0 o 1 punto), así que **un 🟡 cuenta como riesgo de 0**.

---

## 1. Resumen

| # | Criterio | Estado | Evidencia principal | Qué falta |
|---|----------|--------|---------------------|-----------|
| 1 | Sistema desplegado y accesible públicamente en la nube **(obligatorio)** | ✅ | **Azure**: web en Static Web Apps, API y dev-auth en App Service, PostgreSQL Flexible Server; despliegue automático con GitHub Actions | — |
| 2 | Sistema de administración funcional (CRUD, gestión operativa, navegación) | ✅ | Panel `/admin`: **CRUD de rutas programadas y de la flota**, vuelos y asientos, estado de vuelo, pasajeros, flota, eventos, observabilidad | Que las rutas se guarden en la base de datos (criterio 5) |
| 3 | Marketplace web funcional (consulta, publicación, flujo de venta) | ✅ | Búsqueda → tarifa → hold → pasajeros, asientos y maletas → pago → boleto → postventa → check-in | Ver la nota sobre "publicación" en el punto 3 |
| 4 | APIs implementadas y documentadas con OpenAPI/Swagger | ✅ | 22 operaciones del contrato + extensiones, Swagger en `/docs`, guía `PRUEBASSW.md` | Que Swagger funcione también en la nube (NUBE-01) |
| 5 | Base de datos operativa | ✅ | **PostgreSQL** (`DATABASE_URL`): 15 tablas en 11 esquemas, uno por dominio; los datos sobreviven a un reinicio (prueba `persistence.e2e-spec.ts`). En Azure: Flexible Server | Confirmar la conexión en Azure al desplegar |
| 6 | Diseño API-first y preparación para integración futura | ✅ | El contrato es la fuente de verdad y no se modifica; pruebas de conformidad; 4 capas y dominios aislados | — |
| 7 | Contratos o endpoints identificados para interoperabilidad | ✅ | `vuelos-openapi.yaml`, `ecoairlines-extensions.yaml`, `HALLAZGOS.md` (26 hallazgos del contrato y EXT-01…04) | — |
| 8 | Diseño preliminar de eventos o servicios (SOA/EDA) | ✅ | `EVENTOS.md`, bus interno `DomainEventBus`, 9 de los 12 eventos del contrato publicados, webhooks firmados con HMAC y reintentos | Persistir los eventos (*outbox*) y un broker al pasar a microservicios |
| 9 | Documentación técnica mínima (arquitectura, modelo de datos, APIs) | ✅ | `ARQUITECTURA.md` (componentes, capas, secuencia de compra, **modelo de datos**), `EVENTOS.md`, Swagger, README, `PRUEBASSW.md` | Actualizar el modelo cuando existan las tablas reales |
| 10 | Dominio del código en la defensa | — | Depende del estudiante | Estudiar la sección 4 de este archivo |

**Conteo actual** (actualizado el 07/10, tras el despliegue en Azure): **9 ✅** de 9 criterios evaluables, más el 10, que es la defensa.

**Para asegurar el puntaje:** falta cerrar los dos ❌, la **base de datos** y el **despliegue en la nube** (obligatorio). El plan está en la sección 3.

---

## 2. Detalle por criterio

### Criterio 1 — Despliegue en la nube (obligatorio) · ✅ Cumple (07/10)

**URLs públicas:**

| Componente | Servicio de Azure | URL |
|------------|-------------------|-----|
| Web (marketplace y panel admin) | Static Web Apps (Free) | https://nice-hill-090e19c10.1.azurestaticapps.net |
| API y Swagger | App Service, Linux, Node 24, plan B1 | https://ecoairlines-api-gv-fjfaa7b5geg3hphs.brazilsouth-01.azurewebsites.net/docs |
| dev-auth (login y registro) | App Service (mismo plan) | https://ecoairlines-auth-gv-fscaa6e6gqbcb7ew.brazilsouth-01.azurewebsites.net/health |
| Base de datos | Azure Database for PostgreSQL Flexible Server (B1ms, Brazil South) | Privada: solo la usan la API y dev-auth |

**Cómo se despliega:** cada `push` a `main` ejecuta GitHub Actions y despliega solo la parte que cambió.
- **Web:** compila con las URLs públicas.
- **API:** tipos, lint, unitarias y e2e, y luego empaqueta las 4 capas.
- **dev-auth:** despliega su carpeta.

Paso a paso y problemas frecuentes en `DESPLIEGUE_AZURE.md`.

**Verificación en la nube (07/10):**
- Iniciar sesión en dev-auth desde la web responde `200`, con CORS para la web.
- Con ese token, la API responde `200` en "Mis reservas".
- La búsqueda UIO → BOG devuelve ofertas.
- Swagger publica la URL pública y el esquema de token.
- En PostgreSQL, las 16 tablas se crearon solas, con 90 rutas, 149 aviones y los usuarios de prueba.
- Una compra completa y el panel de administración se probaron desde la web pública.

**Evidencia para la defensa:**
1. Abrir la web.
2. Comprar como `demo@ecoairlines.test`.
3. Ver la reserva en el panel admin y en Observabilidad → Eventos.
4. Reiniciar la API en el portal: la reserva sigue (PostgreSQL).
5. En Swagger, `dev-auth` → `POST /login` → Authorize → cualquier endpoint.

---

### Criterio 2 — Sistema de administración · ✅ Cumple

**Lo que existe** (usuario `admin@ecoairlines.test` / `EcoAdmin2026`, ruta `/admin`):

| Función | Tipo | Dónde |
|---------|------|-------|
| **Rutas programadas**: crear, listar, editar y dar de baja vuelos del horario, eligiendo sus aviones | **CRUD** | `GET/POST /admin/routes`, `GET/PUT/DELETE /admin/routes/{routeId}`, pestaña "Rutas programadas" (`RoutesPanel`) |
| **Flota**: registrar aviones (tipo y base), cambiar su base y retirarlos; ver los tipos de avión | **CRUD** | `GET/POST /admin/aircraft`, `GET/PUT/DELETE /admin/aircraft/{registration}`, `GET /admin/aircraft-types`, pestaña "Flota" (`FleetPanel`) |
| Cambiar el estado operativo de un vuelo (a tiempo, demorado, cancelado…) | Actualización | `PUT /admin/flights/{n}/status` |
| Indicadores: reservas, ingresos, pasajeros, ocupación | Lectura | `GET /admin/dashboard-stats`, `AdminDashboardPage` |
| Vuelos y asientos por fecha, origen o ruta (hoy por defecto) | Lectura | `GET /admin/flights`, `AdminFlightsPanel` |
| Pasajeros de un vuelo con su asiento | Lectura | `GET /admin/flights/{n}/passengers` |
| Ventas por ruta y reservas recientes | Lectura | Pestañas del panel |
| Horario de la flota: qué hace cada avión cada día | Lectura | `GET /admin/fleet-schedule`, `FleetSchedulePanel` |
| Eventos de dominio y entregas de webhooks | Lectura | `GET /admin/events`, `EventsPanel` |
| Observabilidad: peticiones, latencias, errores | Lectura | `GET /admin/observability`, `AdminObservabilityPage` |
| Navegación por rol | — | `RequireAdmin`: el administrador entra a `/admin` y el cliente no |
| Seguridad | — | Scope `ecoairlines:admin`: `401` sin token, `403` con token de cliente |

**Cómo funciona el CRUD de rutas** (V1.K):
- **La ruta.** Es una línea de ida y vuelta: origen (base de los aviones), destino, hora de la ida, hora de la vuelta, días de la semana
  y tipo de avión (automático según la distancia, o elegido).
- **Crear.** Asigna números de vuelo libres desde EA300. El horario se reconstruye con `TimetableBuilder`, que asigna los aviones y
  valida que ninguno quede en dos lugares a la vez. Después se publica en el GDS: los vuelos quedan a la venta al instante, en los 91
  días.
- **Validaciones:**
  - aeropuertos de la red;
  - alcance del avión (un A220 no llega a Madrid: `422`);
  - vuelos duplicados a la misma hora (`409`).
- **Editar o dar de baja.** Se rechaza si la ruta tiene cupos vendidos o retenidos (`409`): para esos vuelos se usa el estado operativo.
- **Aviso a otros sistemas.** Cada cambio publica `flight.schedule_changed` (criterio 8).

**Persistencia:** las rutas y la flota se guardan en PostgreSQL, en el esquema `schedule` (tablas `routes` y `aircraft`). Al arrancar,
la API vuelve a publicar el horario guardado, así las rutas creadas siguen a la venta después de un reinicio.

---

### Criterio 3 — Marketplace web · ✅ Cumple

**Flujo de venta completo** en `ecoairlines-web`:
1. **Consulta:** buscador de solo ida, ida y vuelta o multidestino con pasajeros por tipo (`SearchWidget`), resultados con familias
   tarifarias, precio por grupo y CO₂ (`ResultsPage`), y estado de vuelo público (`FlightStatusPage`).
2. **Reserva:** hold con cuenta regresiva del precio congelado (`Countdown`), datos de pasajeros validados (edad por tipo, cédula, documento
   único), asientos y equipaje del grupo en un solo panel, y pago por referencia (`CheckoutPage`).
3. **Emisión:** boletos emitidos y detalle de la reserva (`BookingDetailPage`).
4. **Postventa:** maletas, cambio de fecha, cambio de asiento, cancelación con cotización, y check-in con pase de abordar y código QR
   (`pages/booking/*`).
5. **Cuenta:** registro e inicio de sesión, perfil que autocompleta al pasajero 1, y "Mis viajes".

**Nota sobre "publicación":**
- Las ofertas se **publican** automáticamente: el horario semanal genera 180 vuelos diarios con 91 días de venta, y cada día entra uno nuevo.
- La API está diseñada para publicar el inventario hacia un **marketplace central** (el booking del grupo) mediante el contrato.
- Si el evaluador espera que un usuario "publique" desde la web, la respuesta es el CRUD de rutas del criterio 2.

---

### Criterio 4 — APIs implementadas y documentadas (OpenAPI/Swagger) · ✅ Cumple

- **22 operaciones** del contrato `contract/vuelos-openapi.yaml`, todas implementadas.
- **Extensiones propias** documentadas aparte en `contract/ecoairlines-extensions.yaml`: perfil, cambio de asiento, administración y
  observabilidad.
- **Swagger UI** en `/docs` con tres documentos y "Try it out" con token de desarrollo:
  - el contrato tal cual;
  - las extensiones;
  - en desarrollo, **dev-auth**, para registrarse e iniciar sesión (`200` + token) sin salir de Swagger.
- **Errores** con el formato `ProblemDetails` del contrato en todas las rutas.
- **Verificación:** `contract-conformance.e2e-spec.ts` valida cada respuesta contra el schema del contrato, y `swagger.e2e-spec.ts` que
  cada ruta del contrato tiene implementación y que no hay rutas de más.
- **Guía de pruebas manuales:** `PRUEBASSW.md`, con 53 casos de error.

**Riesgo:** en la nube, Swagger debe quedar visible y apuntar a la URL pública (NUBE-01).

---

### Criterio 5 — Base de datos operativa · ✅ Cumple (V1.M)

**Cómo funciona:**
- **Conexión.** Con `DATABASE_URL`, cada contexto de datos (`DataAccess/src/context`, equivalente a un `DbContext`) guarda sus tablas
  en PostgreSQL. Las tablas se crean solas al arrancar y la primera vez se carga la red base (90 rutas y 149 aviones). Sin la variable,
  todo sigue en memoria, que es lo que usan las pruebas.
- **Un esquema por dominio**, que es la "base de datos por dominio" del diseño:

  | Esquemas | Tablas |
  |----------|--------|
  | `bookings`, `offers`, `post_sale`, `check_in`, `customers`, `flight_status`, `webhooks`, `idempotency` | De cada dominio del contrato |
  | `schedule` | Rutas y flota |
  | `gds`, `payment` | Sistemas externos simulados |
  | `auth` | Cuentas de dev-auth |

- **Formato.** Cada agregado se guarda como documento JSONB: la reserva con sus pasajeros y boletos; el hold con sus selecciones…
- **Patrón repositorio intacto.** La lógica de negocio sigue usando las interfaces de `DataManagement`. Los repositorios no
  cambiaron: las tablas (`PersistentTable`) se usan como un `Map` y escriben en la base cada cambio, en orden.
- **Evidencia:** `EcoAirlines.API/test/persistence.e2e-spec.ts`, con PostgreSQL 16 en Docker.
  - Crea reserva con asiento, perfil, webhook, avión y ruta.
  - Apaga la API, la vuelve a levantar y comprueba que todo sigue ahí, incluido el asiento ocupado en el GDS.

**Decisión a defender:** la memoria es la copia de trabajo y PostgreSQL la fuente durable.
- Es simple y rápido, y no cambió ningún repositorio.
- La API corre como **una sola instancia**.
- Para escalar a varias instancias, los repositorios pasarían a consultar PostgreSQL directamente: las interfaces ya lo permiten.

---

### Criterio 6 — Diseño API-first y preparación para integración · ✅ Cumple

- **El contrato primero:** el código se adapta a `vuelos-openapi.yaml`, nunca al revés (reglas en `CLAUDE.md`). El archivo no se
  modifica; su hash se verifica en cada revisión.
- **DTOs idénticos al contrato:** `required`, `enum`, `pattern`, `additionalProperties: false`, formatos de fecha.
- **Pruebas que obligan a cumplirlo:** conformidad de cada respuesta y cobertura de cada combinación operación + status.
- **Preparado para integrar:**
  - autenticación OAuth2/JWT lista para un proveedor real (`AUTH_JWKS_URL`);
  - gateways al GDS y a la Payment API detrás de interfaces (hoy simulados);
  - `Idempotency-Key` para reintentos seguros;
  - `X-Request-Id` para trazar entre sistemas.
- **Preparado para microservicios:** 4 capas y dominios aislados; un dominio solo habla con otro mediante fachadas
  (`BookingsFacade`), comprobado por `test/architecture.spec.ts`.

---

### Criterio 7 — Contratos o endpoints para interoperabilidad · ✅ Cumple

| Documento | Para qué sirve |
|-----------|----------------|
| `contract/vuelos-openapi.yaml` | Contrato común con el booking central: 22 operaciones, seguridad OAuth2 con scopes, schemas, errores y callbacks de webhooks |
| `contract/ecoairlines-extensions.yaml` | Endpoints propios que otros sistemas deberían conocer (perfil, asiento, administración) |
| `HALLAZGOS.md` §6 | 26 inconsistencias del contrato detectadas y verificadas contra el código, con propuesta de corrección para el grupo |
| `HALLAZGOS.md` §4 y §4b | Diferencias con la plantilla del grupo (rutas base, Swagger, persistencia) y extensiones a acordar (EXT-01…04) |
| `PRUEBASSW.md` | Cómo consumir cada endpoint y qué responde en cada caso |

---

### Criterio 8 — Diseño preliminar de eventos o servicios (SOA/EDA) · ✅ Cumple

**Diseño documentado** en [`EVENTOS.md`](EVENTOS.md):
- catálogo de los 12 eventos del contrato, con el dominio que produce cada uno, el momento, los datos y los consumidores sugeridos
  (booking central, notificaciones, contabilidad);
- diagramas de la arquitectura y de la entrega;
- firma y reintentos;
- evolución hacia *outbox*, un broker (RabbitMQ o Kafka) y microservicios.

**Implementado (V1.K):**
- **Bus interno** `DomainEventBus` (`Business/src/common/events`):
  - quien publica no conoce a quien consume;
  - los consumidores corren después de responder y un fallo no rompe la operación;
  - guarda el historial de eventos.
- **9 eventos publicados por la lógica de negocio:**
  - `booking.confirmed`, `booking.ticket_issuing`, `booking.ticket_issued`;
  - `booking.changed` (cambio de fecha o de asiento), `booking.baggage_added`, `booking.cancelled`, `booking.checked_in`;
  - `flight.cancelled` y `flight.schedule_changed` (estado de vuelo y CRUD de rutas).
- **Webhooks reales:**
  - HTTP POST con firma HMAC-SHA256 usando el `secret` del suscriptor y cabeceras `X-EcoAirlines-*`;
  - 3 intentos ante errores `5xx`, `429` o de red;
  - los eventos `booking.*` llegan solo al dueño y los `flight.*` a todos los suscriptores;
  - la regla anti-SSRF se repite al enviar.
- **Visible en el panel:** Observabilidad → "Eventos de dominio y webhooks" (`GET /admin/events`).
- **Pruebas:** `events.e2e-spec.ts`, con un suscriptor local que verifica la firma, el filtrado por dueño y los reintentos.

**Diseñados pero no emitidos:**
- `hold.expired`: necesita un proceso programado.
- `booking.failed` y `booking.ticket_failed`: los sistemas simulados no fallan.

Están explicados en `EVENTOS.md`.

---

### Criterio 9 — Documentación técnica mínima · ✅ Cumple

| Tema | Dónde está | Estado |
|------|------------|--------|
| Visión general y puesta en marcha | `README.md` (raíz) | ✅ |
| **Arquitectura** | [`ARQUITECTURA.md`](ARQUITECTURA.md): diagrama de componentes, capas y dominios, secuencia de la compra, rutas programadas, eventos y seguridad | ✅ |
| **Modelo de datos** | [`ARQUITECTURA.md`](ARQUITECTURA.md) §5: diagrama entidad-relación (Mermaid) con 9 bases de datos por dominio y sus tablas | ✅ |
| Eventos | [`EVENTOS.md`](EVENTOS.md) | ✅ |
| APIs | Swagger, contrato, anexo de extensiones, `PRUEBASSW.md` | ✅ |
| Decisiones y evolución | `CAMBIOS.md` (V1.A…V1.K), `HALLAZGOS.md`, `AUDITORIA.md` (marcada como histórica, con el estado de cada hallazgo) | ✅ |
| Pruebas | `EcoAirlines.API/README.md` (sección Pruebas), `PRUEBASSW.md` | ✅ |

Los diagramas Mermaid se comprobaron dibujándolos. El modelo de datos muestra:
- el **modelo lógico**: entidades y relaciones;
- las **tablas físicas** de PostgreSQL: 16 tablas en 12 esquemas, con un documento JSONB por agregado.

Además, la §8 cubre el despliegue en Azure.

---

### Criterio 10 — Dominio del código en la defensa

No depende del repositorio sino del estudiante. La sección 4 resume cada parte del proyecto: qué hace, cómo y por qué se decidió así.

---

## 3. Plan para cerrar las brechas (en orden)

| Orden | Trabajo | Criterios | Estado |
|-------|---------|-----------|--------|
| 1 | **CRUD de rutas programadas** en el panel admin | 2, 3 | ✅ V1.K |
| 2 | **Eventos**: bus interno, webhooks firmados y `EVENTOS.md` | 8 | ✅ V1.K |
| 3 | **`ARQUITECTURA.md`** con diagramas y modelo de datos; `AUDITORIA.md` histórica; README | 9 | ✅ V1.K |
| 4 | **PostgreSQL**: tablas por dominio con `DATABASE_URL`, probado con Docker; dev-auth también persiste | 5 (y 1) | ✅ V1.M |
| 5 | **Despliegue en Azure**: Static Web Apps (web), App Service (API y dev-auth), PostgreSQL Flexible Server; Swagger con URL pública; workflows de GitHub Actions | 1, 4 | ✅ 07/10 (ver criterio 1) |
| 6 | Auditoría de Gemini, pruebas con `PRUEBASSW.md`, commits y merge a `main` | Todos | ✅ Código en `main` y desplegado; queda la nueva auditoría de Gemini sobre esta versión (opcional) |

De las observaciones de `PRUEBASSW.md` §10:
- **OBS-1** (URL de webhook sin esquema): resuelta en V1.K.
- **OBS-2** (búsquedas vacías con `200`): sigue pendiente de decisión del grupo.

---

## 4. Descripción de cada parte del proyecto (para la defensa)

### 4.1 Visión general

**AppVuelos / EcoAirlines** es la aerolínea ficticia del grupo de vuelos dentro de un ecosistema de reservas (booking hub). Tiene tres
piezas, desplegadas en Azure y con PostgreSQL:

```
 Navegador ──► ecoairlines-web (React)  ──HTTP/JSON──►  API EcoAirlines (NestJS, 4 capas)  ──►  GDS y Payment API (simulados)
                     │                                          ▲            │
                     └──► dev-auth (emite JWT) ─────────────────┘            └──► PostgreSQL (un esquema por dominio)
                                    └──► PostgreSQL (auth.users)     la API verifica la firma del token
```

- **API:** implementa el contrato `vuelos-openapi.yaml`. Es lo que consumirá el booking central.
- **Web:** el marketplace propio de la aerolínea (clientes) y el panel de administración.
- **dev-auth:** simula el servidor OAuth2 externo que el contrato da por existente.

**Tecnologías:**
- TypeScript estricto en todo el proyecto.
- API: NestJS 12 sobre Node 24, con class-validator para los DTOs.
- Web: React 19 + Vite 8.
- Datos: PostgreSQL (driver `pg`).
- Pruebas: Vitest y Supertest.
- Lint: oxlint.
- Nube: Azure (Static Web Apps, App Service, PostgreSQL Flexible Server) con despliegue continuo en GitHub Actions.

### 4.2 El contrato (`contract/`)

- **`vuelos-openapi.yaml`** (OpenAPI 3.0, GDS Flight Core API v1.5.0.0): **fuente de verdad**. Define 22 operaciones agrupadas en:
  - búsqueda y catálogo;
  - hold;
  - reservas y emisión;
  - postventa;
  - check-in;
  - estado de vuelos;
  - webhooks.

  También define la seguridad (OAuth2 con 5 scopes `flights:*`), los schemas y el modelo de error `ProblemDetails` con su enum `code`.
- **Regla:** no se modifica. Si algo está mal o falta, se documenta en `HALLAZGOS.md` y se propone al grupo. Ejemplos: falta documentar
  el `401` (HALL-02); el enum `code` no tiene códigos de autenticación (HALL-05).
- **`ecoairlines-extensions.yaml`:** endpoints propios fuera del contrato, en un archivo aparte para no "contaminar" el acordado. Reusa los
  schemas del contrato al publicarse.

### 4.3 Arquitectura en 4 capas

Igual que una solución .NET con 4 proyectos. Cada capa es un *workspace* npm y **solo puede usar las capas inferiores**:

```
EcoAirlines.API  →  EcoAirlines.Business  →  EcoAirlines.DataManagement  →  EcoAirlines.DataAccess
 (HTTP)              (reglas de negocio)       (repositorios y gateways)       (entidades, datos, sistemas externos)
```

Dentro de cada capa, los archivos se agrupan **por dominio**:
- search, offers, bookings, post-sale, check-in, flight-status y webhooks (del contrato);
- customers y admin (extensiones).

Cada dominio podría extraerse como microservicio con su propia base de datos.

**Por qué así:**
- separa responsabilidades: el controller no sabe de reglas, y el servicio no sabe de HTTP ni de cómo se guardan los datos;
- permite cambiar la memoria por PostgreSQL, o el GDS simulado por uno real, sin tocar lo de arriba;
- sigue la plantilla del compañero, para integrarse con el grupo.

**Cómo se garantiza:** `EcoAirlines.API/test/architecture.spec.ts` analiza los imports y falla si:
- una capa importa de una superior;
- un dominio accede a los datos de otro.

Solo se permiten dependencias explícitas, por ejemplo post-sale → bookings a través de `BookingsFacade`.

#### `EcoAirlines.DataAccess` — datos y sistemas externos
- **`entities/`**: la forma de cada dato guardado.
  - `BookingRecord`: la reserva del contrato + dueño + tarifas compradas.
  - `HoldRecord`: estado `HELD/RELEASED/EXPIRED/CONSUMED`, precio bloqueado y vencimiento.
  - `CustomerProfileRecord`, `FlightStatusOverride`, `WebhookSubscriptionRecord`, `IdempotencyRecord`, `StoredQuote` (cotizaciones y
    ofertas de cambio) y `CheckInRecord`.
- **`context/`**: **un contexto por dominio** (como un `DbContext`), cada uno con su esquema de PostgreSQL.
- **`database/`**: `DatabaseService` y `PersistentTable`.
  - Con `DATABASE_URL`, crean y cargan las tablas al arrancar y escriben cada cambio en orden.
  - Sin la variable, las tablas funcionan en memoria (pruebas).
- **`external/gds/mock-gds.service.ts`**: el **GDS simulado**, el sistema de reservas de la aerolínea.
  - Busca vuelos directos y con escala (1 a 10 h, sin rodeos mayores a 1,6 veces la distancia).
  - Calcula precios por familia tarifaria y tipo de pasajero, y lleva el inventario de asientos por vuelo.
  - Responde el estado de vuelo y el horario de la flota.
  - Respeta la **ventana de venta de 91 días**.
  - Solo los vuelos de la primera semana tienen ocupación simulada (20–49 %); el resto empieza vacío.
- **`external/payment/`**: la **Payment API simulada**. Según la referencia, aprueba, rechaza (`declined`) o queda pendiente (`async`).
  La API nunca ve datos de tarjeta, como exige el contrato.
- **`seed/`**: datos fijos.
  - `airports.ts`: 10 aeropuertos con coordenadas y huso horario.
  - `network.ts`: aviones, cabinas, terminales y familias tarifarias `SEMILLA`, `BROTE`, `BOSQUE` y `DOSEL`.
  - `timetable.ts`: el **horario semanal**, explicado abajo.

**El horario (`timetable.ts`):**
- Todos los aeropuertos están conectados con todos, con 2 vuelos diarios por ruta y sentido: 180 vuelos al día.
- **`TimetableBuilder`** arma el horario:
  - `addAircraft(tipo, base)` da de alta un avión;
  - `addFlight({vuelo, origen, destino, día, hora, avión})` agrega un vuelo;
  - `build()` valida que ningún avión esté en dos lugares a la vez y que cada uno vuelva a su base al terminar la semana.
- Cada avión tiene un **horario semanal fijo**: el martes de la semana 13 hace lo mismo que hoy martes.
- El tipo de avión depende de la distancia: A220 (< 1 500 km), A320neo (< 4 500 km) o 787-9. La flota es de 149 aviones.
- **Rutas programadas** (`RouteDefinition`):
  - el horario se arma con `buildTimetable(routes)` a partir de 90 rutas de ida y vuelta (la red base);
  - el administrador agrega, edita o da de baja rutas desde el panel;
  - en cada cambio se reconstruye el horario completo y el GDS lo publica (`publishRoutes`);
  - si un avión quedaría en dos lugares, el horario anterior no cambia y el administrador recibe un `422` con los conflictos.

#### `EcoAirlines.DataManagement` — patrón repositorio
- **`interfaces/`**: contratos internos que usa la lógica de negocio. Por ejemplo, `BookingRepository` (`create`, `findById`,
  `findAllByOwner`…), `PaymentVerifierGateway` y `ReservationSystemGateway`.
- **`repositories/`**: las implementaciones, que usan las tablas del contexto como un `Map`. Al conectar PostgreSQL no cambiaron.
  Para escalar a varias instancias, serían lo único que cambia (consultas directas a la base).
- **`gateways/`**: adaptadores hacia el GDS, la Payment API y el despacho de webhooks.
- Cada interfaz se registra con un *token* de inyección de dependencias de NestJS (`BOOKING_REPOSITORY`…), así que cambiar la
  implementación es cambiar una línea en `data-management.module.ts`.

#### `EcoAirlines.Business` — lógica de negocio
- **`dto/`**: la forma exacta de cada request y response del contrato, con validaciones (`@IsIn`, `@Matches(/^[A-Z]{3}$/)`,
  `@Max(50)`…). Si un dato no cumple, la API responde `400` antes de llegar al servicio.
- **`services/`**, por dominio:
  - **search** (`catalog.service`): búsqueda y mapa de asientos.
  - **offers** (`hold.service`): bloquea cupos por 15 minutos con precio congelado. Solo el dueño puede verlo o liberarlo; vence solo.
  - **bookings** (`bookings.service`): la operación central. Su orden está pensado para no dejar nada a medias:
    1. validar el hold;
    2. validar los pasajeros (tipos y cantidades del hold, infantes con su adulto, edad según el tipo, documento único, cédula
       ecuatoriana válida);
    3. calcular las maletas;
    4. verificar el pago;
    5. asignar asientos;
    6. consumir el hold;
    7. emitir los boletos, al momento (`201`) o de forma diferida (`202`).
  - **bookings** (`bookings.facade`): la única puerta para que otros dominios usen reservas.
  - **bookings** (`seat-change.service`): cambio de asiento (extensión).
  - **post-sale**:
    - `baggage.service`: hasta 3 maletas extra por pasajero y vuelo;
    - `date-change.service`: buscar y confirmar el cambio con su diferencia de precio y cargo; `SEMILLA` no permite cambios;
    - `cancellation.service`: cotización válida 15 min, reembolso y penalidad según la tarifa.
  - **check-in**: abre 48 h antes y cierra 60 min antes; asigna asiento si falta y emite pases con código de barras.
  - **flight-status**: estado del vuelo. Si el administrador fijó uno, prevalece.
  - **webhooks**: suscripciones por dueño, con validación anti-SSRF en producción. `WebhookDeliveryService` escucha el bus de eventos
    y entrega cada evento por HTTP POST firmado con HMAC (`X-EcoAirlines-Signature`), con 3 intentos.
  - **customers** y **admin**: perfil del cliente; indicadores, ocupación, flota, pasajeros, eventos y el **CRUD de rutas programadas**
    (`admin-routes.service`: valida, publica el horario en el GDS, guarda y emite `flight.schedule_changed`) y de la **flota**
    (`admin-fleet.service`: registra aviones con matrícula automática; no deja mover ni retirar un avión que opera rutas).
    `schedule-publisher` publica en el GDS el horario completo (rutas + flota) en cada cambio.
- **`common/events/domain-event-bus.ts`**: el **bus de eventos interno**.
  - Los servicios publican (`booking.confirmed`, `booking.cancelled`, `flight.cancelled`…) sin saber quién escucha.
  - Los consumidores corren después de responder al cliente.
  - En microservicios se reemplaza por RabbitMQ o Kafka. Ver `EVENTOS.md`.
- **`rules/`**: reglas puras, fáciles de probar. Por ejemplo, `passenger-rules.ts`, `passenger-identity-rules.ts` y la política de URLs
  de webhooks.
- **`exceptions/`**: `ProblemDetailsException`. Cada error de negocio lleva su status y su `code` del contrato.

#### `EcoAirlines.API` — capa HTTP
- **`controllers/`**: un controller por recurso del contrato. Reciben, validan con los DTOs, llaman al servicio y deciden el status
  HTTP (`200/201/202/204`). No contienen reglas de negocio.
- **`auth/`**: verificación del JWT.
  - Comprueba firma, expiración, emisor y audiencia, y rechaza `alg: none`.
  - El **`sub` del token es el dueño** de holds y reservas; nunca se acepta un `ownerId` en el body.
  - Los guards de scopes devuelven `403` si falta el permiso.
  - Un recurso ajeno responde `404`, para no revelar que existe.
- **`interceptors/idempotency`**: guarda la respuesta de cada `Idempotency-Key` por 24 h.
  - Un reintento recibe la misma respuesta sin duplicar la reserva ni el cobro.
  - La misma key con otro body responde `409`.
- **`middleware/`**:
  - filtro global de errores: todo sale como `ProblemDetails`, incluso JSON roto o rutas inexistentes, y un error interno no expone
    el stack;
  - `X-Request-Id` en cada respuesta;
  - log de acceso sin datos sensibles.
- **`security/`**:
  - helmet (cabeceras);
  - CORS con lista blanca;
  - límite de peticiones por IP (`429` con `Retry-After`);
  - body de máximo 100 kb;
  - rechazo de `__proto__` y de propiedades extra donde el contrato dice `additionalProperties: false`.
- **`observability/`**: métricas en memoria por ruta y status, latencias (media, p95) y errores recientes, para el panel admin.
- **`docs/swagger.setup.ts`**: publica el contrato **tal cual** en `/docs`.
  - En desarrollo, y en la nube con `PUBLIC_API_URL`, agrega solo en memoria el servidor de la API y el esquema `DevBearer`.
  - También agrega el documento de dev-auth para obtener el token.
- **`config/validate-environment.ts`**: valida todas las variables al arrancar. En producción, sin la configuración segura, no arranca.

### 4.4 Flujo de una compra (para explicar con el código)

1. **`POST /search`** (público, con `X-Device-Fingerprint`): `SearchController` → `CatalogService` → GDS. Devuelve ofertas con
   `offerId`.
2. **`POST /offers/hold`** (`flights:hold` + `Idempotency-Key`): bloquea cupos y precio por 15 minutos para el `sub` del token.
3. **`POST /bookings`** (`flights:book` + `Idempotency-Key`): valida todo, verifica el pago con la referencia, asigna asientos, consume
   el hold y emite boletos.
   - Si el pago está pendiente: `202 PENDING_PAYMENT`, y un proceso diferido lo confirma.
4. **Postventa** sobre la reserva: maletas, cambio de fecha, cancelación. Siempre validando que la reserva sea del usuario.
5. **`POST /bookings/{id}/check-in`** dentro de la ventana de 48 h → **`GET /boarding-passes`**.

### 4.5 Frontend (`ecoairlines-web`)

- **`api/`**: cliente HTTP tipado.
  - `client.ts` agrega el token, `Idempotency-Key` y `X-Request-Id`.
  - `endpoints.ts` cubre el contrato y `extensions.ts` los endpoints propios.
  - `problem-messages.ts` traduce cada `code` de error a un mensaje para el usuario.
- **`auth/`**: `AuthContext` (sesión con dev-auth) y las rutas protegidas `RequireAuth` y `RequireAdmin`.
- **`booking/BookingFlowContext`**: la compra en curso (oferta, tarifas, pasajeros, hold). Vive en memoria y no guarda datos sensibles.
- **`pages/`**:
  - inicio, resultados, checkout (con `checkout/SeatSelectionPanel` y `BaggageSelectionPanel`);
  - Mis viajes, detalle de reserva (con `booking/*`: maletas, cambio de fecha y de asiento, cancelación, check-in);
  - estado de vuelo, perfil, Compromiso verde (CO₂), login;
  - `admin/*`: panel, vuelos y asientos, **rutas programadas (CRUD)**, flota, eventos y webhooks, observabilidad.
- **`components/`**: buscador, mapa de asientos, cuenta regresiva, alerta de errores, QR del pase de abordar.
- **`lib/`**: formato de fechas y moneda, cálculo de CO₂, validación de pasajeros (las mismas reglas que la API, para avisar antes
  de pagar) y observabilidad del lado del cliente.

### 4.6 dev-auth

- Servidor mínimo de Node (su única dependencia es el driver `pg`) que **simula el proveedor OAuth2** del contrato. Ofrece `POST /register`, `POST /login` y
  `GET /health`.
- Las contraseñas se guardan con `scrypt` y se comparan en tiempo constante.
- Emite JWT firmados (HS256) con los **scopes según el rol**: un cliente recibe `flights:*` y `ecoairlines:profile`; un administrador,
  `ecoairlines:admin`.
- Está **fuera de la API a propósito**: la API solo verifica tokens. En producción se reemplaza por el proveedor real con `AUTH_JWKS_URL`
  sin tocar el código.
- **Dónde se guardan las cuentas:** nombre, correo, contraseña derivada y rol, en PostgreSQL (`auth.users`), propiedad de dev-auth.
  - La API no las ve: conoce al cliente solo por el `sub` del token, y guarda su perfil (`/customers/me`) y sus reservas en sus propios
    esquemas.
  - Los usuarios de prueba tienen un `sub` fijo, así sus reservas siguen siendo suyas tras un reinicio.
- **En la nube:** se niega a arrancar sin un secreto propio, y `ADMIN_PASSWORD` cambia la clave del administrador.
- **Su documento OpenAPI** (`dev-auth/openapi.yaml`) aparece en el selector del Swagger de la API.
  - "Try it out" llama directamente a dev-auth (su CORS admite el origen de la API) y devuelve el token.
  - Es documentación, no una ruta de la API.

### 4.7 Pruebas

- **174 unitarias:** reglas de pasajeros, horario y flota, GDS, pagos, JWT, configuración, Swagger, filtros de error y bus de eventos.
  Más la **prueba de arquitectura**.
- **138 e2e** contra la aplicación completa:
  - conformidad de **cada respuesta** con el schema del contrato, incluidos `410` y `429` con el reloj adelantado;
  - flujo de compra, postventa, seguridad (cabeceras, CORS, límites, saneamiento), autenticación y propiedad de recursos;
  - extensiones (rutas, flota, eventos y webhooks) y regresiones de la auditoría;
  - **persistencia**: con `TEST_DATABASE_URL`, reinicia la API contra PostgreSQL y comprueba que los datos siguen.
- **Comandos:** `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`.
- **Pruebas manuales:** `PRUEBASSW.md`.
- **Antes de cada despliegue:** GitHub Actions corre tipos, lint, unitarias y e2e. Si algo falla, la API no se despliega.

### 4.8 Documentos del repositorio

| Archivo | Contenido |
|---------|-----------|
| `README.md` | Qué es el proyecto, estructura y cómo levantarlo |
| `EcoAirlines.API/README.md` | Detalle técnico de la API: capas, auth, seguridad, datos de prueba, errores, pruebas |
| `CAMBIOS.md` | Bitácora por versiones: qué se pidió, cómo se hizo y cómo se verificó (V1.A…V1.J) |
| `HALLAZGOS.md` | Problemas detectados: entorno, nube, plantilla del grupo, extensiones y contrato |
| `AUDITORIA.md` | Auditoría técnica de Gemini (rol de auditor) |
| `PRUEBASSW.md` | Guía de pruebas manuales en Swagger |
| `ARQUITECTURA.md` | Componentes, capas, flujo de compra, rutas programadas, modelo de datos (lógico y tablas físicas) y despliegue, con diagramas Mermaid |
| `DESPLIEGUE_AZURE.md` | Despliegue en Azure paso a paso, URLs públicas y problemas frecuentes |
| `EVENTOS.md` | Catálogo de eventos, bus interno, webhooks firmados y evolución hacia un broker |
| `CRITERIOS.md` | Este documento |
| `CLAUDE.md` / `GEMINI.md` | Reglas de trabajo del programador y del auditor |

### 4.9 Decisiones técnicas clave (y cómo justificarlas)

| Decisión | Justificación |
|----------|---------------|
| El contrato no se modifica | Es el acuerdo con el grupo. Si cada equipo lo cambia, la integración se rompe. Los problemas se reportan (`HALLAZGOS.md`) |
| 4 capas + dominios aislados | Responsabilidades claras y lista para microservicios; la prueba de arquitectura lo garantiza |
| Repositorios y gateways detrás de interfaces | Cambiar memoria por PostgreSQL, o el GDS simulado por uno real, sin tocar la lógica |
| El dueño sale del JWT, nunca del body | Impide que un usuario cree o lea reservas a nombre de otro |
| `404` en vez de `403` para recursos ajenos | No revelar qué reservas existen |
| `Idempotency-Key` obligatoria | Un reintento por mala red no duplica la reserva ni el cobro |
| La API no procesa tarjetas | Lo exige el contrato: solo recibe una `paymentReference` de la Payment API (alcance PCI fuera del sistema) |
| `ProblemDetails` en todo error | Un único formato que cualquier cliente puede interpretar por su `code` |
| Horario semanal fijo por avión con validación | Realismo operativo: un avión no puede estar en dos lugares, y agregar una ruta es una llamada a `addFlight` |
| Rutas con pasajeros no se editan ni se borran | Un cambio de horario no puede dejar a un cliente sin vuelo: para eso está el estado operativo (`CANCELLED`) y su evento |
| Bus de eventos + webhooks firmados | Desacopla a quien publica de quien consume (EDA); la firma HMAC prueba el origen y la integridad del mensaje |
| Ventana de venta de 91 días | 13 semanas exactas: el mismo día de la semana repite el horario, y cada día entra uno nuevo |
| dev-auth separado | Simula el proveedor OAuth2 externo sin meter el login dentro de la API |

### 4.10 Preguntas probables en la defensa

| Pregunta | Respuesta breve |
|----------|-----------------|
| ¿Qué pasa si dos personas eligen el mismo asiento? | El GDS asigna el asiento al confirmar; el segundo recibe `409 SEAT_TAKEN` |
| ¿Qué pasa si el usuario no paga en 15 minutos? | El hold vence (`EXPIRED`), se liberan los cupos y `POST /bookings` responde `410` |
| ¿Cómo evitan reservas duplicadas por doble clic? | `Idempotency-Key`: la misma key devuelve la misma respuesta sin crear otra reserva |
| ¿Cómo sabe la API quién es el usuario? | Por el `sub` del JWT verificado. El body nunca decide el dueño |
| ¿Por qué hay un `202`? | Pagos o emisiones asíncronas: la reserva queda `PENDING_PAYMENT` y un proceso la confirma después |
| ¿Cómo agregarían una base de datos? | Nuevas implementaciones de las interfaces de `DataManagement`; controllers y servicios no cambian |
| ¿Cómo lo pasarían a microservicios? | Cada dominio ya tiene su contexto de datos y solo habla con otros por fachadas; se separa y la fachada pasa a ser una llamada HTTP o un evento |
| ¿Qué hacen los webhooks? | Un sistema externo se suscribe a eventos (reserva confirmada, cancelada…) y recibe un POST en su URL, firmado con HMAC usando su `secret`, con hasta 3 intentos. Se ve en Observabilidad → "Eventos de dominio y webhooks" |
| ¿Cómo sabe el receptor que el webhook es auténtico? | Recalcula `HMAC-SHA256(secret, "<t>.<cuerpo>")` y lo compara con `X-EcoAirlines-Signature`; rechaza marcas de tiempo viejas |
| ¿Qué pasa si el suscriptor está caído? | Se reintenta ante `5xx`, `429` o error de red (3 intentos); la reserva no se ve afectada porque la entrega ocurre después de responder |
| ¿Dónde se guardan los clientes? | La cuenta (correo y contraseña cifrada) en el servidor de autenticación (dev-auth, que simula al OAuth2 externo); el perfil y las reservas en la API, asociados al `sub` del token. Todo en PostgreSQL (Azure), cada uno en su esquema |
| ¿Por qué no se crea un cliente desde la API? | El contrato delega el registro y el login a un servidor OAuth2 externo; la API solo verifica tokens. En Swagger se usa el documento de dev-auth |
| ¿Por qué los tipos de avión no se editan? | Definen el mapa de asientos, el alcance y el tiempo en tierra; cambiarlos rompería vuelos ya vendidos. Son datos maestros: se consultan |
| ¿Cómo se crea una ruta nueva? | Panel → Rutas programadas → Nueva ruta. El servicio valida, `buildTimetable` asigna los aviones y comprueba que no haya conflictos, el GDS publica el horario y se emite `flight.schedule_changed` |
| ¿Por qué no puedo borrar una ruta con reservas? | Dejaría pasajeros sin vuelo. Se responde `409` y se usa el estado operativo del vuelo (`CANCELLED`), que avisa con `flight.cancelled` |
| ¿Cómo protegen la administración? | Scope `ecoairlines:admin`: `401` sin token, `403` con token de cliente |
| ¿Cómo validan que cumplen el contrato? | Las pruebas e2e validan cada respuesta contra el schema del YAML y exigen cubrir cada status documentado |
| ¿Cómo validan los datos del pasajero? | DTOs (forma) + reglas de negocio: edad según el tipo, cédula con dígito verificador y documento único por vuelo |
