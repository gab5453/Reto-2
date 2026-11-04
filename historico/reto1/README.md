# AppVuelos — EcoAirlines

Plataforma web para una aerolínea ficticia con identidad ecológica, construida a partir de un **contrato REST (OpenAPI 3.0)**.
Proyecto académico de *Integración de Sistemas* (Reto 1), desarrollado con prácticas profesionales: contrato como fuente de verdad,
arquitectura en capas, seguridad, persistencia en PostgreSQL, eventos, pruebas automatizadas, despliegue continuo en Azure y
trazabilidad de cada decisión.

> EcoAirlines es ficticia: vuelos, precios y cifras ambientales son ilustrativos.

## En línea (Azure)

| | URL |
|---|-----|
| **Web** (marketplace y panel de administración) | https://nice-hill-090e19c10.1.azurestaticapps.net |
| **API · Swagger** | https://ecoairlines-api-gv-fjfaa7b5geg3hphs.brazilsouth-01.azurewebsites.net/docs |

**Clientes de prueba:** `demo@ecoairlines.test` / `EcoDemo2026`, `maria@ecoairlines.test` / `EcoMaria2026` y `luis@ecoairlines.test` /
`EcoLuis2026`. La clave del administrador (`admin@ecoairlines.test`) se entrega aparte.

**Swagger:**
1. En el selector de documentos, elegir **"dev-auth"** y hacer `POST /login` para obtener el token.
2. Pegar el token en **Authorize**.

Casos de prueba en [`PRUEBASSW.md`](PRUEBASSW.md).

**Servicios:** Static Web Apps (web), App Service (API y dev-auth), PostgreSQL Flexible Server y GitHub Actions. Cada push a `main`
despliega solo lo que cambió. Paso a paso en [`DESPLIEGUE_AZURE.md`](DESPLIEGUE_AZURE.md).

## Qué incluye

| Área | Funcionalidad |
|------|---------------|
| **API del contrato** | Las 22 operaciones de `contract/vuelos-openapi.yaml`: búsqueda, mapa de asientos, holds, reservas y emisión, postventa (maletas, cambio de fecha, cancelación), check-in y pases, estado de vuelo, webhooks |
| **Marketplace** | Búsqueda (ida, ida y vuelta, multidestino), tarifas, reserva con asientos y equipaje del grupo en un panel, validación de pasajeros (edad, cédula, documento único), pago por referencia, "Mis viajes", postventa y check-in con QR |
| **Administración** | Indicadores, ocupación por fecha/origen/ruta, estado operativo de vuelos, pasajeros por vuelo, **CRUD de rutas programadas** y **de la flota**, horario de cada avión, eventos y observabilidad |
| **Horario** | 90 rutas de ida y vuelta (todos con todos, 180 vuelos diarios), 91 días a la venta, horario semanal fijo por avión, validado para que ningún avión esté en dos lugares a la vez |
| **Eventos (SOA/EDA)** | Bus interno con 9 eventos del contrato y webhooks firmados con HMAC-SHA256, con reintentos ([`EVENTOS.md`](EVENTOS.md)) |
| **Datos** | PostgreSQL, con un esquema por dominio; en memoria si no hay base (desarrollo y pruebas) |
| **Seguridad** | JWT con scopes, propiedad de recursos por usuario, idempotencia, rate limit, CORS por lista blanca, ProblemDetails |

## Estructura

La API está organizada en **4 capas**, como una solución .NET con 4 proyectos (`.sln` + `.csproj`). Aquí cada capa es un
workspace npm con su `package.json` y su `tsconfig.json`, y cada una solo usa las capas inferiores:

```
EcoAirlines.API  →  EcoAirlines.Business  →  EcoAirlines.DataManagement  →  EcoAirlines.DataAccess
```

| Carpeta / archivo | Contenido |
|-------------------|-----------|
| [`EcoAirlines.API/`](EcoAirlines.API) | **API REST** (NestJS + TypeScript): controllers, autenticación, seguridad, ProblemDetails, idempotencia, observabilidad y Swagger en `/docs` |
| [`EcoAirlines.Business/`](EcoAirlines.Business) | **Lógica de negocio**: services, DTOs del contrato, reglas, excepciones y bus de eventos |
| [`EcoAirlines.DataManagement/`](EcoAirlines.DataManagement) | **Patrón repositorio**: interfaces, repositorios y gateways hacia el GDS, la Payment API y los webhooks |
| [`EcoAirlines.DataAccess/`](EcoAirlines.DataAccess) | **Datos**: entidades, un contexto de datos por dominio (un esquema de PostgreSQL cada uno), GDS y Payment API simulados, horario |
| [`contract/`](contract) | Contrato [`vuelos-openapi.yaml`](contract/vuelos-openapi.yaml): fuente de verdad, no se modifica. Anexo [`ecoairlines-extensions.yaml`](contract/ecoairlines-extensions.yaml): endpoints propios (perfil, cambio de asiento, administración, rutas, flota, eventos y observabilidad) |
| [`ecoairlines-web/`](ecoairlines-web) | **Sitio web** (React + TypeScript + Vite), verde y blanco |
| [`dev-auth/`](dev-auth) | Servidor de **autenticación**: registro, login y JWT con scopes según el rol; cuentas en PostgreSQL. Simula al proveedor OAuth2 del contrato |
| [`.github/workflows/`](.github/workflows) | Despliegue continuo a Azure: web, API (con pruebas) y dev-auth |
| [`ARQUITECTURA.md`](ARQUITECTURA.md) | **Arquitectura**: componentes, capas, flujo de compra, horario, modelo de datos y eventos (diagramas Mermaid) |
| [`EVENTOS.md`](EVENTOS.md) | **Eventos (SOA/EDA)**: catálogo, bus interno, webhooks firmados y evolución hacia un broker |
| [`DESPLIEGUE_AZURE.md`](DESPLIEGUE_AZURE.md) | Despliegue en Azure paso a paso, URLs públicas y problemas frecuentes |
| [`PRUEBASSW.md`](PRUEBASSW.md) | Guía de pruebas manuales en Swagger, incluidos los errores 400–429 |
| [`CRITERIOS.md`](CRITERIOS.md) | Estado frente a la rúbrica de evaluación y descripción de cada parte para la defensa |
| [`CAMBIOS.md`](CAMBIOS.md) | Bitácora por versiones: qué se pidió, cómo se hizo y cómo se verificó |
| [`HALLAZGOS.md`](HALLAZGOS.md) | Hallazgos verificados: entorno, nube, plantilla del booking, extensiones y contrato |
| [`AUDITORIA.md`](AUDITORIA.md) | Auditoría técnica de Gemini sobre la primera versión (histórica, con el estado de cada hallazgo) |
| [`CLAUDE.md`](CLAUDE.md) / [`GEMINI.md`](GEMINI.md) | Reglas del programador (Claude) y del auditor (Gemini) |

