# HALLAZGOS — AppVuelos (EcoAirlines)

> **Versión 1 · revisado el 2026-10-05 contra el código** (commit `adb6c48`, etiqueta `v0.1.0`).
> Fusiona el antiguo `HALLAZGOS.md` (contrato) y `HALLAZGOS2.md` (puesta en marcha), y suma la comparación con la **plantilla del booking**
> (`Vuelos-Integracion-Sistemas-main`) y los requisitos de **RDA1**: API REST, funcionamiento individual y despliegue en la nube (Render).
> El contrato `contract/vuelos-openapi.yaml` **no se modifica**. Es idéntico (mismo hash) al de la plantilla.
>
> **Para decidir con el líder de booking:** completar la columna *Decisión*. Las versiones anteriores de este archivo y de
> `HALLAZGOS2.md` están en el historial de git (`git show adb6c48:HALLAZGOS.md`).
>
> **Estado al 07/10/2026:** el proyecto está **desplegado en Azure** (no en Render) con PostgreSQL (ver `DESPLIEGUE_AZURE.md`).
> - **Resueltos:** los hallazgos de nube (NUBE-01 a 04) y el de persistencia (PLT-03).
> - **Siguen abiertos**, porque requieren decisión del grupo o cambiar el contrato: la plantilla del booking (PLT-01, PLT-02), las
>   extensiones (EXT-01 a 04) y los del contrato (HALL).
>
> **Actualización 25/10/2026 (Reto 2):** el grupo entregó el **contrato de Vuelos v2** (`contract/vuelos-openapi-v2.yaml`), que pasa
> a ser la fuente de verdad. Fija la ruta base `/api/v2/vuelos` (responde a PLT-01) y agrega las operaciones que en v1 eran
> extensiones (cambio de asiento, estado de vuelo, eventos: EXT-01 en parte). Las preguntas nuevas para el grupo están en la
> **sección 8 (serie `BKG`)**. Las series anteriores se refieren al contrato v1 y se conservan como historial.

**Estados:** 🔴 bloquea ver, usar o desplegar · 🟠 importante · 🟡 menor · ⚪ informativo · ✅ resuelto.
**Prefijos:** `OPS` = entorno local · `NUBE` = despliegue RDA1 · `PLT` = plantilla del booking · `EXT` = extensiones fuera del contrato · `HALL` = contrato · `DOC` = documentación y proceso · `BKG` = contrato v2 de Booking (Reto 2).

---

## 1. Resumen y prioridades

