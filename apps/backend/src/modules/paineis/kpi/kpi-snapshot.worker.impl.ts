// DOC-10 RN-PAI-042 [INVIOLÁVEL] — "K-13, K-16 pelo scheduler às 23:59 do
// fuso do armazém". Roda como APP_ROLE=scheduler, eleição de líder via lock
// Redis (RNF-ARQ-021), mesmo padrão de ExpirationAlertWorkerImpl. Poll
// curto (padrão 5 min) para não perder a janela 23:59-23:59:59 local por
// armazém; idempotente via alreadySnapshotted() — repoll dentro da mesma
// janela não recomputa.
import { Logger } from '@nestjs/common';
import { CacheService } from '../../../core/cache/cache.service.js';
import { KpiSnapshotService } from './kpi-snapshot.service.js';
import { isPastLocalSnapshotTime, localDate } from './kpi-snapshot-boundary.util.js';
import { AlertMaterializationService } from '../alertas/alert-materialization.service.js';

export interface KpiSnapshotWorkerOptions {
  pollIntervalMs?: number;
}

const LOCK_RESOURCE = 'kpi-snapshot:daily';
const LOCK_TIMEOUT_MS = 30000;

export class KpiSnapshotWorkerImpl {
  private readonly logger = new Logger(KpiSnapshotWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly kpiSnapshotService: KpiSnapshotService,
    private readonly cacheService: CacheService,
    private readonly alertMaterializationService?: AlertMaterializationService,
    options: KpiSnapshotWorkerOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 5 * 60 * 1000;
  }

  async start(): Promise<void> {
    this.logger.log('KPI snapshot worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('KPI snapshot run error', error as Error);
      }
      if (this.running) await this.sleep(this.pollIntervalMs);
    }
  }

  async runOnce(referenceDate: Date = new Date()): Promise<{ ranAsLeader: boolean; snapshotted: string[] }> {
    const lock = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!lock) return { ranAsLeader: false, snapshotted: [] };

    try {
      const warehouses = await this.kpiSnapshotService.listWarehousesForSnapshot();
      const snapshotted: string[] = [];
      for (const warehouse of warehouses) {
        if (!isPastLocalSnapshotTime(warehouse.timezone, referenceDate)) continue;
        const day = localDate(warehouse.timezone, referenceDate);
        if (await this.kpiSnapshotService.alreadySnapshotted(warehouse.id, day)) continue;
        await this.kpiSnapshotService.runSnapshot(warehouse.id, day);
        // RF-PAI-010 "cartões atrasados" — mesma varredura de K-14, materializada em alert.
        await this.alertMaterializationService?.syncLateCards(warehouse.id);
        snapshotted.push(warehouse.id);
      }
      return { ranAsLeader: true, snapshotted };
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, lock);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) await this.loopPromise.catch(() => {});
    this.logger.log('KPI snapshot worker stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
