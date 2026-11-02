import { createRequire } from 'node:module';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * OpenTelemetry (§4.7 del plan): trazas de cada petición HTTP entrante y saliente (`http` y `fetch`) y gRPC, exportadas por OTLP/HTTP al Collector.
 * Se activa solo si existe OTEL_EXPORTER_OTLP_ENDPOINT (p. ej. http://otel-collector:4318); sin ella (pruebas, local sin
 * Docker) no hace nada. Debe llamarse ANTES de importar NestJS/Express, para que la instrumentación de `http` se aplique:
 * cada servicio lo hace en la primera línea de su `main.ts` (`import './telemetry.js'`).
 *
 * El correlation ID no es el trace_id: viaja como atributo `correlation_id` de cada span (lo pone correlationMiddleware),
 * así una compra se busca en las trazas por su X-Correlation-Id.
 */
let sdk: NodeSDK | undefined;

/**
 * Los servicios son ESM y la instrumentación de gRPC se engancha a `require`: un `import` de `@grpc/grpc-js` no pasa por ahí y
 * el salto ESB → Offers quedaba fuera de las trazas (V2.16). Cargarlo con `require` después de arrancar el SDK lo parchea, y el
 * `import` de cada servicio (que corre después: `telemetry.js` es la primera línea de `main.ts`) recibe la versión parcheada.
 */
function loadGrpcThroughRequire(): void {
  try {
    createRequire(import.meta.url)('@grpc/grpc-js');
  } catch {
    // Este servicio no usa gRPC.
  }
}

export function startTelemetry(serviceName: string, version = '1.0.0'): boolean {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint || sdk) return Boolean(sdk);
  const base = endpoint.replace(/\/$/, '');
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': serviceName,
      'service.version': version,
      'deployment.environment.name': process.env['NODE_ENV'] ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    // V2.16: métricas (latencia y errores HTTP, y las de negocio de metrics.ts) cada 15 s, y los logs JSON (logging.ts).
    metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }), exportIntervalMillis: 15_000 }),
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${base}/v1/logs` }) })],
    instrumentations: [
      new HttpInstrumentation({
        // No se traza el sondeo de salud: sería ruido en cada verificación del orquestador.
        ignoreIncomingRequestHook: (request) => request.url === '/health',
      }),
      // V2.16: el salto ESB → Offers es gRPC; sin esto la traza de una compra se cortaba ahí.
      new GrpcInstrumentation(),
      // V2.16: los servicios se llaman con `fetch` (undici), que HttpInstrumentation no ve: sin esto no se propagaba
      // `traceparent` y cada salto empezaba una traza nueva.
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();
  loadGrpcThroughRequire();
  const stop = () => {
    void sdk?.shutdown();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return true;
}
