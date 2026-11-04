# PRUEBASSW — Guía de pruebas de la API con Swagger

## 1. Para qué sirve este documento

Sirve para demostrar, en local o en la nube, que la API hace lo que promete el contrato `contract/vuelos-openapi.yaml`:

1. **Que los flujos correctos funcionan:** buscar, bloquear un cupo, reservar, consultar, postventa, check-in y estado de vuelo.
2. **Que los errores responden bien:** cuando se envía algo incorrecto, la API debe contestar con el **código HTTP correcto**
   (400, 401, 403, 404, 409, 410, 422, 429) y con un cuerpo `ProblemDetails` que explique qué falló. No debe caerse (500) ni aceptar
   datos inválidos.
3. **Que la seguridad funciona:** sin token no se entra, sin el permiso (scope) correcto tampoco, y un usuario no ve los datos de otro.

Cada prueba indica **qué enviar**, **qué debe responder** y **por qué**. Las respuestas esperadas de la sección 6 no son teóricas: se
obtuvieron ejecutando cada caso contra la API el 06/10/2026. La sección 9 tiene una tabla para registrar el resultado de cada prueba.

---

## 2. Qué es Swagger y cómo está montado aquí

**Swagger UI** es una página web que lee un documento OpenAPI y genera un formulario por cada endpoint. Con el botón **"Try it out"**
se llena el formulario, se envía la petición real a la API y se ve la respuesta: status, headers y body. Sirve para probar sin
escribir código ni usar Postman.

En este proyecto:

| Elemento | Detalle |
|----------|---------|
| URL | **En la nube:** https://ecoairlines-api-gv-fjfaa7b5geg3hphs.brazilsouth-01.azurewebsites.net/docs · **En local:** http://localhost:3000/docs (con la API levantada) |
| Documento 1 | **"Contrato GDS Flight Core API"**: el YAML del contrato, **tal cual**, en `/docs/openapi.json`. Swagger no se genera desde el código, así que lo que se ve es exactamente lo acordado con el grupo |
| Documento 2 | **"Extensiones EcoAirlines"**: endpoints propios fuera del contrato (perfil, cambio de asiento, administración, rutas, flota, eventos, observabilidad), en `/docs/extensions.json`. Se elige en el selector de arriba a la derecha |
| Documento 3 | **"dev-auth: login y registro"**: el servidor de autenticación (otro servicio). Sirve para registrarse o iniciar sesión y obtener el token sin salir de Swagger (sección 3.2) |
| Servidor | Aparece primero la URL de esta API: la pública en la nube o `http://localhost:3000` en local. Los servidores del contrato siguen en la lista, pero no existen todavía |
| Autenticación | El contrato usa OAuth2, cuyo servidor de autorización todavía no existe. Por eso se agrega el esquema **`DevBearer`**, donde se pega el JWT (sección 3.2). Se agrega en memoria, sin tocar el archivo del contrato |
| Producción | Con `NODE_ENV=production` Swagger se **apaga** salvo `SWAGGER_ENABLED=true`. En Azure está encendido a propósito, para la evaluación, con `PUBLIC_API_URL` |

Cada endpoint en Swagger muestra:
- **Parameters:** path, query y headers (`Idempotency-Key`, `X-Device-Fingerprint`).
- **Request body:** con un ejemplo editable.
- **Responses:** todos los códigos que documenta el contrato. Sirven para comparar lo que llega con lo esperado.

---

## 3. Preparación

### 3.1 Abrir Swagger

**En la nube** no hay que levantar nada: abrir https://ecoairlines-api-gv-fjfaa7b5geg3hphs.brazilsouth-01.azurewebsites.net/docs.

> En la nube los datos se guardan en **PostgreSQL**: las reservas, holds y webhooks que crees en las pruebas **quedan guardados**. Y
> la prueba de `429` bloquea tu IP un minuto.

**En local**, desde la raíz del repositorio (`Reto 1/`):

```bash
npm install          # solo la primera vez
npm run start:dev    # compila y levanta la API en http://localhost:3000
```

Abrir **http://localhost:3000/docs**.

> En local, sin `DATABASE_URL`, los datos viven **en memoria**: al reiniciar la API se borran. Es útil para empezar desde cero.

### 3.2 Obtener un token (para los endpoints con candado 🔒)

**Opción A, con la terminal.** En otra terminal, desde la raíz:

