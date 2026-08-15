// RNF-ARQ-033: Real-time Fanout Worker
// Consumer group on events:* streams; republishes to Pub/Sub
// rt:{tenant_id}:{warehouse_id}:{topico}. ACK only after successful publish.
// Failure → message stays pending → XAUTOCLAIM after idle window → DLQ after
// maxRetries deliveries (RNF-ARQ-032). Runs as APP_ROLE=worker.
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';
import { EVENT_TOPIC_MAPPING } from '@wms/contracts';

export interface RealtimeFanoutOptions {
  pollIntervalMs?: number;
  blockMs?: number;
  minIdleMs?: number;
  maxRetries?: number;
  consumerGroup?: string;
  consumerName?: string;
  dlqStreamKey?: string;
}

export class RealtimeFanoutWorkerImpl {
  private readonly logger = new Logger(RealtimeFanoutWorkerImpl.name);
  private redisClient!: RedisClientType;
  private running = false;
  private loopPromise: Promise<void> | null = null;

  private readonly pollIntervalMs: number;
  private readonly blockMs: number;
  private readonly minIdleMs: number;
  private readonly maxRetries: number;
  private readonly consumerGroup: string;
  private readonly consumer: string;
  private readonly dlqStreamKey: string;

  private readonly knownGroups = new Set<string>();

  constructor(private readonly configService: ConfigService, options: RealtimeFanoutOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.blockMs = options.blockMs ?? 1000;
    this.minIdleMs = options.minIdleMs ?? 60000; // RNF-ARQ-032: 60s
    this.maxRetries = options.maxRetries ?? 5; // RNF-ARQ-032: DLQ after 5
    this.consumerGroup = options.consumerGroup ?? 'group:fanout';
    this.consumer = options.consumerName ?? `consumer:${process.pid}:${Date.now()}`;
    this.dlqStreamKey = options.dlqStreamKey ?? 'events:dlq';
  }

  async init(): Promise<void> {
    if (this.redisClient) return;
    this.redisClient = createClient({
      url: this.configService.get('REDIS_URL', 'redis://localhost:6379/0'),
    });
    await this.redisClient.connect();
  }

  async start(): Promise<void> {
    await this.init();
    this.logger.log('Real-time fanout worker started');
    this.running = true;
    this.loopPromise = this.fanoutLoop();
  }

