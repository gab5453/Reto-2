# Estilo, arquitectura, patrones y diseño — EcoAirlines Reto 2

Cómo está construido el sistema y por qué. Revisado el **11/11/2026** sobre la rama `feature/v2-microservicios`.
Diagramas de referencia (en esta carpeta): `arquitectura-microservicios-v6.png` y `modelo-conceptual-v6.png` (11/11/2026; en rojo, lo nuevo desde la v5). Las versiones anteriores están en `PLAN/` como historial.

---

## 1. Cuatro palabras que se suelen confundir

Van de lo más general a lo más concreto:

| Término | Qué es | Pregunta que responde | En este sistema |
|---|---|---|---|
| **Estilo arquitectónico** | La familia general de soluciones, con sus reglas | ¿Cómo se organiza el sistema en grande? | Microservicios en capas con un bus de servicios (ESB), en parte dirigido por eventos |
| **Arquitectura** | La forma concreta del sistema: qué componentes hay, qué hace cada uno y cómo se conectan | ¿Qué piezas tiene **este** sistema? | 1 gateway, 5 MS de respuesta, 1 ESB, 9 MS de gestión, 2 externos, RabbitMQ, PostgreSQL, observabilidad (sección 3) |
| **Patrón arquitectónico o de integración** | Una solución probada a un problema **entre** componentes | ¿Cómo resuelvo que un pago no se cobre dos veces, o que una reserva a medias se deshaga? | Saga, outbox transaccional, idempotencia, circuit breaker, API Gateway… (sección 4) |
| **Patrón de diseño** | Una solución probada a un problema **dentro** del código de un componente | ¿Cómo cambio PostgreSQL por memoria en las pruebas sin tocar la lógica? | Repository, Adapter, Inyección de dependencias, Template method… (sección 5) |

Y **diseño** es cómo se organiza el código dentro de cada servicio (sección 6).

**Error común:** decir «el patrón de diseño del sistema es microservicios». Microservicios es un **estilo**. Un sistema no tiene
un único patrón de diseño: tiene varios, cada uno para un problema distinto.

---

## 2. Estilo arquitectónico

### 2.1 Cuál es

**Microservicios en capas con un bus de servicios empresarial (ESB).** Es un estilo **híbrido** que combina:

1. **Microservicios:** 9 servicios de negocio (MS.G), cada uno con su propia base de datos, que se despliegan por separado.
2. **Capas estrictas:** una petición siempre baja en el mismo orden: **entrada → respuesta → ESB → gestión**. Una capa solo habla
   con la de abajo.
3. **SOA / ESB:** toda la comunicación entre servicios de negocio pasa por un bus central que enruta, orquesta, compone y aplica
   reglas comunes. Esto viene de la arquitectura orientada a servicios (SOA), no de los microservicios «puros».
4. **Dirigido por eventos (en parte):** lo que no necesita respuesta inmediata (retrasos, reservas confirmadas, copias de
   catálogos) viaja como eventos por RabbitMQ.

### 2.2 Por qué este estilo y no otro

| Alternativa | Por qué no |
|---|---|
| **Monolito** (la V1) | Una falla o un despliegue afecta a todo. El reto pide integrar sistemas por varios protocolos y que Booking dependa de un contrato estable |
| **Microservicios «puros» (coreografía)**, cada servicio llama a los que necesite | Con 9 servicios aparecen dependencias cruzadas difíciles de seguir. Una compra que toca Offers, Bookings, Payment y CheckIn no tendría un dueño que la deshaga si falla |
| **Solo eventos** | La búsqueda, el hold y el pago necesitan una respuesta en el momento |

**Lo que se gana:**
- Los MS.G no se conocen entre sí. Cambiar uno no rompe a los demás (lo verifican las pruebas de arquitectura, regla 4).
- Las reglas que se repiten (timeouts, circuit breaker, idempotencia, correlation ID, token de servicio) están en **un solo
  lugar**: el ESB.