## Requisitos (local)

- **Node.js 24** (LTS; recomendado ≥ 24.15) y npm.
- Puertos libres: **3000** (API), **4000** (dev-auth) y **5173** (frontend).
- Opcional: **Docker**, para usar PostgreSQL en local. Sin base de datos, todo funciona en memoria.

## Puesta en marcha (local)

En tres terminales:

```bash
# 1) API — http://localhost:3000  (Swagger: http://localhost:3000/docs). Desde la raíz del repositorio:
npm install
npm run start:dev

# 2) Autenticación — http://localhost:4000
cd dev-auth
npm install
npm start

# 3) Frontend — http://localhost:5173
cd ecoairlines-web
npm install
npm run dev
```

Abrir **http://localhost:5173** (con `localhost`, no `127.0.0.1`).
- **Usuarios de prueba:** los clientes de arriba y el administrador `admin@ecoairlines.test` / `EcoAdmin2026` (en local; en la nube se
  cambia con `ADMIN_PASSWORD`).
- **Panel de administración y observabilidad:** en `/admin`.

**Con PostgreSQL en local** (opcional): los datos sobreviven a los reinicios.

```bash
docker run -d --name ecoairlines-pg -e POSTGRES_PASSWORD=clave -e POSTGRES_DB=ecoairlines -p 5432:5432 postgres:16-alpine
# y antes de iniciar la API y dev-auth:
export DATABASE_URL=postgres://postgres:clave@localhost:5432/ecoairlines   # PowerShell: $env:DATABASE_URL="..."
```

Las tablas se crean solas al arrancar.

**Swagger en local:** generar un token con `npm run token` (en la raíz) o con el documento **"dev-auth"** del selector, y pegarlo en
*Authorize* → `DevBearer`.

## Calidad

```bash
npm run typecheck && npm run lint && npm test && npm run test:e2e && npm run build   # API (raíz)
cd ecoairlines-web && npm run lint && npm run build                                   # frontend
```

- **Pruebas:** 174 unitarias y 138 e2e.
- **Conformidad con el contrato:** las e2e validan **cada respuesta real de la API contra los schemas del contrato** y exigen cubrir
  todas las combinaciones operación + status documentadas.
- **Arquitectura:** una prueba verifica el sentido de las dependencias entre capas y que ningún dominio acceda a los datos de otro.
- **Persistencia:** con `TEST_DATABASE_URL`, una prueba reinicia la API contra PostgreSQL y comprueba que los datos siguen ahí.
- GitHub Actions corre todo esto antes de cada despliegue de la API.

Detalle en [`EcoAirlines.API/README.md`](EcoAirlines.API/README.md).

## Seguridad (resumen)

- **JWT verificado:** firma, expiración, emisor, audiencia y algoritmos permitidos, con scopes OAuth2 del contrato.
- **Recursos por usuario:** cada uno ve solo lo suyo; un recurso ajeno responde 404.
- **Protección HTTP:** cabeceras seguras, CORS por lista blanca, límite de peticiones (`429`), validación y saneamiento de entradas,
  idempotencia y errores uniformes en formato ProblemDetails.
- **Webhooks:** firmados con HMAC y con protección anti-SSRF.
- **Secretos:** los que aparecen en el código son **solo de desarrollo**. La API y dev-auth se niegan a arrancar con ellos en la nube,
  y los secretos reales viven en la configuración de Azure.

## Flujo de trabajo

1. Cada cambio se propone y se aprueba antes de implementarse, y se registra en `CAMBIOS.md` con su verificación.
2. El contrato **no se modifica**: las inconsistencias se registran en `HALLAZGOS.md`.
3. Gemini audita el resultado (`AUDITORIA.md`) y el responsable del proyecto supervisa el funcionamiento antes de cada commit.
4. Un push a `main` despliega en Azure: la API solo si pasan los tipos, el lint y las pruebas.
