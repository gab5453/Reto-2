# Auditoría del proyecto Vuelos

> **Documento histórico.** Es la auditoría de Gemini sobre la **primera versión** (estructura `src/modules/...`, un solo
> proyecto). Las rutas de archivos que cita ya no existen: desde V1.C la API está en 4 capas (`EcoAirlines.API`, `.Business`,
> `.DataManagement`, `.DataAccess`). Estado de cada hallazgo:
>
> | Hallazgo | Resolución |
> |----------|------------|
> | CRITICAL — acoplamiento entre dominios | ✅ Corregido (V1.A/V1.C): post-sale, check-in y admin usan solo `BookingsFacade`; cada dominio tiene su contexto de datos y `test/architecture.spec.ts` lo verifica |
> | HIGH — servicios que devuelven códigos HTTP | ⏳ Pendiente: propuesto como V1.B en `CAMBIOS.md` (los servicios aún devuelven `statusCode` 201 o 202) |
> | MEDIUM — `404` no documentado en postventa | 📋 Registrado como HALL-11 en `HALLAZGOS.md`: requiere cambiar el contrato, lo decide el líder de booking |
> | LOW — `202` de `/cancel` nunca producido | 📋 Registrado en `HALLAZGOS.md` (sección 7) y en la prueba de conformidad (`NOT_PRODUCIBLE`) |
> | LOW — `/cancel` sin `ForbidUnknownPropertiesGuard` | ⏳ Pendiente de decisión (nota de V1.B en `CAMBIOS.md`) |
>
> La arquitectura vigente está en [`ARQUITECTURA.md`](ARQUITECTURA.md). La próxima auditoría debe hacerse sobre esta versión.

## CRITICAL

### Dependencia circular / Acoplamiento fuerte entre dominios
* **Archivos:** `src/modules/post-sale/application/date-change.service.ts`, `src/modules/post-sale/application/baggage.service.ts`, `src/modules/post-sale/application/cancellation.service.ts`, `src/modules/check-in/application/check-in.service.ts`
* **Línea aproximada:** Cabeceras de importación (ej. imports de `BookingRepositoryPort`, `ReservationSystemPort`, `seatHolder`).
* **Elemento del contrato afectado:** Arquitectura (preparación para microservicios).
* **Problema encontrado:** Los módulos `post-sale` y `check-in` utilizan directamente puertos de base de datos e infraestructura (como `BookingRepositoryPort` y `ReservationSystemPort`) pertenecientes al módulo `bookings`. 
* **Impacto:** Rompe el aislamiento de dominios (bounded contexts). Imposibilita la futura extracción de estos módulos a microservicios independientes, dado que comparten el acceso directo a la misma base de datos o sistema externo en lugar de interactuar a través de interfaces de servicio, eventos o APIs de red.
* **Corrección recomendada:** Crear servicios de aplicación públicos en `bookings` (fachadas) que expongan las operaciones necesarias, y evitar exportar los puertos de repositorio hacia otros dominios.

## HIGH

### Servicios de aplicación acoplados a detalles HTTP
* **Archivos:** `src/modules/bookings/application/bookings.service.ts` (Líneas 28, 122), `src/modules/post-sale/application/baggage.service.ts` (Línea 20), `src/modules/post-sale/application/date-change.service.ts` (Línea 21). Controladores asociados: `BookingsController`, `BaggageController`, `DateChangeController`.
* **Línea aproximada:** Interfaces `BookingCreationResult`, `BaggageResult` y en los `return` de sus respectivos métodos.
* **Elemento del contrato afectado:** Arquitectura (responsabilidades).
* **Problema encontrado:** Los servicios de aplicación están decidiendo y devolviendo explícitamente códigos de estado HTTP (ej. `statusCode: 201 | 202`). Los controladores utilizan el objeto `@Res()` nativo de Express para inyectar este código.
* **Impacto:** Viola la regla de que los servicios no deben conocer detalles HTTP innecesarios, acoplando la lógica de negocio al transporte web. Dificulta la reutilización del servicio en contextos que no sean HTTP (e.g. colas de mensajes o CLI).
* **Corrección recomendada:** Modificar los servicios para que devuelvan el estado del proceso en términos de negocio (ej. `{ process: 'PENDING_PAYMENT' }` o `{ process: 'COMPLETED' }`) y que el controlador, al interpretar ese estado, defina si devuelve `200`, `201` o `202`.