```bash
npm run token                                                      # usuario dev-user-1, todos los scopes, 1 hora
npm run token -- --sub usuario-2                                   # otro usuario (para probar acceso ajeno)
npm run token -- --sub usuario-1 --scopes flights:read             # token con un solo permiso (para probar 403)
npm run token -- --sub admin-1 --scopes ecoairlines:admin          # administrador (extensiones)
```

**Opción B, sin terminal (desde el mismo Swagger):**
1. En el selector de arriba, elegir **"dev-auth: login y registro"**. Es otro servicio: en la nube ya está en línea; en local debe
   estar levantado (`cd dev-auth && npm start`, puerto 4000).
2. Abrir `POST /login` → **Try it out**. El ejemplo ya trae `demo@ecoairlines.test` / `EcoDemo2026` (hay un ejemplo de administrador)
   → **Execute**:
   - credenciales correctas → `200` con `access_token`;
   - contraseña incorrecta → `401`.
3. Para un cliente nuevo: `POST /register` con `name`, `email` y `password` (8 o más caracteres) → `201`. Repetir el correo → `409`.
4. Copiar el `access_token` y volver al documento de la API.

Los permisos del token dependen del rol:
- **Cliente:** reservar y consultar, y su perfil.
- **Administrador:** `/admin/*` y webhooks.
- Para tener **todos** los permisos a la vez, usar la opción A (`npm run token`).

El comando de la opción A imprime un texto largo (`eyJhbGciOi...`). En Swagger:

1. Clic en **Authorize** (arriba a la derecha).
2. En **DevBearer**, pegar el token **sin** la palabra `Bearer`.
3. **Authorize** → **Close**.

El token queda guardado aunque se recargue la página. Para cambiar de usuario: **Authorize → Logout** y pegar otro.

> **Ojo:** el documento "Extensiones EcoAirlines" tiene su propio esquema, **EcoAirlinesBearer**. Al cambiar de documento hay que
> volver a hacer **Authorize** con el mismo token. Si no, Swagger muestra `401` ("no autorizado").

| Scope | Permite |
|-------|---------|
| `flights:read` | Consultar holds, reservas, tickets, maletas, cotizaciones y pases |
| `flights:hold` | Crear y liberar holds |
| `flights:book` | Reservar, agregar maletas, cambiar fecha, check-in |
| `flights:cancel` | Cancelar reservas |
| `flights:webhooks` | Gestionar webhooks |
| `ecoairlines:profile` / `ecoairlines:admin` | Extensiones: perfil del cliente / administración |

### 3.3 Headers especiales

| Header | Dónde | Qué poner |
|--------|-------|-----------|
| `X-Device-Fingerprint` | `POST /search` | Cualquier texto, por ejemplo `swagger-test` |
| `Idempotency-Key` | `POST /offers/hold`, `/bookings`, `/baggage`, `/date-change`, `/cancel` | **Un UUID nuevo por cada operación distinta** |

Para generar un UUID:

```powershell
[guid]::NewGuid()                                   # PowerShell
node -e "console.log(crypto.randomUUID())"          # cualquier terminal
```

**Idempotencia:** si se repite la misma petición con la misma `Idempotency-Key`, la API devuelve la misma respuesta sin duplicar la
operación (útil si se cayó la red). Si se usa la misma key con **otro** body, responde `409`.

### 3.4 Fechas

Los vuelos se publican desde **hoy hasta hoy + 90 días** (91 días). En los ejemplos, `AAAA-MM-DD` significa "una fecha dentro de ese
rango"; por ejemplo, 30 días adelante. Para el check-in se necesita un vuelo que salga en **menos de 48 h** (mañana).

---

## 4. Cómo leer una respuesta de error

Todos los errores tienen el mismo formato, `application/problem+json`, con el schema `ProblemDetails` del contrato:

```json
{
  "type": "about:blank",
  "title": "La petición no cumple con las reglas de validación.",
  "status": 400,
  "code": "VALIDATION_FAILED",
  "invalidParams": [
    { "name": "itineraries.0.origin", "reason": "origin must match /^[A-Z]{3}$/ regular expression" }
  ]
}
```

| Campo | Significado |
|-------|-------------|
| `status` | El mismo código HTTP de la respuesta |
| `code` | Código de negocio del contrato (`VALIDATION_FAILED`, `SEAT_TAKEN`, `ALREADY_CANCELLED`…). Es lo que un cliente usa para decidir qué hacer |
| `title` / `detail` | Explicación legible |
| `invalidParams` | Qué campo falló y por qué |

