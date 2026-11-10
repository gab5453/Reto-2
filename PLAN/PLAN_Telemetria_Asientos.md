# PLAN — Asientos, retrasos, datos maestros administrables y telemetría en tiempo real

| | |
|---|---|
| Fecha | 09/11/2026 (reestructurado dos veces el mismo día) |
| Estado | **Todas las decisiones tomadas (D-T1 a D-T13, §8).** **Plan completo: T-1, R-1, P-1, T-2 (09/11), M-1, M-2, T-3, T-4 y T-5 (10/11) hechas**, desplegadas y verificadas (ver `CAMBIOS.md`) |
| Origen | (7) **precios** editables por paquete y $/km desde «Precios y promociones»; (1) Pedido de Booking sobre `SEAT_TAKEN` y el mapa de asientos; (2) ver en tiempo real cómo viaja un correlation ID, en un grafo; (3) error al buscar `corr-f488627d-…` con «Últimas 24 horas»; (4) tiempos en tierra y margen de ida y vuelta (caso Quito ⇄ Loja); (5) **retrasos**: que el administrador indique cuánto se atrasa un vuelo y se vea en su estado y su nueva hora (pedido de Booking); (6) crear aeropuertos y tipos de avión desde el panel |
| Qué NO cambia | El contrato del grupo (`vuelos-openapi-v2.yaml`): `SEAT_TAKEN`, los estados del mapa de asientos y los códigos de aeropuerto de 3 letras ya están en él |
| Costo | **US$0**: todo corre en la VM actual |

---

## 1. Pedido de Booking — verificación en la nube (09/11)

Se probó exactamente lo que hace Booking (`seat_taken_booking.mjs`): token de partner, búsqueda, hold y `POST /api/v2/vuelos/bookings`
por REST pidiendo el **15A del EA304 del 11/11**, ya vendido (reserva `X3J2U7`, boleto emitido).

### a) `SEAT_TAKEN` en `POST /vuelos/bookings` — ✅ cumple para Booking; ❌ falta «antes de cobrar» en nuestra web

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json; charset=utf-8

{"type":"about:blank","title":"El asiento 15A ya no está disponible.","status":409,"code":"SEAT_TAKEN",
 "instance":"/api/v2/vuelos/bookings","correlation_id":"corr-72fed8a8-…","invalidParams":[{"name":"seatNumber","reason":"15A en EA304-20261111"}]}
