// Scenario: Cache blacklist enforcement (stock_balance, fiscal_stock_balance)
// RNF-ARQ-020: BLACKLIST entities that MUST NOT be cached
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../database/__tests__/test-setup.helper';
import { CacheModule } from '../cache.module';
import { CacheService } from '../cache.service';
import { createClient, RedisClientType } from 'redis';
import { v4 as uuid } from 'uuid';

describe('Cache - Blacklist Enforcement', () => {
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
    // Flush all Redis data so each test starts from a clean cache state.
    await redisClient.flushDb();
  });

  it('Throws error when attempting to cache stock_balance', async () => {
    const loader = async () => ({ balance: 100 });

    let errorThrown = false;
    let errorMessage = '';

    try {
      await cacheService.getOrLoad('tenant1', 'stock_balance', 'product1', 300, loader);
    } catch (error) {
      errorThrown = true;
      errorMessage = error.message;
    }

    expect(errorThrown).toBe(true);
    expect(errorMessage).toContain('BLACKLIST');
  });

  it('Throws error when attempting to cache fiscal_stock_balance', async () => {
    const loader = async () => ({ balance: 50 });

    let errorThrown = false;

    try {
      await cacheService.getOrLoad('tenant1', 'fiscal_stock_balance', 'product1', 300, loader);
    } catch (error) {
      errorThrown = true;
    }

    expect(errorThrown).toBe(true);
  });

  it('Allows caching of non-blacklisted entities', async () => {
    const loader = async () => ({ name: 'Product A' });

    // Should not throw
    const result = await cacheService.getOrLoad('tenant1', 'product', 'sku123', 300, loader);

    expect(result.name).toBe('Product A');
  });

  it('Invalidates cached entity', async () => {
    // Use a unique id per test invocation so stale cache from a prior run can't
    // interfere even before flushDb runs (belt-and-suspenders with beforeEach).
    const entityId = uuid();
    let loadCount = 0;
    const loader = async () => {
      loadCount++;
      return { value: loadCount };
    };

    // First call hits loader
    const result1 = await cacheService.getOrLoad('tenant1', 'entity', entityId, 300, loader);
    expect(result1.value).toBe(1);

    // Second call should hit cache
    const result2 = await cacheService.getOrLoad('tenant1', 'entity', entityId, 300, loader);
    expect(result2.value).toBe(1);
    expect(loadCount).toBe(1);

    // Invalidate
    await cacheService.invalidate('tenant1', 'entity', entityId);

    // Third call should hit loader again
    const result3 = await cacheService.getOrLoad('tenant1', 'entity', entityId, 300, loader);
    expect(result3.value).toBe(2);
    expect(loadCount).toBe(2);
  });
});