Además, **toda respuesta** trae el header **`X-Request-Id`**: es el identificador de la petición en los logs de la API. Si una prueba
falla de forma rara, anotarlo en la tabla de resultados.

**Regla general de códigos:**

| Código | Significa | Ejemplo típico |
|--------|-----------|----------------|
| `400` | La **forma** de la petición está mal (falta un campo, tipo o formato incorrecto, propiedad no permitida) | Fecha `2026-13-40`, IATA en minúsculas |
| `401` | No hay token, o es inválido o expiró | Probar sin Authorize |
| `403` | El token es válido pero **no tiene el permiso** (scope) | Cancelar con un token solo de lectura |
| `404` | El recurso no existe **o es de otro usuario** (no se revela que existe) | Ver la reserva de otro usuario |
| `409` | Conflicto con el **estado actual** | Cancelar dos veces, hold ya usado, límite de maletas |
| `410` | El recurso **expiró** | Reservar con un hold de hace más de 15 min |
| `422` | La forma está bien, pero viola una **regla de negocio** | Adulto de 0 años, cédula inválida, pago rechazado |
| `429` | Demasiadas peticiones en poco tiempo | Más de 30 búsquedas por minuto |

---

## 5. Flujo correcto (camino feliz)

Hacer estos pasos en orden y guardar los IDs que se van obteniendo. Token: `npm run token` (todos los scopes).

### Paso 1 — Buscar vuelos · `POST /search` (público)
- Header `X-Device-Fingerprint`: `swagger-test`
- Body:
  ```json
  {
    "itineraries": [{ "origin": "UIO", "destination": "BOG", "departureDate": "AAAA-MM-DD" }],
    "passengers": { "adults": 1 }
  }
  ```
- **Esperado:** `200` con `offers[]`. Anotar `offers[0].offerId`, `offers[0].itineraries[0].itineraryId` y
  `offers[0].itineraries[0].segments[0].segmentId` (en un vuelo directo los tres son iguales, por ejemplo `EA104-20261105`).
- Ida y vuelta: dos elementos en `itineraries` (UIO→BOG y BOG→UIO). Aeropuertos: `UIO GYE CUE BOG MDE LIM SCL MIA MEX MAD`.

### Paso 2 — Mapa de asientos · `GET /offers/{offerId}/seatmap?segmentId=...` (público)
- **Esperado:** `200` con cabinas, filas y asientos (`isAvailable`). Anotar un asiento libre de ECONOMY (por ejemplo `12C`).

### Paso 3 — Bloquear el cupo · `POST /offers/hold` 🔒 `flights:hold`
- `Idempotency-Key`: UUID nuevo
- Body:
  ```json
  {
    "offerId": "EA104-20261105",
    "itinerarySelections": [{ "itineraryId": "EA104-20261105", "cabinClass": "ECONOMY", "fareBrand": "BROTE" }],
    "passengersBreakdown": { "adults": 1 }
  }
  ```
- **Esperado:** `201` con `holdId`, `status: HELD`, `ttlMinutes: 15` y `lockedPrice`. **El hold dura 15 minutos.**
- Familias tarifarias: `SEMILLA` (sin cambios ni reembolso), `BROTE` (cambios con cargo), `BOSQUE` (reembolsable) y `DOSEL` (business,
  `cabinClass: BUSINESS`).
- Consultarlo: `GET /offers/hold/{holdId}` → `200` con `remainingSeconds`.

### Paso 4 — Reservar · `POST /bookings` 🔒 `flights:book`
- `Idempotency-Key`: UUID nuevo
- Body (mismos tipos y cantidad de pasajeros que el hold):
  ```json
  {
    "holdId": "<holdId>",
    "passengers": [{
      "passengerId": "p1",
      "passengerType": "ADULT",
      "firstName": "Ana",
      "lastName": "Verde",
      "documentType": "PASSPORT",
      "documentNumber": "AB123456",
      "nationality": "EC",
      "birthDate": "1990-05-20",
      "gender": "F",
      "contact": { "email": "ana@example.com", "phone": "+593999999999" },
      "assignedSeats": [{ "segmentId": "EA104-20261105", "seatNumber": "12C" }],
      "extraBaggage": [{ "itineraryId": "EA104-20261105", "quantity": 1 }]
    }],
    "payment": { "paymentReference": "pay_prueba_001" }
  }
  ```