| ID | Prioridad | Hallazgo | Requiere decisión | Decisión |
|----|-----------|----------|-------------------|----------|
| OPS-01 | ✅ | API vieja (02/10) ocupa el puerto 3000: `/docs` da 404 | Resuelto (05/10: ya no corre) | |
| OPS-02 | ✅ | El frontend apunta por defecto al 3000 (la API vieja) | Resuelto con OPS-01 | |
| OPS-03 | ✅ | Servicios de la sesión anterior siguen ocupando 3001, 4000 y 5173 | Resuelto (05/10: ya no corren) | |
| NUBE-01 | ✅ | Swagger no queda usable en la nube (apagado en producción y "Try it out" sin la URL pública) | Resuelto (V1.M) | `SWAGGER_ENABLED=true` + `PUBLIC_API_URL` |
| NUBE-02 | ✅ | Datos en memoria: se pierden al reiniciar el servicio | Resuelto (V1.M) | PostgreSQL con `DATABASE_URL` |
| NUBE-03 | ✅ | `dev-auth` no arranca en producción y la API exige configuración de auth explícita | Resuelto (V1.M) | dev-auth desplegado aparte, con secreto compartido |
| NUBE-04 | ✅ | Falta la configuración de despliegue; el repo es monorepo | Resuelto (V1.M) | GitHub Actions hacia Azure |
| PLT-01 | 🔴 | Tres rutas base distintas: contrato `/flights/v1`, plantilla `/api/v1`, código en la raíz | **Sí** | |
| PLT-02 | 🟠 | Swagger: la plantilla usa `/api/docs`, el código `/docs` | Sí | |
| PLT-03 | ✅ | La plantilla usa PostgreSQL + TypeORM; el código usaba memoria | Resuelto (V1.M) | PostgreSQL con el driver `pg` (documentos JSONB por agregado), sin TypeORM |
| PLT-04 | 🟡 | Los DTOs de la plantilla son más estrictos que el contrato | Informativo | |
| PLT-05 | ⚪ | Entidad `Vuelo` y `CreateVueloDto` de la plantilla no existen en el contrato | Informativo | |
| PLT-06 | ⚪ | Estructura interna distinta (un módulo frente a varios dominios) | Informativo | |
| DOC-01 | ✅ | Documentación dice "25 operaciones"; son **22** | Resuelto (V1.C) | |
| DOC-02 | ✅ | Gemini CLI no lee `AGENTS.md` por defecto | Resuelto (`GEMINI.md`) | |
| OPS-04 | 🟠 | `127.0.0.1:5173` no abre; solo `localhost` | No | |
| OPS-05 | 🟠 | Si el 5173 está ocupado, Vite cambia de puerto y CORS bloquea | No | |
| OPS-06 | 🟡 | Node 24.12 < 24.15 que piden algunas dependencias | No | |
| EXT-01 | 🟠 | Endpoints propios fuera del contrato (perfil, cambio de asiento, administración, rutas programadas, eventos, observabilidad) y firma de webhooks | **Sí**: acordar con el líder de booking | |
| EXT-02 | ⚪ | La plantilla del grupo expone la administración sin autenticación; aquí exige `ecoairlines:admin` | Informativo | |
| EXT-03 | 🟡 | El estado que fija el administrador no se refleja en `FlightSegment.status` de la búsqueda | Sí (si se quiere reflejar) | |
| HALL-01…26 | — | Inconsistencias del contrato (sección 6). 2 resueltas, 24 abiertas | Sí | ver tabla |
| BKG-01 | 🔴 | Contrato v2: no dice por qué canal llegan `payment.*` y `package.cancelled` | **Sí**: preguntar al grupo | |
| BKG-02 | 🟠 | Contrato v2: no hay forma de verificar un `paymentReference` de Booking | **Sí** | |
| BKG-03 | 🟠 | Contrato v2: `tokenUrl` relativa y entrega de credenciales del partner | **Sí** | |
| BKG-04 | ✅ | Contrato v2: quién llama a `PUT /promociones/contrato` | Resuelto internamente (D35) | Lo define nuestro admin; Booking consulta |
| BKG-05 | 🟡 | Contrato v2: ningún endpoint lleva un asiento a `BOARDED` | Informativo | `DEPARTED` → `BOARDED` |
| BKG-06 | ✅ | Contrato v2: forma del stock por gRPC (absoluto o delta, hora, TLS) | Resuelto (03/11) | Booking lo recibe por REST, valor absoluto (D53) |
| BKG-07 | ✅ | Contrato v2: qué eventos recibe cada suscriptor | Resuelto internamente (D40) | Solo sus reservas + vuelos; stock por gRPC |
| BKG-08 | 🟠 | Contrato v2: sobre qué precio se aplica `discountPercentage` | **Sí** | |
| BKG-09 | ⚪ | Contrato v2: la firma del webhook no lleva marca de tiempo | Informativo | |
| BKG-10 | ⚪ | Contrato v2: inconsistencias menores de nombres y `additionalProperties` | Informativo | Se implementa tal cual |
| BKG-11 | 🟡 | Contrato v2: zona horaria de `vuelos_programados_hoy` | Sí | |
| BKG-12 | ⚪ | Nuestro descuento máximo (50 %) es más estricto que el contrato (0–100) | Informativo | D35 |
| BKG-13 | ✅ | `booking.epn.edu.ec` no resuelve en el DNS público: el stock gRPC no puede llegar a Booking desde la nube | Resuelto (03/11) | Booking publicó `POST https://booking-core-api.azurewebsites.net/api/v2/inventory/stock` (D53) |
| BKG-15 | 🟡 | Webhooks de Booking (`/api/v2/webhooks/vuelos`) «se activan en unos días» | Esperar el aviso | Ver sección 8 |
| BKG-16 | 🔴 | Booking registró su webhook (04/11) pero **rechaza con HTTP 400 todas nuestras entregas** | **Sí**: preguntar qué valida | 49 entregas agotadas; se ven en el historial de cada reserva |
| BKG-14 | 🟠 | Contrato v2: `extraBaggage` al crear la reserva no dice si su precio va incluido en el pago | **Sí** | Se ignora al crear; las maletas se compran con `addBaggage` |

---

## 2. Entorno local (`OPS`) — impiden ver o usar el proyecto hoy

### OPS-01 ✅ Una API vieja ocupa el puerto 3000 *(resuelto: el 05/10 ya no había procesos en el puerto)*
- **Verificado hoy:** PID **28580**, `node dist/main.js`, iniciado el **02/10/2026 21:01**, antes de la Fase 1. Es un proceso huérfano: su terminal ya
  se cerró. `GET /docs` → 404, `/search` → 0 ofertas, y no envía `X-Request-Id` ni cabeceras de seguridad.
- **Impacto:** `localhost:3000/docs` no muestra Swagger y `npm run start:dev` falla con `EADDRINUSE`.
- **Acción:** `Stop-Process -Id 28580` y luego `cd vuelos; npm run start:dev`.

### OPS-02 ✅ El frontend usa por defecto el puerto 3000 *(resuelto con OPS-01)*
- `ecoairlines-web/src/config.ts` (antes `frontend/`) → `http://localhost:3000`. Contra la API vieja, el JWT real de `dev-auth` da **403** al reservar, porque esa
  versión usa el verificador simulado antiguo.
- **Acción:** se resuelve con OPS-01. Si la API corre en otro puerto, crear `ecoairlines-web/.env` con `VITE_API_URL`.

### OPS-03 ✅ Siguen corriendo los servicios que levanté en la sesión anterior *(resuelto: el 05/10 ya no corrían; desde V1.C los procesos de prueba se detienen al terminar)*
- PIDs **21772** (API en 3001), **16720** (dev-auth en 4000) y **40972** (Vite en 5173), del 04/10 19:24.
- **Impacto:** si levantas el proyecto tú, el 4000 y el 5173 ya están ocupados. `npm start` de dev-auth falla, y Vite toma otro puerto,
  con lo que CORS lo bloquea (OPS-05).
