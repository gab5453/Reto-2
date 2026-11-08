# PLAN — Corrección de los errores de la prueba de usuario

| | |
|---|---|
| Fecha | 08/11/2026 (replanteado el mismo día con las decisiones del responsable) |
| Estado | **Completo: C-1, C-2 y C-3 hechas (08/11)**, desplegadas y verificadas contra la nube (ver `CAMBIOS.md`). Falta publicar la web, la auditoría y el commit |
| Origen | Prueba de usuario del 08/11 con `demo@ecoairlines.test` y `admin@ecoairlines.test`. Reservas `X3J2U7` (UIO → MAD, Bosque) y `FFT8J6` (GYE → LIM, Semilla: check-in y después cancelada); ruta `EA304-EA305` (UIO ⇄ MAD, Boeing 787-9, HC-W01) |
| Qué NO cambia | El contrato del grupo (`vuelos-openapi-v2.yaml`). Booking ve un único cambio de comportamiento, el de D-C2: después del check-in no puede cancelar a pedido del cliente |
| Costo | **US$0**: no se crea ningún recurso |

---

## 1. Resumen

Revisé cada error contra el código y contra los datos reales de la nube. **Siete se confirman; el 2 no es lo que parece**: el
sistema respeta los 90 minutos, pero la pantalla lo presenta de forma engañosa. Con la decisión D-C2 se agrega un punto nuevo (9).

| # | Error | Veredicto | Causa | Dónde se arregla | Fase |
|---|---|---|---|---|---|
| 1 | F5 o una URL directa cierra la sesión | ✅ Confirmado (era a propósito) | El token vive solo en memoria | Web | C-1 |
| 2 | Madrid: 35 min de escala para un 787-9 que necesita 90 | ⚠️ **Es de presentación**, no de validación | El avión llega el **jueves** 12:25 y la vuelta sale el **viernes** 13:00 (24 h 35 min en tierra). La lista muestra solo «Mié» y las horas | Schedule + gateway + web | C-3 |
| 3 | Reserva cancelada con el banner «¡Reserva confirmada!» | ✅ Confirmado | El banner depende de que *se acaba de reservar*, no del estado | Web | C-1 |
| 4 | Tramo «Emitido» con el boleto anulado | ✅ Confirmado | Bookings anula el boleto, no el cupón; el contrato del grupo no tiene estado anulado para el cupón | Web | C-1 |
| 5 | El cliente no ve el reembolso | ✅ Confirmado | El dato existe (`Booking.refunds`), la página no lo pide | Web | C-1 |
| 6 | El motivo de cancelación no queda en el historial | ✅ Confirmado | Bookings recibe el motivo y guarda solo el código | MS.G.Bookings | C-2 |
| 7 | El asiento se asigna al reservar, no en el check-in | ✅ Confirmado: el **texto** está mal | Offers asigna al reservar; el texto del pago dice «en el check-in». Con D-C2, el comportamiento se queda y se corrige el texto | Web | C-1 |
| 8 | «Ingresos» ignora la penalidad retenida | ✅ Confirmado | Solo suma reservas activas; una cancelada desaparece entera | MS.G.Bookings + web | C-2 |
| 9 | *(Nuevo, D-C2)* Después del check-in se puede cambiar la fecha, agregar equipaje y cancelar | Hoy solo se bloquean el asiento y la asistencia | Faltan las reglas en el ESB y en Bookings | ESB + MS.G.Bookings + web | C-2 |

---

## 2. Detalle de cada punto

### 1 · La sesión se pierde al recargar → `sessionStorage` (D-C1)

`AuthContext.tsx` guarda el token solo en memoria. Pasa a guardarse también en **`sessionStorage`**:
- sobrevive a F5 y a una URL directa **en la misma pestaña**, y se borra al cerrarla;
- al cargar, se descarta si el JWT ya venció (dura 1 hora), y la sesión se cierra sola al vencer, como hoy;
- «Salir» lo borra. Nunca se guarda en `localStorage`.

**Riesgo que se acepta:** un script inyectado (XSS) podría leer el token, pero ese mismo script ya podría usar la sesión abierta. Se
registra como **D54** en `PLAN/PLAN.md` (precisa la nota de D52 sobre el token en memoria).

### 2 · La «escala» de 35 minutos en Madrid

Lo que pasa de verdad (consultado en la nube):

| Vuelo | Sale | Llega |
|---|---|---|
| EA304 UIO → MAD | **mié 11/11** 19:00 (Quito) | **jue 12/11** 12:25 (Madrid) |
| EA305 MAD → UIO | **vie 13/11** 13:00 (Madrid) | vie 13/11 18:25 (Quito) |