## MEDIUM

### Códigos de estado HTTP faltantes en el contrato (o no respetados)
* **Archivo:** `contract/vuelos-openapi.yaml` y controladores de `post-sale`.
* **Línea aproximada:** Operaciones `get` en `/bookings/{bookingId}/cancellation-quote`, `get` en `/bookings/{bookingId}/baggage-options`, `post` en `/bookings/{bookingId}/baggage`, `post` en `/bookings/{bookingId}/date-change`.
* **Elemento del contrato afectado:** Respuestas HTTP (Responses).
* **Problema encontrado:** La aplicación correctamente usa el `BookingOwnershipGuard` para denegar el acceso a una reserva que no existe o pertenece a otro usuario, lanzando un `404 Not Found`. Sin embargo, el contrato OpenAPI omite declarar el código `404` para estas rutas específicas.
* **Impacto:** Inconsistencia entre lo documentado en el contrato OpenAPI y el comportamiento real del backend. Un cliente generado automáticamente podría fallar al no contemplar un `404` como respuesta.
* **Corrección recomendada:** Añadir la referencia `$ref: '#/components/responses/ProblemDetails404'` a las respuestas de dichas operaciones en el archivo `vuelos-openapi.yaml` (al ser la fuente de la verdad, se debe elevar un reporte para corregir el contrato).

## LOW

### Funcionalidad asíncrona documentada no implementada en cancelación
* **Archivos:** `vuelos-openapi.yaml` y `src/modules/post-sale/application/cancellation.service.ts`
* **Línea aproximada:** 457 del contrato y controlador `CancellationController`.
* **Elemento del contrato afectado:** Respuesta `202` en `POST /bookings/{bookingId}/cancel`.
* **Problema encontrado:** El contrato documenta que la cancelación puede devolver `202 Cancelación en proceso`. Sin embargo, el código ejecuta la cancelación completamente de manera síncrona devolviendo siempre `200`.
* **Impacto:** Menor. El servicio cumple con el éxito (`200`), pero documentar `202` sugiere a los consumidores que deben estar preparados para asincronismo y sondeos o webhooks, lo cual en la práctica nunca ocurre.
* **Corrección recomendada:** Si no se prevén cancelaciones demoradas, remover el `202` del contrato. Si pueden ocurrir en el futuro, es un comportamiento aceptable temporal.

### Consistencia en la restricción de propiedades desconocidas (Unknown properties)
* **Archivos:** `src/modules/post-sale/presentation/cancellation.controller.ts`
* **Línea aproximada:** 24.
* **Elemento del contrato afectado:** Validación de request bodies.
* **Problema encontrado:** Rutas como `/search` o `/bookings` emplean el guard `ForbidUnknownPropertiesGuard` para rechazar solicitudes con parámetros no declarados. La ruta `/bookings/{bookingId}/cancel` omite este guard.
* **Impacto:** Menor, ya que globalmente `ValidationPipe` con `whitelist: true` las descarta silenciosamente. Sin embargo, se genera un comportamiento inconsistente (algunas fallan con 400 y otras pasan descartando la data extra).
* **Corrección recomendada:** Agregar el `@UseGuards(new ForbidUnknownPropertiesGuard({ root: ['quoteId', 'reason'] }))` al controlador de cancelación.

---

### Resumen de la Auditoría