- **Acción:** `Stop-Process -Id 21772, 16720, 40972`.

### OPS-04 🟠 `http://127.0.0.1:5173` rechaza la conexión *(antes H2-03)*
- Vite escucha solo en `localhost` (IPv6 `::1` en Windows con Node 17+). Además, CORS solo permite `http://localhost:5173`.
- **Acción:** usar `http://localhost:5173`.

### OPS-05 🟠 Puerto 5173 ocupado → CORS bloquea *(antes H2-04)*
- `npm run dev` no usa `--strictPort`. Si cambia a 5174, la API lo rechaza.
- **Acción:** liberar el 5173 o agregar el puerto real a `CORS_ORIGINS`.

### OPS-06 🟡 Versión de Node *(antes H2-06)*
- Instalado 24.12.0. `@nestjs/cli` pide ≥ 24.15 (advertencias `EBADENGINE`). Todo funciona; se recomienda actualizar a la última LTS 24.

---

## 3. Despliegue en la nube — RDA1 (`NUBE`) *(nuevo)*

> **Actualización V1.M (06/10):** la plataforma elegida es **Azure** (no Render). Los cuatro hallazgos están resueltos:
> - **NUBE-01:** `PUBLIC_API_URL` activa en producción el overlay de Swagger con la URL pública y el token, y el documento de
>   dev-auth.
> - **NUBE-02:** PostgreSQL con `DATABASE_URL`, un esquema por dominio; dev-auth también guarda sus cuentas.
> - **NUBE-03:** dev-auth corre como App Service aparte con `AUTH_JWT_SECRET` propio y `ADMIN_PASSWORD`.
> - **NUBE-04:** workflows de GitHub Actions para la web, la API y dev-auth.
>
> Paso a paso en `DESPLIEGUE_AZURE.md`. El texto de abajo se conserva como registro del diagnóstico original.

> RDA1: *"Cada equipo debe construir su aplicativo para que funcione de manera independiente y subir su API correspondiente a Render."*
> El proyecto **funciona en local**, pero hoy **no queda listo para usarse en la nube** sin estos ajustes.

### NUBE-01 ✅ Swagger no es usable en la nube *(resuelto V1.M: `PUBLIC_API_URL` + `SWAGGER_ENABLED=true`)*
- **Verificado en el código:**
  - `isSwaggerEnabled()` apaga `/docs` cuando `NODE_ENV=production` (`swagger.setup.ts:93`).
  - El servidor de "Try it out" se arma como `http://localhost:${port}` (`main.ts:40`), y el overlay solo existe fuera de producción (`main.ts:39`).
    En producción solo quedan los `servers` del contrato (`api.booking-hub.com`), que no existen.
- **Impacto:** en Render, o no hay Swagger, o "Try it out" envía las peticiones a una URL equivocada. Es justo lo que usarían los evaluadores.
- **Propuesta (fase V1.3):** URL pública configurable (p. ej. `PUBLIC_API_URL`) para el servidor de Swagger y `SWAGGER_ENABLED=true` en Render.
  **El contrato no cambia**: es el mismo overlay en memoria.

### NUBE-02 ✅ Persistencia en memoria *(resuelto V1.M: PostgreSQL con `DATABASE_URL`, un esquema por dominio)*
- Holds, reservas, idempotencia, rate limiting, webhooks y usuarios de `dev-auth` viven en memoria.
- **Impacto en Render:** el plan gratuito duerme el servicio tras inactividad, y cada reinicio o redeploy **borra todas las reservas**.
- **Propuesta (fase V1.2):** PostgreSQL con TypeORM, como la plantilla (ver PLT-03). Los repositorios ya están detrás de *ports*, así que
  se cambian los adaptadores sin tocar controllers ni contrato.

### NUBE-03 ✅ Autenticación en la nube *(resuelto V1.M: dev-auth como App Service aparte, secreto propio y `ADMIN_PASSWORD`)*
- `dev-auth/server.mjs:15` termina el proceso con `NODE_ENV=production`. La API en producción exige `AUTH_ISSUER`, `AUTH_AUDIENCE` y un
  `AUTH_JWT_SECRET` propio (≥ 32 caracteres, distinto al de desarrollo), o bien un `AUTH_JWKS_URL`.
- **Decisión necesaria:** ¿quién emite tokens en la nube durante RDA1? Opciones: (a) desplegar `dev-auth` como servicio aparte con un
  secreto compartido real (habría que permitirle arrancar en la nube); (b) que el booking central provea el proveedor OAuth2.

### NUBE-04 ✅ Falta la configuración de despliegue *(resuelto V1.M: workflows de GitHub Actions hacia Azure)*
- No hay `Dockerfile`, `render.yaml` ni `.dockerignore` en el repo (la plantilla sí trae Docker para PostgreSQL).
- Monorepo: en Render cada servicio necesita su *Root Directory*: `vuelos` (Web Service), `dev-auth` (Web Service) y `frontend`
  (Static Site, con `VITE_API_URL` y `VITE_AUTH_URL` definidos **al compilar**).