- Los procesos de varios pasos (sagas) tienen un dueño que los compensa.
- Booking solo ve el contrato v2 (`vuelos-openapi-v2.yaml`). Lo de adentro puede cambiar sin avisarle.

**Lo que cuesta (es honesto decirlo):**
- El ESB es un **punto central**: si cae, cae todo. Se mitiga con health checks, reinicio automático y el diseño sin estado (lo que
  importa está en su base de datos).
- Hay **un salto de red más** en cada petición (unos milisegundos).
- **Riesgo de «ESB gordo»:** que la lógica de negocio termine en el bus. La regla es que el ESB **coordina** pero no **decide**:
  los precios los calcula Offers y las reglas de reservas están en Bookings.

### 2.3 Cómo se llegó aquí: estrangulador (*strangler fig*)

La V2 reemplazó a la V1 por partes. La nueva API (`/api/v2`) creció al lado de la vieja, y cada operación se movió cuando su
versión nueva estuvo probada. Así Booking nunca se quedó sin servicio. Ver `PLAN/PLAN.md` §1.

---

## 3. Arquitectura

### 3.1 Capas y componentes

```
                Booking (B2B, REST)              Web y PWA (B2C, GraphQL + WebSocket)
                        │                                     │
 ENTRADA       ┌────────┴─────────── Gateway (NestJS) ────────┴─────────┐   REST /api/v2 + GraphQL /graphql
               │   valida JWT · rate limit · CORS · correlation ID      │   (Caddy delante: HTTPS)
               └──────────────────────────┬─────────────────────────────┘
 RESPUESTA     MS.Vuelos · MS.Reservas · MS.Postventa · MS.Clientes · MS.Admin       arman la respuesta del canal
                                          │  (solo hablan con el ESB)
 INTEGRACIÓN   ┌──────────────────────── ESB ───────────────────────────┐
               │ enrutador · orquestador de sagas · composición ·       │   REST · gRPC · SOAP · AMQP
               │ eventos entrantes · transversal (idempotencia, CB…)    │
               └──────────────────────────┬─────────────────────────────┘
 GESTIÓN       Identity · Schedule · Offers · Bookings · CheckIn · PostSale · FlightStatus · Webhooks · Customers
                (cada uno con su base PostgreSQL; nunca se llaman entre sí)
 EXTERNOS      Payment API (pagos) · Booking (webhooks, referencias de pago)
 SOPORTE       RabbitMQ (eventos) · PostgreSQL · OpenTelemetry Collector → Tempo / Prometheus / Loki → Grafana
```

El diagrama completo está en `arquitectura-microservicios-v6.png` y en `ARQUITECTURA.md` §2.

### 3.2 Responsabilidad de cada capa

| Capa | Hace | No hace |
|---|---|---|
| **Gateway** (`services/gateway`) | Punto de entrada único: valida el token, limita la tasa, pone el correlation ID, traduce GraphQL a llamadas REST, mantiene las suscripciones WebSocket | Reglas de negocio; llamar al ESB o a un MS.G |
| **MS de respuesta** (`services/respuesta/*`) | Arman la respuesta para el canal (formato del contrato v2, enlaces, mensajes), validan la entrada y revisan permisos por *scope* | Guardar datos; hablar con un MS.G |
| **ESB** (`services/esb`) | Enruta, orquesta sagas, compone respuestas de varios MS.G, recibe eventos, aplica reglas comunes | Decidir reglas de negocio |
| **MS.G** (`services/gestion/*`) | Las reglas de negocio y los datos de su dominio | Llamar a otro MS.G |

### 3.3 Protocolos y por qué cada uno

