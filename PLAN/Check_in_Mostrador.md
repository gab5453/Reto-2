# PLAN — Check-in en mostrador (el administrador hace el check-in e imprime el pase)

| | |
|---|---|
| Fecha | 13/11/2026 |
| Estado | **Aprobado (13/11)**: CM-1 = **A** (`jspdf`), CM-2 = **A** (toda la reserva), CM-3 = **calcular** (estándar), CM-4 = **intentar siempre el check-in** (13/11, ver §5.1). **Completo (13/11)**: M-1, M-2 y M-3 hechas; desplegado (`e0f6876`) y web publicada por el responsable, con un pase impreso en la nube |
| Origen | Pedido del responsable: que el administrador pueda hacer el check-in de un pasajero que no tiene cómo mostrar su pase (sin teléfono, sin batería, sin conexión) e imprimirle el pase de abordar en PDF. Referencia visual: pase de Avianca (no se copia al pie de la letra; se usan los datos que ya tiene el sistema) |
| Qué cambia | Una operación nueva del administrador (check-in en mostrador), la lectura de los pases de cualquier reserva para el administrador y un botón en el detalle de la reserva del panel que genera el PDF. Se registra como **D57** |
| Qué NO cambia | El contrato del grupo (`vuelos-openapi-v2.yaml`): es una función propia del panel (MS.Admin). Las reglas del check-in (ventana, boletos emitidos, vuelo no cancelado). El check-in del pasajero en la web y la PWA |
| Costo | **US$0**: no se crea ningún recurso. El PDF se genera en el navegador del administrador |

---

## 1. Qué ya existe y qué falta

| Pieza | Hoy | Falta |
|---|---|---|
| **Saga «Check-in» del ESB** | Hace el check-in de **todos** los pasajeros pendientes de la reserva (ventana de 48 h, boletos emitidos, vuelo no cancelado, asiento automático a quien no tiene) y emite `booking.checked_in`. **Ya acepta que la ejecute un administrador** (como la cancelación de administrador: `X-Actor-Id`) | Nada en la saga. Solo dejar constancia en el historial de que fue en mostrador |
| **MS.Admin** | `adminCancelBooking` y `markAssistanceReady` llaman a sagas como administrador | `adminCheckIn` y `listAdminBoardingPasses` |
| **Gateway (GraphQL)** | `adminBooking` trae pasajeros, itinerarios, tarifas y boletos, **sin pases** | La mutación `adminCheckIn` y los pases en la vista del administrador |
| **Web — detalle de la reserva (admin)** | Secciones Resumen, Liquidación, Itinerario, **Pasajeros**, Boletos y Pagos | El botón en la sección Pasajeros y el PDF |
| **Código QR** | La web ya dibuja el QR del pase con `qrcode` (el contenido es el código BCBP de IATA) | Reutilizarlo en el PDF |

---

## 2. Aviso a Booking (pedido del responsable, 13/11)

El check-in en mostrador usa **la misma saga** que el del pasajero, que al terminar publica **`booking.checked_in`** con `bookingId`,
`pnr` y `passengersCheckedIn` (el formato que pidió Booking, BKG-16). Le llega por los dos canales de la integración: el **webhook**
(`POST …/api/v2/webhooks/vuelos`) y el feed **`GET /vuelos/eventos`**. No hace falta código nuevo para esto; sí una prueba (M-1) que
compruebe que el check-in del administrador emite el evento.

Como cualquier evento de reserva (D40): Booking recibe el aviso **solo de sus propias reservas**. Si el pasajero compró en nuestra
web, Booking no se entera.

## 3. El pase de abordar en PDF

Una página por **pasajero y tramo** (un ida y vuelta de 2 pasajeros = 4 páginas), tamaño de una tarjeta como la referencia.

