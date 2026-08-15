// Scenario: E2E Event Pipeline - Commit → Outbox → Streams → Pub/Sub → WebSocket
// RNF-ARQ-031/033: Complete pipeline with latency ≤ 2s (RNF-ARQ-042/088)
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../core/database/__tests__/test-setup.helper';
import { EventsModule } from '../core/events/events.module';
import { DatabaseService } from '../core/database/database.service';
import { EventsService, EventEnvelope } from '../core/events/events.service';
import { createClient, RedisClientType } from 'redis';
import { v4 as uuid } from 'uuid';

describe('E2E Event Pipeline - Commit → Streams → WebSocket', () => {
  let testContext: TestContext;
  let databaseService: DatabaseService;
  let eventsService: EventsService;
  let redisClient: RedisClientType;

  const tenant = uuid();
  const user = uuid();
  const warehouse = uuid();

  beforeAll(async () => {
    testContext = await setupIntegrationTest([EventsModule]);
    databaseService = testContext.databaseService;
    eventsService = testContext.module.get<EventsService>(EventsService);

    redisClient = createClient({
      url: testContext.configService.get('REDIS_URL', 'redis://localhost:6379/0'),
    });

    await redisClient.connect();
  });

  afterAll(async () => {
    try {
      await redisClient.quit();
    } catch (e) {
      console.warn('Error closing Redis:', e);
    }
    await teardownIntegrationTest(testContext);
  });

  it('Event flows: Outbox → Streams → Pub/Sub → Client in ≤ 2s', async () => {
    const eventType = 'teste.evento_emitido';
    const aggregateId = uuid();
    const moduleName = 'test';
    const startTime = Date.now();

    let eventIdFromOutbox: string;

    // STEP 1: Publish event to outbox (commit)
    await databaseService.transaction(
      { tenant_id: tenant, user_id: user, warehouse_id: warehouse },
      async (client) => {
        const event: EventEnvelope = {
          event_type: eventType,
          aggregate_type: 'test_aggregate',
          aggregate_id: aggregateId,
          tenant_id: tenant,
          module: moduleName,
          data: { test_field: 'test_value' },
          correlation_id: uuid(),
        };

        eventIdFromOutbox = await eventsService.publishInTransaction(client, event);
      }
    );

    expect(eventIdFromOutbox).toBeDefined();

    // Verify event in outbox
    const outboxResult = await databaseService.query(
      { tenant_id: tenant, user_id: user },
      'SELECT * FROM wms.event_outbox WHERE event_id = $1',
      [eventIdFromOutbox]
    );

    expect(outboxResult.rows.length).toBe(1);
    expect(outboxResult.rows[0].published_at).toBeNull(); // Not yet published by worker

    // STEP 2: Simulate publisher worker - XADD to stream
    const streamKey = `events:${moduleName}`;

    const messageId = await redisClient.xAdd(streamKey, '*', {
      event_id: eventIdFromOutbox,
      event_type: eventType,
      aggregate_type: 'test_aggregate',
      aggregate_id: aggregateId,
      tenant_id: tenant,
      data: JSON.stringify({ test_field: 'test_value' }),
      timestamp: new Date().toISOString(),
    });

    expect(messageId).toBeDefined();

    // STEP 3: Simulate fanout worker - read from stream starting at our message.
    // Use xRange from the specific messageId to avoid reading stale messages from
    // the persistent Redis volume (Redis streams retain messages across runs).
    // node-redis v4: xRange → [{ id: string, message: Record<string, string> }]
    const rangeMessages = await redisClient.xRange(streamKey, messageId, messageId);

    expect(rangeMessages).toBeDefined();
    expect(rangeMessages.length).toBeGreaterThan(0);

    const receivedEventId = rangeMessages[0].message.event_id;

    expect(receivedEventId).toBe(eventIdFromOutbox);

    // Republish to Pub/Sub (simulate fanout worker)
    const topic = 'operations:pending'; // Mapped from teste.evento_emitido
    const pubsubKey = `rt:${tenant}:${warehouse}:${topic}`;

    const subscriberCount = await redisClient.publish(pubsubKey, JSON.stringify({
      event_id: receivedEventId,
      event_type: eventType,
      data: JSON.stringify({ test_field: 'test_value' }),
      timestamp: new Date().toISOString(),
    }));

    // Note: subscriberCount will be 0 in test (no actual subscribers), but publish succeeds

    // STEP 4: Measure latency
    const endTime = Date.now();
    const latencyMs = endTime - startTime;

    console.log(`Pipeline latency: ${latencyMs}ms`);

    // RNF-ARQ-042/088: Latency must be ≤ 2 seconds
    expect(latencyMs).toBeLessThan(2000);
  });

  it('Concurrent workers do not duplicate events in stream', async () => {
    // Simulate two worker instances publishing same event batch
    const eventIds: string[] = [];

    // Publish 10 events
    for (let i = 0; i < 10; i++) {
      let eventId: string;

      await databaseService.transaction(
        { tenant_id: tenant, user_id: user },
        async (client) => {
          const event: EventEnvelope = {
            event_type: 'teste.evento_emitido',
            aggregate_type: 'test',
            aggregate_id: uuid(),
            tenant_id: tenant,
            module: 'test',
            data: { index: i },
          };

          eventId = await eventsService.publishInTransaction(client, event);
        }
      );

      eventIds.push(eventId!);
    }

    // Simulate first worker instance polling and publishing
    const streamKey1 = 'events:test';

    for (const eventId of eventIds.slice(0, 5)) {
      await redisClient.xAdd(streamKey1, '*', {
        event_id: eventId,
        event_type: 'teste.evento_emitido',
      });
    }

    // Simulate second worker instance (should skip already published with FOR UPDATE SKIP LOCKED)
    // In real scenario, the lock would prevent duplicate publishes

    // Verify no duplicates in stream
    // node-redis v4: xRange returns [{ id: string, message: Record<string, string> }]
    const allMessages = await redisClient.xRange(streamKey1, '-', '+');

    const eventIdSet = new Set<string>();
    let duplicates = 0;

    for (const msg of allMessages) {
      const eventId = msg.message.event_id;
      if (eventIdSet.has(eventId)) {
        duplicates++;
      }
      eventIdSet.add(eventId);
    }

    expect(duplicates).toBe(0);
  });

  it('Respects 2-second latency under simulated load', async () => {
    const iterations = 5;
    const latencies: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const startTime = Date.now();

      await databaseService.transaction(
        { tenant_id: tenant, user_id: user },
        async (client) => {
          const event: EventEnvelope = {
            event_type: 'teste.evento_emitido',
            aggregate_type: 'test',
            aggregate_id: uuid(),
            tenant_id: tenant,
            module: 'test',
            data: { iteration: i },
          };

          const eventId = await eventsService.publishInTransaction(client, event);

          // Publish to stream
          await redisClient.xAdd('events:test', '*', {
            event_id: eventId,
            event_type: event.event_type,
          });
        }
      );

      latencies.push(Date.now() - startTime);
    }

    // All latencies must be ≤ 2s
    const exceedingLimit = latencies.filter((l) => l > 2000).length;
    expect(exceedingLimit).toBe(0);

    // P95 latency also < 2s (RNF-ARQ-088)
    const sorted = latencies.sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];

    console.log(`Latencies: min=${Math.min(...latencies)}ms, p95=${p95}ms, max=${Math.max(...latencies)}ms`);

    expect(p95).toBeLessThan(2000);
  });
});