El planificador vio que a las 13:00 del jueves el avión no está listo (12:25 + 90 min = 13:55) y **pasó la vuelta al día
siguiente**. La lista de rutas muestra «EA304 19:00 → 12:25 +1 · EA305 13:00 → 18:25 · Mié», y eso se lee como 35 minutos.

**Cambios:**
- **MS.G.Schedule** (contrato propio, aditivo): cada ruta devuelve `inbound.weekdays` y `groundMinutes` (tiempo real en tierra en
  destino).
- **Gateway:** expone los dos campos en `ScheduledRoute`.
- **Web (Rutas):**
  - la lista muestra «Ida: Mié · Vuelta: Vie» y «En tierra en MAD: 24 h 35 min»;
  - al crear o editar se avisa: «La vuelta no cabe el mismo día (el 787-9 necesita 90 min en tierra): saldrá el viernes».
  - *Al implementarlo:* el aviso sale **al guardar**, no antes. La web no conoce los husos horarios de los aeropuertos y calcularlo
    ahí duplicaría las reglas del horario. El formulario explica de antemano los tiempos mínimos en tierra, y el mensaje al guardar
    dice qué día sale la vuelta y cuánto tiempo queda el avión en tierra. Una ruta recién creada no tiene cupos vendidos: se edita al
    instante si no conviene.

### 3 · Banner «¡Reserva confirmada!» en una reserva cancelada

El banner de éxito se muestra **solo si la reserva está `CONFIRMED`**. Al terminar una cancelación, un cambio o un check-in, se borra
`justBooked` del historial del navegador (`navigate(…, { replace: true, state: null })`). Archivo: `pages/BookingDetailPage.tsx`.

### 4 · Tramo «Emitido» con el boleto anulado

El estado de cada tramo se muestra **según el boleto**: si el boleto está anulado o reembolsado, el tramo dice «Anulado» o
«Reembolsado»; si no, el estado de su cupón. Se aplica en el detalle del cliente. (Al implementarlo se comprobó que el detalle del
administrador no muestra el estado de los tramos, solo el del boleto: no tenía el problema.) No se toca el backend porque el estado del cupón (`PENDING, ISSUED, FAILED`) es del contrato del grupo. Se anota en
`HALLAZGOS.md` como sugerencia: agregar `VOIDED` al cupón en una versión futura.

### 5 · El cliente no ve el reembolso

La consulta del detalle pide `refunds`. En una reserva cancelada aparece la tarjeta **«Reembolso»** con:
- el monto devuelto;
- la penalidad retenida;
- el estado en palabras: «Acreditado a tu tarjeta» (SETTLED), «Lo acredita Booking» (CALCULATED) o «Tarifa no reembolsable»
  (NOT_REFUNDABLE).

Con `FFT8J6`: devuelto **31,80**, retenido **132,00**.

### 6 · El motivo de cancelación en el historial

Bookings guarda «Reserva cancelada a pedido del cliente: «<motivo>».». El código se traduce: CUSTOMER_REQUEST → «a pedido del
cliente», FLIGHT_CANCELLED → «por cancelación del vuelo», SAGA_COMPENSATION → «por Booking (combo cancelado)», OTHER → «por otro
motivo». El motivo no se escribe en los logs; solo queda en la reserva, que ven su dueño y el administrador.

### 7 · El asiento: se elige al reservar y se cambia hasta el check-in (D-C2)

**Decisión:** el asiento es **opcional** al pagar. Si el cliente no elige, **se le asigna uno al confirmar la reserva**: es lo que ya
hace Offers, y sirve también para Booking, que no elige asientos. **Hasta el check-in puede cambiarlo; después, no.**

**Lo que ya funciona** (no se toca):
- la asignación automática al reservar;
- el panel «Cambiar asiento» antes del check-in;
- el bloqueo del cambio de asiento después del check-in (`CUTOFF_PASSED` en Bookings).

**Cambios:**
- **Texto del pago:** «Elegir asiento es opcional: si no eliges, te asignamos uno al confirmar. Puedes cambiarlo hasta hacer el
  check-in».
- **Confirmación:** el detalle muestra el asiento asignado de cada pasajero, con el aviso «Asignado automáticamente · puedes cambiarlo
  hasta el check-in».
- **`PLAN.md`:** se corrige AR-02. El check-in asigna asiento solo a quien no lo tiene, lo que hoy pasa únicamente tras un cambio de
  fecha.

### 8 · «Ingresos» = cobrado − reembolsado (D-C3)

`summary()` de Bookings usa la misma regla que Reportes (O-3). Cuenta toda reserva cobrada; no entran FAILED ni las pendientes de
pago. **Ingresos = cobrado − reembolsado**, así que una cancelada aporta su penalidad y una no reembolsable aporta todo. «Ingresos por
ruta» usa la misma regla, y la tarjeta del panel pasa a decir «Ingresos netos (cobrado − reembolsos)». Con `FFT8J6`, los 132,00
retenidos empiezan a contar. La prueba de indicadores se ajusta a los números nuevos.

