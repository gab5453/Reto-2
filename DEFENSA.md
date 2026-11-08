# DEFENSA — Guía para presentar el Reto 2

Guion para la defensa de EcoAirlines v2: qué preparar, qué mostrar y en qué orden, y cómo responder las preguntas probables.
Detalle técnico: `ARQUITECTURA.md`, `EVENTOS.md` y `CRITERIOS.md`. Decisiones: `PLAN/PLAN.md` §7.

---

## 1. El mensaje en un minuto

> EcoAirlines pasó de un monolito en 4 capas a **18 servicios en TypeScript** que integran **REST, gRPC, SOAP, GraphQL y
> mensajería con CloudEvents**. Booking nos vende vuelos por el **contrato v2 del grupo**: les publicamos las 30 operaciones,
> les enviamos el stock en cada cambio y les avisamos por webhooks firmados. Cada compra es **una saga** con compensación, y se
> sigue de punta a punta con **un solo correlation ID**. Todo corre en **Azure** por menos de US$1 al día, y la web es una
> **PWA** que muestra el pase de abordar sin conexión.

---

## 2. Antes de la defensa (checklist)

| Cuándo | Qué | Cómo |
|--------|-----|------|
| El día anterior | Confirmar crédito de Azure | Portal → «Education» (`DESPLIEGUE_AZURE.md` §3.4) |
| **1 h antes** | **Encender la VM** (tras días apagada, Ubuntu aplica parches y responde lento al principio) | `az vm start -g rg-ecoairlines-reto2 -n vm-ecoairlines-reto2` |
| 1 h antes | Si cambiaste de red, autorizar tu IP para SSH | `DESPLIEGUE_AZURE.md` §6 |
| 30 min antes | Comprobar el nodo | `curl https://ecoairlines-reto2.northcentralus.cloudapp.azure.com/api/v2/vuelos/health` → `"status":"HEALTHY"` |
| 30 min antes | Abrir en pestañas: la web, Swagger (`/api/docs/`), Grafana (`/grafana/`, usuario `admin`) | Web: `admin@ecoairlines.test` / `EcoAdmin2026`. Grafana: `GRAFANA_ADMIN_PASSWORD` de `infra/cloud/.env`. **No proyectar ese archivo** |
| 30 min antes | Tener el teléfono con la PWA instalada y un pase ya abierto una vez | Ver §3, paso 6 |
| Al terminar | **Apagar la VM** (si no, sigue cobrando hasta las 23:00) | `az vm deallocate -g rg-ecoairlines-reto2 -n vm-ecoairlines-reto2` |

---

## 3. Guion de demostración (≈ 15 min)

### Paso 1 — La arquitectura (2 min)
Mostrar el diagrama de `ARQUITECTURA.md` §1 (o `PLAN/arquitectura-microservicios-v5.png`, con el despliegue en Azure). Recorrerlo de arriba abajo:
gateway → 5 MS de respuesta → ESB → 9 MS.G con su base cada uno. Señalar **dónde está cada tecnología** (§3 de ARQUITECTURA).

### Paso 2 — Booking compra por el contrato v2 (3 min)
En Git Bash (el secreto es `BOOKING_CLIENT_SECRET` de `infra/cloud/.env`):
```bash
U=https://ecoairlines-reto2.northcentralus.cloudapp.azure.com/api/v2
TOKEN=$(curl -s -u "BOOKING_PROTOTIPO:$SECRETO" -d grant_type=client_credentials $U/oauth2/token | sed 's/.*"access_token":"\([^"]*\)".*/\1/')
curl -s -X POST $U/vuelos/search -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Correlation-Id: corr-defensa-001' \
  -d '{"itineraries":[{"origin":"UIO","destination":"GYE","departureDate":"<fecha de mañana>"}],"passengers":{"adults":1}}'
```
O desde Swagger (`/api/docs/`) con «Authorize». Puntos a decir: el token es **OAuth2 `client_credentials`**; el
`X-Correlation-Id` vuelve igual en la respuesta; un recurso ajeno responde `404`.

### Paso 3 — Compra en la web con tarjeta (3 min)
En la web: buscar UIO → GYE, elegir asiento, **«Usar tarjeta de prueba»** (Aprobada) y pagar. Decir: la tarjeta va del navegador a
la Payment API; **a nuestros servicios solo llega la `paymentReference`**; el ESB captura el monto exacto dentro de la saga.
Luego, hacer el **check-in** y abrir el pase con su QR.

### Paso 4 — Una compra = una traza (3 min)
Grafana → Explore → Tempo → buscar por el correlation ID de la compra (o Administración → Telemetría en la web). Mostrar que la
traza cruza **gateway → MS.Reservas → ESB → Offers (gRPC) → Bookings**, y en Loki los logs con el mismo `correlation_id`.

