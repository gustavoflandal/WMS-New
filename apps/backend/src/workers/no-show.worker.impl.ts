// DOC-03 RN-POR-004 — expiração automática de agendamentos vencidos
// (janela + POR.TOLERANCIA_ATRASO_MIN sem gate-in) para NO_SHOW, liberando
// a capacidade da janela. Eleição de líder via lock Redis (RNF-ARQ-021),
// mesmo padrão de ExceptionExpiryWorkerImpl/PartitionManagerWorkerImpl.
// Roda como APP_ROLE=scheduler.
import { Logger } from '@nestjs/common';
import { CacheService } from '../core/cache/cache.service.js';
import { AppointmentService } from '../modules/portaria/appointment/appointment.service.js';

export interface NoShowWorkerOptions {
  pollIntervalMs?: number;
}

export interface NoShowWorkerRunResult {
  ranAsLeader: boolean;
  noShowIds: string[];
}

const LOCK_RESOURCE = 'no-show:appointment';
const LOCK_TIMEOUT_MS = 30000;

export class NoShowWorkerImpl {
  private readonly logger = new Logger(NoShowWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly appointmentService: AppointmentService,
    private readonly cacheService: CacheService,
    options: NoShowWorkerOptions = {}
  ) {
    // Produção: checagem a cada 15 min é granularidade suficiente para
    // POR.TOLERANCIA_ATRASO_MIN (medido em minutos, mas com folga
    // aceitável — mesmo raciocínio de ExceptionExpiryWorkerImpl). Configurável para testes.
    this.pollIntervalMs = options.pollIntervalMs ?? 15 * 60 * 1000;
  }

  async start(): Promise<void> {
    this.logger.log('No-show worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('No-show run error', error as Error);
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
    this.logger.log('No-show worker stopped');
  }

  async runOnce(): Promise<NoShowWorkerRunResult> {
    const token = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!token) {
      return { ranAsLeader: false, noShowIds: [] };
    }

    try {
      const { noShowIds } = await this.appointmentService.expireNoShows();
      if (noShowIds.length > 0) {
        this.logger.log(`RN-POR-004: ${noShowIds.length} agendamento(s) marcado(s) NO_SHOW: ${noShowIds.join(', ')}`);
      }
      return { ranAsLeader: true, noShowIds };
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, token);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