| Protocolo | Dónde | Por qué |
|---|---|---|
| **REST + JSON (OpenAPI)** | Booking → gateway; entre capas; ESB → la mayoría de los MS.G | Estándar, fácil de documentar y de probar; es lo que pide el contrato de grupo |
| **GraphQL** (+ WebSocket `graphql-ws`) | Web → gateway | La web pide exactamente los campos que dibuja, en una sola consulta; las suscripciones empujan cambios (T-5) |
| **gRPC (proto)** | ESB → MS.G.Offers | Búsqueda y precios: lo más llamado del sistema. Es binario, tipado y rápido |
| **SOAP (WSDL)** | ESB → MS.G.PostSale | Integra un estilo de servicio heredado, como piden los requisitos del reto |
| **AMQP + CloudEvents** (RabbitMQ) | Eventos entre el ESB y los MS.G | Lo que no necesita respuesta inmediata; desacopla en el tiempo; formato estándar de evento |
| **Webhooks firmados (HMAC)** | MS.G.Webhooks → Booking | Avisarle a Booking de un cambio sin que tenga que preguntar |

Cada contrato está en `contract/` y las pruebas validan que el código lo cumpla.

### 3.4 Datos

- **Una base por servicio** (*database per service*): cada MS.G tiene la suya y nadie más la lee.
- **Copias de lectura:** Offers guarda una copia del catálogo de aeropuertos, tipos de avión y precios, que le llega por eventos de
  Schedule. Así una búsqueda no tiene que llamar a otro servicio.
- **Dinero:** siempre en centavos enteros (`packages/shared/src/domain/money.ts`), nunca en decimales de punto flotante.
- **Modelo conceptual:** `modelo-conceptual-v6.png`: catálogos de aeropuertos y tipos de avión, tarifa base y precio por ruta (en Schedule) y sus copias en Offers.

### 3.5 Despliegue

Una VM de Azure (B2pls_v2, ARM64, 4 GB) con **Docker Compose**. Caddy da HTTPS; solo están abiertos 80/443 y SSH desde IP
permitidas. La web va en Azure Static Web Apps. El presupuesto es el crédito de estudiante (US$ 90): por eso es una sola VM y
no Kubernetes.

---

## 4. Patrones de integración y de microservicios

Para cada uno: **qué es**, **dónde está** y **por qué se usa**.

### 4.1 API Gateway
- **Qué:** una sola puerta de entrada que oculta los servicios internos.
- **Dónde:** `services/gateway` (`rest/`, `graphql/`), con Caddy delante.
- **Por qué:** Booking y la web ven una sola URL, un solo contrato y un solo control de seguridad (JWT, rate limit, CORS).

### 4.2 Backend for Frontend (BFF)
- **Qué:** una capa que arma la respuesta pensada para un canal.
- **Dónde:** los 5 MS de respuesta, más el GraphQL del gateway para la web.
- **Por qué:** Booking necesita el formato exacto del contrato v2; la web necesita otros campos. La lógica del canal no ensucia los
  MS.G.

### 4.3 Enrutador basado en contenido (*Content-based router*)
- **Qué:** decide a qué servicio va un mensaje según su contenido o su ruta.
- **Dónde:** `services/esb/src/router/routes.ts` (la tabla) y `router.service.ts`.
- **Por qué:** los MS de respuesta no saben dónde vive cada MS.G. La tabla se publica en `esb.openapi.yaml` y una prueba
  comprueba que sean iguales.

### 4.4 Saga orquestada con compensación
- **Qué:** un proceso de varios pasos en servicios distintos, sin transacción global. Si un paso falla, se **deshacen** los
  anteriores en orden inverso (compensación).
- **Dónde:** `services/esb/src/sagas/engine.ts` (el motor), `booking-sagas.ts` y `operations-sagas.ts` (las 11 sagas).
- **Detalles:**
  - Cada paso guarda su resultado: si el ESB se reinicia a la mitad, la saga sigue donde quedó y no repite pasos.
  - La compensación se registra **antes** de ejecutar el paso. Si el paso vence por tiempo (no se sabe si se hizo), igual se
    compensa, y cada compensación es segura aunque el paso no haya ocurrido.
  - **Punto de no retorno** (`pointOfNoReturn()`): después de cobrar, un fallo ya no se deshace. Se **reintenta** (2 s, 10 s,
    30 s, 2 min, 10 min, 30 min), porque devolver un pago cobrado es peor que terminar la emisión un poco tarde.
