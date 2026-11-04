# EcoAirlines — Reto 2: transición a microservicios

## Objetivo

Migrar el monolito modular del Reto 1 (API NestJS en 4 capas; **retirado en V2.21**, código en el commit `7cdd384` y documentos en
`historico/reto1/`) a una **arquitectura de microservicios**, por fases y sin romper lo que ya funciona, **integrarlo con Booking Prototipo según el contrato de Vuelos v2** (prioridad), e incorporar las mejoras de
administración, asistencia médica, pagos con tarjeta, observabilidad y PWA.

**El plan aprobado y el registro de decisiones están en `PLAN/PLAN.md`.** Antes de cualquier tarea:
1. Leer `PLAN/PLAN.md` (sobre todo la sección 6, fases, y la sección 7, decisiones D1–D53). Visión general: `ARQUITECTURA.md`.
2. Ubicar la fase en curso y trabajar **solo** en ella.
3. Si una tarea contradice una decisión registrada, señalarlo y pedir confirmación antes de cambiarla.

Los diagramas vigentes son `PLAN/modelo-conceptual-v4.png` y `PLAN/arquitectura-microservicios-v4.png`.

## Requisitos del ingeniero

- Al menos un microservicio en **gRPC**: **MS.G.Offers**.
- Al menos un servicio **SOA**: **MS.G.PostSale** (SOAP + WSDL + XSD).
- El resto en **REST**.
- **Todo debe quedar desplegado en la nube** (Azure u otra plataforma si hace falta).

## Arquitectura (resumen; detalle en `PLAN/PLAN.md`)

- **9 MS.G** (dueños de sus datos): Identity, Webhooks, Schedule, Offers (gRPC), FlightStatus, Customers, Bookings,
  PostSale (SOAP), CheckIn.
- **ESB** (NestJS): enrutador (un MS.G), orquestador de sagas (varios MS.G con compensación), composición (solo lectura) y
  entrada de eventos de Booking (sin duplicados).
- **5 MS de respuesta**: Vuelos, Reservas, Postventa y Clientes implementan las 30 operaciones del contrato v2 (cada una en su
  `x-microservice`); Admin, las funciones propias.
- **Gateway**: fachada REST **`/api/v2/vuelos/*`** (única entrada de Booking; no hay `/api/v1`), GraphQL en `/api/graphql`
  (única entrada de la web) y Swagger en `/api/docs`.
- **RabbitMQ** para eventos en formato **CloudEvents 1.0** (con *outbox*, reintentos y *dead letter*).
- **MS.G.Offers** envía el stock a Booking por gRPC (`inventory.InventoryStockService`) después de cada cambio.
- **Payment API simulada** (sistema externo): solo para el canal web; recibe la tarjeta directo del navegador.
- **Observabilidad** con OpenTelemetry. **Web** React como PWA.
- Lenguaje: **TypeScript** en todo. Framework: **NestJS**.

## Reglas de arquitectura

- Un MS.G **nunca llama a otro MS.G**. Solo el ESB los coordina.
- El ESB llama a los MS.G con su **token de servicio** (`token_use = service`); el dueño y el administrador viajan en
  `X-Owner-Id` y `X-Actor-Id`, que solo pone el ESB (D41).
- **Hacia Booking solo hablan** MS.G.Offers (stock por gRPC), MS.G.Webhooks (entrega de eventos) y el ESB (entrada de
  eventos). Ninguna operación de un cliente espera a Booking: si no responde, se reintenta en segundo plano.
- Si una operación toca **varios** MS.G, es una **saga** del orquestador, con compensación y estado en `saga_log`.
- **Una base de datos y un usuario de PostgreSQL por servicio.** Ningún servicio lee la base de otro.
- Entre servicios no hay claves foráneas: solo **referencias por id**.
- Los datos que un servicio necesita de otro con frecuencia se mantienen como **copia de lectura** publicada por el orquestador o
  por un evento (p. ej. `fare_prices` en Offers, `scheduled_flights` en FlightStatus).
- El código común va en `packages/shared`; no se copia entre servicios.
- Cada servicio conserva capas internas: entrada → reglas → repositorios → datos.

