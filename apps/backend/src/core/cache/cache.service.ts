// RNF-ARQ-020..021: Cache and distributed locks via Redis
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

// RNF-ARQ-020: BLACKLIST of entities that MUST NOT be cached
const CACHE_BLACKLIST = new Set(['stock_balance', 'fiscal_stock_balance']);

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private client: RedisClientType;

  constructor(private readonly configService?: ConfigService) {}

  async onModuleInit(): Promise<void> {
    // RNF-ARQ-011: Fail-fast if REDIS_URL not configured (no fallback)
    const redisUrl = this.configService
      ? this.configService.get<string>('REDIS_URL')
      : process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable not configured');
    }

    this.client = createClient({
      url: redisUrl,
    });

    this.client.on('error', (err) => this.logger.error('Redis error', err));

    await this.client.connect();
    this.logger.log('Redis cache connected');
  }

  /**
   * Cache-aside pattern: check cache, fallback to provider
   * RNF-ARQ-020: Key format: cache:{tenant}:{entity}:{id}
   */
  async getOrLoad<T>(
    tenantId: string,
    entity: string,
    id: string,
    ttlSeconds: number = 300,
    loader: () => Promise<T>
  ): Promise<T> {
    // RNF-ARQ-020: Enforce blacklist
    if (CACHE_BLACKLIST.has(entity)) {
      throw new Error(
        `Entity "${entity}" is BLACKLISTED and cannot be cached. Load directly from database.`
      );
    }

    const key = `cache:${tenantId}:${entity}:${id}`;

    try {
      // Try to get from cache
      const cached = await this.client.get(key);
      if (cached) {
        return JSON.parse(cached);
      }

      // Load from provider
      const value = await loader();

      // Store in cache
      await this.client.setEx(key, ttlSeconds, JSON.stringify(value));

      return value;
    } catch (error) {
      this.logger.warn(`Cache operation failed for ${key}, loading from provider`, error);
      // Graceful degradation: if cache fails, just load
      return loader();
    }
  }

  /**
   * Invalidate cached entity
   * Called when entity is modified
   */
  async invalidate(tenantId: string, entity: string, id: string): Promise<void> {
    const key = `cache:${tenantId}:${entity}:${id}`;
    await this.client.del(key);
    this.logger.debug(`Cache invalidated: ${key}`);
  }

  /**
   * Distributed lock: SET NX PX with token
   * RNF-ARQ-021: 10 second timeout
   */
  async acquireLock(
    resource: string,
    lockTimeoutMs: number = 10000
  ): Promise<string | null> {
    const token = Math.random().toString(36).substring(7);
    const lockKey = `lock:${resource}`;

    try {
      const result = await this.client.set(lockKey, token, {
        NX: true,
        PX: lockTimeoutMs,
      });

      if (result === 'OK') {
        return token;
      }

      return null;
    } catch (error) {
      this.logger.error(`Failed to acquire lock for ${resource}`, error);
      return null;
    }
  }

  /**
   * Release lock (verify token to prevent accidental release)
   * RNF-ARQ-021: Token verification
   */
  async releaseLock(resource: string, token: string): Promise<boolean> {
    const lockKey = `lock:${resource}`;

    try {
      // Verify token before releasing
      const currentToken = await this.client.get(lockKey);
      if (currentToken !== token) {
        this.logger.warn(`Lock token mismatch for ${resource}, not released`);
        return false;
      }

      const result = await this.client.del(lockKey);
      return result === 1;
    } catch (error) {
      this.logger.error(`Failed to release lock for ${resource}`, error);
      return false;
    }
  }

  /**
   * RNF-ARQ-100: Atomic fixed-window counter for rate limiting.
   * Increments `key`, setting a TTL of `windowSeconds` on the first hit of the
   * window. Returns the new count and the window's remaining TTL.
   */
  async incrementCounter(
    key: string,
    windowSeconds: number
  ): Promise<{ count: number; ttlSeconds: number }> {
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, windowSeconds);
    }
    const ttl = await this.client.ttl(key);
    return { count, ttlSeconds: ttl > 0 ? ttl : windowSeconds };
  }

  /** Generic raw string read (used by the /metrics endpoint). */
  async getRaw(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch (error) {
      this.logger.error('Redis health check failed', error);
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.quit();
    this.logger.log('Redis connection closed');
  }
}