- **Por qué orquestada y no coreografiada:** hay un dueño claro del proceso que sabe en qué paso va y qué deshacer. Con
  coreografía, cada servicio reacciona a eventos y nadie tiene la foto completa.

### 4.5 Outbox transaccional
- **Qué:** el evento se guarda en la **misma transacción** que el cambio de datos, en una tabla `outbox`. Otro proceso (el
  *relay*) lo publica después en RabbitMQ.
- **Dónde:** `packages/shared/src/bus/outbox.ts` (`OutboxRelay`) y las tablas `outbox` de cada servicio.
- **Por qué:** sin esto podría pasar que se guarda la reserva y se cae antes de publicar el evento (Booking nunca se entera), o
  que se publica y la transacción falla (se avisa de algo que no ocurrió).

### 4.6 Consumidor idempotente y clave de idempotencia
- **Qué:** repetir la misma operación produce el mismo resultado que hacerla una vez.
- **Dónde:**
  - `Idempotency-Key` en las operaciones que crean o cobran: `services/esb/src/transversal/idempotency.service.ts`.
  - Eventos entrantes: la tabla `inbound_events` (`services/esb/src/inbound/`) descarta los repetidos.
- **Por qué:** en redes reales los reintentos son normales. Sin esto, un reintento de Booking por timeout **cobraría dos veces**.

### 4.7 Circuit breaker
- **Qué:** tras 5 fallas seguidas de un servicio, se deja de llamarlo durante 10 s y se responde 503 al instante. Después se deja
  pasar una llamada de prueba.
- **Dónde:** `packages/shared/src/clients/circuit-breaker.ts`. Su estado aparece en `/health`.
- **Por qué:** si un MS.G se cae, que no arrastre a los demás con peticiones colgadas. Un error de negocio (4xx) no cuenta como
  falla: el servicio sí respondió.

### 4.8 Timeout y reintento con espera creciente
- **Qué:** cada llamada tiene un plazo; los trabajos de fondo se reintentan con esperas cada vez más largas.
- **Dónde:** los clientes del ESB (`services/esb/src/clients/`) y `RETRY_DELAYS_MS` en el motor de sagas.
- **Por qué:** lo pide el contrato v2 §7, y evita martillar a un servicio que se está recuperando.

### 4.9 Composición de APIs (*API composition*)
- **Qué:** una respuesta que necesita datos de varios servicios la arma uno solo, que los consulta y los une.
- **Dónde:** `services/esb/src/composition/` (itinerario, postventa, salud del sistema, «Recorrido»).
- **Por qué:** evita que el MS de respuesta haga varias llamadas, y que un MS.G llame a otro.

### 4.10 Transferencia de estado por eventos (*event-carried state transfer*)
- **Qué:** el evento lleva los datos (no solo «algo cambió»), y quien lo recibe guarda su propia copia.
- **Dónde:** Schedule publica aeropuertos, tipos de avión y precios; Offers los guarda en `airport_catalog`,
  `aircraft_type_catalog` y `pricing_settings`.
- **Por qué:** la búsqueda (lo más usado) no depende de que Schedule esté arriba.

### 4.11 Publicar / suscribir
- **Qué:** quien publica no sabe quién escucha.
- **Dónde:** RabbitMQ con CloudEvents (`packages/shared/src/bus/amqp.ts`, `cloudevents/`); las suscripciones GraphQL de la web.
- **Por qué:** agregar un consumidor nuevo (por ejemplo Webhooks) no obliga a cambiar al que publica.