- **Esperado:** `201` con `bookingId`, `pnr`, `status: CONFIRMED` y `tickets` emitidos. Anotar el `bookingId`.
- `assignedSeats` y `extraBaggage` son opcionales.
- **Pagos simulados:** `pay_` + 3 a 64 caracteres = aprobado. Con `async` (`pay_async_001`) → `202 PENDING_PAYMENT`, que se confirma a
  los ~3 s. Con `declined` → rechazado. **Cada referencia se usa una sola vez.**

### Paso 5 — Consultas 🔒 `flights:read`
| Petición | Esperado |
|----------|----------|
| `GET /bookings` (`?pnr=`, `?status=`, `?limit=1..50`) | `200`, solo las reservas del usuario del token |
| `GET /bookings/{bookingId}` | `200` con pasajeros, asientos, tickets e historial |
| `GET /bookings/{bookingId}/tickets` y `/tickets/{ticketId}` | `200` |

### Paso 6 — Postventa
| Petición | Body | Esperado |
|----------|------|----------|
| `GET /bookings/{id}/baggage-options` | — | `200`: precio, máximo y compradas por pasajero y vuelo |
| `POST /bookings/{id}/baggage` + `Idempotency-Key` | `{"passengerId":"p1","itineraryId":"<itineraryId>","quantity":1,"payment":{"paymentReference":"pay_maleta_001"}}` | `200` con `totalBaggage` |
| `POST /bookings/{id}/date-change/search` | `{"changes":[{"itineraryId":"<itineraryId>","newDepartureDate":"AAAA-MM-DD"}]}` | `200` con opciones y `changeOfferId` (tarifa `BROTE` o superior) |
| `POST /bookings/{id}/date-change` + `Idempotency-Key` | `{"changeOfferId":"<id>","payment":{"paymentReference":"pay_cambio_001"}}` | `200`, la reserva queda con el nuevo vuelo |
| `GET /bookings/{id}/cancellation-quote` | — | `200` con `quoteId`, reembolso y penalidad (vale 15 min) |
| `POST /bookings/{id}/cancel` + `Idempotency-Key` | `{"quoteId":"<quoteId>","reason":"Prueba"}` | `200`, la reserva queda `CANCELLED` |

### Paso 7 — Check-in y pases 🔒
1. Repetir los pasos 1, 3 y 4 con un vuelo de **mañana**.
2. `POST /bookings/{id}/check-in` (sin body) → `200` con el estado del check-in.
3. `GET /bookings/{id}/boarding-passes` → `200` con los pases y su código de barras.

### Paso 8 — Estado de vuelo · `GET /flights/{flightNumber}/status?date=AAAA-MM-DD` (público)
- `EA104` y la fecha de mañana → `200` con horarios, terminal y estado.

### Paso 9 — Webhooks 🔒 `flights:webhooks`
| Petición | Esperado |
|----------|----------|
| `POST /webhooks` con `{"url":"https://example.com/hook","events":["booking.confirmed"],"secret":"una-clave-secreta-123"}` | `201` con `id` |
| `GET /webhooks` | `200`, solo los del usuario |
| `DELETE /webhooks/{id}` | `204` |

---

## 6. Pruebas de error (provocar 400, 401, 403, 404, 409, 410, 422 y 429)

Para cada caso: partir del ejemplo correcto de la sección 5, hacer **solo el cambio indicado** y comparar con la respuesta esperada.
Los `code` y `title` son los que devolvió la API al ejecutar estas pruebas.

### 6.1 Errores `400` — petición mal formada

