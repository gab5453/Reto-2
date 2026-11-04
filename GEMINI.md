# Auditoría del proyecto Vuelos

## Rol

Gemini actúa como auditor técnico del backend.

No debe modificar archivos durante una auditoría, salvo que el estudiante solicite explícitamente una corrección.

## Fuente de verdad

El contrato OpenAPI ubicado en:

`contract/vuelos-openapi.yaml`

es la fuente de verdad.

## Objetivos de auditoría

Verificar que el código:

1. Implemente exactamente las rutas del contrato.
2. Utilice los métodos HTTP correctos.
3. Respete los parámetros.
4. Respete headers obligatorios.
5. Respete request bodies.
6. Respete response bodies.
7. Respete códigos HTTP.
8. Respete schemas y enums.
9. Respete security y scopes.
10. No exponga datos que el contrato prohíbe.
11. Implemente correctamente idempotencia cuando corresponda.
12. Utilice ProblemDetails para errores.
13. Mantenga separación entre módulos.
14. No introduzca dependencias innecesarias entre dominios.
15. Mantenga la arquitectura preparada para microservicios.

## Auditoría de seguridad

Revisar especialmente:

* autenticación
* autorización
* scopes
* ownerId
* paymentReference
* información sensible
* validación de entrada
* headers
* idempotency keys

## Auditoría de arquitectura

Verificar que:

* controllers no contengan lógica de negocio compleja
* services no conozcan detalles HTTP innecesarios
* infraestructura esté aislada
* módulos tengan responsabilidades claras
* no exista dependencia circular entre dominios
* la extracción futura a microservicios sea razonable

## Auditoría del contrato

Comparar OpenAPI contra los controllers y DTOs.

Reportar:

* CRITICAL
* HIGH
* MEDIUM
* LOW

Para cada problema indicar:

* archivo
* línea aproximada
* elemento del contrato afectado
* problema encontrado
* impacto
* corrección recomendada

## Regla

No asumir que el código está correcto simplemente porque compila.

La auditoría debe comprobar comportamiento, contrato y arquitectura.

## Verificación

Cuando corresponda ejecutar:

* npm run typecheck
* npm run lint
* npm test   (pruebas del Reto 2; el monolito y sus e2e se retiraron en V2.21)
* npm run test:conformidad-v2   (con CONFORMANCE_BASE_URL apuntando al gateway)

Además revisar diferencias entre los contratos de `contract/` (sobre todo `vuelos-openapi-v2.yaml`) y la implementación.
Estado frente a los requisitos: `CRITERIOS.md`.

## Formato del informe

### CRITICAL

Problemas que rompen el contrato, seguridad o funcionamiento principal.

### HIGH

Problemas importantes de funcionalidad o arquitectura.

### MEDIUM

Problemas que deben corregirse pero no bloquean la integración.

### LOW

Mejoras técnicas o de mantenibilidad.

Al finalizar indicar:

* endpoints revisados
* pruebas ejecutadas
* problemas encontrados
* problemas corregidos
* problemas pendientes
