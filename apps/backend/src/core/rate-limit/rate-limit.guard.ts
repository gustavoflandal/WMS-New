// RNF-ARQ-100: Rate Limiting Guard
// Fixed-window counter per identifier (IP; user_id once DOC-12 auth lands):
// 60 req/min on auth routes (and any unauthenticated request, as the
// conservative default — no third tier is defined by RNF-ARQ-100), 1200
// req/min for authenticated requests. 429 with Retry-After + RFC 9457
// problem+json body (DOC-13 RNF-INT-001 format). /health/* and /metrics are
// exempt.
import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus, Logger, Optional } from '@nestjs/common';
import { Request, Response } from 'express';
import { CacheService } from '../cache/cache.service.js';

export interface RateLimitGuardOptions {
  authLimit?: number;
  authenticatedLimit?: number;
  windowSeconds?: number;
}

const EXEMPT_PREFIXES = ['/health'];
const EXEMPT_EXACT = ['/metrics'];

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  readonly authLimit: number;
  readonly authenticatedLimit: number;
  private readonly windowSeconds: number;

  constructor(
    private readonly cacheService: CacheService,
    // @Optional(): registered as APP_GUARD via useClass, so Nest's DI
    // constructs this directly and would otherwise try (and fail) to resolve
    // this plain options object as an injectable dependency.
    @Optional() options: RateLimitGuardOptions = {}
  ) {
    this.authLimit = options.authLimit ?? 60;
    this.authenticatedLimit = options.authenticatedLimit ?? 1200;
    this.windowSeconds = options.windowSeconds ?? 60;
  }

  static isExempt(path: string): boolean {
    return EXEMPT_EXACT.includes(path) || EXEMPT_PREFIXES.some((p) => path.startsWith(p));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    if (RateLimitGuard.isExempt(request.path)) {
      return true;
    }

    const isAuthRoute = request.path.startsWith('/auth');
    const isAuthenticated = !!request.headers.authorization;
    const limit = isAuthRoute || !isAuthenticated ? this.authLimit : this.authenticatedLimit;

    // [LACUNA: real user_id extraction from JWT — DOC-12] Until then, key by IP.
    const identifier = request.ip ?? 'unknown';
    const key = `ratelimit:${isAuthRoute ? 'auth' : 'app'}:${identifier}`;

    let count: number;
    let ttlSeconds: number;

    try {
      ({ count, ttlSeconds } = await this.cacheService.incrementCounter(key, this.windowSeconds));
    } catch (error) {
      // Cache unavailable: fail open (graceful degradation) rather than block traffic.
      this.logger.warn(`Rate limit check failed for ${identifier}`, error as Error);
      return true;
    }

    response.set('X-RateLimit-Limit', limit.toString());
    response.set('X-RateLimit-Remaining', Math.max(0, limit - count).toString());
    response.set('X-RateLimit-Reset', (Date.now() + ttlSeconds * 1000).toString());

    if (count > limit) {
      // Set Content-Type BEFORE throwing: Express's res.json() (used by Nest's
      // exception filter) only defaults Content-Type when unset, so this wins.
      response.set('Content-Type', 'application/problem+json');
      response.set('Retry-After', ttlSeconds.toString());

      throw new HttpException(
        {
          type: 'https://wms.internal/problems/rate-limit-exceeded',
          title: 'Too Many Requests',
          status: HttpStatus.TOO_MANY_REQUESTS,
          detail: `Rate limit exceeded: ${limit} requests per minute`,
          instance: request.originalUrl,
          retry_after: ttlSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    return true;
  }
}
