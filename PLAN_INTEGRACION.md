# PLAN DE INTEGRACIÓN — EcoAirlines frente a la guía de despliegue de otro equipo

Revisión del **03/11/2026** de `PLAN_DESPLIEGUE_UNA_APP_GENERAL.md`: qué pide, si EcoAirlines lo cumple y, cuando no, cómo se
haría el cambio. **No se modificó nada**: este documento es solo el análisis y el plan. Cada cambio se implementa por separado,
con la aprobación del responsable (flujo de `CAMBIOS.md`).

---

## 1. Qué es esa guía

Es la guía de despliegue de **otro equipo** (vertical *Atracciones*): su repositorio tiene `tools/launcher.mjs`, `partner-api`,
bases `ms_catalog`/`ms_location`, vouchers y rutas `/api/v3/atracciones`. Nada de eso existe en el nuestro.

Tiene dos tipos de contenido, y hay que separarlos:

| Tipo | Ejemplos | ¿Nos obliga? |
|------|----------|:------------:|
| **Cómo hospeda ese equipo su sistema** | Una App Service B1 con un lanzador, PostgreSQL Flexible, CloudAMQP, perfil de publicación | **No**: cada equipo hospeda como quiera (decisión del 03/11); nosotros usamos una VM con Docker Compose |
| **Cómo se integra cualquier nodo con Booking** | X-API-Key, broker central `booking.events`, stock por REST, identidad del nodo, health, reporte | **Probablemente sí**: es lo que Booking espera de todos |

---

## 2. ¿Cumplimos?

Leyenda: ✅ cumple · 🟡 parcial o por confirmar · ❌ no cumple.

### 2.1 Hospedaje (no obligatorio; se compara para entender la diferencia)

| Lo que hace la guía | Lo que hacemos | Estado |
|---------------------|----------------|:------:|
| Todos los servicios en **una** App Service B1 (1,75 GB) | Todos en **una** VM B2pls_v2 (4 GiB) con Docker Compose | ✅ Equivalente |
| Cada servicio es un proceso con su puerto y su base | Cada servicio es un contenedor con su puerto, su base y su usuario | ✅ |
| Solo el Gateway es público | Solo Caddy (80/443) → gateway; ESB, MS, PostgreSQL y RabbitMQ no salen de la VM | ✅ |
| HTTPS obligatorio, TLS 1.2 | HTTPS con Let's Encrypt (Caddy); TLS 1.2+ por defecto | ✅ |
| Reinicia procesos caídos | `restart: unless-stopped` + healthchecks con `start_period` | ✅ |
| **Always On** (encendido siempre) | La VM se apaga sola a las **23:00** de Ecuador | 🟡 Ver I-2 |
| Secretos solo en la configuración de la app | Secretos solo en `infra/cloud/.env` (fuera del repositorio) | ✅ |
| Despliegue con GitHub Actions | `desplegar.sh` compila en la VM; GitHub Actions en pausa (decisión del responsable) | 🟡 Aceptado |
| Vigilar la memoria del plan | Prometheus, Grafana y alertas en la VM | ✅ |

### 2.2 Integración con Booking (lo que importa)