| En la referencia (Avianca) | En EcoAirlines | De dónde sale |
|---|---|---|
| Logo y nombre | Logo y nombre de **EcoAirlines** (y su lema verde) | Marca de la web |
| Fecha y vuelo | Fecha de salida y número de vuelo (`EA100`) | Itinerario de la reserva |
| Origen y destino con ciudad y hora | Código IATA, ciudad, hora de salida y de llegada | Itinerario y catálogo de aeropuertos |
| Tiempo en sala (hora de embarque) | **Embarque**: salida − 40 min | Se calcula (CM-3). Con un retraso vigente, sobre la salida **estimada** |
| Cierre de puertas | **Cierre de puertas**: salida − 15 min | Se calcula (CM-3) |
| Grupo, asiento | Grupo (A/B/C) y asiento | Pase de abordar (MS.G.CheckIn) |
| SEC 118 (secuencia) | **Posición** de abordaje (`002`) | Pase de abordar |
| Puerta (o «revisa las pantallas») | Puerta, si ya está asignada; si no, «Revisa la puerta en las pantallas del aeropuerto» | Pase / estado del vuelo |
| Pasajero APELLIDO / NOMBRE | `APELLIDOS / NOMBRES` en mayúsculas | Pasajero de la reserva |
| Cabina | Cabina y **paquete** (Economy · Bosque) | Tarifa de la reserva |
| Código de reserva | PNR | Reserva |
| E-ticket | Número del boleto del pasajero | Boletos de la reserva |
| Equipaje de mano / bodega | Lo que incluye su paquete + las maletas extra compradas | Tarifa y maletas de la reserva |
| Operado por | «Operado por EcoAirlines» | Fijo |
| Código QR | Código QR con el BCBP del pase | Pase de abordar (`barcode`) |
| Viajero frecuente | **No se incluye**: el sistema no tiene programa de viajero frecuente | — |
| — | «Check-in en mostrador» y la fecha y hora de emisión | Momento de la impresión |

**Nunca va en el PDF** (datos sensibles, reglas del proyecto): el **tipo de asistencia médica** (dato de salud), el documento de identidad, el contacto y los datos de pago. El PDF se genera en el navegador y no se guarda en ningún servidor ni en la caché de la PWA.

---

## 4. Fases

### M-1 · Backend: check-in en mostrador y pases para el administrador — ✅ HECHA (13/11)

- **MS.Admin** (`ms-admin.openapi.yaml`, primero el contrato):
  - `POST /ecoairlines/admin/bookings/{bookingId}/check-in` (`adminCheckIn`): la saga «Check-in» del ESB como administrador
    (`X-Actor-Id`). Las mismas reglas que el check-in del pasajero y los mismos errores (con `code` y `detail`).
  - `GET /ecoairlines/admin/bookings/{bookingId}/boarding-passes` (`listAdminBoardingPasses`): los pases de cualquier reserva.
- **ESB:** sin cambios: la composición de los pases ya acepta a un administrador (Bookings deja leer cualquier reserva con
  `X-Actor-Id`), y la saga de check-in también.
- **Historial de la reserva:** «Check-in en mostrador (administrador)», para distinguirlo del check-in del pasajero.
- **Gateway** (`gateway.graphql`): `adminCheckIn(bookingId): [BoardingPass!]!` y `adminBoardingPasses(bookingId)`, con
  `@auth(scopes: [ECOAIRLINES_ADMIN])`. Un CLIENTE o un partner reciben 403.
- **Pruebas:** MS.Admin contra su contrato; ESB (el administrador lee pases ajenos; un usuario sin rol no; **el check-in del
  administrador publica `booking.checked_in` con el dueño de la reserva**, así llega a Booking si es su reserva); gateway (403 sin
  ADMIN); `web-graphql.spec` con los documentos nuevos.

### M-2 · Web: botón y PDF — ✅ HECHA (13/11)

- En **Pasajeros** del detalle de la reserva del panel: botón **«Check-in en mostrador e imprimir»**.
  - Pide confirmación («Se hará el check-in de todos los pasajeros pendientes de la reserva»), llama a `adminCheckIn` y genera el PDF.
  - Si la reserva **ya tiene check-in**: el botón pasa a **«Reimprimir pases»**, pero **igual intenta primero el check-in de lo
    pendiente** (CM-4, §5.1): si no hay nada pendiente, solo reimprime.
  - No imprime los pases de tramos que **ya salieron** (con retraso, cuenta la salida estimada); si no queda ninguno, avisa en vez de
    descargar un PDF vacío.
  - Solo para reservas `CONFIRMED` con boletos emitidos; con la ventana cerrada o el vuelo cancelado muestra el error del servidor.
- **PDF** con `jspdf` (CM-1), cargado **solo** cuando el administrador pulsa el botón (`import()` dinámico): no pesa en la web del
  pasajero ni en la PWA (se excluye de la precaché: `globIgnores`). El QR con la librería `qrcode` que ya se usa.
- **Pruebas de la web (Vitest):** la función que arma el contenido del pase a partir de la reserva (sin datos de salud, horas de
  embarque y cierre, equipaje, mayúsculas) — separada del dibujo del PDF para poder probarla.

### M-3 · E2E, documentación y despliegue — ✅ HECHA (13/11), desplegada y publicada

