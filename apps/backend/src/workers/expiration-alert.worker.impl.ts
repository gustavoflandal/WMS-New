// DOC-05 §4.2 RN-EST-014 — job diário: alerta de lotes a vencer (90/60/30/
// 15/0 dias) + bloqueio automático de saldo VENCIDO. Eleição de líder via
// lock Redis (RNF-ARQ-021), mesmo padrão de PartitionManagerWorkerImpl/
// CrossDockAgingWorkerImpl. Roda como APP_ROLE=scheduler.
import { Logger } from '@nestjs/common';
import { CacheService } from '../core/cache/cache.service.js';
import { ExpirationService } from '../modules/estoque/expiration/expiration.service.js';

export interface ExpirationAlertWorkerOptions {
  pollIntervalMs?: number;
}

export interface ExpirationAlertWorkerRunResult {
  ranAsLeader: boolean;
  alertedBatchIds: string[];
  blockedBatchIds: string[];
}

const LOCK_RESOURCE = 'expiration-alert:batch';
const LOCK_TIMEOUT_MS = 30000;

export class ExpirationAlertWorkerImpl {
  private readonly logger = new Logger(ExpirationAlertWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly expirationService: ExpirationService,
    private readonly cacheService: CacheService,
    options: ExpirationAlertWorkerOptions = {}
  ) {
    // RN-EST-014: "diariamente" — mesmo raciocínio de PartitionManagerWorkerImpl (24h em produção). Configurável para testes.
    this.pollIntervalMs = options.pollIntervalMs ?? 24 * 60 * 60 * 1000;
  }

  async start(): Promise<void> {
    this.logger.log('Expiration alert worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Expiration alert run error', error as Error);
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
    this.logger.log('Expiration alert worker stopped');
  }

  /**
   * Um ciclo completo: tenta virar líder (RNF-ARQ-021), e só então roda
   * RN-EST-014. Se outra réplica já detém o lock, este ciclo é um no-op.
   */
  async runOnce(): Promise<ExpirationAlertWorkerRunResult> {
    const token = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!token) {
      return { ranAsLeader: false, alertedBatchIds: [], blockedBatchIds: [] };
    }

    try {
      const { alertedBatchIds, blockedBatchIds } = await this.expirationService.checkExpirations();
      if (alertedBatchIds.length > 0) {
        this.logger.log(`RN-EST-014: ${alertedBatchIds.length} lote(s) alertado(s) por proximidade de vencimento: ${alertedBatchIds.join(', ')}`);
      }
      if (blockedBatchIds.length > 0) {
        this.logger.log(`RN-EST-014: ${blockedBatchIds.length} lote(s) vencido(s) bloqueado(s) automaticamente: ${blockedBatchIds.join(', ')}`);
      }
      return { ranAsLeader: true, alertedBatchIds, blockedBatchIds };
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, token);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
