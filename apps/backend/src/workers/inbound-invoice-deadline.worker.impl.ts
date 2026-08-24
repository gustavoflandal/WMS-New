// DOC-08 §4.2 RN-FIS-010 — job diário: alerta de prazo de regularização
// fiscal (50/80/100%). Eleição de líder via lock Redis (RNF-ARQ-021), mesmo
// padrão de ExpirationAlertWorkerImpl. Roda como APP_ROLE=scheduler.
import { Logger } from '@nestjs/common';
import { CacheService } from '../core/cache/cache.service.js';
import { InboundInvoiceFiscalService } from '../modules/fiscal/inbound-invoice/inbound-invoice-fiscal.service.js';

export interface InboundInvoiceDeadlineWorkerOptions {
  pollIntervalMs?: number;
}

export interface InboundInvoiceDeadlineWorkerRunResult {
  ranAsLeader: boolean;
  alertedInvoiceIds: string[];
  expiredInvoiceIds: string[];
}

const LOCK_RESOURCE = 'inbound-invoice-deadline:fiscal';
const LOCK_TIMEOUT_MS = 30000;

export class InboundInvoiceDeadlineWorkerImpl {
  private readonly logger = new Logger(InboundInvoiceDeadlineWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly inboundInvoiceFiscalService: InboundInvoiceFiscalService,
    private readonly cacheService: CacheService,
    options: InboundInvoiceDeadlineWorkerOptions = {}
  ) {
    // RN-FIS-010: "diariamente" — mesmo raciocínio de ExpirationAlertWorkerImpl (24h em produção). Configurável para testes.
    this.pollIntervalMs = options.pollIntervalMs ?? 24 * 60 * 60 * 1000;
  }

  async start(): Promise<void> {
    this.logger.log('Inbound invoice deadline worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Inbound invoice deadline run error', error as Error);
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
    this.logger.log('Inbound invoice deadline worker stopped');
  }

  async runOnce(): Promise<InboundInvoiceDeadlineWorkerRunResult> {
    const token = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!token) {
      return { ranAsLeader: false, alertedInvoiceIds: [], expiredInvoiceIds: [] };
    }

    try {
      const { alertedInvoiceIds, expiredInvoiceIds } = await this.inboundInvoiceFiscalService.checkDeadlines();
      if (alertedInvoiceIds.length > 0) {
        this.logger.log(`RN-FIS-010: ${alertedInvoiceIds.length} NF(s) de entrada alertada(s) por proximidade do prazo fiscal: ${alertedInvoiceIds.join(', ')}`);
      }
      if (expiredInvoiceIds.length > 0) {
        this.logger.log(`RN-FIS-010: ${expiredInvoiceIds.length} NF(s) de entrada com prazo fiscal vencido: ${expiredInvoiceIds.join(', ')}`);
      }
      return { ranAsLeader: true, alertedInvoiceIds, expiredInvoiceIds };
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, token);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
