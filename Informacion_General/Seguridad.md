# Seguridad — EcoAirlines Reto 2

Qué protege hoy el sistema, qué riesgos se conocen y qué mejoras se pueden hacer. Revisado el **12/11/2026** (SEG-1) sobre la rama
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
| **Dependencias de PRODUCCIÓN con avisos:** tras SEG-1 (12/11) queda **1 aviso alto**: `@graphql-tools/utils` (contaminación de prototipos, GHSA-c4qx-w738-7hr3), que viene con `@nestjs/graphql`. Los otros 7 (`multer`, `body-parser`, `follow-redirects`, `fast-uri`, `qs`, `@nestjs/platform-express`) se corrigieron | **Aceptado hasta el 18/11** (S-0) | La corrección es `@nestjs/graphql` 14.2.0, publicada el 04/11 (regla de las 2 semanas). Riesgo práctico bajo: el GraphQL tiene límites de profundidad y complejidad. La CI tiene la excepción **con fecha**: desde el 19/11 falla si no se actualizó |
| **Dependencias de desarrollo con avisos:** en la raíz, 1 moderado (`minimatch` dentro de ESLint, DoS con patrones glob; `npm audit` lo cuenta 9 veces); en la web, 3 (`deepmerge`, `glob`, `minimatch` dentro del plugin PWA), sin ningún alto. Vitest y `vite` ya se actualizaron (SEG-1) | Aceptado | Son herramientas de desarrollo: **no llegan al navegador ni a los contenedores**. Sus correcciones son versiones mayores que las herramientas aún no piden; Dependabot las propondrá |
| **Una sola VM:** si se cae, cae todo | Aceptado (presupuesto) | El crédito de estudiante (US$ 90) no alcanza para alta disponibilidad |
| La web no envía **Content-Security-Policy** ni **HSTS** | Pendiente (sección 4) | La API sí las tiene. La web no maneja tarjetas (eso es la Payment API), pero una CSP limitaría el daño de un script inyectado |

---

## 4. Mejoras posibles (opcionales, por esfuerzo)

| # | Mejora | Esfuerzo | Detalle |
|---|---|---|---|
| S-0 | **Actualizar las dependencias de producción con avisos** | ✅ **Hecha** (12/11), salvo `@nestjs/graphql` | NestJS 12.1.2 → **12.3.2** (27/10) en los 19 paquetes, con `multer` 2.5.0 y `express` 5.3.0; `body-parser` 2.4.0, `follow-redirects` 1.16.2, `fast-uri` 3.1.9 y `qs` 6.17.1 fijados con `overrides`. De 8 avisos (6 altos) a 1. **Falta `@nestjs/graphql` 14.0.3 → 14.2.0 desde el 18/11** |
| S-1 | **Actualizar las dependencias de desarrollo con avisos** | ✅ **Hecha** (12/11) | Vitest y `@vitest/coverage-v8` 4.1.12 en la raíz; `vite` 8.3.5 en la raíz (vía Vitest) y en la web (corrige el aviso alto); `rolldown` 1.2.15. Lo que queda es moderado o bajo, de herramientas |
| S-2 | **Revisión de dependencias en la CI** | ✅ **Hecha** (12/11) | `scripts/ci/auditoria.mjs` en la etapa de calidad y en la de la web: **falla con un aviso alto o crítico en producción**, salvo excepciones con fecha de vencimiento (hoy, solo la de `@nestjs/graphql`, hasta el 18/11). Los de desarrollo solo se informan. Escribe el resumen en cada ejecución |
| S-3 | **Dependabot y secret scanning de GitHub** | ✅ Configurado (12/11); falta activarlo | `.github/dependabot.yml`: npm (raíz y web), GitHub Actions y la imagen base de Docker, semanal o mensual, con **`cooldown` de 14 días** (la regla del proyecto), las menores agrupadas en una sola PR y **sin versiones mayores** de npm ni de Node (se migran a propósito; al activarse abrió 14 PR, varias mayores). **El responsable activa** en *Settings → Advanced Security*: *Dependabot alerts*, *Dependabot security updates*, *Secret scanning* y *Push protection* (gratis en un repositorio público) |
| S-4 | **Cambiar la contraseña del ADMIN de demostración** al terminar la evaluación | Bajo | Una variable en `infra/cloud/.env` (`ADMIN_PASSWORD`) y reiniciar Identity |
| S-5 | **CSP y HSTS en la web** | Medio | Agregar a `staticwebapp.config.json`: `Content-Security-Policy` con `connect-src` al gateway (https y wss) y a la Payment API, y `Strict-Transport-Security`. Requiere probar la web completa: una CSP mal escrita rompe el pago o el WebSocket |
| S-6 | **ESLint con reglas de tipos** | Medio | Ya está en el plan de pruebas (CI-2): detecta promesas olvidadas, que en las sagas pueden dejar operaciones a medias |
| S-7 | **Proteger la rama** en GitHub | Bajo | *Required status checks*: no se puede fusionar con la CI en rojo (el «gate» del PDF de la Semana 9). Útil si se empieza a trabajar con pull requests |
| S-8 | Revisar las imágenes Docker con **Trivy** | Medio | La opción B ya está (CD-1): un paso de Trivy en `imagenes-v2.yml` revisaría cada imagen antes de subirla. Las imágenes no llevan secretos (los recibe cada servicio de `cloud/.env` al arrancar) |

**Estado (12/11):** S-0 (salvo `@nestjs/graphql`, desde el 18/11), S-1, S-2 y S-3 hechas. Quedan: activar S-3 en GitHub, S-4 al
terminar la evaluación, y S-5 a S-8 como mejoras opcionales (S-5 conviene solo si queda tiempo, porque hay que probar la web
completa después de agregarla).

**Cómo se actualizó (lección de SEG-1):** `npm audit fix` y `npm dedupe` toman la versión **más nueva**, que puede tener días (el
12/11 subieron `@nestjs/platform-express` 12.5.0 y `rolldown` 1.2.19, publicados ese mismo día o la víspera; el segundo además
trajo una dependencia beta que rompió la compilación de las imágenes en Linux). Lo correcto es **`npm install --before=<fecha de
hace 14 días>`** (y lo mismo con `npm dedupe`), que resuelve como si fuera ese día, y después comprobar la fecha de cada paquete
que cambió en el lockfile.
