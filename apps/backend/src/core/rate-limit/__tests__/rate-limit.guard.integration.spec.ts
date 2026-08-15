// Scenario: Rate limiting guard (RNF-ARQ-100) — auth overflow, authenticated
// overflow, and exemption of /health & /metrics. Uses the real CacheService
// against real Redis (no mocking of Redis, per session rules); only the
// ExecutionContext (there is no real HTTP server in this test) is a plain
// object, since RateLimitGuard.canActivate() only reads request.path/ip/headers
// and calls response.set() — exactly what NestJS extracts from ExecutionContext.
import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../database/__tests__/test-setup.helper.js';
import { CacheModule } from '../../cache/cache.module.js';
import { CacheService } from '../../cache/cache.service.js';
import { RateLimitGuard } from '../rate-limit.guard.js';
import { createClient, RedisClientType } from 'redis';

function makeContext(path: string, opts: { ip?: string; authorization?: string } = {}): {
  context: ExecutionContext;
  responseHeaders: Record<string, string>;
} {
  const request: any = {
    path,
    originalUrl: path,
    ip: opts.ip ?? '127.0.0.1',
    headers: opts.authorization ? { authorization: opts.authorization } : {},
  };
  const responseHeaders: Record<string, string> = {};
  const response: any = {
    set: (key: string, value: string) => {
      responseHeaders[key] = value;
    },
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { context, responseHeaders };
}

describe('RateLimitGuard [RNF-ARQ-100]', () => {
  let testContext: TestContext;
  let cacheService: CacheService;
  let redisClient: RedisClientType;

  beforeAll(async () => {
    testContext = await setupIntegrationTest([CacheModule]);
    cacheService = testContext.module.get<CacheService>(CacheService);

    redisClient = createClient({
      url: testContext.configService.get('REDIS_URL', 'redis://localhost:6379/0'),
    }) as RedisClientType;
    await redisClient.connect();
  });

  afterAll(async () => {
    try {
      await redisClient.quit();
    } catch (e) {
      // ignore
    }
    await teardownIntegrationTest(testContext);
  });

  beforeEach(async () => {
    await redisClient.flushDb();
  });

  it('Blocks the (limit+1)th request on an /auth route with 429, Retry-After, and problem+json body', async () => {
    const guard = new RateLimitGuard(cacheService, { authLimit: 3, windowSeconds: 60 });
    const ip = '10.0.0.1';

    for (let i = 1; i <= 3; i++) {
      const { context } = makeContext('/auth/login', { ip });
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }

    const { context, responseHeaders } = makeContext('/auth/login', { ip });
    let thrown: HttpException | undefined;
    try {
      await guard.canActivate(context);
    } catch (error) {
      thrown = error as HttpException;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown!.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);

    const body = thrown!.getResponse() as Record<string, any>;
    expect(body.status).toBe(429);
    expect(body.type).toContain('rate-limit-exceeded');
    expect(body.retry_after).toBeGreaterThan(0);

    expect(responseHeaders['Content-Type']).toBe('application/problem+json');
    expect(Number(responseHeaders['Retry-After'])).toBeGreaterThan(0);
  });

  it('Blocks the (limit+1)th request on an authenticated non-auth route using the authenticated limit', async () => {
    const guard = new RateLimitGuard(cacheService, { authenticatedLimit: 2, windowSeconds: 60 });
    const ip = '10.0.0.2';
    const auth = 'Bearer some.jwt.token';

    for (let i = 1; i <= 2; i++) {
      const { context } = makeContext('/orders', { ip, authorization: auth });
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }

    const { context } = makeContext('/orders', { ip, authorization: auth });
    let thrown: HttpException | undefined;
    try {
      await guard.canActivate(context);
    } catch (error) {
      thrown = error as HttpException;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown!.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('Unauthenticated non-auth requests use the stricter auth-tier limit, not a third tier', async () => {
    const guard = new RateLimitGuard(cacheService, { authLimit: 1, authenticatedLimit: 1000, windowSeconds: 60 });
    const ip = '10.0.0.3';

    const first = makeContext('/orders', { ip }); // no Authorization header
    await expect(guard.canActivate(first.context)).resolves.toBe(true);

    const second = makeContext('/orders', { ip });
    let thrown: HttpException | undefined;
    try {
      await guard.canActivate(second.context);
    } catch (error) {
      thrown = error as HttpException;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown!.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('/health/* and /metrics are exempt: unlimited requests always pass, no counter created', async () => {
    const guard = new RateLimitGuard(cacheService, { authLimit: 1, authenticatedLimit: 1, windowSeconds: 60 });
    const ip = '10.0.0.4';

    for (let i = 0; i < 10; i++) {
      const health = makeContext('/health/ready', { ip });
      await expect(guard.canActivate(health.context)).resolves.toBe(true);

      const metrics = makeContext('/metrics', { ip });
      await expect(guard.canActivate(metrics.context)).resolves.toBe(true);
    }

    const keys = await redisClient.keys('ratelimit:*');
    expect(keys.length).toBe(0);
  });
});
