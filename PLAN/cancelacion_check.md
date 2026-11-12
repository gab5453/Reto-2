# PLAN — Cancelar y modificar después del check-in

| | |
|---|---|
| Fecha | 12/11/2026 |
| Estado | **Aprobado (12/11)** con K-0 = **A**. **Completo: K-1 a K-4 hechas (12/11)**. Falta que el responsable despliegue y avise a Booking |
| Origen | Mensaje de Booking del 12/11 y decisión del responsable de quitar la regla D55 para estandarizarse con el resto del grupo |
| Qué cambia | **D55 se revoca** y se registra **D56** en `PLAN/PLAN.md`. Booking ve un cambio de comportamiento: después del check-in ya puede cancelar (y modificar, según la tabla de la sección 2) |
| Qué NO cambia | Los *holds* (ver sección 1.1). La política de reembolso de cada tarifa. Lo que ya voló no se cancela ni se modifica |
| Costo | **US$0**: no se crea ningún recurso |

---

## 1. Contexto

Booking escribió el 12/11:

> «Permiten que dos holds tengan el mismo asiento a la vez. […] Pedido: un asiento solo puede estar en un hold activo.»
> «Cancelar después del check-in responde 409 sin explicación. Pedido: devolver code y detail.»

### 1.1 Los holds: se omiten (decisión del responsable)

Un *hold* retiene **cupos** de una cabina, no asientos concretos (el contrato del grupo no lleva asientos en el *hold*); el asiento se
asigna al crear la reserva. **No se puede vender un asiento dos veces**: Offers tiene un índice único `(segment_id, seat_number)` y
el segundo recibe `SEAT_TAKEN` **antes de cobrar** (la prueba E2E **E-2** lo comprueba en cada CI). El mismo Booking indica que no les
afecta. Retener asientos concretos desde el *hold* sería un cambio de diseño y de contrato: **queda fuera de este plan**.

### 1.2 El 409 «sin explicación»

Respondemos `409` con `code: CUTOFF_PASSED` y un `title`, pero **sin `detail`**. Al quitar la regla ese 409 desaparece para la
cancelación; igual, todo error de la postventa tiene que llevar `code` y `detail` (fase K-1).

### 1.3 Hallazgo: el check-in no se anula al cancelar

Hoy el administrador ya puede cancelar una reserva con check-in (`adminCancelBooking`, `SAGA_COMPENSATION`, `FLIGHT_CANCELLED`), pero
la saga de cancelación **no deshace el check-in**: el pasajero conserva un **pase de abordar válido** de una reserva cancelada. MS.G.CheckIn
solo sabe deshacer lo que registró una saga (compensación), no **anular** un check-in. Al permitir que cualquier cliente cancele
después del check-in, esto pasa de raro a frecuente: **corregirlo es condición** de quitar la regla.

---

## 2. Regla nueva (aprobada por el responsable el 12/11)

| Operación después del check-in | Regla |
|---|---|
| **Cancelar** | Se permite, con la política de reembolso de su tarifa. El check-in **se anula**: los pases de abordar dejan de ser válidos y los asientos vuelven a `AVAILABLE` |
| **Cambiar fecha** | Se permite. El check-in del vuelo viejo se anula; el pasajero hace check-in en el nuevo |
| **Cambiar asiento** | **Sigue bloqueado** (contrato del grupo, `changeSeats`), con un 409 `CUTOFF_PASSED` que explica el motivo en `detail` (K-0 = A) |
| **Maletas y asistencia** | Se permiten. El check-in sigue válido (el pase no cambia) |

Sin cambios: el check-in abre 48 h antes y cierra a la salida; un tramo que ya voló no se cancela ni se modifica
(`FLIGHT_ALREADY_DEPARTED`).

---

## 3. Fases

### K-1 · Cancelar después del check-in (backend) — ✅ HECHA (12/11)

- **MS.G.CheckIn — anular un check-in:** operación nueva (p. ej. `POST /check-ins/{bookingId}/void`, con `segmentIds` y
  `passengerIds` opcionales; sin ellos, toda la reserva). Marca el check-in como **anulado** (no lo borra: queda la historia) e
  idempotente por `sagaId`. Los pases de una reserva anulada responden `409 BOARDING_PASS_NOT_AVAILABLE` con `detail`.