- `CORS_ORIGINS` debe contener la URL pública del frontend.

---

## 4. Plantilla del booking (`PLT`) *(nuevo)*

> La plantilla declara que su código es **"ejemplo estructural"** (todos sus endpoints devuelven `{}`). Lo obligatorio es el contrato,
> idéntico al nuestro. Estas diferencias importan para la **integración en RDA2**.

### PLT-01 🔴 Tres rutas base distintas *(amplía el antiguo HALL-01)*
| Fuente | Ruta base | Ejemplo |
|--------|-----------|---------|
| Contrato (`servers`) | `/flights/v1` | `https://api.booking-hub.com/flights/v1/search` |
| Plantilla (`main.ts`) | `/api/v1` | `http://localhost:3000/api/v1/search` |
| Nuestro código | raíz | `http://localhost:3000/search` |
- **Impacto:** en RDA2 el booking central llamará a una ruta concreta. Si no coincide, todas las llamadas darán 404.
- **Pregunta al líder:** ¿qué ruta base se usará en la integración? Sugerencia: la del contrato (`/flights/v1`). Se implementa con un
  prefijo configurable (`API_PREFIX`), sin tocar el contrato.

### PLT-02 🟠 Ruta de Swagger
- Plantilla: `/api/docs` (Swagger generado con decoradores `@nestjs/swagger`). Nuestro código: `/docs` (sirve el YAML del contrato tal cual).
- Mantener el YAML original es más fiel al contrato. Solo hace falta acordar la ruta.

### PLT-03 ✅ Persistencia *(resuelto V1.M)*
- La plantilla trae `TypeOrmModule` con PostgreSQL (`DATABASE_URL`) y `docker-compose.yml` (postgres:16). Nuestro código usaba
  repositorios en memoria.
- **Resolución:** PostgreSQL con la misma variable `DATABASE_URL`.
  - Cada contexto de datos es un esquema; cada agregado, un documento JSONB.
  - Se usa el driver `pg` sin ORM, así los repositorios no cambiaron.
  - Pasar a TypeORM, como la plantilla, solo cambiaría las implementaciones de `repositories/`. Ver `ARQUITECTURA.md` §5.

### PLT-04 🟡 Los DTOs de la plantilla no siguen al pie de la letra el contrato
- Exigen campos que el contrato marca como **opcionales**: `CancelBookingRequest.reason`, y `DateChangeRequest.payment` y `assignedSeats`.
- Activan `forbidNonWhitelisted` en toda la API: rechazan propiedades extra incluso en schemas que el contrato no marca como `additionalProperties: false`.
- Validan fechas con `IsDateString`, que acepta fecha-hora, cuando el contrato pide `format: date`.
- **Nuestro código sigue el contrato** en los tres casos (comprobado por la prueba de conformidad). Si se compara contra la plantilla,
  la diferencia está justificada.

### PLT-05 ⚪ Entidad `Vuelo` y `CreateVueloDto`
- La plantilla incluye un CRUD de vuelos (`aerolinea`, `codigoVuelo`, `precioBase`…) que **no existe en el contrato**. No se expone
  como endpoint. Nuestro catálogo equivalente vive en el GDS simulado.

### PLT-06 ⚪ Estructura interna
- La plantilla usa un único módulo `vuelos` con un controller. Nuestro código usa 7 dominios (search, offers, bookings, post-sale,
  check-in, flight-status, webhooks), como pide `CLAUDE.md`. La integración es por HTTP según el contrato, así que la estructura interna
  no afecta. Solo importan PLT-01 y PLT-02.

---

## 4b. Extensiones fuera del contrato (`EXT`) *(nuevo, V1.D)*

> Endpoints PROPIOS de EcoAirlines, documentados en `contract/ecoairlines-extensions.yaml` y publicados en Swagger aparte
> (`/docs/extensions.json`). El contrato `vuelos-openapi.yaml` no cambia. Sus campos son los de la plantilla del grupo de vuelos
> (`APIVUELOSV1DIEGOCEVALLOS`), para coincidir al integrarse con el booking.

### EXT-01 🟠 Endpoints propios que el booking debe conocer
- `GET/PUT /customers/me` (perfil, scope `ecoairlines:profile`), `PUT /bookings/{bookingId}/seat` (cambio de asiento, `flights:book`),
  `GET /admin/dashboard-stats`, `GET /admin/flights`, `PUT /admin/flights/{flightNumber}/status`, `GET /admin/flights/{flightNumber}/passengers`,
  `GET /admin/fleet-schedule`, `GET /admin/observability`, `GET /admin/events` (eventos y entregas de webhooks) y el CRUD de rutas
  programadas `GET/POST /admin/routes` y `GET/PUT/DELETE /admin/routes/{routeId}`, y de la flota `GET /admin/aircraft-types`,
  `GET/POST /admin/aircraft` y `GET/PUT/DELETE /admin/aircraft/{registration}` (`ecoairlines:admin`).
- Los webhooks salientes agregan cabeceras propias (`X-EcoAirlines-Event`, `X-EcoAirlines-Delivery`, `X-EcoAirlines-Signature`) y
  campos propios en `data` (ver `EVENTOS.md`); el contrato no define cómo firmar ni cabeceras.
