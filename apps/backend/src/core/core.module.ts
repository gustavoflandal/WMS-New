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
import { RbacModule } from './rbac/rbac.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuditModule } from './audit/audit.module.js';
import { LgpdModule } from './lgpd/lgpd.module.js';
import { WorkflowModule } from './workflow/workflow.module.js';

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
    RbacModule,
    AuthModule,
    AuditModule,
    LgpdModule,
    WorkflowModule,
  ],
  exports: [
    LoggerModule,
    DatabaseModule,
    RedisModule,
    CacheModule,
    EventsModule,
    RealtimeModule,
    RbacModule,
    AuthModule,
    AuditModule,
    LgpdModule,
    WorkflowModule,
  ],
})
export class CoreModule {}
