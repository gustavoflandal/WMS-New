// Scenario: Realtime fanout DLQ path (RNF-ARQ-032) [INVIOLÁVEL]
// A message that never gets ACKed stays in the consumer group's pending
// entries list (PEL). Once its Redis-tracked delivery count exceeds
// maxRetries, cleanupDeadLetters() (XAUTOCLAIM + XPENDING) must move it to
// events:dlq and ACK the original so it stops being redelivered.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../core/database/__tests__/test-setup.helper.js';
import { RealtimeFanoutWorkerImpl } from '../realtime-fanout.worker.impl.js';
import { createClient, RedisClientType } from 'redis';
import { v4 as uuid } from 'uuid';

describe('Realtime Fanout — DLQ path [INVIOLÁVEL]', () => {
  let testContext: TestContext;
  let redisClient: RedisClientType;
  let fanoutWorker: RealtimeFanoutWorkerImpl;

  // Module derived from the mapped 'teste.evento_emitido' event_type
  // (EVENT_TOPIC_MAPPING, packages/contracts) so handleMessage() attempts a
  // real publish instead of taking the "unmapped, ack-and-skip" path.
  const streamKey = 'events:teste';
  const dlqStreamKey = 'events:dlq';
  const consumerGroup = 'group:dlqtest';
  const maxRetries = 2;

  beforeAll(async () => {
    testContext = await setupIntegrationTest([]);

    redisClient = createClient({
      url: testContext.configService.get('REDIS_URL', 'redis://localhost:6379/0'),
    });
    await redisClient.connect();

    fanoutWorker = new RealtimeFanoutWorkerImpl(testContext.configService, {
      consumerGroup,
      consumerName: 'dlqtest-consumer',
      minIdleMs: 20, // short window so the test doesn't need to wait out RNF-ARQ-032's 60s default
      maxRetries,
      dlqStreamKey,
    });
    await fanoutWorker.init();

    await redisClient
      .xGroupCreate(streamKey, consumerGroup, '0-0', { MKSTREAM: true })
      .catch((e: any) => {
        if (!String(e?.message ?? '').includes('BUSYGROUP')) throw e;
      });
  });

  afterAll(async () => {
    await fanoutWorker.stop();
    try {
      await redisClient.quit();
    } catch (e) {
      // ignore
    }
    await teardownIntegrationTest(testContext);
  });

  it(`Message stuck pending is moved to ${dlqStreamKey} after exceeding maxRetries deliveries`, async () => {
    const eventId = uuid();
    const tenantId = uuid();
    const warehouseId = uuid();

    const messageId = await redisClient.xAdd(streamKey, '*', {
      event_id: eventId,
      event_type: 'teste.evento_emitido',
      tenant_id: tenantId,
      warehouse_id: warehouseId,
      payload: JSON.stringify({ test: true }),
      occurred_at: new Date().toISOString(),
    });

    // Deliver once via a foreign consumer so the entry enters this group's
    // PEL without ever going through handleMessage()/ACK.
    await redisClient.xReadGroup(consumerGroup, 'foreign-consumer', [{ key: streamKey, id: '>' }], {
      COUNT: 10,
    });

    // Inflate the delivery counter past maxRetries with real XCLAIM calls
    // (min-idle-time 0 forces immediate reclaim regardless of actual idle
    // time) — the same Redis-native counter RNF-ARQ-032's XAUTOCLAIM/XPENDING
    // path relies on, exercised directly instead of waiting out real idle
    // windows.
    for (let i = 0; i < maxRetries + 1; i++) {
      await redisClient.xClaim(streamKey, consumerGroup, `forcer-${i}`, 0, [messageId]);
    }

    const pendingBefore = await redisClient.xPendingRange(streamKey, consumerGroup, messageId, messageId, 1);
    expect(pendingBefore[0]?.deliveriesCounter).toBeGreaterThan(maxRetries);

    // Let the configured minIdleMs window elapse, then run the real worker's
    // cleanup: it reclaims via XAUTOCLAIM, sees deliveryCount > maxRetries via
    // XPENDING, and moves the message to the DLQ.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fanoutWorker.cleanupDeadLetters();

    const dlqMessages = await redisClient.xRange(dlqStreamKey, '-', '+');
    const dlqEntry = dlqMessages.find((m) => m.message.event_id === eventId);

    expect(dlqEntry).toBeDefined();
    expect(dlqEntry!.message.reason).toBe('max_retries_exceeded');
    expect(dlqEntry!.message.source_stream).toBe(streamKey);
    expect(dlqEntry!.message.source_message_id).toBe(messageId);

    // Original message must be ACKed so XAUTOCLAIM stops redelivering it.
    const pendingAfter = await redisClient.xPendingRange(streamKey, consumerGroup, messageId, messageId, 1);
    expect(pendingAfter.length).toBe(0);
  }, 15000);
});
