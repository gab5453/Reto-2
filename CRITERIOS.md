# CRITERIOS — Estado del Reto 2 frente a sus requisitos

Revisión del **03/11/2026** (fase V2.21) sobre la rama `feature/v2-microservicios`. Cada requisito tiene su evidencia
verificable en el repositorio o en la nube.

- ✅ **Cumple**: implementado y verificado.
- 🟡 **Parcial**: implementado, pero falta algo que no depende solo de nosotros, o una verificación.
- ❌ **No cumple**.

Los requisitos salen de tres fuentes: el **ingeniero** (tecnologías), el **contrato de Vuelos v2** del grupo de Booking, y las
**mejoras propias** aprobadas (`PLAN/PLAN.md` §0). La rúbrica del Reto 1 está en `historico/reto1/CRITERIOS.md`.

---

## 1. Requisitos del ingeniero

| # | Requisito | Estado | Evidencia |
|---|-----------|:------:|-----------|
| I-1 | Al menos un servicio en **gRPC** | ✅ | MS.G.Offers: `contract/ms-g-offers.proto` (4 servicios + health estándar); cliente en el ESB. Pruebas: `services/gestion/ms-g-offers/test/offers.spec.ts` con un cliente gRPC real |
| I-2 | Al menos un servicio en **SOA** | ✅ | MS.G.PostSale: SOAP 1.1 con `contract/ms-g-post-sale.wsdl` + `.xsd`, `CorrelationId` en `<soap:Header>`, `soap:Fault` traducido a `ProblemDetails` |
| I-3 | El resto en **REST** | ✅ | 7 MS.G REST, 5 MS de respuesta, ESB y Payment API, cada uno con su OpenAPI en `contract/` |
| I-4 | Todo en **TypeScript** | ✅ | `npm run typecheck` (TypeScript estricto) sobre todos los paquetes |
| I-5 | Arquitectura por capas: respuesta → ESB → gestión | ✅ | `tests/arquitectura-v2/arquitectura.spec.ts`: un MS.G nunca llama a otro; solo el ESB los coordina |
| I-6 | Base de datos por servicio | ✅ | Una base y un usuario de PostgreSQL por MS.G (`infra/postgres/`) |
| I-7 | Todo en la **nube** | ✅ | Azure: VM con los 26 contenedores + Static Web App con la web (`DESPLIEGUE_AZURE.md`) |

## 2. Contrato de Vuelos v2 (integración con Booking)

| # | Exigencia | Estado | Evidencia |
|---|-----------|:------:|-----------|
| C-1 | `/api/v2/vuelos/...`, una URL base, **30 operaciones** | ✅ | Gateway + 4 MS de respuesta. `npm run test:conformidad-v2` en local: 49 pasan, 5 omitidas (requieren el token de administrador). En la nube se verificaron la compra, el health y el token |
| C-2 | **Booking cobra**: la aerolínea solo valida `paymentReference` y calcula reembolsos | ✅ | Validador de referencias en el ESB (formato, uso único, monto); reembolsos `CALCULATED` |
| C-3 | Token OAuth2 `client_credentials` + `X-User-Id` | ✅ | MS.G.Identity; `POST /api/v2/oauth2/token`. Verificado en la nube con el partner `BOOKING_PROTOTIPO` |
| C-4 | `X-Correlation-Id` que nunca cambia, en todos los protocolos | ✅ | Una compra de Booking en la nube = **una traza** gateway → MS.Reservas → ESB → Offers (gRPC) → Bookings (CAMBIOS.md, V2.20) |
| C-5 | Eventos CloudEvents firmados por webhook + feed | 🟡 | Implementado y probado con el simulador; **Booking aún no activa sus webhooks** (BKG-15) |
| C-6 | **Stock** hacia Booking en cada cambio | ✅ | Por REST desde el 03/11 (D53, `NODE_VUE_EQ5`): Booking respondió `success: true`; 736 envíos sin errores. El gRPC original queda como alternativa |
| C-7 | Consumir `payment.confirmed`, `payment.failed` y `package.cancelled` | 🟡 | Entrada firmada y sin duplicados (D34), probada con el simulador. Falta que Booking defina su canal (BKG-01) y reciba el secreto |
| C-8 | Boletos aparte, varios asientos, estado de vuelo, operaciones, health, promociones, estados por asiento, `ProblemDetails` ampliado | ✅ | Sagas del ESB; `GET /vuelos/health` desde caché (< 1 s); máquina de estados de asiento en Offers |
| C-9 | Timeout de 5 s de Booking | ✅ | Plazo de saga 3,5 s; si no alcanza, `202` y se termina en segundo plano |
| C-10 | Credenciales entregadas a Booking | 🟡 | Generadas (`infra/cloud/.env`); falta acordar el canal privado (V2.14) |

