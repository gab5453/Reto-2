# Seguridad — EcoAirlines Reto 2

Qué protege hoy el sistema, qué riesgos se conocen y qué mejoras se pueden hacer. Revisado el **11/11/2026** sobre la rama
`feature/v2-microservicios`.

> **Alcance:** es un proyecto académico desplegado en una sola VM con el crédito de estudiante. Las medidas buscan las buenas
> prácticas razonables de una integración de sistemas (y no exponer datos de personas ni de tarjetas), no una certificación. Las
> mejoras de la sección 4 están ordenadas por esfuerzo; ninguna es obligatoria para que el sistema funcione.

---

## 1. Lo que ya está implementado

### 1.1 Identidad, tokens y permisos

| Medida | Dónde |
|---|---|
| Tokens **JWT RS256** con `kid`; quien los verifica descarga la clave pública desde el **JWKS** de Identity (D46) | `packages/shared/src/auth/jwt.ts`, MS.G.Identity |
| Tres tipos de token: **usuario** (web), **partner** (Booking, OAuth2 `client_credentials`) y **servicio** (ESB y MS de respuesta, D41/D44). Un token de servicio no se acepta en los MS de respuesta, y uno de usuario no se acepta entre servicios | `respuesta/principal.ts`, `auth/service-token.guard.ts` |
| **Confianza cero** entre servicios: cada llamada interna lleva su token de servicio; estar dentro de la red no basta | ESB y MS de respuesta |
| **Scopes** por operación, tomados del contrato (`flights:read`, `flights:book`…); un partner nunca recibe `flights:admin` | `principal.ts`, `ms-g-identity/src/domain/rules.ts` |
| Una reserva o un hold de otro dueño responde **404**, nunca 403 (no se revela que existe) | MS.G.Bookings, MS.G.Offers |
| Dueño de Booking: `partner:<clientId>:<X-User-Id>`; las reservas de distintos usuarios de un partner no se mezclan | `principal.ts` |
| Contraseñas y secretos de partner derivados con **scrypt** y sal propia; comparación en tiempo constante; un correo inexistente responde igual y tarda lo mismo que una contraseña incorrecta | `ms-g-identity/src/services/security.ts` |
| El secreto de un partner se muestra **una sola vez**; se puede rotar | MS.G.Identity |
| **Límite de intentos** de login y de token por IP o `client_id`; **rate limit** en el gateway | Identity, `gateway/src/runtime.ts` |
| Regla de negocio: siempre queda al menos un ADMIN activo; nadie se cambia su propio rol | `ms-g-identity/src/domain/rules.ts` |

### 1.2 Datos sensibles

| Medida | Dónde |
|---|---|
| **Tarjetas:** la tarjeta va del navegador a la Payment API; a EcoAirlines solo llega la referencia del pago. Solo se guardan marca y últimos 4 dígitos. Booking cobra en su sistema: la aerolínea solo valida la referencia | Payment API, `sagas/support.ts` |
| **Datos de salud** (asistencia médica): tabla aparte; nunca en logs, trazas, eventos ni webhooks. El panel solo recibe *qué* pasajeros la tienen | MS.G.Bookings, `route-events.ts`, `gateway/.../mappers.ts` |
| **Logs sin datos sensibles:** `redact` oculta tokens, contraseñas, tarjetas, documentos, correo, teléfono y asistencia; nunca se registra el cuerpo con datos personales | `packages/shared/src/logging/logging.ts` |
| El «Recorrido» de Telemetría enmascara los identificadores de las rutas (reservas, referencias de pago) | `esb/src/composition/journey.ts` |
| El secreto de cada webhook se guarda **cifrado** (AES-256-GCM) y solo se muestran sus últimos 4 caracteres | MS.G.Webhooks |
| La PWA guarda sin conexión **solo** lo necesario para abordar, y «Salir» lo borra; el service worker no guarda respuestas de la API | `ecoairlines-web/src/lib/offline-trips.ts`, `vite.config.ts` |

### 1.3 Integración con sistemas externos