- **E2E nueva (E-9):** el administrador abre una reserva del vuelo de mañana, pulsa el botón, el PDF se descarga (empieza con
  `%PDF` y trae el PNR y el vuelo) y la reserva queda con check-in (el pasajero ya ve sus pases).
  Un segundo clic (**«Reimprimir pases»**) vuelve a descargar el PDF **sin error** (CM-4: el 409 de «nada pendiente» no se muestra).
- **Documentación:** D57 en `PLAN/PLAN.md`, `CAMBIOS.md`, `Pruebas.md` (E-9) y `Seguridad.md` (qué datos lleva el pase).
- **Commit** cuando el responsable lo pida; **despliegue** de la API y **publicación de la web** (compilada con las URL de la nube).

---

## 5. Decisiones (resueltas el 13/11)

| # | Pregunta | Opciones | Recomendación |
|---|---|---|---|
| **CM-1** | ¿Cómo se genera el PDF? | **A.** `jspdf` 4.2.1 (marzo de 2026): el botón descarga un PDF real con el diseño del pase. **B.** Una vista para imprimir y el diálogo del navegador («Guardar como PDF»): sin librería nueva, pero el resultado depende del navegador y el administrador tiene que elegir la opción a mano | **A**: lo que se pidió es que el botón **genere un PDF**. Se carga solo en el panel del administrador |
| **CM-2** | ¿Check-in de toda la reserva o de un pasajero? | **A.** Toda la reserva (todos los pasajeros pendientes en la ventana), como hoy hace la web. **B.** Por pasajero, con un botón en cada fila: hay que cambiar la saga para recibir los pasajeros | **A**: es la regla que ya existe y prueba el sistema; en el mostrador se atiende la reserva. El PDF trae una página por pasajero y tramo |
| **CM-3** | Horas de **embarque** y **cierre de puertas** (el sistema no las guarda) | Calcularlas desde la salida: embarque = salida − 40 min y cierre = salida − 15 min (con un retraso, desde la salida estimada). O no mostrarlas | **Calcularlas** con esos valores, que son los habituales en vuelos nacionales; quedan como constantes fáciles de cambiar |

### 5.1 CM-4 · Reservas con check-in a medias (13/11, aprobado por el responsable)

**Corrección de M-2.** La primera versión del botón suponía que, si la reserva ya tenía pases, ya tenía todo el check-in hecho, y
solo reimprimía. Es falso: el check-in es de toda la reserva **solo en los tramos que están en su ventana** (48 h antes de cada
salida). Una reserva queda con check-in a medias en casos normales:

| Caso | Qué pasaba con la primera versión |
|---|---|
| **Ida y vuelta**: la ida (14/11) tuvo check-in; la vuelta (20/11) aún no abría | El 20/11 el botón decía «Reimprimir pases», imprimía la ida ya volada y **no** hacía el check-in de la vuelta |
| **Cambio de fecha después del check-in** (D56): se anula el check-in del vuelo viejo | Quedaban pases del otro tramo; el vuelo nuevo no podía tener check-in desde el mostrador |

**Decisión:** el botón **siempre intenta primero el check-in de lo pendiente** (la saga hace solo lo que está en la ventana y no
repite lo hecho) y después imprime:

- Hay algo pendiente en la ventana → se hace el check-in y se imprimen todos los pases.
- No hay nada pendiente (`409 CHECK_IN_NOT_AVAILABLE`) **y ya hay pases** → no es un error: solo se reimprime.
- Sin pases, ese mismo 409 sí se muestra (p. ej. la ventana aún no abre).
- La confirmación se pide solo la primera vez (cuando todavía no hay pases).
- No se imprimen los pases de tramos que ya salieron.

Así la regla de la ventana **no se copia en la web**: la decide el servidor, como para el check-in del pasajero.

La **ventana** del check-in en mostrador es la misma de siempre (de 48 h antes a la salida). Un mostrador real suele cerrar antes
(40–60 min); si se quiere, se agrega después.

---

## 6. Riesgos

- **Un pase impreso es una copia en papel:** si después se cancela la reserva o cambia la fecha (D56), el papel sigue existiendo,
  pero el sistema ya no lo reconoce (los pases quedan anulados).
- **Datos personales en el PDF** (nombre, PNR, e-ticket): se generan en el equipo del administrador. No llevan datos de salud,
  documento, contacto ni pago.
- **Peso de la web:** `jspdf` (~350 KB) se carga solo al pulsar el botón; la web del pasajero y la PWA no cambian de tamaño.
