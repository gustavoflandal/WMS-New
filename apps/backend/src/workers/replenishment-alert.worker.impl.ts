// DOC-05 §4.5 RF-EST-040 (estoque de segurança, "execução horária") +
// RF-EST-041 (kanban — mesma cadência, ver LACUNA em kanban.service.ts).
// Eleição de líder via lock Redis (RNF-ARQ-021), mesmo padrão dos demais
// workers do scheduler. Roda como APP_ROLE=scheduler.
import { Logger } from '@nestjs/common';
import { CacheService } from '../core/cache/cache.service.js';
import { SafetyStockService } from '../modules/estoque/replenishment/safety-stock.service.js';
import { KanbanService } from '../modules/estoque/replenishment/kanban.service.js';

export interface ReplenishmentAlertWorkerOptions {
  pollIntervalMs?: number;
}

export interface ReplenishmentAlertWorkerRunResult {
  ranAsLeader: boolean;
  violatedProductIds: string[];
  generatedTaskIds: string[];
}

const LOCK_RESOURCE = 'replenishment-alert:safety-stock-kanban';
const LOCK_TIMEOUT_MS = 30000;

export class ReplenishmentAlertWorkerImpl {
  private readonly logger = new Logger(ReplenishmentAlertWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly safetyStockService: SafetyStockService,
    private readonly kanbanService: KanbanService,
    private readonly cacheService: CacheService,
    options: ReplenishmentAlertWorkerOptions = {}
  ) {
    // RF-EST-040: "execução horária". Configurável para testes.
    this.pollIntervalMs = options.pollIntervalMs ?? 60 * 60 * 1000;
  }

  async start(): Promise<void> {
    this.logger.log('Replenishment alert worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Replenishment alert run error', error as Error);
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
    this.logger.log('Replenishment alert worker stopped');
  }

  async runOnce(): Promise<ReplenishmentAlertWorkerRunResult> {
    const token = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!token) {
      return { ranAsLeader: false, violatedProductIds: [], generatedTaskIds: [] };
    }

    try {
      const { violatedProductIds } = await this.safetyStockService.checkSafetyStock();
      const { generatedTaskIds } = await this.kanbanService.checkKanban();
      if (violatedProductIds.length > 0) {
        this.logger.log(`RF-EST-040: ${violatedProductIds.length} produto(s) abaixo do estoque de segurança: ${violatedProductIds.join(', ')}`);
      }
      if (generatedTaskIds.length > 0) {
        this.logger.log(`RF-EST-041: ${generatedTaskIds.length} tarefa(s) de reposição gerada(s) por kanban: ${generatedTaskIds.join(', ')}`);
      }
      return { ranAsLeader: true, violatedProductIds, generatedTaskIds };
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, token);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