| # | Endpoint | Cambio a introducir | Respuesta esperada |
|---|----------|---------------------|--------------------|
| E01 | `POST /search` | Borrar el valor de `X-Device-Fingerprint` | `400 VALIDATION_FAILED` · "El header X-Device-Fingerprint es requerido." |
| E02 | `POST /search` | `"origin": "uio"` (minúsculas) | `400` · `invalidParams: itineraries.0.origin` debe cumplir `^[A-Z]{3}$` |
| E03 | `POST /search` | `"passengers": { "adults": 0 }` | `400` · `passengers.adults` no puede ser menor a 1 |
| E04 | `POST /search` | Agregar `"promo": "X"` al body | `400` · "La petición contiene propiedades no permitidas por el contrato." (`additionalProperties: false`) |
| E05 | `POST /search` | Borrar el último `}` del body (JSON roto) | `400` · "El body no es un JSON válido." |
| E06 | `POST /search` | 7 elementos en `itineraries` | `400` · máximo 6 tramos |
| E07 | `GET /offers/{offerId}/seatmap` | Dejar vacío `segmentId` | `400` · `segmentId` es obligatorio |
| E08 | `POST /offers/hold` | Borrar `Idempotency-Key` o poner `123` | `400` · "El header Idempotency-Key es requerido y debe ser un UUID." |
| E09 | `POST /bookings` | Agregar `"ownerId": "otro"` al body | `400` · propiedad no permitida. **Seguridad:** el dueño sale del token, nunca del body |
| E10 | `POST /bookings` | Quitar `payment` | `400` · `payment` es obligatorio |
| E11 | `GET /bookings/{bookingId}` | `bookingId` = `abc` | `400` · "bookingId debe ser un UUID válido." |
| E12 | `GET /bookings` | `limit` = `51` | `400` · `limit` no puede ser mayor a 50 |
| E13 | `POST /bookings/{id}/baggage` | `"quantity": 0` | `400` · `quantity` no puede ser menor a 1 |
| E14 | `POST /webhooks` | `"events": ["booking.paid"]` | `400` · el evento debe ser uno de los 12 del contrato |
| E15 | `GET /flights/EA104/status` | Sin el parámetro `date` | `400` · `date` debe ser una fecha válida (AAAA-MM-DD) |

### 6.2 Errores `401` y `403` — autenticación y permisos

| # | Cómo provocarlo | Respuesta esperada |
|---|-----------------|--------------------|
| E16 | **Authorize → Logout** y ejecutar `POST /offers/hold` | `401` · "Falta el header Authorization Bearer." |
| E17 | Authorize con un token inventado (`abc.def.ghi`) | `401` · "Token inválido o expirado." |
| E18 | Token de `npm run token -- --scopes flights:read` y ejecutar `POST /offers/hold` | `403` · "El token no posee los scopes requeridos." |
| E19 | Mismo token de solo lectura y `POST /bookings/{id}/cancel` | `403` |
| E20 | Documento "Extensiones" → `GET /admin/flights` con token de cliente (sin `ecoairlines:admin`) | `403` |

> En 401 y 403 el `code` es `VALIDATION_FAILED` porque el enum del contrato no tiene códigos de autenticación (HALLAZGOS HALL-02 y HALL-05).

### 6.3 Errores `404` — no existe o no es tuyo

| # | Cómo provocarlo | Respuesta esperada |
|---|-----------------|--------------------|
| E21 | `GET /offers/NOEXISTE/seatmap?segmentId=EA104-...` | `404` · "Oferta o segmento no encontrado." |
| E22 | `GET /offers/hold/{UUID inventado}` | `404` · "Hold no encontrado." |
| E23 | Crear un hold con el usuario 1 y consultarlo con un token de `--sub usuario-2` | `404` (no `403`: no se revela que existe) |
| E24 | `GET /bookings/{bookingId}` de otro usuario (token `--sub usuario-2`) | `404` · "Reserva no encontrada." |
| E25 | `GET /bookings/{id}/tickets/{UUID inventado}` | `404` · "Ticket no encontrado." |
| E26 | `GET /bookings/{id}/boarding-passes` sin haber hecho check-in | `404 BOARDING_PASS_NOT_AVAILABLE` |
| E27 | `GET /flights/EA999/status?date=...` | `404 FLIGHT_STATUS_NOT_AVAILABLE` |
| E28 | Abrir `http://localhost:3000/no-existe` | `404` en formato ProblemDetails (nunca una página HTML) |
| E29 | Extensiones → `GET /customers/me` con un usuario que nunca guardó su perfil | `404` · "El cliente todavía no registró su perfil." |

### 6.4 Errores `409` — conflicto con el estado actual