- **Impacto:** los scopes `ecoairlines:*` no existen en el authorization server del contrato (`auth.booking-hub.com`); hoy los emite `dev-auth`.
- **Acción:** acordar con el líder de booking si estas rutas pasan al contrato (o a un contrato propio de la aerolínea) y cómo se
  emiten los scopes y el rol de administrador.

### EXT-02 ⚪ La plantilla del grupo no protege la administración
- En la plantilla, `/admin/*` no exige autenticación y `POST /admin/login` compara credenciales fijas y devuelve un token que nadie
  verifica. Aquí se conservan **las rutas y los campos**, pero el acceso exige un JWT con `ecoairlines:admin` (401 sin token, 403 con token
  de cliente) y el login lo hace el servidor de autenticación, no la API.

### EXT-03 🟡 Estado operativo fijado por el administrador
- `GET /flights/{flightNumber}/status` devuelve el estado que fija el administrador, pero el campo `status` de cada `FlightSegment` en la
  búsqueda y en las reservas sigue saliendo del GDS.
- **Acción:** decidir si debe reflejarse también ahí (requiere que search consulte a flight-status: una dependencia nueva entre dominios).

### EXT-04 🟡 Reglas de identidad y edad de los pasajeros *(V1.J)*
- El contrato define `passengerType`, `birthDate`, `documentType` y `documentNumber`, pero no los rangos de edad ni que el documento sea único.
- **Decisión** (regla de negocio, sin tocar el contrato):
  - Rangos de edad: adulto 15+, joven 12–14, niño 2–11, infante < 2 durante todo el viaje. Son los mismos que ya mostraba el buscador.
  - El documento no se repite en la reserva ni en otra reserva activa del mismo vuelo. Los nombres sí pueden repetirse.
  - La cédula ecuatoriana se valida con su dígito verificador, y el documento no puede vencer antes del último vuelo.
  - Todo responde `422 VALIDATION_FAILED` con `invalidParams`, el código que el contrato ya documenta para `POST /bookings`.
- **Acción:** confirmar los rangos de edad con el grupo. Si otras aerolíneas del booking usan rangos distintos, convendría que el contrato los publique.

## 5. Documentación y proceso (`DOC`)

### DOC-01 ✅ "25 operaciones" es incorrecto: son 22 *(resuelto el 05/10 en `EcoAirlines.API/README.md`; `vuelos/AUDITORIA.md` ya no existe)*
- Aparece en `CAMBIOS.md` (resultados de las fases 1 y 7), `vuelos/AUDITORIA.md` (AUD-012) y `vuelos/README.md` (tabla de pruebas e2e).
  Las pruebas no usan un número fijo: calculan la lista desde el contrato.

### DOC-02 ✅ Gemini no leerá `AGENTS.md` automáticamente *(resuelto por el supervisor: hoy es `GEMINI.md`, en la raíz)*
- Cambiaste el rol de auditor a **Gemini** en `vuelos/AGENTS.md` (cambio aún sin commit). Gemini CLI carga por defecto **`GEMINI.md`**;
  no hay `GEMINI.md` ni `~/.gemini/settings.json` con `contextFileName`.
- **Impacto:** Gemini auditaría sin las reglas de auditoría.
- **Acción:** crear `GEMINI.md` (o configurar `"contextFileName": ["AGENTS.md"]`). Además, `vuelos/AUDITORIA.md` y `README.md` todavía
  nombran a OpenCode como auditor.

---

## 6. Contrato (`HALL`) — estado verificado contra el código