### 9 · Después del check-in no se modifica nada (D-C2)

**Regla:** si **algún** pasajero de la reserva ya hizo check-in, el cliente no puede:

| Acción | Hoy | Con el cambio |
|---|---|---|
| Cambiar asiento | Bloqueado ✅ | Bloqueado |
| Asistencia médica | Bloqueada ✅ | Bloqueada |
| Cambiar la fecha | **Permitido** | Bloqueado |
| Agregar equipaje | **Permitido** | Bloqueado |
| Cancelar | **Permitido** (así se canceló `FFT8J6`) | Bloqueado |

Lo bloqueo para **toda la reserva** (no por tramo) porque dijiste «nada». En un viaje de ida y vuelta, el check-in de la ida bloquea
también cambiar la vuelta. Si prefieres que la vuelta siga siendo modificable, dímelo.

**Dónde va la regla:**
- **ESB** (sagas de cambio de fecha, equipaje y cancelación): se revisa **en el primer paso**, antes de cobrar nada. Así nunca se cobra
  un cambio que después se rechaza. Responde `409 CUTOFF_PASSED` («Ya hiciste check-in: la reserva no se puede modificar»).
- **MS.G.Bookings:** la misma regla como última defensa en `applyDateChange`, `applyBaggage` y `applyCancellation`.
- **Excepciones** (no las pide el cliente): la cancelación por **vuelo cancelado** (`FLIGHT_CANCELLED`, la hace EcoAirlines) y la
  **compensación de Booking** (`SAGA_COMPENSATION`, deshace un combo) siguen funcionando.
- **Booking:** si intenta cancelar a pedido del cliente una reserva con check-in, recibe `409 CUTOFF_PASSED`. El código ya existe en
  el contrato del grupo, así que no cambia el contrato.
- **Web:** con check-in hecho, el detalle oculta las pestañas «Asiento», «Equipaje», «Asistencia», «Cambiar fecha» y «Cancelar».
  Deja «Check-in» (los pases) y el aviso «Ya hiciste check-in: tu reserva ya no se puede modificar».
- Se registra como **D55** en `PLAN/PLAN.md`.

### Observación adicional · el texto de Semilla

Semilla dice «Sin cambios ni reembolso», pero `FFT8J6` devolvió 31,80. Es correcto: son los **impuestos**, que se devuelven siempre.
El texto pasa a decir «Sin cambios. Si cancelas, solo se devuelven los impuestos». La regla no cambia. Va en C-1.

---

## 3. Decisiones (tomadas el 08/11)

| # | Decisión | Resultado |
|---|---|---|
| D-C1 | Sesión al recargar | **`sessionStorage`** (por pestaña, vence con el JWT de 1 h) → D54 |
| D-C2 | Asientos y check-in | Asiento **opcional al reservar** (automático si no se elige), **cambiable hasta el check-in**. Después del check-in **nada se modifica, ni la cancelación** → D55 |
| D-C3 | Ingresos | **Cobrado − reembolsado** (igual que Reportes) |

---

## 4. Fases

| Fase | Contenido | Verificación |
|---|---|---|
| **C-1** ✅ · Web | Puntos 1, 3, 4, 5 y 7, y el texto de Semilla | `tsc`, lint y build. Recorrido en Edge con el cliente demo: F5 y URL directa mantienen la sesión; «Salir» la borra; `FFT8J6` sin banner, tramo «Anulado» y tarjeta de reembolso 31,80 / 132,00; el texto del pago y el aviso de asiento automático |
| **C-2** ✅ · Backend | Puntos 6, 8 y 9 (ESB, Bookings y las pestañas de la web), con sus pruebas | Pruebas nuevas: el historial guarda el motivo; los ingresos cuadran con el reporte de ventas (incluye la penalidad); con check-in, el cambio de fecha, el equipaje y la cancelación responden `409 CUTOFF_PASSED` **sin cobrar**, y la cancelación por vuelo cancelado sigue funcionando. En Edge: reservar → check-in → las pestañas desaparecen |
| **C-3** ✅ · Rutas | Punto 2 (Schedule, gateway y web) | Prueba de Schedule: UIO ⇄ MAD devuelve vuelta el viernes y 1.475 min en tierra. En Edge: la lista y el aviso al crear |

Al final de cada fase: `npm test` completo, despliegue en la VM, recorrido en Edge contra la nube, registro en `CAMBIOS.md` y, si me
lo pides, commit. Orden propuesto: **C-1 → C-2 → C-3**.

**Contratos:** solo los propios y de forma aditiva (`ms-g-schedule.openapi.yaml` y `gateway.graphql` en C-3). El contrato del grupo
no cambia.
