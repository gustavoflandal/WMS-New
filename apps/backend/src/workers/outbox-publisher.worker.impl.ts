// RNF-ARQ-031/032 [INVIOLÁVEL]: Outbox Publisher Worker
// Polls wms.event_outbox across ALL tenants (ADR-006: wms_worker role, BYPASSRLS),
// XADDs to events:{modulo} (module derived from event_type prefix, RNF-ARQ-030),
// marks published_at in the SAME transaction. Concurrency-safe across replicas via
// FOR UPDATE SKIP LOCKED (ADR-006). Runs as APP_ROLE=worker.
import { Logger } from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service.js';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

export interface OutboxRow {
  event_id: string;
  event_type: string;
  // NULL para eventos de domínio verdadeiramente GLOBAIS (migration 0031,
  // DOC-03 RF-POR-031) — ex.: portaria.pessoa_entrou/pessoa_saiu.
  tenant_id: string | null;
  warehouse_id: string | null;
  payload: Record<string, any> | string;
  occurred_at: string;
  correlation_id: string | null;
  causation_id: string | null;
}

/**
 * RNF-ARQ-030: Event Envelope — event_type format is "<modulo>.<fato_no_passado>".
 * The module is the prefix before the first dot; this is the ONLY place the
 * publisher derives a stream key from, so there is no separate `module` column
 * to keep in sync with `event_type`.
 */
export function moduleFromEventType(eventType: string): string {
  const dotIndex = eventType.indexOf('.');
  return dotIndex === -1 ? eventType : eventType.substring(0, dotIndex);
}

export interface OutboxPublisherOptions {
  pollIntervalMs?: number;
  batchSize?: number;
}

export class OutboxPublisherWorkerImpl {
  private readonly logger = new Logger(OutboxPublisherWorkerImpl.name);
  private redisClient!: RedisClientType;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;

  // Metrics (RNF-ARQ-071/072), also pushed to Redis so the API process's
  // /metrics endpoint can expose them (worker and API are separate processes).
  private metricsLag = 0;
  private metricsPending = 0;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
    options: OutboxPublisherOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.batchSize = options.batchSize ?? 500;
  }

  /** Connect Redis without starting the poll loop (used directly by tests). */
  async init(): Promise<void> {
    if (this.redisClient) return;
    this.redisClient = createClient({
      url: this.configService.get('REDIS_URL', 'redis://localhost:6379/0'),
    });
    await this.redisClient.connect();
  }

  async start(): Promise<void> {
    await this.init();
    this.logger.log('Outbox publisher worker started');
    this.running = true;
    this.loopPromise = this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const published = await this.pollBatch();
        if (published === 0) {
          await this.sleep(this.pollIntervalMs);
        }
      } catch (error) {
        this.logger.error('Poll batch error', error as Error);
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  /**
   * Poll unpublished events with FOR UPDATE SKIP LOCKED (ADR-006).
   * Ordered by event_id (UUIDv7 → sortable by creation time, RG-011) per spec.
   * Returns the number of events successfully published in this call.
   */
  async pollBatch(): Promise<number> {
    let published = 0;

    await this.databaseService.transactionAsWorker(async (client) => {
      const result = await client.query<OutboxRow>(
        `SELECT event_id, event_type, tenant_id, warehouse_id, payload,
                occurred_at, correlation_id, causation_id
         FROM wms.event_outbox
         WHERE published_at IS NULL
         ORDER BY event_id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize]
      );

      for (const event of result.rows) {
        try {
          const moduleName = moduleFromEventType(event.event_type);
          const streamKey = `events:${moduleName}`;
          const payload =
            typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);

          await this.redisClient.xAdd(streamKey, '*', {
            event_id: event.event_id,
            event_type: event.event_type,
            // '' (nunca null — XADD exige string) sinaliza evento GLOBAL
            // para o fanout worker, que roteia para o canal `rt:global:...`.
            tenant_id: event.tenant_id ?? '',
            warehouse_id: event.warehouse_id ?? '',
            correlation_id: event.correlation_id ?? '',
            causation_id: event.causation_id ?? '',
            payload,
            occurred_at: new Date(event.occurred_at).toISOString(),
          });

          // Mark published in the SAME transaction (RNF-ARQ-031)
          await client.query(
            `UPDATE wms.event_outbox SET published_at = NOW() WHERE event_id = $1`,
            [event.event_id]
          );

          published++;
        } catch (error) {
          // Failure on XADD (or the subsequent UPDATE) = do NOT mark published.
          // The row lock releases when this transaction commits, so the row is
          // free for the next poll (this worker's or a replica's) to retry.
          this.logger.error(`Failed to publish event ${event.event_id}`, error as Error);
        }
      }

      // Metrics computed in the same transaction (RNF-ARQ-072)
      const pendingResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM wms.event_outbox WHERE published_at IS NULL`
      );
      this.metricsPending = parseInt(pendingResult.rows[0].count, 10);

      if (this.metricsPending > 0) {
        const lagResult = await client.query<{ lag_seconds: number }>(
          `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at)))::INTEGER as lag_seconds
           FROM wms.event_outbox
           WHERE published_at IS NULL`
        );
        this.metricsLag = lagResult.rows[0]?.lag_seconds ?? 0;
      } else {
        this.metricsLag = 0;
      }
    });

    await this.pushMetricsToRedis();

    return published;
  }

  /**
   * RNF-ARQ-072: worker and API are separate processes (RNF-ARQ-003), so the
   * worker pushes its own metric values to Redis; the API's /metrics endpoint
   * reads them from there (see core/metrics/metrics.service.ts).
   */
  private async pushMetricsToRedis(): Promise<void> {
    try {
      await this.redisClient.set('wms:metrics:outbox_lag_seconds', String(this.metricsLag));
      await this.redisClient.set('wms:metrics:outbox_pending_total', String(this.metricsPending));
    } catch (error) {
      this.logger.warn('Failed to push metrics to Redis', error as Error);
    }
  }

  /** Get current metrics (for tests / diagnostics) */
  getMetrics(): { lag_seconds: number; pending_total: number } {
    return {
      lag_seconds: this.metricsLag,
      pending_total: this.metricsPending,
    };
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
    }
    if (this.redisClient?.isOpen) {
      await this.redisClient.quit();
    }
    this.logger.log('Outbox publisher worker stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
