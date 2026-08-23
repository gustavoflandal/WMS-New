// DOC-10 RF-PAI-010 — consome os MESMOS streams events:* (grupo consumidor
// próprio 'group:alert-materialization'), mesmo padrão de
// kpi-materialization.worker.impl.ts (comentário completo lá).
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';
import { AlertMaterializationService } from './alert-materialization.service.js';

export interface AlertMaterializationWorkerOptions {
  pollIntervalMs?: number;
  blockMs?: number;
  minIdleMs?: number;
  maxRetries?: number;
  consumerGroup?: string;
  consumerName?: string;
  dlqStreamKey?: string;
}

export class AlertMaterializationWorkerImpl {
  private readonly logger = new Logger(AlertMaterializationWorkerImpl.name);
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

  constructor(
    private readonly configService: ConfigService,
    private readonly alertMaterializationService: AlertMaterializationService,
    options: AlertMaterializationWorkerOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.blockMs = options.blockMs ?? 1000;
    this.minIdleMs = options.minIdleMs ?? 60000;
    this.maxRetries = options.maxRetries ?? 5;
    this.consumerGroup = options.consumerGroup ?? 'group:alert-materialization';
    this.consumer = options.consumerName ?? `consumer:${process.pid}:${Date.now()}`;
    this.dlqStreamKey = options.dlqStreamKey ?? 'events:dlq:alert';
  }

  async init(): Promise<void> {
    if (this.redisClient) return;
    this.redisClient = createClient({ url: this.configService.get('REDIS_URL', 'redis://localhost:6379/0') });
    await this.redisClient.connect();
  }

  async start(): Promise<void> {
    await this.init();
    this.logger.log('Alert materialization worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.pollStreams();
        await this.cleanupDeadLetters();
        if (processed === 0) await this.sleep(this.pollIntervalMs);
      } catch (error) {
        this.logger.error('Alert materialization poll error', error as Error);
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  private async discoverModuleStreams(): Promise<string[]> {
    const keys = await this.redisClient.keys('events:*');
    return keys.filter((k) => !k.startsWith('events:dlq'));
  }

  private async ensureGroup(streamKey: string): Promise<void> {
    if (this.knownGroups.has(streamKey)) return;
    try {
      await this.redisClient.xGroupCreate(streamKey, this.consumerGroup, '0-0', { MKSTREAM: true });
    } catch (error: any) {
      if (!String(error?.message ?? '').includes('BUSYGROUP')) throw error;
    }
    this.knownGroups.add(streamKey);
  }

  async pollStreams(): Promise<number> {
    const modules = await this.discoverModuleStreams();
    if (modules.length === 0) return 0;
    for (const streamKey of modules) await this.ensureGroup(streamKey);

    let response;
    try {
      response = await this.redisClient.xReadGroup(this.consumerGroup, this.consumer, modules.map((key) => ({ key, id: '>' })), {
        COUNT: 100,
        BLOCK: this.blockMs,
      });
    } catch (error) {
      this.logger.error('XREADGROUP failed', error as Error);
      return 0;
    }
    if (!response) return 0;

    let processed = 0;
    for (const streamResult of response) {
      for (const entry of streamResult.messages) {
        const acked = await this.handleMessage(streamResult.name, entry.id, entry.message);
        if (acked) processed++;
      }
    }
    return processed;
  }

  private async handleMessage(streamKey: string, messageId: string, fields: Record<string, string>): Promise<boolean> {
    try {
      let payload: Record<string, unknown> = {};
      try {
        payload = fields.payload ? JSON.parse(fields.payload) : {};
      } catch {
        payload = {};
      }
      await this.alertMaterializationService.applyEvent({
        event_id: fields.event_id,
        event_type: fields.event_type,
        tenant_id: fields.tenant_id || null,
        warehouse_id: fields.warehouse_id,
        payload,
      });
      await this.redisClient.xAck(streamKey, this.consumerGroup, messageId);
      return true;
    } catch (error) {
      this.logger.error(`Failed to materialize alert for ${fields.event_id} on ${streamKey}`, error as Error);
      return false;
    }
  }

  async cleanupDeadLetters(): Promise<void> {
    const modules = await this.discoverModuleStreams();
    for (const streamKey of modules) {
      await this.ensureGroup(streamKey);
      let claimed;
      try {
        claimed = await this.redisClient.xAutoClaim(streamKey, this.consumerGroup, this.consumer, this.minIdleMs, '0-0');
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
        await this.handleMessage(streamKey, msg.id, msg.message);
      }
    }
  }

  private async getDeliveryCount(streamKey: string, messageId: string): Promise<number> {
    try {
      const pending = await this.redisClient.xPendingRange(streamKey, this.consumerGroup, messageId, messageId, 1);
      return pending[0]?.deliveriesCounter ?? 1;
    } catch (error) {
      this.logger.warn(`XPENDING lookup failed for ${messageId}`, error as Error);
      return 1;
    }
  }

  private async moveToDlq(streamKey: string, messageId: string, fields: Record<string, string>, reason: string): Promise<void> {
    await this.redisClient.xAdd(this.dlqStreamKey, '*', { ...fields, source_stream: streamKey, source_message_id: messageId, reason, moved_at: new Date().toISOString() });
    await this.redisClient.xAck(streamKey, this.consumerGroup, messageId);
    this.logger.warn(`Event ${fields.event_id} moved to alert DLQ after exceeding ${this.maxRetries} deliveries`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) await this.loopPromise.catch(() => {});
    if (this.redisClient?.isOpen) await this.redisClient.quit();
    this.logger.log('Alert materialization worker stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
