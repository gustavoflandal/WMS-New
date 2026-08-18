// DOC-06 §4.1 RN-EXP-003 — expiração de reserva de pedido
// (`EXP.RESERVA_VALIDADE_H`, padrão 72 h). Eleição de líder via lock Redis
// (RNF-ARQ-021), mesmo padrão de ExpirationAlertWorkerImpl (RN-EST-014) e dos
// demais workers do scheduler. Roda como APP_ROLE=scheduler.
import { Logger } from '@nestjs/common';
import { CacheService } from '../core/cache/cache.service.js';
import { ReservationExpiryService } from '../modules/expedicao/order/reservation-expiry.service.js';

export interface ReservationExpiryWorkerOptions {
  pollIntervalMs?: number;
}

export interface ReservationExpiryWorkerRunResult {
  ranAsLeader: boolean;
  expiredOrderIds: string[];
}

const LOCK_RESOURCE = 'reservation-expiry:outbound-order';
const LOCK_TIMEOUT_MS = 30000;

export class ReservationExpiryWorkerImpl {
  private readonly logger = new Logger(ReservationExpiryWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly reservationExpiryService: ReservationExpiryService,
    private readonly cacheService: CacheService,
    options: ReservationExpiryWorkerOptions = {}
  ) {
    // Validade medida em HORAS (padrão 72) — checagem a cada 15 min é
    // granularidade suficiente, mesmo raciocínio de ExceptionExpiryWorkerImpl.
    this.pollIntervalMs = options.pollIntervalMs ?? 15 * 60 * 1000;
  }

  async start(): Promise<void> {
    this.logger.log('Reservation expiry worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Reservation expiry run error', error as Error);
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
    this.logger.log('Reservation expiry worker stopped');
  }

  async runOnce(): Promise<ReservationExpiryWorkerRunResult> {
    const token = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!token) {
      return { ranAsLeader: false, expiredOrderIds: [] };
    }

    try {
      const { expiredOrderIds, qtyReleased } = await this.reservationExpiryService.expireOverdueReservations();
      if (expiredOrderIds.length > 0) {
        this.logger.log(`RN-EXP-003: ${expiredOrderIds.length} pedido(s) com reserva expirada (RELEASED_EXPIRED), ${qtyReleased} devolvido(s) ao disponível`);
      }
      return { ranAsLeader: true, expiredOrderIds };
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, token);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
