// RNF-ARQ-090 (débito herdado LAC-S1.5-003) — Partition Manager Worker.
// Garante que TODAS as tabelas particionadas mensalmente (wms.stock_movement,
// DOC-02 §5.5; wms.audit_log, DOC-12 RD-SEG-030) sempre tenham a partição do
// mês corrente E, a partir do dia 20 de cada mês, a partição do mês
// seguinte já criada — sem isso o primeiro INSERT do próximo mês falha
// (nenhuma partição cobre a faixa de datas).
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

// Cada entrada é uma tabela particionada mensalmente + o nome da função
// SQL SECURITY DEFINER que a gerencia (ver migrations 0014/0019). Lista
// fechada/interna (não vem de input externo) — segura para interpolar no
// nome da função chamada via SQL.
interface PartitionedTable {
  tableName: string;
  ensureFunctionSql: string;
}

const PARTITIONED_TABLES: PartitionedTable[] = [
  { tableName: 'stock_movement', ensureFunctionSql: 'wms.ensure_stock_movement_partition' },
  { tableName: 'audit_log', ensureFunctionSql: 'wms.ensure_audit_log_partition' },
  // DOC-04 RD-REC-005 (Sessão 4A): putaway_task, particionada como `task` (RNF-ARQ-090).
  { tableName: 'putaway_task', ensureFunctionSql: 'wms.ensure_putaway_task_partition' },
];

const LOCK_RESOURCE = 'partition-manager:monthly-tables';
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
   * as partições de TODAS as tabelas de PARTITIONED_TABLES. Se outra
   * réplica já detém o lock, este ciclo é um no-op (retorna
   * ranAsLeader=false) — não é erro, é o comportamento esperado de eleição
   * de líder com múltiplas réplicas do scheduler.
   */
  async runOnce(referenceDate: Date = new Date()): Promise<PartitionManagerRunResult> {
    const token = await this.cacheService.acquireLock(LOCK_RESOURCE, LOCK_TIMEOUT_MS);
    if (!token) {
      return { ranAsLeader: false, missingPartitionAlerts: [], createdPartitions: [] };
    }

    try {
      const missingPartitionAlerts: string[] = [];
      const createdPartitions: string[] = [];
      for (const table of PARTITIONED_TABLES) {
        const result = await this.manageTable(table, referenceDate);
        missingPartitionAlerts.push(...result.missingPartitionAlerts);
        createdPartitions.push(...result.createdPartitions);
      }
      return { ranAsLeader: true, missingPartitionAlerts, createdPartitions };
    } finally {
      await this.cacheService.releaseLock(LOCK_RESOURCE, token);
    }
  }

  private async manageTable(
    table: PartitionedTable,
    now: Date
  ): Promise<{ missingPartitionAlerts: string[]; createdPartitions: string[] }> {
    const missingPartitionAlerts: string[] = [];
    const createdPartitions: string[] = [];

    // 1) Alerta de partição ausente: o mês CORRENTE deveria sempre existir
    // (bootstrap da migration correspondente ou de um ciclo anterior deste
    // job). Se não existir, é uma falha real — loga ALERTA e corrige na
    // hora, para não deixar o próximo INSERT falhar.
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    if (!(await this.partitionExists(table, currentYear, currentMonth))) {
      const alert = `RNF-ARQ-090 ALERTA: particao de wms.${table.tableName} do mes corrente (${currentYear}-${String(currentMonth).padStart(2, '0')}) esta AUSENTE — criando agora para evitar falha de INSERT.`;
      this.logger.error(alert);
      missingPartitionAlerts.push(alert);
      createdPartitions.push(await this.ensurePartition(table, currentYear, currentMonth));
    }

    // 2) A partir do dia 20, garante a partição do MÊS SEGUINTE com
    // antecedência (RNF-ARQ-090). Antes do dia 20, não faz nada aqui — a
    // partição atual do mês seguinte já foi coberta pelo bootstrap da
    // migration ou pelo próprio ciclo deste job no mês anterior.
    if (now.getUTCDate() >= 20) {
      const next = new Date(Date.UTC(currentYear, currentMonth, 1)); // mês 0-based + 1 = próximo mês
      const nextYear = next.getUTCFullYear();
      const nextMonth = next.getUTCMonth() + 1;
      if (!(await this.partitionExists(table, nextYear, nextMonth))) {
        createdPartitions.push(await this.ensurePartition(table, nextYear, nextMonth));
        this.logger.log(`Partição do próximo mês criada com antecedência: wms.${table.tableName} ${nextYear}-${String(nextMonth).padStart(2, '0')}`);
      }
    }

    return { missingPartitionAlerts, createdPartitions };
  }

  private async partitionExists(table: PartitionedTable, year: number, month: number): Promise<boolean> {
    const name = `${table.tableName}_y${year}_m${String(month).padStart(2, '0')}`;
    const result = await this.databaseService.queryGlobal(
      `SELECT 1 FROM pg_class WHERE relname = $1 AND relnamespace = 'wms'::regnamespace`,
      [name]
    );
    return result.rows.length > 0;
  }

  private async ensurePartition(table: PartitionedTable, year: number, month: number): Promise<string> {
    // table.ensureFunctionSql vem só da lista interna PARTITIONED_TABLES
    // (nunca de input externo) — interpolação de identificador aqui é
    // segura, os valores de dados (year/month) continuam parametrizados.
    const result = await this.databaseService.queryGlobal<Record<string, string>>(`SELECT ${table.ensureFunctionSql}($1, $2) AS partition_name`, [
      year,
      month,
    ]);
    return result.rows[0].partition_name;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
