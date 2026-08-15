// RNF-ARQ-001: Core infrastructure modules
import { Module } from '@nestjs/common';
import { LoggerModule } from './logger/logger.module.js';
import { DatabaseModule } from './database/database.module.js';
import { RedisModule } from './redis/redis.module.js';
import { CacheModule } from './cache/cache.module.js';
import { EventsModule } from './events/events.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';
import { MetricsModule } from './metrics/metrics.module.js';

@Module({
  imports: [
    LoggerModule,
    DatabaseModule,
    RedisModule,
    CacheModule,
    EventsModule,
    RealtimeModule,
    RateLimitModule,
    MetricsModule,
  ],
  exports: [
    LoggerModule,
    DatabaseModule,
    RedisModule,
    CacheModule,
    EventsModule,
    RealtimeModule,
  ],
})
export class CoreModule {}
