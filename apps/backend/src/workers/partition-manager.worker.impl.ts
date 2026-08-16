// RNF-ARQ-090 (débito herdado LAC-S1.5-003) — Partition Manager Worker.
// Garante que wms.stock_movement (particionada mensal, DOC-02 §5.5) sempre
// tenha a partição do mês corrente E, a partir do dia 20 de cada mês, a
// partição do mês seguinte já criada — sem isso o primeiro INSERT do
// próximo mês falha (nenhuma partição cobre a faixa de datas).
// Eleição de líder via lock Redis (RNF-ARQ-021, CacheService.acquireLock)
// para que só uma réplica do scheduler execute por ciclo. Roda como
// APP_ROLE=scheduler.
import { Logger } from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service.js';
import { CacheService } from '../core/cache/cache.service.js';

export interface PartitionManagerOptions {
  pollIntervalMs?: number;
}

export interface PartitionManagerRunResult {
  ranAsLeader: boolean;
  missingPartitionAlerts: string[];
  createdPartitions: string[];
}

const LOCK_RESOURCE = 'partition-manager:stock_movement';
const LOCK_TIMEOUT_MS = 30000;

export class PartitionManagerWorkerImpl {
  private readonly logger = new Logger(PartitionManagerWorkerImpl.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly cacheService: CacheService,
    options: PartitionManagerOptions = {}
  ) {
    // Produção: uma checagem por dia é suficiente (a ação real só acontece
    // a partir do dia 20 do mês, ver runOnce()). Configurável para testes.
    this.pollIntervalMs = options.pollIntervalMs ?? 24 * 60 * 60 * 1000;
  }

  async start(): Promise<void> {
    this.logger.log('Partition manager worker started');
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Partition manager run error', error as Error);
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
    this.logger.log('Partition manager worker stopped');
  }

  /**
   * Um ciclo completo: tenta virar líder (RNF-ARQ-021), e só então gerencia
   * as partições. Se outra réplica já detém o lock, este ciclo é um no-op
   * (retorna ranAsLeader=false) — não é erro, é o comportamento esperado de
   * eleição de líder com múltiplas réplicas do scheduler.
   */
  async runOnce(referenceDate: Date = new Date()): Promise<PartitionManagerRunResult> {
    const token = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!token) {
      return { ranAsLeader: false, missingPartitionAlerts: [], createdPartitions: [] };
    }

    try {
      return await this.manage(referenceDate);
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, token);
    }
  }

  private async manage(now: Date): Promise<PartitionManagerRunResult> {
    const missingPartitionAlerts: string[] = [];
    const createdPartitions: string[] = [];

    // 1) Alerta de partição ausente: o mês CORRENTE deveria sempre existir
    // (bootstrap da migration 0014 ou de um ciclo anterior deste job). Se
    // não existir, é uma falha real — loga ALERTA e corrige na hora, para
    // não deixar o próximo INSERT falhar.
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    if (!(await this.partitionExists(currentYear, currentMonth))) {
      const alert = `RNF-ARQ-090 ALERTA: particao de wms.stock_movement do mes corrente (${currentYear}-${String(currentMonth).padStart(2, '0')}) esta AUSENTE — criando agora para evitar falha de INSERT.`;
      this.logger.error(alert);
      missingPartitionAlerts.push(alert);
      createdPartitions.push(await this.ensurePartition(currentYear, currentMonth));
    }

    // 2) A partir do dia 20, garante a partição do MÊS SEGUINTE com
    // antecedência (RNF-ARQ-090). Antes do dia 20, não faz nada aqui — a
    // partição atual do mês seguinte já foi coberta pelo bootstrap da
    // migration 0014 ou pelo próprio ciclo deste job no mês anterior.
    if (now.getUTCDate() >= 20) {
      const next = new Date(Date.UTC(currentYear, currentMonth, 1)); // mês 0-based + 1 = próximo mês
      const nextYear = next.getUTCFullYear();
      const nextMonth = next.getUTCMonth() + 1;
      if (!(await this.partitionExists(nextYear, nextMonth))) {
        createdPartitions.push(await this.ensurePartition(nextYear, nextMonth));
        this.logger.log(`Partição do próximo mês criada com antecedência: ${nextYear}-${String(nextMonth).padStart(2, '0')}`);
      }
    }

    return { ranAsLeader: true, missingPartitionAlerts, createdPartitions };
  }

  private async partitionExists(year: number, month: number): Promise<boolean> {
    const name = `stock_movement_y${year}_m${String(month).padStart(2, '0')}`;
    const result = await this.databaseService.queryGlobal(
      `SELECT 1 FROM pg_class WHERE relname = $1 AND relnamespace = 'wms'::regnamespace`,
      [name]
    );
    return result.rows.length > 0;
  }

  private async ensurePartition(year: number, month: number): Promise<string> {
    const result = await this.databaseService.queryGlobal<{ ensure_stock_movement_partition: string }>(
      'SELECT wms.ensure_stock_movement_partition($1, $2)',
      [year, month]
    );
    return result.rows[0].ensure_stock_movement_partition;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
