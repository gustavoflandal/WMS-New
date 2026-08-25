// DOC-08 §4.7 RNF-FIS-060 — worker de emissão NF-e (fila com processamento
// assíncrono e retry — perfil `worker`, mesmo raciocínio de
// OutboxPublisherWorkerImpl: poll contínuo, backoff simples via
// pollIntervalMs quando não há trabalho). Cada poll processa um lote de
// documentos DRAFT; falhas de transporte incrementam o contador de
// contingência do emitente (RNF-FIS-061) e são retentadas no próximo poll
// — a cadência de poll É o backoff, sem loop de retry manual dentro do
// mesmo ciclo.
import { Logger } from '@nestjs/common';
import { FiscalEmissionService } from '../modules/fiscal/emission/fiscal-emission.service.js';

export interface FiscalEmissionWorkerOptions {
  pollIntervalMs?: number;
  batchSize?: number;
}

export class FiscalEmissionWorkerImpl {
  private readonly logger = new Logger(FiscalEmissionWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;

  constructor(private readonly fiscalEmissionService: FiscalEmissionService, options: FiscalEmissionWorkerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 10000;
    this.batchSize = options.batchSize ?? 20;
  }

  async start(): Promise<void> {
    this.logger.log('Fiscal emission worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let processed = 0;
      try {
        const results = await this.runOnce();
        processed = results.length;
      } catch (error) {
        this.logger.error('Fiscal emission poll error', error as Error);
      }
      if (this.running && processed === 0) {
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  async runOnce() {
    return this.fiscalEmissionService.pollAndProcessBatch(this.batchSize);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
    }
    this.logger.log('Fiscal emission worker stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