| # | Cómo provocarlo | Respuesta esperada |
|---|-----------------|--------------------|
| E30 | Repetir `POST /offers/hold` con la **misma** `Idempotency-Key` pero otro body | `409` · "El Idempotency-Key ya fue utilizado con una solicitud diferente." (con el mismo body: `201`, la misma respuesta) |
| E31 | `POST /bookings` con un `holdId` que ya se usó en una reserva | `409 OFFER_NO_LONGER_AVAILABLE` · "El hold ya fue utilizado o liberado." |
| E32 | Dos reservas eligiendo el **mismo asiento** en el mismo vuelo (dos usuarios) | `409 SEAT_TAKEN` |
| E33 | `POST /bookings/{id}/baggage` hasta superar 3 maletas extra en un vuelo | `409 BAGGAGE_LIMIT_EXCEEDED` |
| E34 | `POST /bookings/{id}/date-change/search` sobre una reserva con tarifa `SEMILLA` | `409 FARE_NOT_CHANGEABLE` |
| E35 | `POST /bookings/{id}/date-change` con `"changeOfferId": "NOEXISTE"` | `409` · "La oferta de cambio no existe para esta reserva." |
| E36 | `POST /bookings/{id}/cancel` con un `quoteId` inventado | `409` · "La cotización de cancelación no existe para esta reserva." |
| E37 | Cancelar la misma reserva **dos veces** | `409 ALREADY_CANCELLED` |

### 6.5 Errores `410` — expirado (requieren esperar 15 minutos)

| # | Cómo provocarlo | Respuesta esperada |
|---|-----------------|--------------------|
| E38 | Crear un hold, esperar **más de 15 min** y hacer `POST /bookings` | `410`; luego `GET /offers/hold/{holdId}` muestra `status: EXPIRED` |
| E39 | `date-change/search`, esperar 15 min y confirmar con ese `changeOfferId` | `410 CHANGE_OFFER_EXPIRED` |
| E40 | `cancellation-quote`, esperar 15 min y cancelar con ese `quoteId` | `409 QUOTE_EXPIRED`. Es `409` y no `410` porque el contrato no documenta `410` para `POST /cancel` |

> Las pruebas automáticas (`npm run test:e2e`) cubren estos casos adelantando el reloj, sin esperar.

### 6.6 Errores `422` — reglas de negocio

| # | Endpoint | Cambio a introducir | Respuesta esperada |
|---|----------|---------------------|--------------------|
| E41 | `POST /offers/hold` | `"fareBrand": "ORO"` | `422` · "La cabina o familia tarifaria no existe en la oferta." |
| E42 | `POST /bookings` | `holdId` = UUID inventado | `422` · "El hold no existe o no pertenece al usuario." |
| E43 | `POST /bookings` | 2 pasajeros para un hold de 1 adulto | `422` · "Los pasajeros no coinciden con los retenidos en el hold." |
| E44 | `POST /bookings` | Adulto con `"birthDate"` de este año | `422` · "La edad del pasajero 1 (0 años el día del vuelo) no corresponde a Adulto (15 años o más)." |
| E45 | `POST /bookings` | `"documentType": "NATIONAL_ID"`, `"documentNumber": "1710034066"` (dígito verificador incorrecto) | `422` · "La cédula ecuatoriana no es válida." (con `1710034065`, que es válida, pasa) |
| E46 | `POST /bookings` | Dos pasajeros con el mismo `documentNumber` | `422` · "El documento … está repetido: lo tienen los pasajeros 1 y 2." |
| E47 | `POST /bookings` | La misma persona (mismo documento) en otra reserva del mismo vuelo | `422` · "El pasajero 1 ya tiene una reserva en el vuelo …" |
| E48 | `POST /bookings` | Un infante con `assignedSeats` | `422 INFANT_SEAT_NOT_ALLOWED` |
| E49 | `POST /bookings` | Asiento de BUSINESS (filas 1–3; en el 787-9, filas 1–7) con tarifa ECONOMY | `422 SEAT_CABIN_MISMATCH` |
| E50 | `POST /bookings` | `"paymentReference": "abc"` (o una ya usada) | `422 PAYMENT_REFERENCE_INVALID` |
| E51 | `POST /bookings` | `"paymentReference": "pay_declined_001"` | `422 PAYMENT_NOT_AUTHORIZED` |
| E52 | `POST /bookings/{id}/check-in` | Reserva de un vuelo a más de 48 h | `422 CHECK_IN_NOT_AVAILABLE` · "El check-in abre 48 h antes de la salida." |

Rangos de edad: adulto 15+, joven 12–14, niño 2–11, infante menor de 2 durante todo el viaje (HALLAZGOS EXT-04).

### 6.7 Error `429` — demasiadas peticiones

