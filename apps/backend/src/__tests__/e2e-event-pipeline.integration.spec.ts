// Scenario: E2E Event Pipeline - Commit → Outbox → Streams → Pub/Sub → WebSocket
// RNF-ARQ-031/033: Complete pipeline with latency ≤ 2s (RNF-ARQ-042/088)
//
// Exercises the REAL workers end-to-end. A previous version of this test
// simulated the pipeline itself (xAdd/xRange/publish called directly from the
// test) and would pass even with the workers 100% broken — see
// docs/relatorios/SESSAO-1.5-HANDOFF-EM-ANDAMENTO.md §0. This version calls
// OutboxPublisherWorkerImpl.pollBatch() and RealtimeFanoutWorkerImpl.pollStreams()
// directly and asserts on a real Pub/Sub subscriber receiving the message.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../core/database/__tests__/test-setup.helper.js';
import { EventsModule } from '../core/events/events.module.js';
import { DatabaseService } from '../core/database/database.service.js';
import { EventsService, EventEnvelope } from '../core/events/events.service.js';
import { OutboxPublisherWorkerImpl } from '../workers/outbox-publisher.worker.impl.js';
import { RealtimeFanoutWorkerImpl } from '../workers/realtime-fanout.worker.impl.js';
import { createClient, RedisClientType } from 'redis';
import { v4 as uuid } from 'uuid';

describe('E2E Event Pipeline - Commit → Streams → WebSocket', () => {
  let testContext: TestContext;
  let databaseService: DatabaseService;
  let eventsService: EventsService;
  let redisClient: RedisClientType;
  let outboxWorker: OutboxPublisherWorkerImpl;
  let fanoutWorker: RealtimeFanoutWorkerImpl;

  const tenant = uuid();
  const user = uuid();
  const warehouse = uuid();
  const eventType = 'teste.evento_emitido';
  const topic = 'operations:pending'; // EVENT_TOPIC_MAPPING['teste.evento_emitido']

  beforeAll(async () => {
    testContext = await setupIntegrationTest([EventsModule]);
    databaseService = testContext.databaseService;
    eventsService = testContext.module.get<EventsService>(EventsService);

    redisClient = createClient({
      url: testContext.configService.get('REDIS_URL', 'redis://localhost:6379/0'),
    });
    await redisClient.connect();

    outboxWorker = new OutboxPublisherWorkerImpl(databaseService, testContext.configService);
    await outboxWorker.init();

    fanoutWorker = new RealtimeFanoutWorkerImpl(testContext.configService);
    await fanoutWorker.init();
  });

  afterAll(async () => {
    await outboxWorker.stop();
    await fanoutWorker.stop();
    try {
      await redisClient.quit();
    } catch (e) {
      console.warn('Error closing Redis:', e);
    }
    await teardownIntegrationTest(testContext);
  });

  async function publishEvent(payload: Record<string, any>): Promise<string> {
    let eventId: string;
    await databaseService.transaction(
      { tenant_id: tenant, user_id: user, warehouse_id: warehouse },
      async (client) => {
        const event: EventEnvelope = {
          event_type: eventType,
          tenant_id: tenant,
          warehouse_id: warehouse,
          payload,
          correlation_id: uuid(),
        };
        eventId = await eventsService.publishInTransaction(client, event);
      }
    );
    return eventId!;
  }

  async function waitForPubSubMessage(pubsubKey: string): Promise<{ resolve: (v: Record<string, any>) => void; promise: Promise<Record<string, any>> }> {
    let resolve!: (v: Record<string, any>) => void;
    const promise = new Promise<Record<string, any>>((r) => (resolve = r));
    return { resolve, promise };
  }

  it('Event flows: Outbox → real workers → Pub/Sub → subscribed client in ≤ 2s', async () => {
    const pubsubKey = `rt:${tenant}:${warehouse}:${topic}`;

    const subscriber = createClient({
      url: testContext.configService.get('REDIS_URL', 'redis://localhost:6379/0'),
    });
    await subscriber.connect();

    const { resolve, promise: received } = await waitForPubSubMessage(pubsubKey);
    await subscriber.subscribe(pubsubKey, (message) => {
      resolve(JSON.parse(message));
    });

    const startTime = Date.now();

    // STEP 1: Publish event to outbox (commit)
    const eventIdFromOutbox = await publishEvent({ test_field: 'test_value' });
    expect(eventIdFromOutbox).toBeDefined();

    const outboxResult = await databaseService.query(
      { tenant_id: tenant, user_id: user },
      'SELECT * FROM wms.event_outbox WHERE event_id = $1',
      [eventIdFromOutbox]
    );
    expect(outboxResult.rows.length).toBe(1);
    expect(outboxResult.rows[0].published_at).toBeNull();

    // STEP 2: Real outbox-publisher worker polls the outbox and XADDs to events:teste
    const publishedCount = await outboxWorker.pollBatch();
    expect(publishedCount).toBeGreaterThan(0);

    // STEP 3: Real fanout worker reads the stream and republishes to Pub/Sub
    await fanoutWorker.pollStreams();

    // STEP 4: The subscriber set up before publishing must actually receive it
    const message = await Promise.race([
      received,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout waiting for pub/sub message')), 2000)
      ),
    ]);

    const latencyMs = Date.now() - startTime;
    console.log(`Pipeline latency: ${latencyMs}ms`);

    expect(message.event_id).toBe(eventIdFromOutbox);
    expect(message.event_type).toBe(eventType);
    expect(latencyMs).toBeLessThan(2000); // RNF-ARQ-042/088

    await subscriber.unsubscribe(pubsubKey);
    await subscriber.quit();

    // The real worker must have marked the row published in the same transaction
    const afterPublish = await databaseService.query(
      { tenant_id: tenant, user_id: user },
      'SELECT published_at FROM wms.event_outbox WHERE event_id = $1',
      [eventIdFromOutbox]
    );
    expect(afterPublish.rows[0].published_at).not.toBeNull();
  });

  it('Respects 2-second end-to-end latency under sequential load via real workers', async () => {
    const iterations = 5;
    const latencies: number[] = [];
    const pubsubKey = `rt:${tenant}:${warehouse}:${topic}`;

    for (let i = 0; i < iterations; i++) {
      const subscriber = createClient({
        url: testContext.configService.get('REDIS_URL', 'redis://localhost:6379/0'),
      });
      await subscriber.connect();

      const { resolve, promise: received } = await waitForPubSubMessage(pubsubKey);
      await subscriber.subscribe(pubsubKey, (message) => resolve(JSON.parse(message)));

      const startTime = Date.now();
      const eventId = await publishEvent({ iteration: i });
      await outboxWorker.pollBatch();
      await fanoutWorker.pollStreams();

      const message = await Promise.race([
        received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout waiting for pub/sub message')), 2000)
        ),
      ]);
      expect(message.event_id).toBe(eventId);

      latencies.push(Date.now() - startTime);

      await subscriber.unsubscribe(pubsubKey);
      await subscriber.quit();
    }

    const exceedingLimit = latencies.filter((l) => l > 2000).length;
    expect(exceedingLimit).toBe(0);

    const sorted = [...latencies].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];

    console.log(`Latencies: min=${Math.min(...latencies)}ms, p95=${p95}ms, max=${Math.max(...latencies)}ms`);

    expect(p95).toBeLessThan(2000); // RNF-ARQ-088
  });
});
