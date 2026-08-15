// RNF-ARQ-100: Rate Limiting Guard
// Token bucket per user/IP: 60 req/min auth, 1200 req/min authenticated
import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { CacheService } from '../cache/cache.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  // Configuration
  private readonly AUTH_LIMIT = 60; // requests per minute
  private readonly AUTHENTICATED_LIMIT = 1200;
  private readonly WINDOW_MS = 60000; // 1 minute

  constructor(private readonly cacheService: CacheService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    // [LACUNA: Determine if route is exempt (e.g., /health/*, /metrics)]
    // For now, all routes rate-limited (will refine in RBAC session)

    const isAuthenticated = !!request.headers.authorization;
    const limit = isAuthenticated ? this.AUTHENTICATED_LIMIT : this.AUTH_LIMIT;

    // Identify by user_id (from token) or IP
    const identifier = isAuthenticated
      ? ((request as any).user)?.sub || request.ip
      : request.ip;

    const key = `ratelimit:${identifier}`;

    try {
      // Token bucket: get current count
      const countStr = await (this.cacheService as any).client?.get(key);
      const count = countStr ? parseInt(countStr) : 0;

      if (count >= limit) {
        // Limit exceeded
        response.set('Retry-After', Math.ceil(this.WINDOW_MS / 1000).toString());

        throw new HttpException({
          type: 'urn:ietf:params:oauth:error-uri:rate-limit-exceeded',
          title: 'Too Many Requests',
          status: 429,
          detail: `Rate limit exceeded: ${limit} requests per minute`,
          instance: request.url,
          retry_after: Math.ceil(this.WINDOW_MS / 1000),
        }, HttpStatus.TOO_MANY_REQUESTS);
      }

      // Increment count
      // First request sets TTL, subsequent requests increment within window
      if (count === 0) {
        await (this.cacheService as any).client?.setEx(
          key,
          Math.ceil(this.WINDOW_MS / 1000),
          '1'
        );
      } else {
        await (this.cacheService as any).client?.incr(key);
      }

      // Set headers
      response.set('X-RateLimit-Limit', limit.toString());
      response.set('X-RateLimit-Remaining', Math.max(0, limit - count - 1).toString());
      response.set('X-RateLimit-Reset', (Date.now() + this.WINDOW_MS).toString());

      return true;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      // Cache failure: log and allow (graceful degradation)
      this.logger.warn(`Rate limit check failed for ${identifier}`, error);
      return true;
    }
  }
}