| # | Cómo provocarlo | Respuesta esperada |
|---|-----------------|--------------------|
| E53 | Ejecutar `POST /search` **más de 30 veces en un minuto** (clic repetido en Execute) | `429 RATE_LIMIT_EXCEEDED` con el header `Retry-After: 60`. Después de un minuto vuelve a funcionar |

Límites: 30 búsquedas/min, 60 mapas de asientos/min y 300 peticiones/min en total, por IP.

### 6.8 Casos que **no** son error (respuesta `200` vacía)

Estas búsquedas responden `200` con `{"totalOffers":0,"offers":[]}`, porque el contrato no define un error para ellas:
- fecha pasada (`2020-01-01`);
- origen igual al destino (`UIO → UIO`);
- fecha fuera de los 91 días publicados.

---

## 7. Extensiones EcoAirlines (fuera del contrato)

En el selector de Swagger elegir **"Extensiones EcoAirlines"**. Son endpoints propios que el contrato no tiene (HALLAZGOS EXT-01).

| Endpoint | Token | Prueba sugerida |
|----------|-------|-----------------|
| `GET / PUT /customers/me` | `ecoairlines:profile` | Guardar el perfil y leerlo (`200`); leerlo con otro usuario sin perfil (`404`) |
| `PUT /bookings/{id}/seat` | `flights:book` | Cambiar a un asiento libre (`200`); a uno ocupado (`409`); en una reserva ajena (`404`) |
| `GET /admin/dashboard-stats` | `ecoairlines:admin` | `200` con indicadores |
| `GET /admin/flights?date=&origin=&destination=` | `ecoairlines:admin` | `200` con la ocupación; `origin=uio` → `400`; fecha a más de 91 días → `400`; token de cliente → `403` |
| `GET /admin/fleet-schedule?date=` | `ecoairlines:admin` | `200` con los vuelos de cada avión |
| `PUT /admin/flights/{n}/status?date=` | `ecoairlines:admin` | Cambiar a `DELAYED` y comprobar con `GET /flights/{n}/status` |
| `GET /admin/flights/{n}/passengers?date=` | `ecoairlines:admin` | `200` con los pasajeros y su asiento |
| `GET /admin/observability` | `ecoairlines:admin` | `200` con las peticiones y errores recientes, incluidas las pruebas de error recién hechas |
| `GET /admin/routes?airport=UIO` | `ecoairlines:admin` | `200` con las 18 rutas de Quito, cada una con sus aviones |
| `POST /admin/routes` | `ecoairlines:admin` | Body `{"origin":"UIO","destination":"CUE","outboundDepartureLocal":"07:00","inboundDepartureLocal":"12:00","weekdays":["MON","WED","FRI"]}` → `201` con `EA300-EA301`. Después, `POST /search` UIO→CUE un lunes muestra EA300 |
| `POST /admin/routes` (errores) | `ecoairlines:admin` | `"outboundDepartureLocal":"25:00"` → `400`; destino igual al origen → `422`; `"destination":"MAD"` con `"aircraftType":"Airbus A220-300"` → `422` "no tiene alcance"; repetir la misma ruta y hora → `409` "Ya existe el vuelo" |
| `PUT /admin/routes/EA300-EA301` | `ecoairlines:admin` | Cambiar hora y días → `200`; ruta inexistente → `404`; ruta con pasajeros (p. ej. `EA100-EA121` después de reservar EA100) → `409` |
| `DELETE /admin/routes/EA300-EA301` | `ecoairlines:admin` | `204`; sus vuelos dejan de aparecer en la búsqueda; con pasajeros → `409` |
| `GET /admin/aircraft-types` | `ecoairlines:admin` | `200` con los 3 tipos: asientos, alcance (1 500 km, 4 500 km, sin límite) y cuántos hay en la flota |
| `POST /admin/aircraft` | `ecoairlines:admin` | `{"aircraftType":"Airbus A220-300","base":"UIO"}` → `201` con `HC-J27`, estado `AVAILABLE`. Tipo inválido → `400`; base `LAX` → `422` |
| `POST /admin/routes` con `"aircraft":["HC-J27"]` | `ecoairlines:admin` | `201`: la ruta usa ese avión. Con `HC-J01` a las 07:00 desde UIO → `422` (ya está volando a esa hora); con un 787 solo para UIO→MAD diario → `422` "necesita N avión(es)" |
| `DELETE /admin/aircraft/HC-J27` | `ecoairlines:admin` | Con rutas → `409`; tras dar de baja la ruta → `204` |
| `GET /admin/events` | `ecoairlines:admin` | `200` con los últimos eventos (`booking.confirmed`, `booking.cancelled`, `flight.cancelled`…) y su entrega. Para ver una entrega real: registrar un webhook con una URL de webhook.site y hacer una reserva (ver `EVENTOS.md`) |

