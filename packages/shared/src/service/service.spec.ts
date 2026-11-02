import 'reflect-metadata';
import { Body, Controller, Get, type INestApplication, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import request from 'supertest';
import { correlationHeaders, currentCorrelation } from '../correlation/correlation.js';
import type { HealthCheck } from '../health/health.js';
import { ProblemDetailsException } from '../problem-details/problem-details.js';
import { configureService, EcoServiceModule } from './service.js';

/** La plantilla de servicio aplicada a una app mínima: lo que obtiene cualquier microservicio al usarla. */
class EchoDto {
  @IsString()
  name!: string;
}

@Controller('ejemplo')
class ExampleController {
  @Get('correlacion')
  correlation() {
    return { context: currentCorrelation(), outgoing: correlationHeaders() };
  }

  @Get('negocio')
  business(): never {
    throw new ProblemDetailsException({ status: 409, code: 'SEAT_TAKEN', title: 'Asiento no disponible', retryAfterSeconds: 5 });
  }

  @Get('fallo')
  failure(): never {
    throw new Error('detalle interno que no debe salir');
  }

  @Post('eco')
  echo(@Body() body: EchoDto) {
    return body;
  }
}

let databaseUp = true;
const database: HealthCheck = { name: 'database', check: async () => (databaseUp ? 'up' : 'down') };
const slow: HealthCheck = { name: 'lenta', check: () => new Promise((resolve) => setTimeout(() => resolve('up'), 5_000)) };

async function createApp(checks: HealthCheck[]): Promise<INestApplication> {
  @Module({ imports: [EcoServiceModule.forRoot({ name: 'ms-prueba', version: '9.9.9', healthChecks: checks })], controllers: [ExampleController] })
  class AppModule {}
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureService(app, { name: 'ms-prueba', version: '9.9.9' });
  await app.init();
  return app;
}

describe('plantilla de servicio (EcoServiceModule + configureService)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp([database]);
  });
  afterAll(async () => {
    await app.close();
  });

  describe('correlation ID (contrato v2 §6, D31)', () => {
    it('conserva el X-Correlation-Id recibido y lo devuelve; X-Request-Id también', async () => {
      const response = await request(app.getHttpServer())
        .get('/ejemplo/correlacion')
        .set('X-Correlation-Id', 'corr-booking-123')
        .set('X-Request-Id', 'req-gateway-1');
      expect(response.status).toBe(200);
      expect(response.headers['x-correlation-id']).toBe('corr-booking-123');
      expect(response.headers['x-request-id']).toBe('req-gateway-1');
      expect(response.body.context).toEqual({ correlationId: 'corr-booking-123', requestId: 'req-gateway-1' });
    });

    it('si no llega, lo crea', async () => {
      const response = await request(app.getHttpServer()).get('/ejemplo/correlacion');
      expect(response.headers['x-correlation-id']).toMatch(/^corr-[0-9a-f-]{36}$/);
      expect(response.headers['x-request-id']).toMatch(/^req-/);
    });

    it('en una llamada saliente propaga el MISMO correlation ID con un X-Request-Id nuevo', async () => {
      const response = await request(app.getHttpServer()).get('/ejemplo/correlacion').set('X-Correlation-Id', 'corr-saga-9');
      expect(response.body.outgoing['X-Correlation-Id']).toBe('corr-saga-9');
      expect(response.body.outgoing['X-Request-Id']).not.toBe(response.headers['x-request-id']);
    });

    it('un X-Correlation-Id inválido responde 400 VALIDATION_FAILED (no se cambia en silencio)', async () => {
      const response = await request(app.getHttpServer()).get('/ejemplo/correlacion').set('X-Correlation-Id', 'x'.repeat(101));
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED', correlation_id: response.headers['x-correlation-id'] });
    });
  });

  describe('ProblemDetails v2 (contrato §11)', () => {
    it('un error de negocio sale con instance, correlation_id, timestamp y Retry-After', async () => {
      const response = await request(app.getHttpServer()).get('/ejemplo/negocio').set('X-Correlation-Id', 'corr-err-1');
      expect(response.status).toBe(409);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.headers['retry-after']).toBe('5');
      expect(response.body).toEqual({
        type: 'about:blank',
        title: 'Asiento no disponible',
        status: 409,
        code: 'SEAT_TAKEN',
        instance: '/ejemplo/negocio',
        correlation_id: 'corr-err-1',
        timestamp: expect.any(String),
      });
    });

    it('una ruta inexistente responde 404 NOT_FOUND', async () => {
      const response = await request(app.getHttpServer()).get('/no-existe?pnr=XK7P2Q');
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND', instance: '/no-existe' }); // sin query string
    });

    it('un error inesperado responde 500 INTERNAL_ERROR sin filtrar el mensaje interno', async () => {
      const response = await request(app.getHttpServer()).get('/ejemplo/fallo');
      expect(response.status).toBe(500);
      expect(response.body.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('detalle interno');
    });

    it('un DTO inválido o con propiedades extra responde 400 con invalidParams', async () => {
      const response = await request(app.getHttpServer()).post('/ejemplo/eco').send({ name: 3, extra: true });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.invalidParams.map((p: { name: string }) => p.name).sort()).toEqual(['extra', 'name']);
    });
  });

  describe('GET /health', () => {
    it('200 ok con sus dependencias', async () => {
      databaseUp = true;
      const response = await request(app.getHttpServer()).get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'ok', service: 'ms-prueba', version: '9.9.9', dependencies: { database: { status: 'up' } } });
    });

    it('503 degraded si una dependencia cae', async () => {
      databaseUp = false;
      const response = await request(app.getHttpServer()).get('/health');
      expect(response.status).toBe(503);
      expect(response.body.dependencies.database.status).toBe('down');
      databaseUp = true;
    });

    it('una dependencia que no responde se marca down en menos de 1 s (el health del contrato exige < 1 s)', async () => {
      const slowApp = await createApp([slow]);
      const started = Date.now();
      const response = await request(slowApp.getHttpServer()).get('/health');
      expect(Date.now() - started).toBeLessThan(1000);
      expect(response.body.dependencies.lenta.status).toBe('down');
      await slowApp.close();
    });
  });
});