| ID | Tema | Estado | Qué hace hoy el código (verificado) | Pregunta o propuesta para el contrato | Decisión |
|----|------|--------|-------------------------------------|---------------------------------------|----------|
| HALL-01 | Ruta base | 🔴 Abierto | Rutas en la raíz | **Ampliado en PLT-01** | |
| HALL-02 | `401` no documentado; `403` definido pero sin usar | 🟠 Abierto | `401` sin token/token inválido, `403` sin scope | Documentar `401` y `403` | |
| HALL-03 | Login para el frontend | ✅ Resuelto | `dev-auth/` separado; la API no ganó rutas | — (ver NUBE-03 para la nube) | Permitido (03/10) |
| HALL-04 | Strings sin `maxLength`/`format` | 🟠 Abierto | Body ≤ 100 KB, sin caracteres de control ni `__proto__` | `maxLength`, `format: email`, `minItems` | |
| HALL-05 | Enum `code` sin valores genéricos | 🟠 Abierto | `VALIDATION_FAILED` para 401/403/404/500 | Agregar `UNAUTHORIZED`, `FORBIDDEN`, `RESOURCE_NOT_FOUND`… | |
| HALL-06 | `201` frente a `PENDING` | 🟡 Implementado provisional | `201 CONFIRMED`; `202 PENDING_PAYMENT` → `CONFIRMED` | Confirmar el estado del `201` | |
| HALL-07 | `cabinClass` libre en HoldRequest | 🟡 Abierto | Acepta cualquier string; si no existe en la oferta → `422` | Reutilizar el enum | |
| HALL-08 | SSRF en URL de webhooks | 🟠 Implementado provisional | En producción: solo `https` y host público | Documentar la restricción | |
| HALL-09 | `secret` devuelto en GET/POST de webhooks | 🟠 Abierto | Se devuelve (lo exige el schema), filtrado por dueño | `writeOnly: true` | |
| HALL-10 | Nombre de la marca | ✅ Resuelto | EcoAirlines, código `EA` | — | EcoAirlines (03/10) |
| HALL-11 | `404` no documentado en endpoints con `{bookingId}` | 🟠 Abierto | `404` si no existe o es ajena (evita IDOR) | Documentar `404` | |
| HALL-12 | Check-in sin `Idempotency-Key` | ⚪ Informativo | Operación idempotente | — | |
| HALL-13 | Respuestas sin body (`cancel 200`, varios `202`) | 🟡 Abierto | Sin body, como el contrato | Devolver `BookingDetail` | |
| HALL-14 | Inconsistencias menores (versión no SemVer, `limit` sin mínimo…) | 🟡 Abierto | `limit` exige ≥ 1 | Ajustes menores | |
| HALL-15 | `413`/`415` no documentados | 🟡 Abierto | Se responde `400` | Documentar `413`/`415` | |
| HALL-16 | `429` solo en 2 endpoints | 🟠 Abierto | Límite global de 300/min y estricto en search/seatmap | Documentar `429` global | |
| HALL-17 | Header `X-Request-Id` | ⚪ Informativo | En todas las respuestas, no en el body | Documentarlo | |
| HALL-18 | Cotización vencida en `/cancel` | 🟠 Abierto | `409 QUOTE_EXPIRED` | Agregar `410` a `/cancel` | |
| HALL-19 | `POST /bookings` sin `404` | 🟠 Abierto | Hold inexistente o ajeno → `422` | ¿`422` o documentar `404`? | |
| HALL-20 | Errores de posventa no documentados | 🟠 Abierto | `400` itinerario o pasajero ajeno; `409` pagos en baggage | Documentar `400`/`409` | |
| HALL-21 | `DateChangeRequest.assignedSeats` sin `passengerId` | 🟠 Abierto | Asigna en orden a los pasajeros con asiento | Agregar `passengerId` | |
| HALL-22 | Arrays sin `minItems` | 🟡 Abierto | Regla de negocio con `422` | `minItems: 1` | |
| HALL-23 | Significado de `totalBaggage` | 🟡 Abierto | Incluidas + extra | Agregar `description` | |
| HALL-24 | `PaymentReference` sin monto ni uso único | 🟠 Abierto | Mock: formato `pay_…`, uso único; `async`/`declined` simulados | Confirmar con el dominio de pagos | |
| HALL-25 | Edades por tipo de pasajero | 🟡 Abierto | No se valida edad contra tipo; el frontend muestra rangos guía | Documentar rangos | |
| HALL-26 | Sin catálogo de aeropuertos | ⚪ Informativo | El frontend mantiene una lista de 10 | `GET /airports` futuro | |

> El detalle de cada `HALL` (contexto, evidencia y opciones) está en la versión anterior: `git show adb6c48:HALLAZGOS.md`.

---

## 7. Comportamientos esperados (no son fallas)

- **Recargar la página cierra la sesión:** el token vive solo en memoria, por seguridad.
- **Reiniciar la API borra reservas y holds** mientras la persistencia sea en memoria (NUBE-02).
- **Endpoints protegidos en Swagger:** generar un token con `cd vuelos; npm run token` y usarlo en *Authorize* → `DevBearer`.
- **`POST /bookings/{id}/cancel` nunca devuelve `202`:** la cancelación del GDS simulado es síncrona.

---

## 8. Contrato de Vuelos v2 de Booking (`BKG`) *(nuevo, 25/10/2026 — Reto 2)*

> Revisión de `contract/vuelos-openapi-v2.yaml` (v2.0.0) y `contract/README-vuelos-v2.md`. **El contrato no se modifica.** Cada
> hallazgo trae la solución que aplica EcoAirlines mientras el grupo responde (decisiones D26–D40 de `PLAN/PLAN.md`).
> **Para enviar al grupo:** BKG-01, 02, 03, 06, 08 y 11. Los demás son informativos o ya se resolvieron internamente.

### BKG-01 🔴 No se define el canal de los eventos que publica Booking
- **Contrato:** §8 «Eventos que CONSUME la aerolínea»: `ec.edu.epn.booking.pagos.payment.confirmed`, `…payment.failed` y
  `ec.edu.epn.booking.paquetes.package.cancelled`. Hay schemas (`EventPaymentConfirmed`, `EventPackageCancelled`) pero **ningún
  endpoint ni cola** para recibirlos.
- **Impacto:** sin canal no podemos emitir boletos al confirmarse el pago ni compensar un combo cancelado.
- **Pregunta:** ¿nos los envían por webhook (¿a qué URL y con qué firma?), por el RabbitMQ `booking.events` (¿URL, credenciales,
  cola?) o por Kafka `topic-ordenes-b2b`?