### 4.12 Correlation ID y trazas distribuidas
- **Qué:** un identificador que acompaña a la petición por todos los servicios y protocolos.
- **Dónde:** `packages/shared/src/correlation/` (HTTP, gRPC, AMQP, SOAP) y OpenTelemetry (`telemetry/`).
- **Por qué:** cuando algo falla, se puede seguir el proceso completo. Es la base de la búsqueda por correlation ID, el
  «Recorrido» y el mapa en vivo.

### 4.13 Seguridad entre servicios: tokens de servicio y JWKS (D44 y D46)
- **Qué:**
  - Cada servicio se autentica con su propio token (`client_credentials`) emitido por Identity.
  - Los tokens se firman con RS256, y quien los verifica descarga la clave pública desde el JWKS de Identity.
- **Dónde:** `packages/shared/src/clients/service-token.ts`, `auth/jwt.ts`, `auth/service-token.guard.ts`.
- **Por qué:** **confianza cero**: estar dentro de la red no basta. Por eso MS.Postventa llama a Identity: no es un atajo de
  negocio, es para obtener su token y la clave pública.

### 4.14 Health check
- **Qué:** `/health` en cada servicio, con el estado de su base y de sus circuitos.
- **Dónde:** `packages/shared/src/health/`; Docker los usa para reiniciar lo que se cae.

### 4.15 Problem Details (RFC 9457)
- **Qué:** todos los errores tienen el mismo formato: `type`, `title`, `status`, `code` y `correlationId`.
- **Dónde:** `packages/shared/src/problem-details/` (excepción y filtro).
- **Por qué:** Booking maneja los errores de una sola forma, y nunca se filtra un detalle interno.

---

## 5. Patrones de diseño en el código

| Patrón (tipo) | Qué resuelve | Dónde |
|---|---|---|
| **Inyección de dependencias** | Una clase recibe lo que necesita en vez de crearlo; así se puede cambiar en pruebas | Todo NestJS: `@Injectable`, `providers`, tokens como `BOOKINGS_STORE` o `TOKEN_VERIFIER` |
| **Repository** | Separar la lógica de negocio de cómo se guardan los datos | `repositories/*.store.ts` (interfaz) con `in-memory.store.ts` y `postgres.store.ts` en cada MS.G |
| **Strategy** | Elegir la implementación al arrancar | `app.module.ts`: con `DATABASE_URL` se usa PostgreSQL, sin ella memoria; el verificador de tokens por JWKS o una clave fija en pruebas |
| **Módulo dinámico / Factory** | Configurar un módulo con parámetros | `XxxModule.register(config, options)` en cada servicio |
| **Template method** | Todos los servicios arrancan igual; cada uno solo agrega lo suyo | `EcoServiceModule` y `configureService` en `packages/shared/src/service/service.ts`; `respuesta/app.ts` para los MS de respuesta |
| **Adapter** | Ocultar el protocolo detrás de una interfaz simple | Los clientes del ESB: `offers.client.ts` (gRPC), `post-sale.client.ts` (SOAP), `rest.client.ts`, `payment-api.client.ts` |
| **Facade** | Un punto simple delante de algo complejo | `esb-client.ts` de los MS de respuesta (una función por operación del ESB); el gateway frente a todo el sistema |
| **Chain of responsibility** | Una petición pasa por una cadena de filtros, y cada uno puede cortarla | El ciclo de NestJS: middleware (correlation ID) → guard (token, scopes) → pipe (validación) → controlador → filtro de excepciones (Problem Details) |
| **Decorator** | Agregar comportamiento sin tocar la clase | Los decoradores de Nest (`@Controller`, `@UseGuards`, `@Roles`) y los de validación de los DTO |
| **Observer** | Avisar a varios interesados de un cambio | Las suscripciones GraphQL, el sondeo compartido de T-5 (un solo sondeo para todos los suscriptores) y los consumidores de RabbitMQ |
| **Proxy** | Controlar el acceso a otro objeto | El circuit breaker envuelve cada cliente; el caché de JWKS |
| **State** | El comportamiento cambia según el estado | El circuit breaker (CERRADO, ABIERTO, MEDIO ABIERTO); los estados de reserva y de saga |
| **Unit of Work** | Varios cambios en una sola transacción | Los `postgres.store.ts`: el cambio y su fila de `outbox` en la misma transacción |
| **DTO** | Separar lo que entra o sale por la red del modelo interno | `http/dto.ts` en cada servicio, validados con class-validator |
| **Value object** | Valores que se comparan por su contenido y se validan al crearse | Dinero en centavos, códigos IATA, `passenger-counts.ts` |

