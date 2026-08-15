// Scenario: Outbox publisher concurrency (RNF-ARQ-031/032, ADR-006) [INVIOLÁVEL]
// Two OutboxPublisherWorkerImpl instances (simulating two replicas) poll the
// SAME event_outbox table concurrently. FOR UPDATE SKIP LOCKED must guarantee
// each event_id is XADDed to the stream exactly once, never zero, never twice.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../core/database/__tests__/test-setup.helper.js';
import { EventsModule } from '../../core/events/events.module.js';
import { DatabaseService } from '../../core/database/database.service.js';
import { EventsService, EventEnvelope } from '../../core/events/events.service.js';
import { OutboxPublisherWorkerImpl } from '../outbox-publisher.worker.impl.js';
import { createClient, RedisClientType } from 'redis';
import { v4 as uuid } from 'uuid';

describe('Outbox Publisher — concurrent replicas [INVIOLÁVEL]', () => {
  let testContext: TestContext;
  let databaseService: DatabaseService;
  let eventsService: EventsService;
  let redisClient: RedisClientType;
  let workerA: OutboxPublisherWorkerImpl;
  let workerB: OutboxPublisherWorkerImpl;

  const tenant = uuid();
  const user = uuid();
  const warehouse = uuid();
  const moduleName = 'concorrenciatest';
  const streamKey = `events:${moduleName}`;
  const eventCount = 100;

  beforeAll(async () => {
    testContext = await setupIntegrationTest([EventsModule]);
    databaseService = testContext.databaseService;
    eventsService = testContext.module.get<EventsService>(EventsService);

    redisClient = createClient({
      url: testContext.configService.get('REDIS_URL', 'redis://localhost:6379/0'),
    });
    await redisClient.connect();
    await redisClient.del(streamKey);

    // Small batchSize so a single pollBatch() call cannot drain all 100 events
    // by itself — forces multiple overlapping rounds between the two replicas.
    workerA = new OutboxPublisherWorkerImpl(databaseService, testContext.configService, { batchSize: 7 });
    workerB = new OutboxPublisherWorkerImpl(databaseService, testContext.configService, { batchSize: 7 });
    await workerA.init();
    await workerB.init();
  });

  afterAll(async () => {
    await workerA.stop();
    await workerB.stop();
    try {
      await redisClient.quit();
    } catch (e) {
      // ignore
    }
    await teardownIntegrationTest(testContext);
  });

  it(`${eventCount} events, two concurrent replicas: each event_id appears exactly once in the stream`, async () => {
    const eventIds: string[] = [];
    for (let i = 0; i < eventCount; i++) {
      await databaseService.transaction(
        { tenant_id: tenant, user_id: user, warehouse_id: warehouse },
        async (client) => {
          const event: EventEnvelope = {
            event_type: `${moduleName}.evento_criado`,
            tenant_id: tenant,
            warehouse_id: warehouse,
            payload: { index: i },
          };
          eventIds.push(await eventsService.publishInTransaction(client, event));
        }
      );
    }

    // Both replicas race concurrently, round after round, until the outbox is
    // fully drained. FOR UPDATE SKIP LOCKED (ADR-006) is what must prevent
    // either replica from re-publishing a row the other one already claimed.
    let pending = eventCount;
    let round = 0;
    const maxRounds = 50;
    while (pending > 0 && round < maxRounds) {
      const [publishedA, publishedB] = await Promise.all([workerA.pollBatch(), workerB.pollBatch()]);
      round++;

      const remaining = await databaseService.query(
        { tenant_id: tenant, user_id: user },
        `SELECT COUNT(*) as count FROM wms.event_outbox
         WHERE event_id = ANY($1) AND published_at IS NULL`,
        [eventIds]
      );
      pending = parseInt(remaining.rows[0].count, 10);

      if (publishedA === 0 && publishedB === 0 && pending > 0) {
        // Nothing claimable this round (both hit SKIP LOCKED on the same rows
        // mid-transaction) — brief yield before retrying.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    expect(pending).toBe(0);

    // Every event_id must be marked published exactly once (no double-processing).
    const publishedRows = await databaseService.query(
      { tenant_id: tenant, user_id: user },
      `SELECT event_id FROM wms.event_outbox WHERE event_id = ANY($1) AND published_at IS NOT NULL`,
      [eventIds]
    );
    expect(publishedRows.rows.length).toBe(eventCount);

    // Verify the stream: exactly one XADD entry per event_id, zero duplicates.
    const streamMessages = await redisClient.xRange(streamKey, '-', '+');
    const relevantMessages = streamMessages.filter((m) => eventIds.includes(m.message.event_id));

    expect(relevantMessages.length).toBe(eventCount);

    const seen = new Set<string>();
    for (const msg of relevantMessages) {
      expect(seen.has(msg.message.event_id)).toBe(false);
      seen.add(msg.message.event_id);
    }
    expect(seen.size).toBe(eventCount);
  }, 30000);
});