| # | Lo que espera Booking (según la guía) | Lo que tenemos | Estado |
|---|---------------------------------------|----------------|:------:|
| A | **Identidad del nodo** asignada por Booking (`NODE_CODE`) | El stock va con `NODE_VUE_EQ5`, pero `GET /vuelos/health` responde `nodo_id: NODE_VUE_ECOAIRLINES` | 🟡 Ver I-1 |
| B | **Stock por REST** a Booking | `POST https://booking-core-api.azurewebsites.net/api/v2/inventory/stock`: respondió `success: true`; 736 envíos sin errores | ✅ |
| C | URL del stock `https://booking-puce.eastus.cloudapp.azure.com/api/v3/inventory/stock` | **Esa dirección no existe** (sondeo del 03/11: sin respuesta DNS). La que Booking nos dio responde en `/api/v2` **y** en `/api/v3` | 🟡 Ver I-6 |
| D | **X-API-Key**: Booking se identifica ante el nodo con una clave, y el nodo la envía al reportar stock | Booking se identifica con **OAuth2 `client_credentials`** (lo exige nuestro contrato v2). No aceptamos `X-API-Key`; el stock va sin clave y Booking lo acepta | ❌ Ver I-3 |
| E | **Broker central de la clase** (`amqps://…`, exchange `booking.events`, claves `<prefijo>.booking.*`) | El ESB **ya sabe escuchar** `booking.events` (`BOOKING_BUS_URL`, para `payment.*` y `package.cancelled`), pero **está apagado** (no tenemos la URL). **No publicamos** nuestros eventos ahí: van por webhook firmado | 🟡 / ❌ Ver I-4 |
| F | Rutas **`/api/v3/...`** | Tenemos `/api/v2/vuelos/...` (contrato v2 del grupo, sin cambios) | ❓ Ver I-5 |
| G | **Health** con semáforo (UP/DEGRADED/DOWN) y tiempos (sano < 1,5 s; caído > 4,5 s) | `GET /api/v2/vuelos/health`: `HEALTHY`/`DEGRADED`/`DOWN` como pide el contrato v2, servido desde caché en < 1 s | ✅ |
| H | `Idempotency-Key` en reservas, cancelación y check-in | En las 11 operaciones que lo piden (reservas, boletos, asientos, check-in, maletas, cambio de fecha, cancelación, holds, webhooks, estado de vuelo y promociones) | ✅ |
| I | **Reporte a Booking** con URL base, health y un ítem de prueba; la clave por privado | Se puede armar hoy (ver §4) | ✅ |

**En resumen:** el hospedaje no tiene que ser igual y lo nuestro es equivalente. En la integración cumplimos el stock, el health y
la idempotencia. Quedan **cuatro puntos abiertos**: la identidad del nodo en el health (A), la X-API-Key (D), el broker central (E)
y la versión de la API (F). Los tres últimos dependen de lo que Booking confirme: la guía es de otro equipo y algunas de sus
direcciones ya no existen (C).

---

## 3. Plan de cambios

Ordenados por prioridad. Cada uno dice **cuándo** hacerlo, **qué** cambia, **cómo** se prueba y su **costo**. Ninguno modifica los
contratos del grupo (`vuelos-openapi-v2.yaml`, `booking-inventory.proto`).

### I-1 — Health con la identidad del nodo `NODE_VUE_EQ5` (recomendado ya)

- **Por qué:** el stock y el health deben decir lo mismo; si Booking los cruza, hoy no nos reconoce.
- **Cambios:** la constante `NODE.nodo_id` en `services/esb/src/composition/health.service.ts` y en
  `services/respuesta/ms-vuelos/src/service.ts`, ambas desde una variable `NODE_ID` (por defecto `NODE_VUE_EQ5`). Revisar si
  `PROMOTIONS_PROVIDER_CODE` (`proveedor_codigo` del acuerdo de promociones, MS.G.Schedule) también debe cambiar: preguntarlo a
  Booking. Ajustar las pruebas que esperan `NODE_VUE_ECOAIRLINES` (`esb.spec.ts`, `vuelos.spec.ts`).
- **Prueba:** `npm test`; en la nube, `curl …/api/v2/vuelos/health` → `"nodo_id":"NODE_VUE_EQ5"`.
- **Costo:** US$0. Un despliegue (~30 min de VM compilando).

### I-2 — Disponibilidad durante las pruebas integradas

- **Por qué:** la guía usa *Always On*; Booking nos ve `DOWN` cuando la VM está apagada.
- **Cambio (sin código):** en las semanas de pruebas con Booking, `az vm auto-shutdown -g rg-ecoairlines-reto2 -n
  vm-ecoairlines-reto2 --off`, y volver a ponerlo (`--time 0400`) al terminar.
- **Costo:** ≈US$0,80 por día encendida (≈US$24,50/mes de VM + ≈US$6/mes de disco e IP). Con US$90 de crédito, ~3 meses. Avisar a
  Booking del horario si se mantiene el apagado.