```

- **Lo que ya está bien:**
  - `409`, `application/problem+json` y `"code": "SEAT_TAKEN"`;
  - **no se crea la reserva:** Offers rechaza el asiento antes del paso que la crea, y el hold sigue vivo y se puede liberar;
  - en el canal Booking no cobramos (cobra Booking): se suelta el reclamo de su referencia de pago y Booking devuelve el dinero.
- **Mejora 1 — mensaje:** `title: "Asiento no disponible"` y
  `detail: "El asiento 15A del segmento EA304-20261111 ya fue tomado."`, como sugiere Booking. El `type` queda `about:blank`
  (`api.booking.local` es un dominio de ellos).
- **Mejora 2 — validar antes de cobrar en nuestra web:** hoy la saga «Crear reserva» hace
  `validar hold → validar pasajeros → CAPTURAR el cobro → registrar la referencia → consumir el hold (valida el asiento)`. En la web,
  si el asiento está tomado, el cobro ya se capturó y la compensación lo reembolsa. **Solución (D-T3):**
  - `ValidateHold` recibe también los asientos pedidos y responde `SEAT_TAKEN` **antes del pago**;
  - se mantiene la validación atómica al consumir el hold, para la carrera de milisegundos entre las dos (ahí sigue el reembolso);
  - la web, ante `SEAT_TAKEN`, quita el asiento, recarga el mapa (ya en gris) y deja elegir otro sin perder el hold.

### b) Mapa de asientos — ✅ ya cumple

Por REST, `GET /api/v2/vuelos/offers/EA304-20261111/seatmap?segmentId=EA304-20261111` devolvió **320 `AVAILABLE`/`true` y el 15A
`TICKETED`/`false`**. Cada asiento vendido sale con su estado real (`BOOKED`, `TICKETED`, `CHECKED_IN`, `BOARDED`). Matiz para
Booking: si una cabina se queda sin cupos por holds o reservas sin número de asiento, los libres salen `HELD` (también `false`,
gris). Solo se agrega una prueba de regresión.

---

## 2. El error de la búsqueda por correlation ID

| Rango | Resultado | Tiempo |
|---|---|---|
| Últimas 3 horas | Saga y 2 eventos, **0 pasos** (la reserva es anterior al rango) | 1,2 s |
| Últimas 24 horas | **«Loki no está disponible»** | 3,7 s |
| Últimas 72 horas | **«Loki no está disponible»** | 3,9 s |

**No hay un microservicio caído.** Los pasos salen de Loki con `… | correlation_id=…`: Loki no tiene índice por correlation ID (no
debe tenerlo), así que lee **todos** los logs del rango (1 día ≈ 7 s en la VM) y el ESB corta a los **3 s**. Tras varios cortes
seguidos se abre el circuito hacia Loki: por eso «inténtalo en 28 s».

**El error es nuestro (O-2):** se ofrecieron «24 horas» y «7 días» sabiendo que superan ese límite. Además, el mensaje confunde: dice
«un servicio no está disponible» cuando lo que pasó es que la búsqueda tardó demasiado.

**Solución (D-T4):**
- **Ventana automática:** el ESB busca primero las sagas y los eventos del correlation ID en la base de datos (rápido) y consulta
  Loki solo entre su primera y su última hora, ±10 min. Así sirve también para una reserva de la semana pasada.
- Se quitan «24 horas» y «7 días».
- Si Loki corta por tiempo, el mensaje lo dice («la búsqueda tardó demasiado»), y ese corte no abre el circuito.

---

## 3. Tiempos en tierra, margen de ida y vuelta y retrasos

### 3.1 Tiempos en tierra y margen de 2 horas — se mantiene como está (D-T5)

| Tipo | Asientos | Alcance | Tiempo en tierra |
|---|---|---|---|
| Airbus A220-300 (HC-J…) | 122 (12 Business + 110 Economy) | Hasta 1.500 km | 35 min |
| Airbus A320neo (HC-N…) | 174 (12 Business + 162 Economy) | Hasta 4.500 km | 45 min |
| Boeing 787-9 (HC-W…) | 321 (42 Business + 279 Economy) | Sin límite | 90 min |

- **El horario ya respeta estos tiempos:** un avión no vuelve a salir antes de cumplirlos (`validateRotations`, `planRoundTrips`).
- **La búsqueda de ida y vuelta exige 2 horas** entre la llegada de la ida y la salida de la vuelta (`MIN_MINUTES_BETWEEN_LEGS`).
  Ese margen es del **pasajero**, no del avión: lo protege si la ida se atrasa.
- **Decisión del responsable (D-T5): se mantiene.** Quito ⇄ Loja, Galápagos y Zamora (115 min) no ofrecen ida y vuelta en el mismo
  día; con la vuelta otro día, sí.

### 3.2 Retrasos de un vuelo (pedido de Booking) — fase R-1

**Pedido:** el administrador indica **cuánto** se atrasa un vuelo; el estado y la nueva hora de salida se ven en el estado del
vuelo (y Booking los observa). Solo debe cambiar **ese vuelo de esa fecha**, no el horario.

**Lo que ya existe** (verificado en el código y en la nube):
- **MS.G.FlightStatus:**
  - estado `DELAYED`, que exige una salida estimada posterior a la programada;
  - `delayMinutes` calculado;
  - transiciones `SCHEDULED → DELAYED → DELAYED` (un nuevo retraso) `→ BOARDING`.
- **Es por vuelo y fecha:** el estado de vuelo es un registro aparte del horario (Schedule). Un retraso **no toca** la ruta, los
  otros días ni los otros vuelos. Tu preocupación por los horarios está cubierta en ese punto.
- **Ningún proceso cambia estados solo por la hora** (no hay un «despegar automático»): un vuelo retrasado no se marca `DEPARTED`
  a la hora programada.
- **Contrato del grupo:** `GET /vuelos/flights/{n}/status` ya trae `status`, `delayMinutes` y `estimatedAt` en salida y llegada
  (comprobado con EA324 del 10/11). Booking puede consultarlo hoy.
- **Eventos:** la saga «Cambiar estado de vuelo» publica `flight.status_changed` y `flight.schedule_changed` con la hora estimada.
- **Web:** «Operaciones» permite poner `DELAYED` con una fecha y hora estimadas; «Estado de vuelo» muestra «Estimado».

**Los huecos frente al pedido:**

| # | Hueco | Efecto |
|---|---|---|
| 1 | El administrador escribe una **fecha y hora**, no «cuántos minutos» | Incómodo y propenso a errores (zona horaria, día) |
| 2 | La **llegada estimada** es opcional y no se calcula | Con solo la salida atrasada, la llegada sigue con la hora programada: Booking y el cliente ven una llegada imposible |
| 3 | **El avión del vuelo atrasado** puede no llegar a su **siguiente vuelo** del día | Ejemplo: EA324 a Loja se atrasa 1 h → aterriza 10:45 y con 35 min queda listo 11:20; la vuelta EA325 sale 11:40, cabe. Con 1 h 30 min de retraso, ya no. Hoy nadie avisa |
| 4 | **Pasajeros con conexión o con ida y vuelta** en el mismo día pueden quedar con menos de su margen | Hoy nadie avisa |
| 5 | El **check-in cierra a la hora programada** (la saga usa la salida del itinerario) | Un vuelo atrasado 2 h ya no deja hacer check-in aunque todavía no sale |
| 6 | El **cliente** no ve el retraso en «Mis viajes», en el detalle de su reserva ni en su pase; el **administrador** tampoco en el detalle de la reserva | Solo lo ve quien entra a «Estado de vuelo» |
| 7 | **Booking no recibe los eventos:** rechaza con HTTP 400 todos nuestros webhooks (hallazgo **BKG-16**, de su lado) | Hoy solo puede verlo consultando el estado. Hay que avisarles |

**Propuesta R-1:**
1. **Operaciones → «Retrasar»:**
   - el administrador elige los **minutos** (15, 30, 45, 60, 90, 120 u otro) y el **motivo**;
   - el sistema calcula la nueva salida y la nueva llegada (las dos programadas + minutos) y las muestra antes de confirmar;
   - se puede **aumentar o reducir** el retraso, y **quitarlo** (volver a «A tiempo»: `DELAYED → SCHEDULED`, transición propia de
     FlightStatus; el contrato del grupo no la prohíbe) (D-T9).
2. **FlightStatus:** si llega solo la salida estimada, **calcula la llegada estimada** con la duración programada. Así la
   respuesta a Booking es siempre coherente.
3. **Revisión de conflictos antes de confirmar**, que avisa y **no** cambia nada por su cuenta (D-T10):
   - **el siguiente vuelo del mismo avión** ese día: si la nueva llegada más su tiempo en tierra pasa su salida, avisa («HC-J13 no
     llega a tiempo para EA325 de las 11:40: estaría listo a las 12:20») y ofrece **retrasar también ese vuelo** con un clic, como
     acción aparte y explícita;
   - **las reservas afectadas:** cuántos pasajeros hay y cuáles quedan con menos de su margen en una conexión o en su vuelta;
   - el horario (Schedule) no se toca: solo cambia el estado de **ese vuelo en esa fecha**.
4. **Check-in:** si el vuelo está `DELAYED`, la ventana cierra a la **salida estimada** (D-T11).
5. **Cliente y administrador:**
   - «Mis viajes», el detalle de la reserva y el pase muestran «Retrasado 1 h · nueva salida 09:40»;
   - el detalle de reserva del administrador también lo muestra;
   - la bitácora de eventos muestra `flight.status_changed` con el retraso.
6. **Booking:** ya puede ver el retraso por `GET /vuelos/flights/{n}/status` (`status: DELAYED`, `delayMinutes`, `estimatedAt`).
   Se les avisa que, para recibirlo **al instante**, falta que su endpoint de webhooks acepte nuestros envíos (BKG-16).

**Lo que no cambia:**
- La venta del vuelo cierra a su hora programada.
- El contrato del grupo no cambia: los campos ya existen.

---

## 4. Datos maestros administrables: aeropuertos y tipos de avión

### Situación actual

Aeropuertos (`AIRPORTS`) y tipos de avión (`AIRCRAFT_TYPES`, su distribución de asientos, alcance, tiempo en tierra y prefijo de
matrícula) son **constantes del código** en `packages/shared`. Los usan:

| Quién | Para qué |
|---|---|
| **MS.G.Schedule** | Validar rutas, elegir el avión por distancia, duración del vuelo, husos horarios, rotaciones, matrículas |
| **MS.G.Offers** | Mapa de asientos y cupos por cabina (recibe de cada vuelo solo el **nombre** del tipo y arma los asientos con la constante); distancias para las conexiones |
| **ESB** | Saber si un vuelo es internacional (país del aeropuerto → pasaporte) |
| **Web** | Selectores de aeropuertos (`data/airports.ts`), datos de la flota |

Agregar un aeropuerto o un tipo hoy exige cambiar el código y desplegar todo. Para hacerlo desde el panel, **pasan a ser datos con
un dueño**.

### Diseño propuesto

- **Dueño: MS.G.Schedule** (ya es el dueño de rutas y flota). Dos tablas nuevas, `airports` y `aircraft_types`, sembradas con los
  34 aeropuertos y los 3 tipos actuales: **nada de lo existente cambia**.
- **Administración:** MS.Admin → ESB → Schedule (`GET`/`POST`/`PUT /airports` y `/aircraft-types`), y GraphQL para el panel. Una
  pestaña **«Aeropuertos»** y otra **«Tipos de avión»** junto a «Rutas programadas» y «Flota».
- **Cómo llegan los datos a los demás** (se respeta la regla «un MS.G no llama a otro»):
  - **Schedule** lee sus tablas en lugar de las constantes; el motor del horario recibe el catálogo como parámetro.
  - **Offers** recibe del ESB, al publicar el horario, la ficha de cada tipo (cabinas y distribución de asientos, tiempo en tierra)
    y la distancia de cada vuelo. Guarda su copia para armar los mapas de asientos (cambio aditivo en `ms-g-offers.proto`).
  - El **ESB** consulta los aeropuertos a Schedule, con caché, para saber si un vuelo es internacional.
  - La **web** pide los aeropuertos por GraphQL (consulta pública para el buscador) en lugar de su lista fija.

**Aeropuertos (M-1):**
- **Campos:** código (3 letras, único y no editable), ciudad, nombre, provincia (Ecuador), país, latitud, longitud y huso horario.
- Ejemplo: agregar «Manta» si otra ciudad de una provincia tiene aeropuerto.
- **Cambios:** se edita todo menos el código. No se borra si tiene rutas o aviones con base ahí; se puede **desactivar** (deja de
  ofrecerse para rutas nuevas).
- **Agregado al implementar (M-1):** con rutas o aviones, tampoco cambian su **país, coordenadas ni huso horario**
  (`409 AIRPORT_IN_USE`): moverían distancias y horas de vuelos ya publicados. Misma lógica que D-T7 para los tipos de avión.

**Tipos de avión (M-2):**
- **Campos:**
  - nombre (p. ej. «Embraer E195-E2») y prefijo de matrícula (`HC-` + una letra, único);
  - **asientos por clase** y su **configuración por fila**: Business 2-2 o 1-2-1; Economy 3-3, 2-4-2 o 3-3-3. Con eso el sistema
    arma el mapa de asientos: filas = asientos ÷ asientos por fila, letras estándar;
  - **alcance en km** (o sin límite) y **tiempo en tierra en minutos**.
- **Cabinas: Business y Economy, siempre las dos (D-T8).** Los 4 paquetes (**familias tarifarias**) se venden dentro de una cabina:
  **Semilla, Brote y Bosque en Economy** y **Dosel en Business**. Exigir las dos cabinas garantiza que todo avión nuevo venda los
  4 paquetes. Ojo: Semilla, Brote, Bosque y Dosel **no son clases de avión** sino tarifas; las clases (cabinas) son Economy y
  Business.
- **Cambios:** un tipo **sin aviones** se edita libremente; **con aviones** no se le cambian asientos, alcance ni tiempo en tierra
  (romperían mapas de asientos vendidos y rotaciones): se crea un tipo nuevo (D-T7).
- **Elección automática por distancia:** el tipo de menor alcance que cubra la ruta (como hoy, ahora entre todos los del catálogo).

**Riesgos:**
- Es el cambio más grande del plan: toca el motor del horario, la publicación a Offers y sus mapas de asientos.
- Cada fase lleva pruebas de que con los datos sembrados todo da **exactamente igual que hoy** antes de agregar nada nuevo.
- Booking no se entera: ve los mismos códigos y estados.

---

## 4b. Precios editables desde «Precios y promociones» — fase P-1

**Cómo se calcula hoy** (Offers, `priceFor`), por pasajero adulto y por vuelo:

> **tarifa = (US$35 fijos + US$0,085 × km) × multiplicador del paquete** · −10 % si tiene escala · + impuestos (15 % + US$12 por
> tramo) · niños e infantes con su factor

| Paquete | Cabina | Multiplicador hoy | Ejemplo Quito → Guayaquil (282 km), tarifa sin impuestos |
|---|---|---|---|
| Semilla | Economy | 1,00 | US$59 |
| Brote | Economy | 1,35 | US$80 |
| Bosque | Economy | 1,80 | US$106 |
| Dosel | Business | 3,20 | US$189 |

**Lo que ya se puede editar:** los multiplicadores de cada paquete, en «Precios y promociones». Se guardan en Schedule con su
historial, se publican a Offers, y los holds ya creados conservan su precio. También las promociones con Booking.

**Lo que falta (pedido del responsable):**
- **Los US$35 fijos y los US$0,085 por km están escritos en el código:** no se pueden ajustar ni ver como «dato de referencia».
- **No hay forma de corregir el precio de una ruta concreta** si se equivocó (hoy solo se mueve el multiplicador, que afecta a
  todas las rutas).
- La pantalla muestra multiplicadores, pero **no cuánto cuesta cada paquete**: el administrador no ve el resultado en dólares.

**Propuesta P-1:**
1. **Tarifa base editable:** «Cargo fijo por vuelo» (US$35) y «**Precio por km**» (US$0,085, el dato de referencia) pasan a ser
   datos de Schedule, con historial (quién y cuándo). Se publican a Offers junto con los multiplicadores, por la misma saga
   «Guardar precios».
2. **Los 4 paquetes, siempre:** su multiplicador sigue editable. La pantalla muestra **cuánto cuesta cada paquete** en una ruta de
   ejemplo que elige el administrador (p. ej. Quito → Loja), antes de guardar.
3. **Precio exacto por ruta (D-T12)** para corregir una ruta concreta: el administrador escribe la **tarifa de cada uno de los 4
   paquetes** de esa ruta (p. ej. Quito → Loja: Semilla US$70, Brote US$95, Bosque US$125, Dosel US$220).
   - Reemplaza al cálculo por km **solo en esa ruta**; las demás siguen con la fórmula.
   - Es la **tarifa base de un adulto, sin impuestos**. Los impuestos (15 % + US$12) y los factores de niño e infante se aplican
     encima, como hoy, para que el total sea coherente con el resto.
   - Si la ruta va dentro de un viaje con escala, se suma con el otro tramo y se aplica el −10 % de la conexión, igual que hoy.
   - Tiene historial y se puede **quitar** (vuelve a la fórmula). La pantalla avisa cuando un precio fijo queda muy lejos del que da
     la fórmula; por ejemplo, después de cambiar el precio por km, ese precio fijo no se mueve.
4. **Lo que no cambia:**
   - las reservas y holds ya creados conservan su precio (ya funciona así);
   - los impuestos siguen fijos (15 % + US$12 por tramo);
   - el contrato del grupo no cambia: Booking recibe los precios nuevos en las búsquedas, como hoy.

---

## 5. Lo que ya tenemos para observar

| Pieza | Estado |
|---|---|
| **OpenTelemetry** en los 17 servicios | HTTP, gRPC y undici instrumentados; **el correlation ID viaja como atributo de cada span** (`correlation_id`) |
| **OTel Collector 0.162** | Métricas → **Prometheus 3.15**, trazas → **Tempo 3.1**, logs → **Loki 3.7** |
| **Grafana 13.2** (`/grafana/`) | Tableros «Servicios» e «Integración y negocio»; Loki → Tempo enlazados por `trace_id` |
| **Panel propio** | Telemetría, Observabilidad, historial de la reserva |

**Falta para el grafo:** el `metrics_generator` de Tempo (`service-graphs`), el `remote write` de Prometheus, `serviceMap` en el
origen de datos de Grafana, y una vista con grafo en el panel.

---

## 6. Herramientas: Prometheus + Grafana (con Tempo) vs. Jaeger — decidido (D-T1)

| | **Prometheus + Grafana + Tempo** | **Jaeger** |
|---|---|---|
| Grafo del sistema | **Service Graph** en vivo (peticiones/s, errores, latencia por arista) | «System Architecture», no en vivo |
| Grafo de un correlation ID | Node graph y cascada; TraceQL `{ span.correlation_id = "corr-…" }` | Trace Graph; búsqueda por tag |
| Encaje | Ya desplegado, con contraseña y enlazado a Loki | Duplica a Tempo; un contenedor más (~150–300 MB) y protegerlo con contraseña |

**Decisión: Prometheus + Grafana + Tempo, sin Jaeger.** Además, la vista propia **«Recorrido»** en el panel (D-T2): nodos por
capa (Web/Booking → Gateway → MS de respuesta → ESB → MS.G.* → PostgreSQL/RabbitMQ/pagos), aristas a partir de los spans y un
**reproductor que muestra el punto viajando nodo a nodo**, más un mapa en vivo del sistema refrescado cada 15 s. Se dibuja con SVG
propio.

---

## 6b. Empuje en tiempo real (D-T13) — fase T-5

**Cómo viaja hoy la telemetría** (verificado en `infra/otel/collector.yaml` y `packages/shared/src/telemetry`):

| Tramo | Protocolo | Cada cuánto |
|---|---|---|
| Microservicios → OTel Collector | OTLP sobre HTTP (protobuf) | Trazas cada **1 s** (`OTEL_BSP_SCHEDULE_DELAY=1000`); métricas cada **15 s** |
| Collector → Tempo | OTLP sobre **gRPC (HTTP/2)** | Al recibir |
| Collector → Prometheus · Loki | Prometheus las lee cada ~15 s · OTLP/HTTP a Loki | — |
| Navegador ⇄ Caddy | HTTPS con **HTTP/2 o HTTP/3** | — |
| Panel «Telemetría» | **Pregunta** (polling) por GraphQL | Cada 15 s con la pestaña visible (O-4) |

**Decisión del responsable (D-T13):** además de preguntar cada cierto tiempo, el panel recibe los cambios **empujados por el
servidor**, aunque sume complejidad.

**Cómo se hace — se reutiliza lo que ya existe:**
- **Transporte:** el gateway ya tiene **suscripciones GraphQL por WebSocket** (`graphql-ws`, la de `bookingEvents`, D47). Valida el
  token al abrir la conexión y Caddy ya deja pasar el WebSocket. No se agrega ningún servidor ni protocolo nuevo.
- **Dos suscripciones nuevas** (solo administradores):
  - `traceProgress(correlationId)`: cada **paso nuevo** de un proceso apenas llega a Tempo (~1–2 s después de ocurrir): servicio,
    operación, estado, duración y de qué nodo a qué nodo fue. La vista «Recorrido» (T-4) lo dibuja **en vivo** mientras la reserva
    ocurre, en lugar de reproducirla al final.
  - `liveSystemMap`: el mapa de servicios (peticiones/s, errores y latencia por arista, del Service Graph de T-3) y la salud de cada
    servicio, cada vez que cambian.
- **Del lado del servidor:** el gateway consulta al ESB (composición nueva) **solo mientras hay alguien suscrito**: cada 2 s para
  `traceProgress` y cada 10 s para el mapa. Es una sola consulta por tema, compartida entre todos los suscriptores, y envía solo
  lo nuevo. Sin nadie mirando, no se consulta nada.
- **Respaldo:** si el WebSocket no conecta (una red que lo bloquee) o se corta, la página vuelve sola al refresco cada 15 s y lo
  avisa («actualización cada 15 s: sin conexión en vivo»).
- **Seguridad:** la misma regla que hoy: solo `ECOAIRLINES_ADMIN`; un token vencido cierra la conexión; nunca se envían datos
  personales (solo nombres de servicio, operación, estado y tiempos).

**Límites honestos:**
- Lo «inmediato» tiene el atraso de la propia plataforma: las métricas cambian cada ~15 s, y un paso tarda en poder buscarse en
  Tempo. **Medido al implementar:** con la configuración por defecto de Tempo 3 eran **31 s** (excluye de las búsquedas los últimos
  30 s, `query_end_cutoff`, y espera 5 s sin spans antes de cerrar una traza, `max_trace_idle`). Con `query_end_cutoff: 1s`,
  `max_trace_idle: 2s` y el lote de trazas del Collector en 0,5 s: **~4 s**. El empuje evita la espera del refresco, no ese atraso.
- Cada administrador con la página abierta mantiene una conexión; en una VM de 2 núcleos y 4 GB no es un problema para un panel
  de pocos usuarios.

---

## 7. Fases

| Fase | Contenido | Verificación |
|---|---|---|
| **T-1** ✅ · Asientos (Booking) | `ValidateHold` con los asientos pedidos, **antes del pago**; mensaje `title`/`detail`; la web recarga el mapa y deja elegir otro; prueba de regresión del mapa | Con asiento tomado: el canal web responde `SEAT_TAKEN` **sin capturar**; el canal Booking, sin reclamar la referencia. En la nube: `seat_taken_booking.mjs` (409 con `detail`). En Edge: elegir otro asiento sin cobrar |
| **R-1** ✅ · Retrasos de un vuelo | «Retrasar» por minutos con salida y llegada calculadas; aumentar, reducir o quitar el retraso; aviso de conflictos (siguiente vuelo del avión, pasajeros con poco margen) con «retrasar también» explícito; check-in hasta la salida estimada; el retraso visible para el cliente y en las reservas | En la nube: retrasar EA324 60 min → `GET /vuelos/flights/EA324/status` con `DELAYED`, `delayMinutes: 60` y llegada estimada; EA325 y los demás días sin cambios. Con 90 min, aviso para EA325. En Edge: el cliente ve «Retrasado 1 h» en su reserva |
| **P-1** ✅ · Precios editables | Cargo fijo y precio por km editables (Schedule, con historial) y publicados a Offers; los 4 paquetes con su precio en dólares en una ruta de ejemplo; precio exacto por paquete en una ruta (D-T12) | Pruebas: con los valores sembrados (35 / 0,085 / 1,00…3,20) los precios dan **exactamente igual que hoy**. En la nube: cambiar el precio por km y ver la búsqueda con el precio nuevo; un hold anterior conserva su precio; fijar los 4 paquetes de Quito → Loja solo cambia esa ruta |
| **T-2** ✅ · Búsqueda por correlation ID | Ventana automática; quitar 24 h / 7 días; mensaje por tiempo agotado sin abrir el circuito | `corr-f488627d-…` encuentra sus pasos sin elegir rango, en < 2 s |
| **M-1** ✅ · Aeropuertos administrables | Tabla en Schedule (sembrada con los 34); API y pestaña «Aeropuertos»; Schedule, ESB y web leen el catálogo | Los 34 dan lo mismo que hoy; crear un aeropuerto nuevo, hacerle una ruta desde Quito y encontrarlo en el buscador |
| **M-2** ✅ · Tipos de avión administrables | Tabla en Schedule (sembrada con los 3); pestaña «Tipos de avión»; la ficha viaja a Offers en la publicación; mapa de asientos desde la ficha | Los 3 tipos dan los mismos mapas que hoy; crear un tipo nuevo, registrarle un avión, hacerle una ruta y ver su mapa de asientos y su tiempo en tierra respetado |
| **T-3** ✅ · Grafana en tiempo real | Tempo `metrics_generator` → Prometheus; `serviceMap`; tablero «Mapa del sistema en vivo»; pasos de la traza desde Tempo | El grafo de servicios con tasas reales tras una compra de prueba |
| **T-4** ✅ · Vista «Recorrido» | Composición del ESB con los spans; vista SVG con el reproductor (Telemetría y detalle de la reserva); mapa en vivo | En Edge: una compra de prueba viaja nodo a nodo y el mapa en vivo se actualiza |
| **T-5** ✅ · Tiempo real por WebSocket (D-T13) | Suscripciones `traceProgress(correlationId)` y `liveSystemMap` en el gateway (graphql-ws, ya existente), alimentadas por una composición del ESB que solo se consulta con suscriptores; «Recorrido» y el mapa en vivo las usan, con respaldo al refresco de 15 s | Pruebas del gateway (sin suscriptores no consulta; dos suscriptores comparten una consulta; solo administradores; token vencido cierra). En Edge: abrir «Recorrido» de un correlation ID, hacer una compra y ver aparecer los pasos en vivo (≤ ~3 s); cortar el WebSocket → vuelve al refresco y lo avisa |

Orden propuesto: **T-1 → R-1 → P-1 → T-2 → M-1 → M-2 → T-3 → T-4 → T-5**. T-1 y R-1 primero, porque los pidió Booking; P-1 es independiente; T-2 es corta; M-1 y M-2
son las más grandes. Al final de cada fase: `npm test`, despliegue (esperando a que la VM se estabilice), recorrido en Edge contra
la nube y registro en `CAMBIOS.md`.

**Contratos:** solo propios y aditivos (`ms-g-offers.proto`, `ms-g-flight-status.openapi.yaml`, `ms-g-schedule.openapi.yaml`,
`esb.openapi.yaml`, `ms-admin.openapi.yaml`, `gateway.graphql`). En M-2 el `AircraftType` de `ms-g-schedule.openapi.yaml` deja de
ser una lista fija (pasa a texto validado contra el catálogo). Es contrato propio; el del grupo no cambia.

---

## 8. Decisiones

| # | Decisión | Estado |
|---|---|---|
| D-T1 | Herramienta de trazas | ✅ **Tempo + Grafana**, sin Jaeger |
| D-T2 | Dónde se ve el grafo | ✅ **En Grafana y en el panel propio** («Recorrido» con el reproductor) |
| D-T3 | Asientos en el e-commerce | ✅ **Revisar antes de cobrar** y mantener la validación al consumir, cumpliendo lo pedido por Booking |
| D-T4 | «24 h» y «7 días» | ✅ **Quitarlos**, con ventana automática (sirve para procesos de la semana pasada) |
| D-T5 | Margen entre ida y vuelta | ✅ **Se mantienen las 2 horas** (es protección del cliente) |
| D-T6 | Aeropuertos | ✅ **Código no editable** (como una clave primaria); desactivar en vez de borrar si tiene rutas o aviones |
| D-T7 | Tipos de avión con aviones | ✅ No se cambian asientos, alcance ni tiempo en tierra; se crea un tipo nuevo |
| D-T8 | Cabinas de un tipo nuevo | ✅ **Business y Economy, siempre las dos**, para vender los 4 paquetes (Semilla, Brote y Bosque en Economy; Dosel en Business) |
| D-T9 | Cómo se indica un retraso | ✅ **En minutos** (llegada calculada); se puede aumentar, reducir o quitar |
| D-T10 | Conflictos de un retraso | ✅ **Avisar** y ofrecer «retrasar también» como acción **opcional**; nunca en cadena automática |
| D-T11 | Check-in de un vuelo retrasado | ✅ Cierra a la **salida estimada** |
| D-T12 | Corregir el precio de una ruta | ✅ **Precio exacto de cada paquete** (Semilla, Brote, Bosque, Dosel) en esa ruta, tarifa base sin impuestos; reversible. El cargo fijo, el $/km y los multiplicadores siguen editables y globales |
| D-T13 | Telemetría en tiempo real | ✅ **Empuje por WebSocket** (suscripciones GraphQL del gateway), además del refresco cada 15 s como respaldo; fase T-5 |
