# PLAN — Observabilidad de las órdenes en el panel de administración

| | |
|---|---|
| Fecha | 08/11/2026 |
| Estado | **Completo: O-1 a O-4 hechas (08/11)**, desplegadas en la VM y verificadas contra la base real (ver `CAMBIOS.md`). Falta publicar la web y la auditoría |
| Objetivo | Que el administrador vea las reservas (órdenes) y su detalle desde el panel, sin entrar a Swagger ni a la base de datos |
| Qué NO cambia | La lógica de negocio, los contratos del grupo (`vuelos-openapi-v2.yaml`) y lo que ve Booking. El sistema funciona: esto es solo la interfaz del administrador |
| Referencia | Panel de administración del equipo de Atracciones (`GlieseKep/Atracciones-Entrega-2-Microservicios`, commit `e970a5b`). Solo se tomó **cómo presentan** las órdenes y la observabilidad; su lógica de atracciones no aplica |

---

## 1. Por qué

El 08/11 Booking pidió confirmar la reserva **DHV47T**: canal, orden `ORD-BKP-7B5BADB7C0`, referencia de pago, cancelación con
reembolso de 20,85 y el neto de 59,00. Hoy eso solo se puede ver:

- por **Swagger**, con un token de partner y el `X-User-Id` exacto del dueño (si no, responde 404), o
- por **SSH y SQL** contra la base `bookings`.

El panel actual muestra **totales** (reservas, ingresos, ventas por canal) pero **ninguna reserva concreta**. Ese es el hueco.

---

## 2. Qué tomamos del panel de Atracciones (solo la presentación)

| Lo que hacen ellos | Archivo de referencia | Lo adaptamos así |
|---|---|---|
| **Tabla administrativa reutilizable**: buscador con espera (350 ms), filtro de estado, rango de fechas, paginación en el servidor y contador de resultados | `AdminTable.tsx` | Un componente `AdminTable` nuestro, sobre el `DataTable` que ya existe en `components/AdminUi.tsx`, con «Ver más» por cursor (nuestras listas paginan por cursor, no por página) |
| **Pedidos** con un diálogo de detalle: líneas, subtotal, IVA, total y estado | `AdminOrdersPage.tsx` | **Reservas** con detalle: tarifa base, impuestos, total, reembolso, penalidad y neto |
| **Reservas** con una columna que dice si la venta vino de **Booking** (y el estado del aviso) o de la **web**, y la orden externa bajo el código | `AdminOperationsPages.tsx` | Columna **Canal**: «Booking · ORD-BKP-…» o «Web», y el PNR con el id de la reserva debajo |
| **Dashboard** con tarjetas que **enlazan** a su listado, cada una con su total y un detalle («12 canceladas»), y una tarjeta de estado del sistema | `AdminDashboardPage.tsx` | Las tarjetas del panel actual se vuelven enlaces filtrados («Canceladas por Booking» → Reservas con ese filtro) |
| **Observabilidad**: tarjetas de salud por servicio que se refrescan cada 15 s (solo con la pestaña visible) y una **bitácora** filtrable con fecha, acción, servicio, entidad, usuario y correlación | `AdminObservabilityPage.tsx` | Ya tenemos salud y eventos por separado; se unen en una vista con refresco automático y con enlace de cada evento a su reserva |
| **Reportes** por período: ingresos por día con barras y ventas por producto en una tabla | `AdminReportsPage.tsx` | Ventas por día, por canal y por ruta, y una **liquidación con Booking** (vendido − reembolsado = neto a recibir) |

**No tomamos:** su factura del SRI (nuestro contrato v2 deja la facturación fuera de la aerolínea), su reembolso parcial manual (en
el canal Booking el reembolso lo ejecuta Booking) ni su microservicio de bitácora (`ms-audit`): nosotros ya guardamos cada evento en
`event_log` de MS.G.Webhooks y cada saga en `saga_log` del ESB.

---

## 3. Lo que ya existe (no hay que construirlo)

| Pieza | Dónde | Sirve para |
|---|---|---|
| Documento completo de la reserva (pasajeros, itinerario, tarifas, `payment`, `salesChannel` con la orden de Booking, boletos, `changes`, `refunds`, `cancellation`) | `bookings.data` (JSONB), MS.G.Bookings | Todo el detalle de una orden, como el de DHV47T |
| **Listado de TODAS las reservas para el administrador**, con filtros `pnr`, `status`, `channel`, `createdFrom` y `createdTo` | `GET /bookings` de MS.G.Bookings con `X-Actor-Id` | La tabla de Reservas |
| Ruta del ESB hacia ese listado y hacia el detalle | `services/esb/src/router/routes.ts` (`listBookings`, `getBooking`) | No hay que tocar el enrutador |
| Referencias de pago usadas, con operación y monto | Tabla `payment_records` | Sección «Pagos» del detalle |
| Pasos de una saga, eventos y entregas a Booking **por correlation ID** | `telemetry.trace(correlationId)` (ESB → `saga_log` + historial de Webhooks) | Historial del detalle y enlace a la traza |
| Historial de eventos con filtros `type`, `correlationId`, `from` y `to` | `GET /history` de MS.G.Webhooks · pestaña Eventos | Bitácora |
| Salud de los servicios, alertas, colas y estado de la integración con Booking | Telemetría (Prometheus, Alertmanager, Loki) | Observabilidad |