* **Endpoints revisados:** Se revisaron las operaciones de Búsqueda (`/search`), Catálogo de asientos, Retención de inventario (`/offers/hold`), Reservas (`/bookings`), Check-in, Webhooks, Postventa (Maletas, Cancelaciones, Cambios) y Estado de Vuelos.
* **Pruebas ejecutadas:** Se ejecutaron `npm run build`, `npm run lint`, `npm run test` (126 pruebas unitarias pasadas exitosamente) y `npm run test:e2e` (96 pruebas E2E y de conformidad con el contrato OpenAPI pasadas exitosamente).
* **Problemas encontrados:** 5 hallazgos reportados (1 Crítico, 1 Alto, 1 Medio, 2 Bajos) enfocados en arquitectura y consistencia del contrato.
* **Problemas corregidos:** 0 (Según instrucción de rol: *No debe modificar archivos durante una auditoría, salvo que el estudiante solicite explícitamente una corrección*).
* **Problemas pendientes:** Todos los detallados en este informe.

## Auditoría del proyecto Vuelos Parte 2

### Resumen de la revisión de correcciones (Parte 2)
Se han revisado los cambios realizados en respuesta al reporte inicial. A continuación el estado actual de los hallazgos:

#### 1. CRITICAL: Dependencia circular / Acoplamiento fuerte entre dominios -> **SOLUCIONADO**
* **Detalle:** Se constata que se ha refactorizado la arquitectura introduciendo una fachada pública (`BookingsFacade` en `src/modules/bookings/application/bookings.facade.ts`) e interfaces de instantáneas (`BookingSnapshot`). Los módulos de `post-sale` y `check-in` ahora consumen esta fachada en lugar de inyectar dependencias internas (`BookingRepositoryPort` o `ReservationSystemPort`). Además, se implementó una prueba estricta (`src/architecture.spec.ts`) que protege el diseño frente a futuras violaciones de acceso de datos cruzado. El acoplamiento entre dominios ha sido resuelto adecuadamente preparándolo para microservicios.

#### 2. HIGH: Servicios de aplicación acoplados a detalles HTTP -> **PENDIENTE**
* **Detalle:** Se observa que las interfaces `BookingCreationResult` y `BaggageResult`, así como los servicios (`BookingsService`, `BaggageService`, `DateChangeService`) continúan retornando explícitamente códigos de estado HTTP (ej. `statusCode: 200 | 202` o `201 | 202`). La lógica HTTP aún se filtra en las capas de aplicación, violando la regla impuesta sobre evitar los detalles de protocolo HTTP en servicios internos.

#### 3. MEDIUM: Códigos de estado HTTP faltantes en el contrato -> **PENDIENTE**
* **Detalle:** La discrepancia entre la implementación real (que sí retorna correctamente `404 Not Found` en caso de no hallar o no ser dueño de la reserva mediante el `BookingOwnershipGuard`) y el contrato `vuelos-openapi.yaml` persiste. Las rutas de post-venta (`/cancellation-quote`, `/baggage-options`, `/baggage`, `/date-change/*`, `/cancel`) aún no documentan la respuesta HTTP `404`.

#### 4. LOW: Funcionalidad asíncrona documentada no implementada en cancelación -> **PENDIENTE**
* **Detalle:** `CancellationController` y su respectivo servicio mantienen el flujo estrictamente síncrono retornando `200`. Si bien no es un error de funcionamiento, sigue habiendo una respuesta documentada en OpenAPI (`202 Cancelación en proceso`) que la API no genera bajo ningún concepto.

#### 5. LOW: Consistencia en la restricción de propiedades desconocidas -> **PENDIENTE**
* **Detalle:** Se verificó que el archivo `src/modules/post-sale/presentation/cancellation.controller.ts` para la ruta `POST /cancel` sigue omitiendo el uso de `ForbidUnknownPropertiesGuard`, manteniendo la discrepancia de nivel de rigurosidad con las otras rutas de la API (como `/search` o `/bookings`).

### Conclusión de Parte 2
El hallazgo más crítico relacionado con la arquitectura de microservicios y encapsulamiento (Bounded Contexts) fue resuelto con éxito y protegido a través de pruebas de arquitectura. No obstante, los hallazgos relacionados a convenciones HTTP (capa de controladores vs aplicación) y el contrato OpenAPI siguen vigentes. La compilación y las 130 pruebas automáticas en total (incluyendo la nueva prueba de arquitectura) se ejecutan correctamente sin errores.
