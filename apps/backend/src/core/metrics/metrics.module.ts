// RNF-ARQ-072: Prometheus /metrics endpoint
import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { MetricsService } from './metrics.service.js';
import { MetricsController } from './metrics.controller.js';

@Module({
  imports: [CacheModule],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
