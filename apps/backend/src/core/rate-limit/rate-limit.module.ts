// RNF-ARQ-100: Global rate-limiting guard (60/min auth, 1200/min authenticated)
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CacheModule } from '../cache/cache.module.js';
import { RateLimitGuard } from './rate-limit.guard.js';

@Module({
  imports: [CacheModule],
  providers: [
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
  ],
})
export class RateLimitModule {}