**Lo que falta:** el GraphQL de la web solo expone «mis reservas» (`bookings` con scope `flights:read`), no las de todos. Hay que
publicar el listado y el detalle **para el administrador**.

---

## 4. Pantallas propuestas

### P1 · Reservas (`/admin/reservas`) — nueva

| Columna | Contenido |
|---|---|
| Reserva | **PNR** (enlace al detalle) · debajo, el id corto |
| Canal | Etiqueta **Booking** o **Web**; debajo, la orden de Booking (`ORD-BKP-…`) |
| Vuelo | Ruta (UIO → GYE) · fecha y hora de salida |
| Pasajeros | Cantidad por tipo (1 adulto, 1 infante…) |
| Total | Monto cobrado |
| Reembolso | Monto y estado (Calculado / Ejecutado) o «—» |
| Estado | Etiqueta de color: Confirmada, Emitiendo, Con check-in, Cancelada, Fallida… |
| Creada | Fecha y hora (hora de Ecuador) |

**Filtros:** buscar por **PNR, orden de Booking o referencia de pago** · estado · canal · fecha de creación desde/hasta.
**Ejemplo:** escribir `DHV47T`, `ORD-BKP-7B5BADB7C0` o `PAY-BKP-20261107-030453` muestra la misma reserva.

### P2 · Detalle de una reserva (`/admin/reservas/:bookingId`) — nueva

Una página propia, no un diálogo: se puede compartir el enlace y volver atrás. Secciones:

1. **Resumen:** PNR, estado, canal, partner, **orden de Booking**, usuario de Booking (`X-User-Id`), creada y actualizada.
2. **Itinerario y asientos:** vuelos, fechas, cabina, familia tarifaria y asiento de cada pasajero.
3. **Pasajeros:** tipo y nombre; documento **enmascarado** (`P****567`); asistencia solo como «Sí / No» (es dato de salud).
4. **Boletos:** número, pasajero y estado (Emitido, Anulado…).
5. **Liquidación** (lo que pidió Booking para DHV47T):

   | Concepto | DHV47T |
   |---|---|
   | Tarifa base | 59,00 |
   | Impuestos | 20,85 |
   | **Total cobrado** (por Booking) | **79,85** |
   | Reembolso (calculado; lo ejecuta Booking) | −20,85 |
   | Penalidad retenida | 59,00 |
   | **Neto a favor de EcoAirlines** | **59,00** |

   Con un aviso fijo: «EcoAirlines no emite facturas: la facturación es del sistema de Facturación del ecosistema (contrato v2)».
6. **Pagos:** cada referencia usada (reserva, asientos, maletas, cambio de fecha), su proveedor, monto y fecha.
7. **Historial:** los cambios de la reserva (`changes`), los pasos de sus sagas y los eventos enviados a Booking con su estado de
   entrega (Entregado, Reintentando, Agotado).
8. **Enlaces:** «Ver la traza» (Telemetría con el correlation ID ya escrito) y «Copiar resumen para Booking», que copia un texto
   como el que se le respondió a Booking el 08/11.

Solo lectura: **no** se agregan botones para cancelar ni reembolsar (ver D-O4).

### P3 · Panel (`/admin`) — se mejora

- Las tarjetas actuales enlazan a Reservas ya filtrada: «Por Booking» → canal Booking; «Canceladas» → estado Cancelada.
- Tarjetas nuevas: **reembolsos calculados pendientes de Booking** (cantidad y monto) y **neto a recibir de Booking** en el mes.
- Una tarjeta **Estado del sistema** (como la de Atracciones), con los servicios caídos por nombre y enlace a Observabilidad.

### P4 · Reportes (`/admin/reportes`) — nueva

- **Período** (desde/hasta, por defecto los últimos 30 días).
- **Ventas por día** con barras, separando Web y Booking.
- **Ventas por ruta** (tabla: reservas, pasajeros, total).
- **Liquidación con Booking:** reservas vendidas, total cobrado, reembolsos calculados, penalidades y **neto a recibir**, con la
  lista de reservas que lo componen y **exportar a CSV** para cuadrar con Booking.

### P5 · Telemetría y Observabilidad — se mejoran por separado (D-O5: no se unen)