### I-3 — Aceptar `X-API-Key` de Booking (solo si Booking lo confirma)

- **Por qué:** la guía (y la ficha de TourGirls) muestran que Booking llama a los nodos con `X-API-Key`. Nuestro contrato v2 pide
  OAuth2; si Booking solo sabe mandar la clave, sus llamadas protegidas fallarían con `401`.
- **Diseño (sin romper OAuth2):** la clave se **canjea** por el mismo token de partner que ya usamos. Así los MS de respuesta, los
  scopes, el dueño (`partner:<client_id>:<X-User-Id>`) y las pruebas no cambian.
  1. **MS.G.Identity:** guardar el **hash** de una API key por partner (columna `api_key_hash` en `partner_clients`), con una
     operación para emitirla o rotarla (se muestra una sola vez) y otra que valida una clave y devuelve el token de partner.
     Actualizar `contract/ms-g-identity.openapi.yaml` (nuestro, no del grupo).
  2. **Gateway:** si llega `X-API-Key` sin `Authorization`, la canjea en Identity (vía MS.Clientes → ESB, respetando las capas) y
     guarda el token en memoria hasta que venza. Una clave inválida responde `401` con `ProblemDetails`.
  3. **Web de administración (Partners):** botón «Emitir API key», como «Rotar secreto».
  4. **Stock:** si Booking pide la clave también al reportar stock, enviar la cabecera `X-API-Key` desde Offers
     (`BOOKING_API_KEY` en `infra/cloud/.env`).
- **Pruebas:** canje correcto, clave inválida o bloqueada (`401`), scopes iguales a los del token, la clave nunca aparece en logs;
  regla de arquitectura intacta.
- **Costo:** US$0. Es la fase más grande de este plan (~1 día).

### I-4 — Broker central `booking.events` (solo con la URL que entregue Booking)

- **Recibir (ya implementado):** poner `BOOKING_BUS_URL=amqps://…` en `infra/cloud/.env` y redesplegar el ESB. Escucha
  `pagos.payment.confirmed`, `pagos.payment.failed` y `paquetes.package.cancelled`, con las mismas 4 capas contra duplicados
  (`EVENTOS.md` §5). **Verificar** con Booking que sus claves de enrutamiento sean esas; si usan otras, es un cambio de una línea
  en `services/esb/src/inbound/inbound-event.ts`.
- **Publicar (nuevo):** nuestros eventos públicos (los mismos de los webhooks: `booking.confirmed`, `booking.cancelled`,
  `flight.status_changed`…) al exchange `booking.events` con la clave `<prefijo>.booking.<evento>`.
  - **Dónde:** en **MS.G.Webhooks**, como un segundo canal de entrega además del webhook HTTP. Ahí ya está el filtro de D40
    (Booking solo recibe sus reservas y los vuelos) y el historial de entregas.
  - **Configuración:** `BOOKING_BUS_URL` y `BOOKING_BUS_PREFIX` (p. ej. `ecoairlines` o `eq5`, a confirmar con Booking).
  - El CloudEvent no cambia: mismo `type`, `correlationid` y datos.
- **Pruebas:** con un RabbitMQ local como si fuera el broker central: publicar `payment.confirmed` y ver la saga; reservar desde
  Booking y ver `ecoairlines.booking.confirmed` en la cola; un evento de una reserva de la web **no** se publica.
- **Costo:** US$0 si el broker es de la clase. Si hubiera que crear uno propio, CloudAMQP tiene un plan gratuito.

### I-5 — Rutas `/api/v3` (solo si Booking publica un contrato v3 de Vuelos)

- **Hoy:** el contrato del grupo para Vuelos es el **v2** (`contract/vuelos-openapi-v2.yaml`); la guía usa v3 porque es de otra
  vertical. Booking aceptó nuestro stock en `/api/v2`.
- **Si llega un v3 de Vuelos:**
  1. Guardarlo sin cambios en `contract/` y compararlo con el v2.
  2. Si solo cambia el prefijo, el gateway publica las mismas operaciones también en `/api/v3/vuelos/...`.
  3. Si cambian los schemas, es una fase nueva, como V2.1–V2.13, con su suite de conformidad.
