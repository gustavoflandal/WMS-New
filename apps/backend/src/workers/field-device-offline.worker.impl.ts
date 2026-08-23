// DOC-15 RNF-COL-051 — "alerta para dispositivo sem contato > 24h com fila >
// 0". Eleição de líder via lock Redis (RNF-ARQ-021), mesmo padrão de
// CrossDockAgingWorkerImpl/NoShowWorkerImpl. Roda como APP_ROLE=scheduler.
import { Logger } from '@nestjs/common';
import { CacheService } from '../core/cache/cache.service.js';
import { FieldDeviceService } from '../modules/campo/field-device/field-device.service.js';

export interface FieldDeviceOfflineWorkerOptions {
  pollIntervalMs?: number;
}

export interface FieldDeviceOfflineWorkerRunResult {
  ranAsLeader: boolean;
  alertedDeviceIds: string[];
}

const LOCK_RESOURCE = 'field-device-offline:field_device';
const LOCK_TIMEOUT_MS = 30000;

export class FieldDeviceOfflineWorkerImpl {
  private readonly logger = new Logger(FieldDeviceOfflineWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly fieldDeviceService: FieldDeviceService,
    private readonly cacheService: CacheService,
    options: FieldDeviceOfflineWorkerOptions = {}
  ) {
    // Limite medido em horas (24h) — granularidade de 15 min é suficiente,
    // mesmo raciocínio de CrossDockAgingWorkerImpl (limite RNF-REC-052).
    this.pollIntervalMs = options.pollIntervalMs ?? 15 * 60 * 1000;
  }

  async start(): Promise<void> {
    this.logger.log('Field device offline worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Field device offline run error', error as Error);
      }
      if (this.running) {
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
    }
    this.logger.log('Field device offline worker stopped');
  }

  async runOnce(): Promise<FieldDeviceOfflineWorkerRunResult> {
    const token = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!token) {
      return { ranAsLeader: false, alertedDeviceIds: [] };
    }

    try {
      const { alertedDeviceIds } = await this.fieldDeviceService.checkOfflineWithPendingQueue();
      if (alertedDeviceIds.length > 0) {
        this.logger.log(`RNF-COL-051: ${alertedDeviceIds.length} dispositivo(s) sem contato > 24h com fila pendente: ${alertedDeviceIds.join(', ')}`);
      }
      return { ranAsLeader: true, alertedDeviceIds };
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, token);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