| Medida | Dónde |
|---|---|
| Webhooks hacia Booking **firmados con HMAC-SHA256**; los eventos que llegan de Booking se verifican sobre los **bytes exactos** recibidos | MS.G.Webhooks, `esb/src/inbound/inbound.service.ts` |
| Protección contra **SSRF**: en producción la URL de un webhook debe ser `https` y apuntar a una IP pública (sin `localhost`, redes privadas, `169.254.x` ni credenciales en la URL); se vuelve a comprobar al entregar | `ms-g-webhooks/src/domain/rules.ts` |
| **Idempotencia** (Idempotency-Key, eventos por `id`, sagas por `sagaId`): un reintento nunca cobra ni reserva dos veces | ESB, MS.G |
| La referencia de pago de Booking se valida (formato, fecha real, monto exacto) y se usa **una sola vez** | `esb/src/transversal/booking-reference.ts`, MS.G.Bookings |

### 1.4 Entrada y salida de la API

| Medida | Dónde |
|---|---|
| Validación de cada petición contra el contrato (DTOs y `ValidationPipe`); propiedades extra → 400 | Todos los servicios |
| `sanitize`: rechaza caracteres de control y claves `__proto__`/`constructor` (contaminación de prototipos) | `respuesta/http-security.ts` |
| Errores con formato **ProblemDetails**: nunca un mensaje interno ni una traza; un error inesperado es `INTERNAL_ERROR` | `problem-details/`, `gateway/.../errors.ts` |
| Gateway con **helmet** (CSP estricta, HSTS en producción) y **CORS** solo para la web publicada | `gateway/src/http.ts`, Caddy |
| GraphQL: **profundidad máxima 10** y **complejidad máxima 1000**; introspección apagada en la nube | `gateway/src/graphql/limits.ts` |
| Web (Static Web App): cabeceras `X-Content-Type-Options`, `X-Frame-Options: DENY` y `Referrer-Policy` | `ecoairlines-web/public/staticwebapp.config.json` |

### 1.5 Infraestructura