- **Mientras tanto:** el ESB acepta las dos primeras vías, verifica el origen y descarta duplicados por el `id` del CloudEvent
  (`inbound_events`, D34). Nada se cobra ni se vende dos veces aunque el evento llegue repetido. Propuesta documentada en
  `contract/events.asyncapi.yaml`: AMQP en el exchange `booking.events` (routing keys `pagos.payment.confirmed`,
  `pagos.payment.failed`, `paquetes.package.cancelled`) o webhook firmado `POST /api/integraciones/booking/eventos`.

### BKG-02 🟠 No hay forma de verificar un `paymentReference` de Booking
- **Contrato:** §4: la aerolínea «solo valida la referencia» (`PAYMENT_REFERENCE_INVALID`, `AMOUNT_MISMATCH`); `amount` es
  opcional en `PaymentReference`. Booking no expone un endpoint de verificación.
- **Impacto:** solo podemos validar el formato y que no se haya usado; sin `amount` no se detecta `AMOUNT_MISMATCH`.
- **Pregunta:** ¿el formato es siempre `PAY-BKP-AAAAMMDD-NNNNNN`? ¿Pueden enviar siempre `amount`? ¿O hay un endpoint para verificar?
- **Mientras tanto:** se valida el formato, el uso único (`payment_records`) y el monto cuando llega (D28).

### BKG-03 🟠 `tokenUrl` relativa y entrega de credenciales
- **Contrato:** `PartnerOAuth2.flows.clientCredentials.tokenUrl: /oauth2/token`, relativa a un servidor `/api/v2`.
- **Pregunta:** ¿la ruta es `/api/v2/oauth2/token` o `/oauth2/token` en la raíz? ¿Cómo prefieren recibir `client_id` y
  `client_secret`?
- **Mientras tanto:** se publican las dos rutas; las credenciales se entregan por un canal privado, nunca en el repositorio.

### BKG-04 ✅ Quién llama a `PUT /vuelos/promociones/contrato` *(resuelto internamente)*
- **Contrato:** exige `flights:admin` con token de partner y «responde una sola vez el cuestionario de la cátedra».
- **Decisión (D35):** el acuerdo lo define **nuestro administrador** en la pantalla de precios por clase. El token del partner no
  tiene `flights:admin`; Booking lo **consulta** con `GET`.

### BKG-05 🟡 Ningún endpoint lleva un asiento a `BOARDED`
- **Contrato:** §10, `SeatStatus` termina en `BOARDED`, pero no hay operación de embarque.
- **Mientras tanto:** cuando el vuelo pasa a `DEPARTED` (`PATCH status`), los asientos `CHECKED_IN` pasan a `BOARDED` (D37).

### BKG-06 🟠 Forma del stock por gRPC
- **Contrato:** §9, `PushStockUpdate` (valor absoluto) y `StreamInventoryChanges` (delta).
- **Pregunta:** ¿cuál prefieren? ¿`date` y `time_slot` en hora local del aeropuerto de salida? ¿Conexión con TLS en la nube?
- **Mientras tanto:** `PushStockUpdate` desde MS.G.Offers (D33): un envío perdido no deja el stock mal, porque el siguiente
  lleva el valor completo. Hora local del aeropuerto de salida.

### BKG-07 ✅ Qué eventos recibe cada suscriptor *(resuelto internamente)*
- **Contrato:** define los eventos y el suscriptor elige cuáles quiere (`WebhookSubscription.events`), pero no dice de qué
  reservas.
- **Decisión (D40):** Booking recibe el ciclo de **sus** reservas y holds y los cambios de estado de vuelo. Las reservas de
  nuestra web no se le notifican (son datos de nuestros clientes); conoce la disponibilidad por el **stock gRPC**, que incluye
  todos los canales.

### BKG-08 🟠 Sobre qué precio se aplica `discountPercentage`
- **Contrato:** `SalesChannel.discountPercentage` «debe ser ≤ `porcentaje_descuento_maximo`»; no dice cómo cambia el monto
  que se compara con `payment.amount`.
- **Pregunta:** ¿el monto cobrado es `lockedPrice × (1 − descuento)`? ¿Se aplica a la tarifa base o al total con impuestos?
- **Mientras tanto:** monto esperado = `lockedPrice.total × (1 − descuento)`, redondeado a 2 decimales.

### BKG-09 ⚪ La firma del webhook no lleva marca de tiempo
- **Contrato:** `X-Webhook-Signature: sha256=<HMAC-SHA256(secret, body)>`.
- **Observación:** un mensaje capturado se podría reenviar. Se sugiere al grupo un `X-Webhook-Timestamp` dentro de la firma.
  Mientras tanto, el consumidor deduplica por el `id` del CloudEvent.

### BKG-10 ⚪ Inconsistencias menores
- `ProblemDetails` mezcla `snake_case` (`correlation_id`) y `camelCase` (`invalidParams`).
- `HoldRequest` no tiene `additionalProperties: false`; `BookingRequest` y `SearchRequest` sí.
- **Mientras tanto:** se implementa **tal cual** el contrato.

### BKG-11 🟡 Zona horaria de `vuelos_programados_hoy` (health)
- **Pregunta:** ¿«hoy» en UTC o en hora local?
- **Mientras tanto:** `America/Guayaquil`.

