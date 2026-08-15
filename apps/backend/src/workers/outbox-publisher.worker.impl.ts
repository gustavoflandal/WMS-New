// RNF-ARQ-031/032: Outbox Publisher Worker Implementation
// Polls event_outbox, publishes to Redis Streams, marks published
// Concurrency-safe via FOR UPDATE SKIP LOCKED (PostgreSQL)
import { Logger } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../core/database/database.service';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';
import { PoolClient } from 'pg';

export interface OutboxEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  tenant_id: string;
  module: string;
  data: string;
  created_at: string;
}

export class OutboxPublisherWorkerImpl {
  private readonly logger = new Logger(OutboxPublisherWorkerImpl.name);
  private redisClient!: RedisClientType;
  private running = false;
  private pollIntervalMs = 5000;
  private batchSize = 500;

  // Metrics
  private metricsLag = 0;
  private metricsPending = 0;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService
  ) {}

  async start(): Promise<void> {
    this.redisClient = createClient({
      url: this.configService.get('REDIS_URL', 'redis://localhost:6379/0'),
    });

    await this.redisClient.connect();
    this.logger.log('Outbox publisher worker started');
    this.running = true;

    // Start polling loop
    this.pollLoop();

    // Metrics reporting every 10 seconds
    setInterval(() => this.reportMetrics(), 10000);
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const published = await this.pollBatch();
        if (published === 0) {
          // No events, backoff
          await this.sleep(this.pollIntervalMs);
        }
      } catch (error) {
        this.logger.error('Poll batch error', error);
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  /**
   * Poll unpublished events with FOR UPDATE SKIP LOCKED for concurrency safety
   * RNF-ARQ-031: Only one worker instance publishes each event
   */
  private async pollBatch(): Promise<number> {
    // Use postgres admin role to query across tenants (RLS disabled for admin)
    // [LACUNA: Require worker to run with admin credentials]
    const adminContext: TenantContext = {
      tenant_id: '00000000-0000-0000-0000-000000000000', // Global context
      user_id: '00000000-0000-0000-0000-000000000000',
    };

    let published = 0;

    await this.databaseService.transaction(adminContext, async (client) => {
      // Query unpublished events, ordered by event_id for consistency
      // FOR UPDATE SKIP LOCKED = PostgreSQL row-level locking without blocking
      // RNF-ARQ-031: Ensures only one worker publishes each event
      const result = await client.query<OutboxEvent>(
        `SELECT event_id, event_type, aggregate_type, aggregate_id,
                tenant_id, module, data, created_at
         FROM wms.event_outbox
         WHERE published_at IS NULL
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize]
      );

      const events = result.rows;

      for (const event of events) {
        try {
          // Publish to Redis Stream: events:{module}
          const streamKey = `events:${event.module}`;

          await this.redisClient.xAdd(streamKey, '*', {
            event_id: event.event_id,
            event_type: event.event_type,
            aggregate_type: event.aggregate_type,
            aggregate_id: event.aggregate_id,
            tenant_id: event.tenant_id,
            data: event.data,
            timestamp: event.created_at,
          });

          // Mark as published (SAME transaction)
          await client.query(
            `UPDATE wms.event_outbox
             SET published_at = NOW()
             WHERE event_id = $1`,
            [event.event_id]
          );

          published++;

          this.logger.debug(
            `Event published: ${event.event_type} (${event.event_id}) → ${streamKey}`
          );
        } catch (error) {
          this.logger.error(`Failed to publish event ${event.event_id}`, error);
          // Don't mark as published on error; retry on next poll
        }
      }

      // Update pending count for metrics
      const pendingResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM wms.event_outbox WHERE published_at IS NULL`
      );

      this.metricsPending = parseInt(pendingResult.rows[0].count);

      // Calculate lag: oldest unpublished event
      if (this.metricsPending > 0) {
        const lagResult = await client.query<{ lag_seconds: number }>(
          `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::INTEGER as lag_seconds
           FROM wms.event_outbox
           WHERE published_at IS NULL`
        );

        this.metricsLag = lagResult.rows[0]?.lag_seconds || 0;
      } else {
        this.metricsLag = 0;
      }
    });

    return published;
  }

  private reportMetrics(): void {
    // Metrics exposed via /metrics endpoint (Prometheus scrape)
    // RNF-ARQ-072: outbox_lag_seconds and outbox_pending_total
    this.logger.debug(
      `Metrics: lag=${this.metricsLag}s, pending=${this.metricsPending}`
    );

    // [LACUNA: Send to Prometheus client library]
    // For now, logged to stdout for Docker log aggregation
  }

  /**
   * Get current metrics (for /metrics endpoint)
   */
  getMetrics(): { lag_seconds: number; pending_total: number } {
    return {
      lag_seconds: this.metricsLag,
      pending_total: this.metricsPending,
    };
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.redisClient.quit();
    this.logger.log('Outbox publisher worker stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