| Medida | Dónde |
|---|---|
| Solo **Caddy** es público (443, con certificado de Let's Encrypt). El ESB, los MS, PostgreSQL y RabbitMQ no salen de la VM | `infra/cloud/Caddyfile`, `docker-compose.cloud.yml` |
| **SSH** solo por el puerto 2222 y **solo desde IP permitidas** (nunca abierto a todo internet) | NSG de Azure |
| **Una base por servicio**, cada una con su propio usuario | `infra/docker-compose.yml` |
| **Secretos** solo en `infra/cloud/.env`, que no se sube al repositorio; la CI no usa secretos de producción | `.gitignore`, `.github/workflows/ci.yml` |
| Grafana con contraseña | `infra/cloud` |
| Pruebas automáticas de lo anterior en cada push (sección 2) | GitHub Actions |

---

## 2. Cómo se verifica

Muchas de estas medidas tienen pruebas automáticas que corren en cada push (`Informacion_General/Pruebas.md`). Por ejemplo:

- el secreto de un partner nunca va en un evento;
- la asistencia médica nunca llega al navegador;
- un token de servicio se rechaza en un MS de respuesta;
- las URL internas se rechazan en los webhooks (SSRF);
- una firma alterada se rechaza;
- `redact` oculta los campos sensibles;
- un error interno no se filtra.

Las **reglas de arquitectura** (por ejemplo, que un MS de respuesta solo hable con el ESB) también se comprueban en cada push.

---

## 3. Riesgos conocidos

| Riesgo | Estado | Por qué |
|---|---|---|
| **Usuarios de demostración con contraseña conocida**, incluido un ADMIN, publicados en el README | **Aceptado por el responsable** (04/11) | Lo pidió el grupo para poder probar el sistema. Cualquiera que lea el README puede entrar como administrador en la nube |
| **Dependencias de PRODUCCIÓN con avisos de seguridad** (`npm audit --omit=dev` en la raíz, 11/11): **8 avisos, 6 altos**. `@nestjs/platform-express` y sus dependencias `body-parser` y `multer` (denegación de servicio con cuerpos mal formados), `follow-redirects` (credenciales que siguen una redirección), `@nestjs/graphql`/`@graphql-tools/utils` (contaminación de prototipos), más `fast-uri` y `qs` (moderados) | **Pendiente, prioridad alta** (S-0) | Corren en los servicios publicados. El riesgo práctico es bajo, porque Caddy y los límites del gateway frenan peticiones grandes o raras y el GraphQL tiene límites de profundidad y complejidad. Aun así, conviene aplicar las correcciones |
| **Dependencias de desarrollo con avisos:** Vitest 4.1.11 en la raíz (2 moderados), `vite` 8.3.2 en la web (1 alto; 7 avisos en total en la web) y, desde CI-2, `minimatch` 10.2.6 dentro de ESLint y typescript-eslint (1 moderado, DoS con patrones glob; `npm audit` lo cuenta 9 veces, una por paquete que lo usa) | Pendiente (S-1) | Son herramientas de desarrollo y pruebas: **no llegan al navegador ni a los contenedores**. El riesgo es para quien desarrolla |
| **Una sola VM:** si se cae, cae todo | Aceptado (presupuesto) | El crédito de estudiante (US$ 90) no alcanza para alta disponibilidad |
| La web no envía **Content-Security-Policy** ni **HSTS** | Pendiente (sección 4) | La API sí las tiene. La web no maneja tarjetas (eso es la Payment API), pero una CSP limitaría el daño de un script inyectado |

---

## 4. Mejoras posibles (opcionales, por esfuerzo)

| # | Mejora | Esfuerzo | Detalle |
|---|---|---|---|
| S-0 | **Actualizar las dependencias de producción con avisos** | Bajo a medio | `npm audit fix` (sin `--force`) actualiza `body-parser`, `multer`, `follow-redirects`, `fast-uri` y `qs` dentro de sus rangos. **`@nestjs/graphql` 14.0.3 → 14.2.0** corrige `@graphql-tools/utils`, pero se publicó el **04/11**: por la regla de las 2 semanas del proyecto, **desde el 18/11**. Después de actualizar, toda la CI (unitarias, integración, contratos) debe seguir en verde |
| S-1 | **Actualizar las dependencias de desarrollo con avisos** | Bajo | Vitest 4.1.11 → **4.1.12** en la raíz (la web ya la usa); `vite` 8.3.2 → **8.3.5** en la web (corrige el aviso alto; publicada el 21/10, cumple las 2 semanas). `minimatch` (de ESLint): la corrección es la 11.0.1 (27/10), un cambio de versión mayor que ESLint todavía no pide; esperar a una versión de ESLint que la traiga. Solo afecta patrones que escribimos nosotros. Verificar con la CI |
| S-2 | **Revisión de dependencias en la CI** | Bajo | Un paso `npm audit --audit-level=high` (o solo un reporte, para no frenar la CI por un aviso de una herramienta de desarrollo) |
| S-3 | **Dependabot y secret scanning de GitHub** | Bajo | Gratis en un repositorio público. Dependabot propone las actualizaciones de seguridad como pull requests; secret scanning avisa si se sube una clave por error |
| S-4 | **Cambiar la contraseña del ADMIN de demostración** al terminar la evaluación | Bajo | Una variable en `infra/cloud/.env` (`ADMIN_PASSWORD`) y reiniciar Identity |
| S-5 | **CSP y HSTS en la web** | Medio | Agregar a `staticwebapp.config.json`: `Content-Security-Policy` con `connect-src` al gateway (https y wss) y a la Payment API, y `Strict-Transport-Security`. Requiere probar la web completa: una CSP mal escrita rompe el pago o el WebSocket |
| S-6 | **ESLint con reglas de tipos** | Medio | Ya está en el plan de pruebas (CI-2): detecta promesas olvidadas, que en las sagas pueden dejar operaciones a medias |
| S-7 | **Proteger la rama** en GitHub | Bajo | *Required status checks*: no se puede fusionar con la CI en rojo (el «gate» del PDF de la Semana 9). Útil si se empieza a trabajar con pull requests |
| S-8 | Revisar las imágenes Docker con **Trivy** | Medio | Solo si se adopta la opción B de despliegue (imágenes en GitHub, `Pruebas.md` §10) |

**Recomendación:** **S-0 primero** (son dependencias que corren en producción), y luego S-1, S-3 y S-4, que son de bajo esfuerzo y cubren lo más visible. S-5 conviene solo si queda tiempo, porque hay que
probar la web completa después de agregarla.