### Paso 5 — Integración real con Booking y resiliencia (2 min)
- **Stock:** Administración → Operaciones o `GET /vuelos/health`: el stock se envía a Booking por REST con `NODE_VUE_EQ5` y
  queda 0 pendiente. Explicar que si Booking se cae, **la venta no se detiene**: se reintenta.
- **Alerta real** (opcional, por SSH): detener un servicio, mostrar `ServicioCaido` en Grafana a los ~75 s y el nodo `DEGRADED`;
  volver a levantarlo.
  ```bash
  ssh -p 2222 azureuser@ecoairlines-reto2.northcentralus.cloudapp.azure.com
  cd ~/reto2/infra && alias dc='docker compose -f docker-compose.yml -f cloud/docker-compose.cloud.yml --env-file cloud/.env'
  dc stop ms-g-post-sale     # … mostrar la alerta …     dc start ms-g-post-sale
  ```

### Paso 6 — PWA sin conexión (1 min)
En el teléfono: activar el **modo avión**, abrir EcoAirlines desde el ícono → «Viajes guardados» → el pase con su QR.
Decir qué se guarda (lo mínimo para abordar) y qué **nunca** (token, documento, tarjeta, salud), y que «Salir» lo borra (D52).

### Paso 7 — SOAP y gRPC por dentro (1 min, si lo piden)
- **SOAP:** `contract/ms-g-post-sale.wsdl`. En la VM: `curl -s http://localhost:4008/?wsdl | head` (no es público, a propósito).
- **gRPC:** `contract/ms-g-offers.proto` y la traza del paso 4 (los spans de gRPC entre el ESB y Offers).

---

## 4. Preguntas probables

**¿Era necesario pasar a microservicios?**
Técnicamente no: la carga es mínima y el monolito ya tenía los dominios aislados. Lo hicimos porque el objetivo del Reto 2 es
**integrar tecnologías distintas**, y eso solo tiene sentido entre procesos separados (PLAN §1). Lo hicimos contenido: librería
común, una sola imagen Docker para todos, un `docker compose up`, y migración por fases.

**¿Para qué un ESB si hay microservicios?**
Para que los MS.G **no se conozcan entre sí**: toda coordinación (sagas, composición) vive en un lugar. Una prueba de
arquitectura falla si un MS.G llama a otro.

**¿Qué pasa si falla un paso a mitad de una compra?**
La saga compensa en orden inverso: libera asientos y referencia de pago, anula o reembolsa, y publica `booking.failed`. El
estado de cada saga está en `saga_log`, así que un reinicio no la deja a medias.

**¿Y si Booking manda el mismo evento dos veces, o dos clientes piden el mismo asiento?**
Cuatro capas (EVENTOS §5): `inbound_events` por `id`, sagas idempotentes, referencia de pago única y cambio de estado del
asiento atómico en Offers. Lo último no es idempotencia: es control de concurrencia.

**¿Cómo cumplen el timeout de 5 s de Booking?**
Las sagas tienen un plazo de 3,5 s; si no alcanzan, responden `202` con el estado pendiente y terminan en segundo plano por
una cola diferida. El health se sirve desde caché (< 1 s).

**¿Por qué una VM y no Kubernetes o Container Apps?**
Por costo (D48): con un servicio siempre encendido por componente, Container Apps costaba US$100–130 al mes, más que todo el
crédito (US$90). La VM cuesta ≈US$0,034 por hora y se apaga entre pruebas.

**¿Por qué el contrato pedía gRPC para el stock y ustedes usan REST?**
Porque **Booking** publicó ese canal en Azure el 03/11 para todos los equipos; su servidor gRPC nunca fue alcanzable desde
Internet (BKG-13). El gRPC quedó como alternativa en el código (D53). Nuestro requisito de gRPC lo cumple el ESB → Offers.

**¿Cómo protegen los datos?**
Tres tipos de token RS256 con JWKS; el dueño sale del token, nunca del cuerpo; tarjetas solo en la Payment API; la asistencia
médica no sale en webhooks, logs ni trazas; secretos derivados o cifrados; solo Caddy es público en la VM.

---

## 5. Limitaciones (decirlas antes de que las encuentren)

| Limitación | Por qué | Qué se hizo |
|------------|---------|-------------|
| Webhooks y eventos de Booking aún no en real | Booking los activa «en unos días» (BKG-15) | Probados de punta a punta con `booking-simulado` |
| Una sola VM de 4 GiB | Presupuesto | Reinicio automático, alertas; un despliegue tarda ~30 min porque compila en la VM |
| Sin CI/CD activo | Decisión del responsable (en pausa) | El workflow por servicio está escrito |
| La VM se apaga a las 23:00 | Cuidar el crédito | Encender antes de cada prueba con Booking |
| Auditoría externa pendiente | — | Ver `CRITERIOS.md` §6 |
