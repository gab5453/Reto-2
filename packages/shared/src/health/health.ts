import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { recordDependency } from '../telemetry/metrics.js';

/**
 * `GET /health` de cada servicio. Lo consulta la Composición del ESB para el health del contrato v2 (`dependencias`) y el
 * orquestador de contenedores. Responde 200 si todas las dependencias están arriba (o en memoria) y 503 si alguna cayó.
 */
export type DependencyStatus = 'up' | 'down' | 'memory';

export interface HealthCheck {
  /** Nombre de la dependencia: `database`, `bus`, `grpc`… */
  name: string;
  check(): Promise<DependencyStatus>;
}

export interface ServiceInfo {
  name: string;
  version: string;
}

export const HEALTH_CHECKS = Symbol('HEALTH_CHECKS');
export const SERVICE_INFO = Symbol('SERVICE_INFO');

export interface HealthReport {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  uptime_seconds: number;
  dependencies: Record<string, { status: DependencyStatus; latency_ms: number }>;
}

const startedAt = Date.now();

export async function runHealthChecks(info: ServiceInfo, checks: HealthCheck[]): Promise<HealthReport> {
  const dependencies: HealthReport['dependencies'] = {};
  await Promise.all(
    checks.map(async (dependency) => {
      const started = Date.now();
      let status: DependencyStatus;
      try {
        status = await Promise.race([
          dependency.check(),
          new Promise<DependencyStatus>((resolve) => setTimeout(() => resolve('down'), 800)),
        ]);
      } catch {
        status = 'down';
      }
      dependencies[dependency.name] = { status, latency_ms: Date.now() - started };
    }),
  );
  const down = Object.values(dependencies).some((dependency) => dependency.status === 'down');
  // V2.16: cada /health (el orquestador lo consulta cada 10 s) deja el estado de sus dependencias en las métricas.
  for (const [name, dependency] of Object.entries(dependencies)) recordDependency(info.name, name, dependency.status !== 'down');
  return {
    status: down ? 'degraded' : 'ok',
    service: info.name,
    version: info.version,
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    dependencies,
  };
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(SERVICE_INFO) private readonly info: ServiceInfo,
    @Inject(HEALTH_CHECKS) private readonly checks: HealthCheck[],
  ) {}

  @Get()
  async health(@Res() response: Response): Promise<void> {
    const report = await runHealthChecks(this.info, this.checks);
    response.status(report.status === 'ok' ? 200 : 503).json(report);
  }
}
