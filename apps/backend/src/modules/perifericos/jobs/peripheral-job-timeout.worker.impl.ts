// DOC-11 RNF-PER-002/RF-PER-021 — watchdog de timeout (ENVIADO/EXECUTANDO
// além de timeout_ms) e de expiração de fila (PENDENTE além da validade,
// RF-PER-021: 30 min). Mesmo padrão de OutboxPublisherWorkerImpl (poll de
// 5s, roda como APP_ROLE=worker) — os jobs têm timeout de segundos, não
// cabem no ciclo de 24h do partition-manager (scheduler).
import { Logger } from '@nestjs/common';
import { PeripheralJobService } from './peripheral-job.service.js';
import { EdgeAgentAdminService } from '../devices/edge-agent-admin.service.js';

export interface PeripheralJobTimeoutWorkerOptions {
  pollIntervalMs?: number;
}

export class PeripheralJobTimeoutWorkerImpl {
  private readonly logger = new Logger(PeripheralJobTimeoutWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly peripheralJobService: PeripheralJobService,
    private readonly edgeAgentAdminService: EdgeAgentAdminService,
    options: PeripheralJobTimeoutWorkerOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
  }

  async start(): Promise<void> {
    this.logger.log('Peripheral job timeout worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Peripheral job sweep error', error as Error);
      }
      if (this.running) {
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  async runOnce(): Promise<{ timedOut: number; expired: number; staleAgents: number }> {
    const timedOut = await this.peripheralJobService.sweepTimedOutJobs();
    const expired = await this.peripheralJobService.sweepExpiredJobs();
    const staleAgents = await this.edgeAgentAdminService.sweepStaleHeartbeats();
    return { timedOut, expired, staleAgents };
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
    }
    this.logger.log('Peripheral job timeout worker stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