- **Costo:** desde unas horas (alias) hasta varios días (contrato distinto).

### I-6 — URL del stock

- **Hoy:** `https://booking-core-api.azurewebsites.net/api/v2/inventory/stock` funciona. La de la guía
  (`booking-puce.eastus…/api/v3`) no existe.
- **Si Booking pide v3:** cambiar solo `BOOKING_STOCK_URL` en `infra/cloud/.env` a `…/api/v3/inventory/stock` y reiniciar
  `ms-g-offers`. No hay que tocar código: ese endpoint ya responde igual.

### I-7 — Mudarse a App Service, como la guía (no recomendado)

- **Por qué no:** B1 tiene 1,75 GB y nuestro sistema usa ≈2,2 GiB solo en contenedores, sin contar la observabilidad. Habría que
  reescribir el arranque (un lanzador en vez de Docker Compose), pagar PostgreSQL Flexible aparte y contratar RabbitMQ. Costo
  aproximado, a verificar con la API de precios antes de decidir: plan B1 (≈US$13/mes) + PostgreSQL B1ms (≈US$15/mes) ≈ US$28/mes,
  sin observabilidad, frente a ≈US$12–30/mes de la VM con todo.
- **Cuándo reconsiderarlo:** solo si Booking exige una URL `*.azurewebsites.net` o *Always On* sin costo de VM.

---

## 4. Reporte a Booking (equivalente al Paso 8 de la guía)

```
📋 REPORTE DE INTEGRACIÓN - EcoAirlines (NODE_VUE_EQ5) · Vuelos
1. Búsqueda: POST /api/v2/vuelos/search (pública) — vuelos UIO, GYE, BOG… hasta 92 días
2. Reservas con Idempotency-Key: SÍ (holds, reservas, boletos, asientos, check-in, maletas, cambio de fecha, cancelación)
3. Stock a Booking: SÍ, por REST a /api/v2/inventory/stock (success: true)
4. Broker central: listo para escuchar booking.events; falta su URL (y publicar, si lo piden)
5. Autenticación: OAuth2 client_credentials en /api/v2/oauth2/token (credenciales por canal privado)
URL base: https://ecoairlines-reto2.northcentralus.cloudapp.azure.com/api/v2
Health:   https://ecoairlines-reto2.northcentralus.cloudapp.azure.com/api/v2/vuelos/health
Horario:  la VM se apaga a las 23:00 (Ecuador) salvo en las semanas de pruebas acordadas
```

El `client_secret` **no** va en el reporte: se envía aparte por un canal privado.

---

## 5. Preguntas para Booking (antes de implementar I-3 a I-6)

1. ¿Para **Vuelos** sigue vigente el contrato **v2** con OAuth2 `client_credentials`, o ahora todos los nodos usan **X-API-Key**?
   Si es la clave, ¿la emiten ustedes o la emitimos nosotros, y también va al reportar stock?
2. ¿Cuál es la URL del **broker central** (`amqps://…`), qué **prefijo** nos toca y qué claves de enrutamiento usan para
   `payment.*` y `package.cancelled`? ¿Quieren que publiquemos ahí nuestros eventos, además o en lugar de los webhooks?
3. ¿Hay un contrato **v3 de Vuelos**, o el `/api/v3` es solo de otras verticales? ¿El stock lo enviamos a `/api/v2` o a `/api/v3`?
4. ¿El `nodo_id` del health debe ser `NODE_VUE_EQ5`? ¿Y el `proveedor_codigo` del acuerdo de promociones?
5. ¿En qué horario necesitan nuestro nodo encendido?

## 6. Orden recomendado

1. **Ahora:** I-1 (health con `NODE_VUE_EQ5`) y enviar las preguntas del §5 junto con el reporte del §4.
2. **Según las respuestas:** I-4 (el broker; recibir es solo configuración), I-3 (X-API-Key), I-6 (URL del stock).
3. **Solo si llega un contrato nuevo:** I-5.
4. **En las semanas de pruebas integradas:** I-2.
