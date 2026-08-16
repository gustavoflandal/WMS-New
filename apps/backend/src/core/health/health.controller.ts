// RNF-ARQ-002: GET /health/live and GET /health/ready
import { Controller, Get, Logger } from '@nestjs/common';
import { HealthService } from './health.service.js';
import { Public } from '../rbac/decorators/public.decorator.js';

interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: string;
  service?: string;
  checks?: Record<string, 'ok' | 'error'>;
  version?: string;
}

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Get('live')
  async liveness(): Promise<HealthResponse> {
    // RNF-ARQ-002: Liveness check - simple probe, no dependencies
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'wms-api',
    };
  }

  @Public()
  @Get('ready')
  async readiness(): Promise<HealthResponse> {
    // RNF-ARQ-002: Readiness check - verifies PostgreSQL and Redis
    const checks = await this.healthService.checkDependencies();

    const status = Object.values(checks).every((c) => c === 'ok') ? 'ok' : 'error';

    if (status === 'error') {
      this.logger.error('Readiness check failed:', checks);
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      service: 'wms-api',
      checks,
      version: '0.0.1',
    };
  }
}