  private async fanoutLoop(): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.pollStreams();
        await this.cleanupDeadLetters();
        if (processed === 0) {
          await this.sleep(this.pollIntervalMs);
        }
      } catch (error) {
        this.logger.error('Fanout poll error', error as Error);
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  /** Discover module streams (events:*, excluding the DLQ stream itself). */
  private async discoverModuleStreams(): Promise<string[]> {
    const keys = await this.redisClient.keys('events:*');
    return keys.filter((k) => k !== this.dlqStreamKey && !k.startsWith(`${this.dlqStreamKey}:`));
  }

  private async ensureGroup(streamKey: string): Promise<void> {
    if (this.knownGroups.has(streamKey)) return;
    try {
      await this.redisClient.xGroupCreate(streamKey, this.consumerGroup, '0-0', { MKSTREAM: true });
    } catch (error: any) {
      if (!String(error?.message ?? '').includes('BUSYGROUP')) {
        throw error;
      }
    }
    this.knownGroups.add(streamKey);
  }

  /**
   * Read new messages ('>') from every known module stream, resolve the
   * event→topic mapping (RF-ARQ-041), republish to Pub/Sub, and XACK only on
   * success. Returns number of messages ACKed (mapped+published or
   * unmapped+skipped) in this call.
   */
  async pollStreams(): Promise<number> {
    const modules = await this.discoverModuleStreams();
    let processed = 0;

    for (const streamKey of modules) {
      await this.ensureGroup(streamKey);

      let response;
      try {
        response = await this.redisClient.xReadGroup(
          this.consumerGroup,
          this.consumer,
          [{ key: streamKey, id: '>' }],
          { COUNT: 100, BLOCK: this.blockMs }
        );
      } catch (error) {
        this.logger.error(`XREADGROUP failed for ${streamKey}`, error as Error);
        continue;
      }

      if (!response) continue;

      for (const streamResult of response) {
        for (const entry of streamResult.messages) {
          const acked = await this.handleMessage(streamKey, entry.id, entry.message);
          if (acked) processed++;
        }
      }
    }

    return processed;
  }

  /**
   * Process one stream entry. Returns true if it was ACKed (either
   * successfully republished, or skipped because event_type has no mapping
   * yet — RF-ARQ-041: unmapped events must not block the pipeline).
   */
  private async handleMessage(
    streamKey: string,
    messageId: string,
    fields: Record<string, string>
  ): Promise<boolean> {
    const eventType = fields.event_type;
    const topic = EVENT_TOPIC_MAPPING[eventType];

    if (!topic) {
      this.logger.warn(
        `[LACUNA: event_type sem mapeamento em EVENT_TOPIC_MAPPING] ${eventType} (stream=${streamKey}) — ACK e segue, RF-ARQ-041`
      );
      await this.redisClient.xAck(streamKey, this.consumerGroup, messageId);
      return true;
    }

    try {
      const pubsubKey = `rt:${fields.tenant_id}:${fields.warehouse_id || 'global'}:${topic}`;
      await this.redisClient.publish(
        pubsubKey,
        JSON.stringify({
          event_id: fields.event_id,
          event_type: eventType,
          payload: fields.payload,
          occurred_at: fields.occurred_at,
        })
      );

      // ACK only after successful republication (RNF-ARQ-033)
      await this.redisClient.xAck(streamKey, this.consumerGroup, messageId);
      return true;
    } catch (error) {
      // Do NOT ack: message stays pending, reclaimed by cleanupDeadLetters()
      this.logger.error(`Failed to fan out ${fields.event_id} on ${streamKey}`, error as Error);
      return false;
    }
  }

  /**
   * RNF-ARQ-032: reclaim messages idle > minIdleMs (default 60s) via
   * XAUTOCLAIM. Re-attempts publish immediately after claiming; if the
   * message has already been delivered > maxRetries times (Redis-tracked
   * delivery counter via XPENDING), moves it to the DLQ stream and ACKs the
   * original so it stops being redelivered.
   */
  async cleanupDeadLetters(): Promise<void> {
    const modules = await this.discoverModuleStreams();

    for (const streamKey of modules) {
      await this.ensureGroup(streamKey);

      let claimed;
      try {
        claimed = await this.redisClient.xAutoClaim(
          streamKey,
          this.consumerGroup,
          this.consumer,
          this.minIdleMs,
          '0-0'
        );
      } catch (error) {
        this.logger.debug(`XAUTOCLAIM skipped for ${streamKey}`, error as Error);
        continue;
      }

      if (!claimed?.messages) continue;

      for (const msg of claimed.messages) {
        if (!msg) continue;

        const deliveryCount = await this.getDeliveryCount(streamKey, msg.id);

        if (deliveryCount > this.maxRetries) {
          await this.moveToDlq(streamKey, msg.id, msg.message, 'max_retries_exceeded');
          continue;
        }

        // Retry immediately now that we hold the claim.
        const acked = await this.handleMessage(streamKey, msg.id, msg.message);
        if (!acked) {
          this.logger.debug(
            `Retry ${deliveryCount}/${this.maxRetries} still pending for ${msg.message.event_id}`
          );
        }
      }
    }
  }

  private async getDeliveryCount(streamKey: string, messageId: string): Promise<number> {
    try {
      const pending = await this.redisClient.xPendingRange(
        streamKey,
        this.consumerGroup,
        messageId,
        messageId,
        1
      );
      return pending[0]?.deliveriesCounter ?? 1;
    } catch (error) {
      this.logger.warn(`XPENDING lookup failed for ${messageId}`, error as Error);
      return 1;
    }
  }

  private async moveToDlq(
    streamKey: string,
    messageId: string,
    fields: Record<string, string>,
    reason: string
  ): Promise<void> {
    await this.redisClient.xAdd(this.dlqStreamKey, '*', {
      ...fields,
      source_stream: streamKey,
      source_message_id: messageId,
      reason,
      moved_at: new Date().toISOString(),
    });

    // ACK the original so it stops being redelivered by future XAUTOCLAIM calls.
    await this.redisClient.xAck(streamKey, this.consumerGroup, messageId);

    this.logger.warn(
      `Event ${fields.event_id} moved to DLQ (${this.dlqStreamKey}) after exceeding ${this.maxRetries} deliveries`
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
    }
    if (this.redisClient?.isOpen) {
      await this.redisClient.quit();
    }
    this.logger.log('Real-time fanout worker stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