- **Telemetría** (`/admin/telemetria`) sigue siendo la pantalla del sistema: salud por servicio, alertas, colas, integración con
  Booking y búsqueda por correlation ID. Se agrega el **refresco automático cada 15 s** mientras la pestaña está visible, y la
  búsqueda acepta un correlation ID que llega por la URL (desde «Ver la traza» del detalle).
- **Observabilidad** (`/admin/observabilidad`) queda como está: diagnóstico del navegador del administrador.
- La **bitácora** (pestaña Eventos del panel) usa la tabla nueva: fecha, evento, reserva (enlace al detalle), canal, correlation ID
  (enlace a la traza) y entrega a Booking. Filtros: tipo de evento, fechas y correlation ID.

---

## 5. Cambios de backend (mínimos)

Todos en contratos **nuestros**; ninguno en los del grupo. Las rutas del enrutador del ESB ya existen.

| Pieza | Cambio | Por qué |
|---|---|---|
| `contract/gateway.graphql` | `adminBookings(filter, limit, cursor)`, `adminBooking(bookingId)` y `adminSalesReport(from, to)`, con `@auth(scopes: [ECOAIRLINES_ADMIN])` | Hoy la web solo puede pedir sus propias reservas |
| `contract/ms-admin.openapi.yaml` + MS.Admin | `GET /ecoairlines/admin/bookings`, `/bookings/{id}`, `/bookings/{id}/timeline` y `/reports/sales`, que llaman al ESB con `X-Actor-Id` | MS.Admin es la puerta de todo lo de administración (D23) |
| `contract/ms-g-bookings.openapi.yaml` + MS.G.Bookings | Filtros nuevos en `GET /bookings`: `paymentReference` (en `payment_records`) y `partnerOrderId` (en `data->'salesChannel'`, con índice). `GET /reports/sales?from&to`, que suma en SQL por día, canal y ruta | Buscar por la orden o la referencia de Booking, y reportes sin traer todas las reservas al navegador |
| ESB (composición) | `bookingTimeline(bookingId)`: los cambios de la reserva + sus sagas en `saga_log` + los eventos y entregas de Webhooks con su correlation ID | Una sola llamada para el historial del detalle |
| MS.G.Webhooks | Filtro `subject` (el `bookingId`) en `GET /history` | Los eventos de una reserva sin conocer su correlation ID |

**Reglas que se mantienen:** solo ADMIN; un MS.G no llama a otro; el documento se enmascara y la asistencia médica no sale en
listados (`tests/arquitectura-v2` y las pruebas de cada servicio lo comprueban); no se registran datos personales en logs.

---

## 6. Fases

| Fase | Contenido | Verificación |
|---|---|---|
| **O-1** ✅ | Backend del listado y del detalle (filtros nuevos en Bookings, MS.Admin, GraphQL) y las pantallas **Reservas** (P1) y **Detalle** (P2, sin historial) | Pruebas de Bookings, MS.Admin y gateway; `web-graphql.spec.ts` valida las operaciones nuevas contra el esquema; en Edge: buscar `DHV47T` muestra 79,85 / −20,85 / 59,00, y buscar por la orden y por la referencia da la misma reserva |
| **O-2** ✅ | Historial del detalle (`bookingTimeline`, filtro `subject`) y enlace a la traza | Una compra con Booking simulado: el historial muestra la saga y la entrega del webhook |
| **O-3** ✅ | Reportes (P4) con liquidación y CSV; tarjetas nuevas del panel (P3) | Cuadre: la suma del reporte es igual a la suma de las reservas del período (prueba con datos conocidos) |
| **O-4** ✅ | Telemetría con refresco automático y bitácora con la tabla nueva (P5); Observabilidad no cambia | Refresco cada 15 s solo con la pestaña visible; enlaces de la bitácora a la reserva y a la traza |

Al final de cada fase: typecheck, lint y `npm test`; recorrido en Edge; despliegue en la VM (≈30 min, compila allí) y registro en
`CAMBIOS.md`. Costo: **US$0** (no se crea ningún recurso).

---

## 7. Decisiones (cerradas por el responsable el 08/11)

| # | Tema | Decisión |
|---|---|---|
| D-O1 | Detalle como página propia o como diálogo | **Página propia** (`/admin/reservas/:bookingId`): se puede enlazar desde la bitácora y desde el panel |
| D-O2 | Documento del pasajero en el detalle | **Enmascarado** (`P****567`), con un botón «mostrar» que solo ve el ADMIN |
| D-O3 | Exportar la liquidación a CSV | **Sí** |
| D-O4 | Acciones desde el detalle | **Solo lectura**: sin cancelar, reembolsar ni reenviar webhooks |
| D-O5 | Unir Telemetría y Observabilidad | **No**: siguen separadas (ver P5) |
| D-O6 | Orden de las fases | **O-1 → O-2 → O-3 → O-4** |