## Contratos (API-first)

- Los contratos se escriben **antes** que el código, uno por microservicio, en `contract/` con el formato
  `<servicio>.<formato>`: `ms-g-identity.openapi.yaml`, `ms-g-offers.proto`, `ms-g-post-sale.wsdl` + `.xsd`,
  `ms-admin.openapi.yaml`, `payment-api.openapi.yaml`, `gateway.graphql`, `events.asyncapi.yaml`, etc.
- **Fuente de verdad del grupo: `contract/vuelos-openapi-v2.yaml`** (contrato de Vuelos v2, 25/10/2026, con
  `contract/README-vuelos-v2.md`). El v1 (`vuelos-openapi.yaml`) queda como histórico.
- **No borrar ni modificar** los contratos existentes: `vuelos-openapi-v2.yaml`, `README-vuelos-v2.md`, `vuelos-openapi.yaml`,
  `ecoairlines-extensions.yaml`, `vuelos-graphql.yaml` y, cuando se agregue en V2.1, `booking-inventory.proto` (copia exacta
  del proto de Booking).
- Las **30 operaciones** de `vuelos-openapi-v2.yaml` se reparten entre los MS de respuesta según su `x-microservice`, **sin
  cambiar sus schemas**.
- Si se detecta una inconsistencia con el contrato del grupo: identificarla, explicarla, registrarla en `HALLAZGOS.md` (serie
  `BKG` para el contrato v2) y no modificar el contrato sin autorización.

## Reglas que se mantienen del Reto 1

- **DTOs** exactos al contrato: `required`, `enum`, `format`, `pattern`, límites, `additionalProperties`, `nullable`, `readOnly`.
- **Seguridad:** tokens firmados con **RS256** por MS.G.Identity y verificados con su **JWKS**: de usuario (web, scopes del rol)
  y de partner (Booking, OAuth2 `client_credentials`). El dueño (`ownerId`) sale **siempre del token**: el `sub` (web) o
  `partner:<client_id>:<X-User-Id>` (Booking; `X-User-Id` se lee **solo** con token de partner). Nunca del cuerpo. Un recurso
  ajeno responde `404`.
- **Roles:** solo CLIENTE y ADMIN, uno por usuario (no hay rol OPS; ADMIN tiene `flights:ops` y `flights:admin`). El registro
  público crea CLIENTE; solo un ADMIN crea administradores y partners.
- **Pagos:** la API de vuelos **no procesa tarjetas**; solo recibe `paymentReference`. **Canal Booking:** Booking ya cobró; se
  valida la referencia (formato, uso único, monto) y en cancelaciones solo se **calcula** el reembolso. **Canal web:** la
  tarjeta va del navegador a la Payment API simulada, que nunca guarda el número completo ni el CVV.
- **Sin duplicados:** nunca un cobro doble ni un asiento vendido dos veces: `Idempotency-Key` (24 h, `Idempotent-Replayed`,
  `IDEMPOTENCY_KEY_REUSED`) en el ESB, eventos entrantes deduplicados por `id`, sagas idempotentes, referencia de pago única y
  cambio de estado de asiento atómico en Offers.
- **Correlation ID:** `X-Correlation-Id` (todo el proceso, lo crea Booking o nuestro gateway) **nunca se cambia** y es distinto
  de `X-Request-Id` (un salto). Viaja por HTTP, gRPC (`x-correlation-id`), SOAP (`<soap:Header>`) y RabbitMQ
  (`correlation_id` + `correlationid` del CloudEvent); se devuelve en cada respuesta, error y evento.
- **Errores:** `ProblemDetails` del contrato v2 en todas partes (con `instance`, `correlation_id`, `timestamp`). Los errores
  gRPC y `SOAP Fault` se traducen a `ProblemDetails` sin perder el `code`.
- **Datos sensibles:** tokens, datos de pago y la asistencia médica (dato de salud) nunca aparecen en logs, trazas, webhooks
  externos ni en la caché de la PWA. A Booking no se le notifican las reservas de nuestra web (solo el stock).

## Flujo de trabajo