## 3. Tecnologías y patrones (`PLAN/PLAN.md` §1)

| Tecnología / patrón | Estado | Dónde |
|---------------------|:------:|-------|
| GraphQL (con suscripciones) | ✅ | Gateway `/api/graphql`; la web solo usa GraphQL (`tests/arquitectura-v2/web-graphql.spec.ts`) |
| AMQP (RabbitMQ) + AsyncAPI + CloudEvents | ✅ | `EVENTOS.md`, `contract/events.asyncapi.yaml` |
| ESB: enrutamiento, orquestación (11 sagas), composición, entrada de eventos | ✅ | `services/esb`, `services/esb/test/sagas.spec.ts` |
| Saga distribuida entre organizaciones (compensación de combos) | ✅ | `package.cancelled` → Cancelar con `SAGA_COMPENSATION` |
| Idempotencia y control de concurrencia | ✅ | `Idempotency-Key`, `inbound_events`, asiento atómico, referencia de pago única |
| OAuth2, JWT RS256, JWKS, roles | ✅ | MS.G.Identity; 3 tipos de token |
| Tokenización de tarjetas | ✅ | Payment API simulada (autorizar → capturar → anular / reembolsar) |
| Observabilidad (OpenTelemetry, métricas, trazas, logs, alertas) | ✅ | En local y en la nube; alerta real verificada en la nube (74 s) |
| PWA (manifest + service worker, sin conexión) | 🟡 | Lighthouse PWA 100; recorrido en la URL pública con modo avión. **Falta probar la instalación en un teléfono real** |
| Contenedores y nube | ✅ | `infra/docker-compose.yml` en local y en la VM |
| CI/CD con GitHub Actions por servicio | 🟡 | `.github/workflows/imagenes-v2.yml` escrito, **en pausa por decisión del responsable** (03/11): se compila en la VM |

## 4. Mejoras propias

| Mejora | Estado | Pantalla |
|--------|:------:|----------|
| Usuarios con rol, creados por el administrador | ✅ | Administración → Usuarios |
| Partners (alta de Booking, credenciales, bloqueo) | ✅ | Administración → Partners |
| Precios por clase con «Rellenar» y descuento máximo de promociones (≤ 50 %) | ✅ | Administración → Precios |
| Asistencia médica (dato de salud, no sale del sistema) | ✅ | Checkout, reserva, perfil, Administración → Asistencia |
| Operaciones: ocupación y cambio de estado de vuelo | ✅ | Administración → Operaciones |
| Telemetría con búsqueda por correlation ID | ✅ | Administración → Telemetría |
| Pago con tarjeta (canal web) | ✅ | Checkout y postventa |

## 5. Calidad

| Criterio | Estado | Evidencia |
|----------|:------:|-----------|
| Pruebas automatizadas | ✅ | `npm test`: 638 pasan, 41 omitidas (necesitan PostgreSQL o RabbitMQ reales). Corren en paralelo y, con la máquina cargada, 1 o 2 que miden tiempos pueden fallar: pasan al repetirlas |
| Pruebas en navegador | ✅ | Recorridos en Edge: compra, administración (48 comprobaciones) y PWA (20, en la URL pública con CORS) |
| Contratos primero (API-first) | ✅ | V2.1: todos los contratos antes del código; los del grupo, sin cambios |
| Seguridad | ✅ | `ARQUITECTURA.md` §7; nada de tokens, tarjetas ni salud en logs |
| Trazabilidad de decisiones | ✅ | D1–D53 en `PLAN/PLAN.md` §7; cada fase en `CAMBIOS.md` |
| **Auditoría externa (Gemini)** | 🟡 | **Pendiente** desde V2.2: es la verificación que el plan pide para cerrar cada fase y V2.21 |

---

## 6. Lo que falta (resumen)

| Pendiente | Depende de |
|-----------|------------|
| Webhooks y eventos de Booking en real (C-5, C-7, BKG-01, BKG-15) | Booking («en unos días») |
| Entregar las credenciales por un canal privado (C-10) | Acordarlo con Booking |
| Instalar la PWA en un teléfono real | El responsable |
| GitHub Actions | Decisión del responsable (en pausa) |
| Auditorías de Gemini (V2.2–V2.21) | El responsable |
