# EcoAirlines v2 — Microservicios (Reto 2)

Aerolínea ficticia con identidad ecológica, integrada con **Booking Prototipo** mediante el **contrato de Vuelos v2** del grupo.
Proyecto académico de *Integración de Sistemas*: 18 servicios en TypeScript que integran **REST, gRPC, SOAP, GraphQL y mensajería
con CloudEvents**, con sagas, observabilidad de punta a punta y una web progresiva (PWA), desplegados en Azure.

> EcoAirlines es ficticia: vuelos, precios y cifras ambientales son ilustrativos. La versión 1 (monolito en 4 capas, Reto 1) se
> retiró en V2.21: su documentación está en [`historico/reto1/`](historico/reto1) y su código en el commit `7cdd384`.

## En línea (Azure)

| | URL |
|---|-----|
| **Web** (PWA: compra, «Mis viajes», check-in, administración) | https://nice-hill-090e19c10.1.azurestaticapps.net |
| **API del contrato v2** (la usa Booking) | https://ecoairlines-reto2.northcentralus.cloudapp.azure.com/api/v2/vuelos/health |
| **Swagger** del contrato v2 | https://ecoairlines-reto2.northcentralus.cloudapp.azure.com/api/docs/ |
| **Grafana** (con usuario y contraseña) | https://ecoairlines-reto2.northcentralus.cloudapp.azure.com/grafana/ |

La VM se apaga a las 23:00 de Ecuador para cuidar el crédito: encenderla según [`DESPLIEGUE_AZURE.md`](DESPLIEGUE_AZURE.md) §5.
Tarjeta de prueba: `4242 4242 4242 4242` (botón «Usar tarjeta de prueba» en el pago).

**Usuarios de prueba** (en local y en la nube; es un proyecto académico):

| Rol | Correo | Contraseña |
|-----|--------|------------|
| Administrador (panel en `/admin`) | `admin@ecoairlines.test` | `EcoAdmin2026` |
| Cliente | `demo@ecoairlines.test` | `EcoDemo2026` |
| Cliente | `maria@ecoairlines.test` | `EcoMaria2026` |
| Cliente | `luis@ecoairlines.test` | `EcoLuis2026` |

## Arquitectura en una imagen

```
Web (GraphQL) ─┐                     ┌─ MS.Vuelos ─┐                ┌─ Identity · Customers · Webhooks · Schedule
               ├─▶ Gateway ─────────▶├─ MS.Reservas ├─▶ ESB ─────────▶├─ FlightStatus · Bookings · CheckIn  (REST)
Booking (REST) ┘   /api/v2/vuelos    ├─ MS.Postventa│   sagas        ├─ Offers  (gRPC)  ──stock──▶ Booking
                   /api/graphql      ├─ MS.Clientes │   composición  └─ PostSale (SOAP)
                                     └─ MS.Admin ───┘   eventos ◀── Booking          PostgreSQL · RabbitMQ · OpenTelemetry
```

Detalle y diagramas: [`ARQUITECTURA.md`](ARQUITECTURA.md). Eventos: [`EVENTOS.md`](EVENTOS.md).

## Puesta en marcha (local)

Requisitos: **Node.js 24**, npm y **Docker Desktop** (conviene limitar su memoria con `.wslconfig`, ver `PASOS_FINALES.md` §1).

```bash
npm ci                     # dependencias de todos los servicios (workspaces)
npm run infra:up           # 27 contenedores: servicios, PostgreSQL, RabbitMQ, observabilidad y Booking simulado
# Una vez, en una base nueva: publica el horario con la saga del ESB (el mismo script de la nube)
docker compose -f infra/docker-compose.yml exec -T -e ADMIN_PASSWORD=EcoAdmin2026 esb node --input-type=module < scripts/cloud/publicar-horario.mjs

cd ecoairlines-web && npm ci && npm run dev   # web en http://localhost:5173
```

| Local | URL |
|-------|-----|
| Gateway (REST v2, GraphQL, Swagger) | http://localhost:8088/api/v2/vuelos/health · `/api/graphql` · `/api/docs/` |
| Grafana | http://localhost:3001 (usuario `admin`, contraseña de desarrollo en `infra/docker-compose.yml`) |
| RabbitMQ | http://localhost:15672 |
| Booking simulado | http://localhost:4090/simulador/stock · `/simulador/webhooks` |

Los usuarios de prueba de arriba también existen en local (`services/gestion/ms-g-identity/src/services/seed.ts`).

Para ahorrar memoria, la observabilidad y el simulador se pueden detener (`docker compose stop otel-collector prometheus …`): ver
`PASOS_FINALES.md` §1.3.

## Calidad

```bash
npm run typecheck && npm run lint && npm test     # tipos, lint y 679 pruebas (41 necesitan PostgreSQL/RabbitMQ reales)
npm run test:conformidad-v2                        # las 30 operaciones del contrato v2 contra CONFORMANCE_BASE_URL
cd ecoairlines-web && npm run lint && npm run build
```

- **Arquitectura:** `tests/arquitectura-v2` falla si un MS.G llama a otro, si algo distinto de Offers, Webhooks o el ESB habla
  con Booking, o si la web usa algo distinto de GraphQL y la Payment API.
- **Contratos primero:** todo contrato está en [`contract/`](contract); los del grupo (`vuelos-openapi-v2.yaml`,
  `booking-inventory.proto`) no se modifican.

## Documentos

| Documento | Contenido |
|-----------|-----------|
| [`ARQUITECTURA.md`](ARQUITECTURA.md) | Componentes, tecnologías, flujos, datos, seguridad, observabilidad y despliegue |
| [`EVENTOS.md`](EVENTOS.md) | CloudEvents, bus RabbitMQ, webhooks a Booking, eventos entrantes y stock |
| [`CRITERIOS.md`](CRITERIOS.md) | Cada requisito (ingeniero, contrato v2, mejoras propias) con su evidencia y estado |
| [`DEFENSA.md`](DEFENSA.md) | Guía de la defensa: checklist, demostración paso a paso y preguntas probables |
| [`DESPLIEGUE_AZURE.md`](DESPLIEGUE_AZURE.md) | La nube: costos, encender y apagar, desplegar, secretos, problemas frecuentes |
| [`PASOS_FINALES.md`](PASOS_FINALES.md) | Recursos que consume el sistema, hospedaje (decidido: Azure) y pendientes |
| [`PLAN/PLAN.md`](PLAN/PLAN.md) | Plan por fases y **registro de decisiones D1–D53** |
| [`CAMBIOS.md`](CAMBIOS.md) | Bitácora de cada fase: qué se pidió, cómo se hizo y cómo se verificó |
| [`HALLAZGOS.md`](HALLAZGOS.md) | Hallazgos y preguntas para Booking (serie BKG) |
| [`CLAUDE.md`](CLAUDE.md) / [`GEMINI.md`](GEMINI.md) | Reglas del programador (Claude) y del auditor (Gemini) |

## Flujo de trabajo

1. Cada fase se propone, se aprueba, se implementa y se verifica (pruebas, navegador y nube), y se registra en `CAMBIOS.md`.
2. Los contratos del grupo **no se modifican**: las dudas van a `HALLAZGOS.md` (serie BKG).
3. Gemini audita cada fase; el responsable aprueba antes de cada commit.