1. Cada fase se **propone, se aprueba y solo después se implementa**. Lo que no está en el plan no se hace.
2. Antes de modificar varios archivos: explicar qué se modifica, por qué y qué parte del plan o del contrato se implementa.
3. Trabajar en una rama `feature/...`. **Commit, push o merge solo cuando el responsable lo pida.**
4. Después de cada fase ejecutar: tipos, lint, pruebas unitarias, e2e (incluidas las de conformidad con el contrato) y, si hay
   interfaz, prueba en el navegador.
5. Registrar cada fase en `CAMBIOS.md` (qué se pidió, cómo se hizo, cómo se verificó) y marcar su estado en `PLAN/PLAN.md`.
6. Gemini audita según `GEMINI.md`; el responsable aprueba antes de pasar a la siguiente fase.
7. No reemplazar la arquitectura por algo más simple para ahorrar trabajo.

## Forma de trabajo con el responsable

- El objetivo es **aprender**: si una propuesta del responsable es incorrecta o tiene un problema, decirlo con claridad y
  explicar por qué; si es correcta, reconocerlo y corregir. No aceptar ni rechazar sin fundamento.
- Escribir en **español**, con un lenguaje claro y sin jerga innecesaria.
- Recomendar una opción concreta cuando haya que decidir, y registrar la decisión en `PLAN/PLAN.md` (sección 7).

## Convenciones de los diagramas

- Se generan con scripts (matplotlib) guardados en `PLAN/scripts/`, y las imágenes en `PLAN/`. Cada versión nueva se guarda como archivo aparte (`-v2`, `-v3`…);
  las anteriores no se borran.
- **Cada línea conserva el color de su grupo**: azul = enrutador, naranja = saga, verde punteado = composición, morado
  punteado = eventos, marrón punto-raya = integración con Booking, gris = gateway y clientes. Lo nuevo se marca solo en el borde o el texto de los recuadros.
- Las líneas son ortogonales y **nunca pasan por encima de un servicio o una tabla**; solo pueden cruzar otras líneas.
- En eventos, la flecha **hacia** el bus significa publicar y **desde** el bus, consumir.
- Modelo de datos: línea continua = FK dentro del servicio; punteada = referencia por id entre servicios (`ref`).

## Comandos del Reto 2

- `npm run test:v2` — pruebas de `packages/`, `services/` y la prueba de arquitectura v2.
- `npm run test:conformidad-v2` — suite de conformidad con el contrato v2 (con `CONFORMANCE_BASE_URL` prueba un servidor; el
  gateway local es `http://localhost:8088/api/v2`).
- `npm run infra:up` / `npm run infra:down` — entorno local en Docker (PostgreSQL, RabbitMQ, Collector y servicios).
- Publicar el horario y los precios: saga del ESB `POST http://localhost:4000/sagas/timetable/publish` (con token de servicio y `X-Actor-Id` de un ADMIN). `node scripts/dev/publicar-horario.mjs` queda solo como respaldo de desarrollo: publica en Offers el horario y los precios de Schedule, y `schedule.published` en el bus (FlightStatus).
- Pruebas con PostgreSQL real (opcionales): `IDENTITY_TEST_DATABASE_URL`, `SCHEDULE_TEST_DATABASE_URL`, `OFFERS_TEST_DATABASE_URL`, `BOOKINGS_TEST_DATABASE_URL`, `CHECK_IN_TEST_DATABASE_URL`, `POST_SALE_TEST_DATABASE_URL`, `FLIGHT_STATUS_TEST_DATABASE_URL`, `WEBHOOKS_TEST_DATABASE_URL`, `ESB_TEST_DATABASE_URL` (ver cada `test/postgres.spec.ts`).
- Bus con RabbitMQ real (opcional): `BUS_TEST_URL=amqp://ecoairlines:dev-rabbitmq-solo-local@localhost:5672` (reintentos y cola de fallidos, `packages/shared/src/bus/bus.spec.ts`).
- ESB (V2.9): `http://localhost:4000` (contrato `contract/esb.openapi.yaml`). booking-simulado le envía sus eventos de pago y de combo (`POST http://localhost:4090/simulador/eventos`).
- MS de respuesta (V2.12): MS.Vuelos `5001`, MS.Reservas `5002`, MS.Postventa `5003`, MS.Clientes `5004`, MS.Admin `5005`
  (`http://localhost:500N/api/v2/...`). Usan el kit `packages/shared/src/respuesta/` (`ResponseServiceModule` + sus *handlers*):
  la validación, el dueño y la proyección salen del contrato. Solo llaman al ESB, con su propio token (D44).
