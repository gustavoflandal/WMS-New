// RNF-ARQ-001: Core infrastructure modules
import { Module } from '@nestjs/common';
import { LoggerModule } from './logger/logger.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { CacheModule } from './cache/cache.module';
import { EventsModule } from './events/events.module';
import { RealtimeModule } from './realtime/realtime.module';

@Module({
  imports: [
    LoggerModule,
    DatabaseModule,
    RedisModule,
    CacheModule,
    EventsModule,
    RealtimeModule,
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
