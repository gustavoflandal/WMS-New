// DOC-12 §4.5 RN-SEG-042 — expiração automática de exceções operacionais
// vencidas (auto_expire_hours). "Expiração por auto_expire_hours equivale
// a rejeição automática com motivo EXPIRADA" — implementado como estado
// terminal próprio EXPIRED (máquina de estados §5.1), não um UPDATE direto
// no status REJECTED. Eleição de líder via lock Redis (RNF-ARQ-021), mesmo
// padrão de PartitionManagerWorkerImpl. Roda como APP_ROLE=scheduler.
import { Logger } from '@nestjs/common';
import { CacheService } from '../core/cache/cache.service.js';
import { OperationalExceptionService } from '../core/workflow/operational-exception.service.js';

export interface ExceptionExpiryOptions {
  pollIntervalMs?: number;
}

export interface ExceptionExpiryRunResult {
  ranAsLeader: boolean;
  expiredIds: string[];
}

const LOCK_RESOURCE = 'exception-expiry:operational-exception';
const LOCK_TIMEOUT_MS = 30000;

export class ExceptionExpiryWorkerImpl {
  private readonly logger = new Logger(ExceptionExpiryWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly operationalExceptionService: OperationalExceptionService,
    private readonly cacheService: CacheService,
    options: ExceptionExpiryOptions = {}
  ) {
    // Produção: checagem a cada 15 min é granularidade suficiente para
    // auto_expire_hours (medido em horas, não minutos). Configurável para testes.
    this.pollIntervalMs = options.pollIntervalMs ?? 15 * 60 * 1000;
  }

  async start(): Promise<void> {
    this.logger.log('Exception expiry worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Exception expiry run error', error as Error);
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
    this.logger.log('Exception expiry worker stopped');
  }

  /**
   * Um ciclo completo: tenta virar líder (RNF-ARQ-021) e só então expira as
   * exceções vencidas. Se outra réplica já detém o lock, no-op
   * (ranAsLeader=false) — comportamento esperado com múltiplas réplicas do
   * scheduler.
   */
  async runOnce(): Promise<ExceptionExpiryRunResult> {
    const token = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!token) {
      return { ranAsLeader: false, expiredIds: [] };
    }

    try {
      const { expiredIds } = await this.operationalExceptionService.expireOverdue();
      if (expiredIds.length > 0) {
        this.logger.log(`RN-SEG-042: ${expiredIds.length} exceção(ões) expirada(s) automaticamente: ${expiredIds.join(', ')}`);
      }
      return { ranAsLeader: true, expiredIds };
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, token);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