---

## 8. Pruebas automáticas (complemento de Swagger)

Swagger sirve para probar a mano y entender la API. Las pruebas automáticas repiten todos estos casos (y más) en segundos. Desde la raíz:

```bash
npm run typecheck   # tipos
npm run lint        # estilo y errores comunes
npm test            # 174 pruebas unitarias + arquitectura
npm run test:e2e    # 138 pruebas e2e contra la API completa (la de PostgreSQL necesita TEST_DATABASE_URL)
```

`contract-conformance.e2e-spec.ts` valida **cada respuesta de las 22 operaciones contra el schema del contrato**, incluidos los 410 y 429.
Si todo sale en verde, la API cumple el contrato. Resultado al 07/10: **174/174 unitarias y 138/138 e2e** (con PostgreSQL). GitHub Actions las ejecuta antes de cada despliegue de la API.

---

## 9. Registro de resultados

Copiar esta tabla y completarla al probar (✅ coincide, ❌ no coincide; en "Notas", el `X-Request-Id` si algo falla).

| # | Prueba | Esperado | Obtenido | ✅/❌ | Notas |
|---|--------|----------|----------|-------|-------|
| F1 | Búsqueda UIO→BOG | 200 | | | |
| F2 | Mapa de asientos | 200 | | | |
| F3 | Hold | 201 | | | |
| F4 | Reserva | 201 | | | |
| F5 | Consultas (listado, detalle, tickets) | 200 | | | |
| F6 | Maleta extra | 200 | | | |
| F7 | Cambio de fecha (BROTE) | 200 | | | |
| F8 | Cancelación | 200 | | | |
| F9 | Check-in y pases (vuelo de mañana) | 200 | | | |
| F10 | Estado de vuelo | 200 | | | |
| F11 | Webhooks (crear, listar, borrar) | 201 / 200 / 204 | | | |
| E01–E15 | Validación | 400 | | | |
| E16–E20 | Autenticación y permisos | 401 / 403 | | | |
| E21–E29 | No encontrado / ajeno | 404 | | | |
| E30–E37 | Conflictos | 409 | | | |
| E38–E40 | Expiración | 410 | | | |
| E41–E52 | Reglas de negocio | 422 | | | |
| E53 | Rate limit | 429 | | | |

---

## 10. Observaciones encontradas al preparar esta guía

Estado al 07/10:

| # | Observación | Impacto | Propuesta |
|---|-------------|---------|-----------|
| OBS-1 | `POST /webhooks` con `"url": "no-es-url"` responde `201`. El contrato pide `format: uri`. En producción la regla anti-SSRF exige `https` y host público, pero en desarrollo se acepta una URL sin esquema | Bajo en local; en producción ya se rechaza | ✅ **Resuelta (V1.K):** ahora exige `http://` o `https://` en todos los entornos y responde `400` |
| OBS-2 | Las búsquedas con fecha pasada o con origen igual al destino responden `200` vacío en lugar de `400` | Bajo: el contrato no define el error | Decidir con el grupo si deben ser `400`; si sí, documentarlo en HALLAZGOS |
| OBS-3 | Para la nube: con `NODE_ENV=production` Swagger se apaga y la API exige un secreto JWT propio (≥ 32 caracteres) o un JWKS real, además de `AUTH_ISSUER` y `AUTH_AUDIENCE` | Si falta la configuración, la API no arranca | ✅ **Resuelta (V1.M/V1.N):** variables configuradas en Azure, con `SWAGGER_ENABLED=true` y `PUBLIC_API_URL` (`DESPLIEGUE_AZURE.md`) |
| OBS-4 | En Observabilidad aparecen `GET (sin ruta) 404` sin que nadie use la web | Ninguno | No es un error: son visitas a la raíz de la API o la sonda de arranque de Azure (`/robots933456.txt`). Comprobado el 07/10 con un `X-Request-Id` marcado |