- Gateway (V2.13): `http://localhost:8088` en el host (8080 dentro de Docker; Windows reserva el 8080): `/api/v2/vuelos/*`
  (REST del contrato v2), `/api/v2/oauth2/token` y `/oauth2/token`, `/api/graphql` (GraphQL y suscripciones graphql-ws) y
  `/api/docs` (Swagger). Solo llama a los 5 MS de respuesta, con el token del cliente (D46).
- Nube (V2.14, D48): VM `vm-ecoairlines-reto2` (grupo `rg-ecoairlines-reto2`, North Central US), URL
  `https://ecoairlines-reto2.northcentralus.cloudapp.azure.com`. Desplegar: `bash scripts/cloud/desplegar.sh <host>`; horario:
  `bash scripts/cloud/publicar-horario.sh <host>`; SSH por el **2222**. Límite: **US$90** de crédito; **preguntar antes de crear
  cualquier recurso con costo** y apagar la VM fuera de las pruebas (`az vm deallocate`). Guía: `DESPLIEGUE_AZURE.md`.
- Payment API simulada (V2.15): `http://localhost:4010` (claves de desarrollo `pk_test_dev_solo_local_ecoairlines_0001` y
  `sk_test_dev_solo_local_ecoairlines_0001`); en la nube, `/payment-api/` con claves propias. Prueba de PostgreSQL:
  `PAYMENT_TEST_DATABASE_URL=postgres://payment_svc:dev-payment@localhost:5432/payment`.
- Web (V2.17, D51): `ecoairlines-web` (`npm run dev`, siempre en el **5173**: es el origen que permiten el gateway y la
  Payment API). Solo habla con `/api/graphql` (`src/api/client.ts`) y con la Payment API (`src/api/payments.ts`);
  `tests/arquitectura-v2/web-graphql.spec.ts` valida sus documentos contra `contract/gateway.graphql`.
- Nube (V2.20): la verificación de despliegue mira el log de `desplegar.sh`, no solo su salida; `CORS_ORIGINS` de `infra/cloud/.env` autoriza solo la web publicada.
- PWA (V2.19, D52): el service worker solo existe en producción (`npm run build` + `npm run preview -- --port 5173 --strictPort`) y
  guarda solo la aplicación: **nunca agregar `runtimeCaching`**. Lo que se usa sin conexión va en `src/lib/offline-trips.ts`, con lo
  mínimo para abordar. Actualizar la versión es decisión del cliente (recargar cierra la sesión).
- Observabilidad (V2.16, D50), en local: Prometheus `9090`, Alertmanager `9093`, Loki `3100`, Tempo `3200`, Grafana `3001`
  (`admin` / `dev-grafana-solo-local`).
- Recursos de la laptop: Docker limitado a 6 GB (`.wslconfig`). Compilar **de a una imagen** (`COMPOSE_PARALLEL_LIMIT=1`) y
  levantar solo lo que la fase necesita; los servicios declaran `depends_on: otel-collector`, así que con la observabilidad
  apagada se reinician con `docker compose up -d --no-deps <servicio>`. Detalle y hospedaje final: `PASOS_FINALES.md`.
- Cada servicio nuevo usa la plantilla de `packages/shared` (`EcoServiceModule.forRoot` + `configureService`) y declara en su
  `package.json` todas sus dependencias (la imagen Docker solo instala las suyas).

## Calidad

Preferir TypeScript estricto, interfaces claras, inyección de dependencias de NestJS, servicios pequeños, repositorios y adapters
para dependencias externas, y pruebas unitarias y e2e. Las implementaciones en memoria se permiten para pruebas, siempre detrás
de una interfaz que permita reemplazarlas sin cambiar los controllers ni los contratos.
