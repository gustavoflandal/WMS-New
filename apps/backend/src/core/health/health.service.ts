// RNF-ARQ-002: Health check logic for PostgreSQL and Redis
import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { CacheService } from '../cache/cache.service.js';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Optional() private readonly databaseService?: DatabaseService,
    @Optional() private readonly cacheService?: CacheService
  ) {}

  async checkDependencies(): Promise<Record<string, 'ok' | 'error'>> {
    const checks: Record<string, 'ok' | 'error'> = {
      postgresql: await this.checkPostgres(),
      redis: await this.checkRedis(),
    };

    return checks;
  }

  private async checkPostgres(): Promise<'ok' | 'error'> {
    try {
      if (!this.databaseService) {
        this.logger.warn('DatabaseService not available for health check');
        return 'ok'; // Assume ok if service not initialized yet
      }

      const isHealthy = await this.databaseService.healthCheck();
      return isHealthy ? 'ok' : 'error';
    } catch (error) {
      this.logger.error('PostgreSQL health check failed:', error);
      return 'error';
    }
  }

  private async checkRedis(): Promise<'ok' | 'error'> {
    try {
      if (!this.cacheService) {
        this.logger.warn('CacheService not available for health check');
        return 'ok'; // Assume ok if service not initialized yet
      }

      const isHealthy = await this.cacheService.healthCheck();
      return isHealthy ? 'ok' : 'error';
    } catch (error) {
      this.logger.error('Redis health check failed:', error);
      return 'error';
    }
  }
}