### BKG-12 ⚪ Nuestro descuento máximo es más estricto que el contrato
- **Contrato:** `porcentaje_descuento_maximo` entre 0 y 100.
- **EcoAirlines (D35):** máximo **50 %**. `GET /promociones/contrato` nunca mostrará más de 50; un `PUT` con más de 50 responde
  `422 PROMOTION_DISCOUNT_OUT_OF_RANGE`. Es una regla de negocio propia, compatible con el contrato.

### BKG-13 ✅ `booking.epn.edu.ec` no existe en el DNS público (V2.14, 26/10) — resuelto el 03/11 (D53)

> **Resolución (03/11):** Booking publicó el stock por REST en Azure: `POST https://booking-core-api.azurewebsites.net/api/v2/inventory/stock`
> con `service_id`, `item_id`, `date`, `time_slot` y `available_units`; vale si responde `success: true`. Nuestro `service_id` es
> `NODE_VUE_EQ5`. Primera respuesta real: `success: true`, «Stock sincronizado exitosamente…», `source: HTTP_REST`. El gRPC queda
> como alternativa (D53). También resuelve BKG-06: valor absoluto por vuelo y cabina.
- **Contrato:** §9, el stock se envía por gRPC a `booking.epn.edu.ec:50051`.
- **Hallazgo:** desde la nube (Azure, North Central US) el nombre **no resuelve** (`Name or service not known`): el servidor de
  Booking no está publicado en Internet o solo existe dentro de la red de la EPN.
- **Impacto:** nuestro stock no llega a Booking. No bloquea nada: cada cambio queda en `stock_sync` y se reintenta en segundo
  plano (D33); al conectarse se envía el valor absoluto vigente (el último gana).
- **Pregunta:** ¿cuál es la dirección pública (host y puerto) de su `InventoryStockService`? ¿Con TLS (BKG-06)?
- **Mientras tanto:** `BOOKING_GRPC_ADDRESS` de la nube se cambia en `infra/cloud/.env` cuando respondan (y se reinicia Offers).

### BKG-14 🟠 Maletas extra al crear la reserva: ¿se cobran en el mismo pago? (V2.17, 26/10)
- **Contrato:** el `PassengerItem` de `POST /bookings` admite `extraBaggage` (maletas extra por itinerario), pero el pago es
  un `paymentReference` con `amount` = precio congelado del hold (BKG-08) y no dice si incluye el precio de esas maletas.
- **Hallazgo:** el ESB nunca guardó ni cobró `extraBaggage` al crear la reserva (lo descartaba sin avisar). El monto que
  valida y captura es solo el del hold. Lo encontró el recorrido de la web: las maletas elegidas en el checkout no llegaban a
  la reserva.
- **Impacto:** si Booking las manda, no se agregan y tampoco se cobran (nadie paga por algo que no recibe).
- **Pregunta:** ¿Booking enviará maletas al crear la reserva? Si sí, ¿el `amount` del pago incluye su precio, o prefieren
  agregarlas después con `POST /bookings/{id}/baggage`, que sí cobra y valida el monto?
- **Mientras tanto:** se mantiene el comportamiento (se ignoran al crear). La web ya no las ofrece en el checkout: se compran
  desde «Mis viajes» con su propio pago (`addBaggage`). Los **asientos** elegidos (`assignedSeats`) sí se respetan desde V2.17.

### BKG-15 🟡 Webhooks de Booking todavía no activos (03/11)

- **Qué dijeron:** «Los webhooks (`/api/v2/webhooks/vuelos`) se activan en unos días».
- **Qué falta saber:** si es la URL donde Booking recibe nuestros eventos (hoy los entrega `ms-g-webhooks` a la URL que Booking registra
  con `POST /vuelos/webhooks`) o por donde nos envían `payment.*` y `package.cancelled` (BKG-01). Con su URL y su secreto de firma se
  configura sin cambiar código.

### BKG-16 🔴 Booking rechaza nuestros webhooks con HTTP 400 (08/11)

- **Qué pasa:** el 04/11 Booking (`partner:BOOKING_PROTOTIPO`) suscribió `https://booking-core-api.azurewebsites.net/api/v2/webhooks/vuelos`
  a 8 eventos. **Las 49 entregas** (`booking.confirmed`, `booking.ticket_issued`, `booking.checked_in`, `booking.cancelled`…) terminaron
  `EXHAUSTED` con **HTTP 400** tras 6 intentos. Se ve en el panel: Reservas → una reserva de Booking → Historial.
- **Qué enviamos** (contrato v2 §8): `POST` con `Content-Type: application/cloudevents+json`, el CloudEvent 1.0 completo
  (`specversion`, `type` `ec.edu.epn.booking.vuelos.*`, `source`, `id`, `time`, `subject`, `correlationid`, `data`) y
  `X-Webhook-Signature: sha256=<HMAC del cuerpo con el secreto que registraron>`.
- **Pregunta:** ¿qué valida su endpoint? ¿Esperan `application/json` en vez de `application/cloudevents+json`, otro formato de firma u
  otros campos en `data`? Un 400 con su ProblemDetails (como el del stock) diría el motivo.
- **Mientras tanto:** los eventos quedan en el feed `GET /vuelos/eventos` (respaldo del contrato), así que Booking puede leerlos.
