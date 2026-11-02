import { type DynamicModule, type INestApplication, Module, type Provider, ValidationPipe } from '@nestjs/common';
import { correlationMiddleware } from '../correlation/correlation.js';
import { HEALTH_CHECKS, type HealthCheck, HealthController, SERVICE_INFO, type ServiceInfo } from '../health/health.js';
import { createRequestLogMiddleware, JsonLogger, requestLogEnabled } from '../logging/logging.js';
import { ProblemDetailsFilter } from '../problem-details/problem-details.filter.js';
import { validationExceptionFactory } from '../problem-details/problem-details.js';

/**
 * Plantilla de servicio (V2.2 del plan). Cada microservicio importa `EcoServiceModule.forRoot(...)` en su módulo raíz y
 * llama a `configureService(app, ...)` al arrancar, en lugar de copiar este código:
 * - `GET /health` con sus dependencias;
 * - X-Correlation-Id / X-Request-Id en toda respuesta (también en errores) y en el contexto de la petición;
 * - log JSON por petición (`api_request_logs`) y logger JSON de NestJS;
 * - ProblemDetails v2 para cualquier error y validación de DTOs estricta (`additionalProperties: false` del contrato).
 * La telemetría se inicia antes, en `main.ts` (ver telemetry.ts).
 */
export interface EcoServiceOptions extends ServiceInfo {
  healthChecks?: HealthCheck[];
}

@Module({})
export class EcoServiceModule {
  static forRoot(options: EcoServiceOptions): DynamicModule {
    const providers: Provider[] = [
      { provide: SERVICE_INFO, useValue: { name: options.name, version: options.version } satisfies ServiceInfo },
      { provide: HEALTH_CHECKS, useValue: options.healthChecks ?? [] },
    ];
    return { module: EcoServiceModule, global: true, controllers: [HealthController], providers, exports: providers };
  }
}

export function configureService(app: INestApplication, service: ServiceInfo): void {
  // En pruebas se respeta el logger que configuró la prueba (normalmente apagado).
  if (process.env['NODE_ENV'] !== 'test') app.useLogger(new JsonLogger(service.name));
  // Primero la correlación: incluso un 404 o un JSON inválido devuelven X-Correlation-Id.
  app.use(correlationMiddleware);
  if (requestLogEnabled()) app.use(createRequestLogMiddleware(service.name));
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory }),
  );
  app.enableShutdownHooks();
}