---

## 6. Diseño interno de cada servicio

Todos los MS.G siguen la misma estructura (ejemplo: `services/gestion/ms-g-bookings/src/`):

```
config/config.ts           variables de entorno → configuración tipada (falla al arrancar si falta algo en producción)
domain/model.ts            tipos del dominio (Booking, Passenger…)
domain/rules.ts            reglas puras, sin red ni base (fáciles de probar)
http/*.controller.ts       recibe HTTP, aplica guards y valida; no tiene lógica de negocio
http/dto.ts                lo que entra y sale, con validación
services/*.service.ts      casos de uso: orquesta reglas y repositorio
repositories/*.store.ts    interfaz del repositorio
repositories/in-memory…    implementación para pruebas y desarrollo
repositories/postgres…     implementación de producción
app.module.ts              une todo (inyección de dependencias)
main.ts · telemetry.ts     arranque y OpenTelemetry
```

Es una **arquitectura en capas dentro del servicio**, cercana a la arquitectura **hexagonal** (puertos y adaptadores): el dominio no
conoce HTTP ni PostgreSQL. El controlador y el repositorio son adaptadores, y la interfaz del repositorio es el puerto. Por eso se
pueden probar 540 casos de integración sin una base real (`Pruebas.md` §3).

**Principios aplicados:**
- **Responsabilidad única:** cada servicio tiene un dominio, y cada archivo una tarea.
- **Inversión de dependencias:** el servicio depende de la interfaz del repositorio, no de PostgreSQL.
- **Contrato primero:** primero se escribe el contrato (OpenAPI, proto, WSDL, GraphQL, AsyncAPI) y después el código; las pruebas
  validan que el código lo cumpla.
- **Librería compartida sin lógica de negocio:** `packages/shared` solo tiene piezas técnicas (autenticación, bus, errores,
  telemetría, plantilla). La regla 2 de las pruebas de arquitectura impide que dependa de un servicio.

---

## 7. Cómo se verifica que se cumpla

Las reglas del diseño no son solo documentación: **las pruebas las comprueban** (`tests/arquitectura-v2/arquitectura.spec.ts`):

| Regla | Qué comprueba |
|---|---|
| 1 | Un servicio no importa el código de otro ni sale de su paquete |
| 2 | La librería compartida (`packages/shared`) no depende de ningún servicio |
| 3 | Nadie depende del monolito V1 |
| 4 | Un MS.G nunca llama a otro MS.G (ni nombra su host) |
| 5 | Solo Offers, Webhooks y el ESB hablan con Booking |
| 6 | Un MS de respuesta solo habla con el ESB (no nombra un MS.G, no usa gRPC, SOAP ni una base de datos) |
| 7 | El gateway solo habla con los 5 MS de respuesta |
| 8 | Todo pool de PostgreSQL se crea con `guardPool` (una conexión que la base corta no tumba el servicio) |

Cada regla tiene además un caso sintético que comprueba que la prueba **sí detecta** la violación.

Además, la tabla del enrutador se compara con su contrato publicado, y cada respuesta se valida contra su contrato. Detalle en
`Pruebas.md` §3.

---

## 8. Pendientes de este documento

- Si cambian las tablas o los servicios, generar una v7 de los diagramas (`PLAN/scripts/*_v6.py` como base) y reemplazar aquí la v6.
- Si se cambia la estrategia de despliegue (`Pruebas.md` §10), actualizar la sección 3.5.
