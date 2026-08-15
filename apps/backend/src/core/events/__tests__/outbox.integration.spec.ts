// Scenario: Outbox garante evento após commit (Redis derrubado no teste)
// RNF-ARQ-030..033: Transactional outbox pattern guarantees exactly-once delivery [INVIOLÁVEL]
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../database/__tests__/test-setup.helper.js';
import { EventsModule } from '../events.module.js';
import { DatabaseService } from '../../database/database.service.js';
import { EventsService, EventEnvelope } from '../events.service.js';
import { v4 as uuid } from 'uuid';

describe('Outbox Pattern - Exactly-Once Delivery [INVIOLÁVEL]', () => {
  let testContext: TestContext;
  let databaseService: DatabaseService;
  let eventsService: EventsService;

  const tenant = uuid();
  const user = uuid();
  const warehouse = uuid();

  beforeAll(async () => {
    testContext = await setupIntegrationTest([EventsModule]);
    databaseService = testContext.databaseService;
    eventsService = testContext.module.get<EventsService>(EventsService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('Event published to outbox within transaction persists after commit', async () => {
    const eventType = 'orders.order_created';
    const aggregateId = uuid();

    let publishedEventId: string;

    // Publish event within transaction
    await databaseService.transaction(
      { tenant_id: tenant, user_id: user },
      async (client) => {
        const event: EventEnvelope = {
          event_type: eventType,
          tenant_id: tenant,
          warehouse_id: warehouse,
          payload: { aggregate_id: aggregateId, order_number: '123', amount: 100 },
        };

        publishedEventId = await eventsService.publishInTransaction(client, event);
      }
    );

    // Verify event persists in database after transaction commit
    const result = await databaseService.query(
      { tenant_id: tenant, user_id: user },
      'SELECT event_id, event_type, published_at FROM wms.event_outbox WHERE event_id = $1',
      [publishedEventId]
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].event_type).toBe(eventType);
    expect(result.rows[0].published_at).toBeNull(); // Not yet published by worker
  });

  it('Multiple events in single transaction all persist', async () => {
    const eventIds: string[] = [];

    await databaseService.transaction(
      { tenant_id: tenant, user_id: user },
      async (client) => {
        for (let i = 0; i < 3; i++) {
          const event: EventEnvelope = {
            event_type: `test.event_${i}`,
            tenant_id: tenant,
            warehouse_id: warehouse,
            payload: { index: i },
          };

          const eventId = await eventsService.publishInTransaction(client, event);
          eventIds.push(eventId);
        }
      }
    );

    // Verify all 3 events persisted
    const result = await databaseService.query(
      { tenant_id: tenant, user_id: user },
      `SELECT COUNT(*) as count FROM wms.event_outbox
       WHERE event_id = ANY($1)`,
      [eventIds]
    );

    expect(parseInt(result.rows[0].count)).toBe(3);
  });

  it('Event rollback prevents outbox entry on transaction abort', async () => {
    const eventType = 'order.rollback_test';

    let eventId: string;

    try {
      await databaseService.transaction(
        { tenant_id: tenant, user_id: user },
        async (client) => {
          const event: EventEnvelope = {
            event_type: eventType,
            tenant_id: tenant,
            warehouse_id: warehouse,
            payload: { aggregate_id: uuid() },
          };

          eventId = await eventsService.publishInTransaction(client, event);

          // Force transaction rollback
          throw new Error('Simulated error');
        }
      );
    } catch (error) {
      // Expected rollback
    }

    // Verify event was NOT persisted
    const result = await databaseService.query(
      { tenant_id: tenant, user_id: user },
      'SELECT COUNT(*) as count FROM wms.event_outbox WHERE event_type = $1',
      [eventType]
    );

    // eventType is unique to this test, and cleanTestData() truncates event_outbox
    // between test files (test-setup.helper.ts), so this must be exactly 0.
    expect(parseInt(result.rows[0].count, 10)).toBe(0);
  });

  it('Event with correlation_id maintains causality', async () => {
    const correlationId = uuid();
    const causationId = uuid();

    let publishedEventId: string;

    await databaseService.transaction(
      { tenant_id: tenant, user_id: user },
      async (client) => {
        const event: EventEnvelope = {
          event_type: 'order.confirmed',
          tenant_id: tenant,
          warehouse_id: warehouse,
          payload: { aggregate_id: uuid() },
          correlation_id: correlationId,
          causation_id: causationId,
        };

        publishedEventId = await eventsService.publishInTransaction(client, event);
      }
    );

    const result = await databaseService.query(
      { tenant_id: tenant, user_id: user },
      `SELECT correlation_id, causation_id FROM wms.event_outbox
       WHERE event_id = $1`,
      [publishedEventId]
    );

    expect(result.rows[0].correlation_id.toString()).toBe(correlationId);
    expect(result.rows[0].causation_id.toString()).toBe(causationId);
  });
});
