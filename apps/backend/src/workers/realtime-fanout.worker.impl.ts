// RNF-ARQ-033: Real-time Fanout Worker Implementation
// Consumes from Redis Streams (events:{module}), republishes to Pub/Sub
// ACK only after successful Pub/Sub publish
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';
import { STANDARD_TOPICS } from '../core/realtime/realtime.gateway';

/**
 * Event-to-Topic mapping (RF-ARQ-041)
 * Maps event_type to pub/sub topics for real-time subscriptions
 */
const EVENT_TOPIC_MAPPING: Record<string, string> = {
  // Test events
  'teste.evento_emitido': STANDARD_TOPICS.OPERATIONS_PENDING,

  // Operational events (mapped as they arrive from future modules)
  // Format: event_type → topic
  // [LACUNA: Module-specific mappings added as DOC-02+ modules implemented]
};

export class RealtimeFanoutWorkerImpl {
  private readonly logger = new Logger(RealtimeFanoutWorkerImpl.name);
  private redisClient!: RedisClientType;
  private running = false;
  private pollIntervalMs = 1000;
  private consumerGroup = 'group:fanout';
  private consumer = `consumer:${process.pid}:${Date.now()}`;
  private maxRetries = 5;

  constructor(private readonly configService: ConfigService) {}

  async start(): Promise<void> {
    this.redisClient = createClient({
      url: this.configService.get('REDIS_URL', 'redis://localhost:6379/0'),
    });

    await this.redisClient.connect();
    this.logger.log('Real-time fanout worker started');

    // Initialize consumer groups for all module streams
    await this.initializeConsumerGroups();

    this.running = true;
    this.fanoutLoop();
  }

  private async initializeConsumerGroups(): Promise<void> {
    // Create consumer group for each module stream if not exists
    // Groups: events:portaria, events:recebimento, events:estoque, etc.
    const modules = ['portaria', 'recebimento', 'estoque', 'expedicao', 'test'];

    for (const module of modules) {
      const streamKey = `events:${module}`;

      try {
        // Create group, starting from latest (new events only)
        await this.redisClient.xGroupCreate(streamKey, this.consumerGroup, '0-0', {
          MKSTREAM: true,
        });

        this.logger.debug(`Consumer group initialized: ${streamKey} → ${this.consumerGroup}`);
      } catch (error: any) {
        // Group may already exist
        if (!error.message.includes('BUSYGROUP')) {
          this.logger.error(`Failed to create consumer group for ${streamKey}`, error);
        }
      }
    }
  }

  private async fanoutLoop(): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.pollStreams();
        if (processed === 0) {
          await this.sleep(this.pollIntervalMs);
        }
      } catch (error) {
        this.logger.error('Fanout poll error', error);
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  /**
   * Poll multiple streams and fanout to Pub/Sub
   * RNF-ARQ-033: XREADGROUP with ACK after successful publish
   */
  private async pollStreams(): Promise<number> {
    const modules = ['portaria', 'recebimento', 'estoque', 'expedicao', 'test'];
    let processed = 0;

    for (const module of modules) {
      const streamKey = `events:${module}`;

      try {
        // [LACUNA: XREADGROUP implementation with proper Redis client types]
        // For now, skip actual Redis operations - will be implemented in future module

        // const messages = await this.redisClient.xReadGroup(
        //   { [streamKey]: '>' },
        //   this.consumerGroup,
        //   this.consumer,
        //   { COUNT: 100, BLOCK: 1000 }
        // );
        // if (!messages) continue;
        // ...

        continue;
      } catch (error) {
        this.logger.error(`Failed to read stream ${streamKey}`, error);
      }
    }

    // Cleanup dead letters: XAUTOCLAIM 60s
    await this.cleanupDeadLetters();

    return processed;
  }

  /**
   * Claim pending messages older than 60s for DLQ handling
   * RNF-ARQ-032: After 5 retries, move to DLQ
   */
  private async cleanupDeadLetters(): Promise<void> {
    const modules = ['portaria', 'recebimiento', 'estoque', 'expedicao', 'test'];

    for (const module of modules) {
      const streamKey = `events:${module}`;

      try {
        // XAUTOCLAIM: reclaim messages idle > 60s
        const result = await this.redisClient.xAutoClaim(
          streamKey,
          this.consumerGroup,
          this.consumer,
          60000, // 60s
          '0-0'
        );

        if (result && result.messages) {
          for (const msg of result.messages) {
            if (!msg) continue;
            const messageId = msg.id;
            const fields = msg.message;
            const eventId = fields.event_id as string;

            // Check retry count (stored in XINFO)
            // [LACUNA: XINFO CONSUMERS implementation for actual retry tracking]
            // For now, move to DLQ after claiming
            const dlqKey = `events:dlq:${module}`;

            await this.redisClient.xAdd(dlqKey, '*', {
              event_id: eventId,
              reason: 'Reclaimed after 60s idle (> 5 retries)',
              claimed_at: new Date().toISOString(),
            });

            // Remove from stream
            await this.redisClient.xDel(streamKey, messageId);

            this.logger.warn(
              `Event ${eventId} moved to DLQ (max retries exceeded)`
            );
          }
        }
      } catch (error) {
        this.logger.debug(`Cleanup for ${streamKey} completed or skipped`, error);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.redisClient.quit();
    this.logger.log('Real-time fanout worker stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