- **ESB — saga de cancelación:** se quita `assertNotCheckedIn`. Nuevo paso `check-in.void` **para toda cancelación** (también la del
  administrador y la de vuelo cancelado: así se corrige el hallazgo 1.3), con su compensación. Offers ya libera los asientos
  `CHECKED_IN` (`ReleaseBookingInventory`).
- **MS.G.Bookings:** se quita el bloqueo de cancelación por check-in.
- **Errores con `code` y `detail`:** todo `ProblemDetails` de la postventa (ESB y Bookings) lleva `detail` (pedido de Booking).
- **Pruebas:** unitarias de la regla; integración de la saga (cancelar con check-in → cancelada, check-in anulado, asientos libres,
  pases 409; la compensación revierte); la cancelación del administrador anula el check-in.

### K-2 · Modificar después del check-in (backend) — ✅ HECHA (12/11)

- **Cambiar fecha:** se quita el bloqueo; la saga anula el check-in de los tramos reemplazados (Bookings ya quita esos tramos de
  `checkedIn`).
- **Maletas y asistencia:** se quita el bloqueo; el check-in no se toca.
- **Cambiar asiento:** sigue bloqueado (K-0 = A), con `detail`.
- **Nota:** con asistencia pedida después del check-in, el grupo de abordaje del pase ya emitido no se recalcula.
- **Pruebas:** integración de cada operación con check-in previo.

### K-3 · Web y PWA — ✅ HECHA (12/11)

- Detalle de la reserva: se quita el aviso «Ya hiciste check-in: tu reserva ya no se puede modificar» y vuelven las pestañas.
- Avisos antes de confirmar: al **cancelar** («tus pases de abordar dejarán de ser válidos») y al **cambiar la fecha** («tendrás
  que volver a hacer el check-in»).
- **PWA:** al ver una reserva cancelada o un check-in anulado, se borran del dispositivo sus pases guardados (que no quede un pase
  válido sin conexión de una reserva cancelada).
- Pruebas de la web (Vitest).

### K-4 · Contrato, E2E, documentación y despliegue — ✅ HECHA (12/11), salvo el despliegue (responsable)

> Adelantado en K-1 para no dejar la CI en rojo: **E-3** ya prueba la cancelación después del check-in.

- **Contrato** (`vuelos-openapi-v2.yaml`): el contrato **no** bloqueaba cancelar ni cambiar la fecha después del check-in (D55 era
  solo nuestra). Se documentó la anulación del check-in en `cancelBooking` y `confirmDateChange` y una fila en §13. `changeSeats` ya
  decía lo de K-0 = A: no cambia.
- **E2E:** **E-3** pasa a «el pasajero hace check-in, cancela, y su pase deja de ser válido (también sin conexión)»; la conformidad v2
  cubre la cancelación con check-in.
- **Documentación:** D55 revocada y **D56** en `PLAN/PLAN.md`; `CAMBIOS.md`; `Pruebas.md` (E-3).
- **Despliegue** con `desplegar-imagenes.sh` (el responsable) y **aviso a Booking**: ya pueden cancelar después del check-in.

---

## 4. Decisión K-0 (resuelta: **A**, 12/11)

| # | Pregunta | Opciones | Recomendación |
|---|---|---|---|
| **K-0** | **Cambiar asiento después del check-in.** El contrato del grupo dice en `changeSeats`: *«No permitido después del check-in del segmento (409 `CUTOFF_PASSED`)»* | **A.** Seguir el contrato: sigue bloqueado, pero el 409 lleva `code` y `detail` claros. **B.** Permitirlo anulando el check-in de ese tramo (el pasajero lo vuelve a hacer) y cambiar el contrato | **A**: el objetivo es estandarizarse con el grupo, y esta regla **sí** está en el contrato que comparten. La de cancelar (D55) era solo nuestra |

---

## 5. Riesgos

- **Un pase de abordar ya impreso o guardado** sigue existiendo en papel o en el teléfono. Lo que cambia es que el sistema ya no lo
  reconoce (pases `409`) y la PWA lo borra al conectarse.
- **Booking** recibe `booking.cancelled` de reservas con check-in: hay que avisarles antes del despliegue.
- Cambios de comportamiento en una semana de pruebas con Booking: desplegar en un horario acordado.
