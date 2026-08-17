// DOC-04 RNF-REC-052 — saldo em zona CROSS_DOCKING além de
// REC.CROSSDOCK_TEMPO_MAX_H (padrão 24h) gera alerta. Eleição de líder via
// lock Redis (RNF-ARQ-021), mesmo padrão de NoShowWorkerImpl/
// PartitionManagerWorkerImpl. Roda como APP_ROLE=scheduler.
import { Logger } from '@nestjs/common';
import { CacheService } from '../core/cache/cache.service.js';
import { CrossDockService } from '../modules/recebimento/crossdock/crossdock.service.js';

export interface CrossDockAgingWorkerOptions {
  pollIntervalMs?: number;
}

export interface CrossDockAgingWorkerRunResult {
  ranAsLeader: boolean;
  alertedLinkIds: string[];
}

const LOCK_RESOURCE = 'crossdock-aging:crossdock_link';
const LOCK_TIMEOUT_MS = 30000;

export class CrossDockAgingWorkerImpl {
  private readonly logger = new Logger(CrossDockAgingWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly crossDockService: CrossDockService,
    private readonly cacheService: CacheService,
    options: CrossDockAgingWorkerOptions = {}
  ) {
    // Produção: checagem a cada 15 min é granularidade suficiente para um
    // limite medido em horas (mesmo raciocínio de NoShowWorkerImpl).
    this.pollIntervalMs = options.pollIntervalMs ?? 15 * 60 * 1000;
  }

  async start(): Promise<void> {
    this.logger.log('Cross-dock aging worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Cross-dock aging run error', error as Error);
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
    this.logger.log('Cross-dock aging worker stopped');
  }

  async runOnce(): Promise<CrossDockAgingWorkerRunResult> {
    const token = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!token) {
      return { ranAsLeader: false, alertedLinkIds: [] };
    }

    try {
      const { alertedLinkIds } = await this.crossDockService.checkAging();
      if (alertedLinkIds.length > 0) {
        this.logger.log(`RNF-REC-052: ${alertedLinkIds.length} crossdock_link(s) além do tempo máximo: ${alertedLinkIds.join(', ')}`);
      }
      return { ranAsLeader: true, alertedLinkIds };
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, token);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
