// DOC-05 §4.2 RN-EST-014 — job diário do scheduler: alerta de lotes a vencer
// (90/60/30/15/0 dias, parâmetro EST.ALERTA_VENCIMENTO_DIAS) + bloqueio
// automático de saldo VENCIDO (validade < hoje) via BLOQUEIO/VENCIDO
// (RN-EST-001, StockMovementService — único caminho de saldo).
//
// Roda cross-tenant via transactionAsWorker (ADR-006, BYPASSRLS), mesmo
// padrão de CrossDockAgingWorkerImpl (DOC-04 RNF-REC-052) — é um job de
// manutenção em background, não uma requisição de usuário.
import { Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { StockMovementService } from '../movement/stock-movement.service.js';

const DEFAULT_ALERT_DAYS = [90, 60, 30, 15, 0];
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

export interface ExpirationCheckResult {
  alertedBatchIds: string[];
  blockedBatchIds: string[];
}

interface ExpiredBalanceRow {
  id: string;
  tenant_id: string;
  warehouse_id: string;
  product_id: string;
  batch_id: string;
  location_id: string;
  pallet_id: string | null;
  qty_available: string;
}

@Injectable()
export class ExpirationService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste (mesmo padrão do resto do módulo).
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService
  ) {}

  /**
   * Idempotência (RN-EST-014 "idempotente"): mesmo padrão já usado por
   * PartitionManagerWorkerImpl/CrossDockAgingWorkerImpl — nenhuma tabela de
   * dedup dedicada. O BLOQUEIO automático é idempotente por construção (uma
   * vez bloqueado, qty_available chega a 0 e a query de "saldo vencido" não
   * o encontra mais numa 2ª execução). O ALERTA de vencimento poderia, em
   * tese, duplicar-se se o worker reiniciar no mesmo dia — risco aceito,
   * mesmo nível de tolerância dos demais jobs desta base (nenhum garante
   * "exactly-once"; a cadência diária do worker, pollIntervalMs=24h, já
   * torna isso raro na prática).
   */
  async checkExpirations(referenceDate: Date = new Date()): Promise<ExpirationCheckResult> {
    const alertDays = await this.resolveAlertDays();
    const today = referenceDate.toISOString().slice(0, 10);

    return this.db.transactionAsWorker(async (client) => {
      const alertedBatchIds = await this.alertUpcomingExpirations(client, alertDays, today);
      const blockedBatchIds = await this.blockExpiredBalances(client, today);
      return { alertedBatchIds, blockedBatchIds };
    });
  }

  /** RD-EST (parâmetro EST.ALERTA_VENCIMENTO_DIAS) — mesmo padrão de REC.CRITERIOS_PUTAWAY (JSON array em wms.app_parameter). */
  private async resolveAlertDays(): Promise<number[]> {
    const result = await this.db.queryGlobal<{ value: string }>(`SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'EST.ALERTA_VENCIMENTO_DIAS'`);
    const raw = result.rows[0]?.value;
    if (!raw) return DEFAULT_ALERT_DAYS;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number')) return parsed;
    } catch {
      // valor mal formado no parâmetro — cai para o default documentado no §4.2.
    }
    return DEFAULT_ALERT_DAYS;
  }

  /** RN-EST-014: alerta por LOTE (não por linha de stock_balance) — um lote com saldo em vários endereços gera 1 evento só. */
  private async alertUpcomingExpirations(client: PoolClient, alertDays: number[], today: string): Promise<string[]> {
    if (alertDays.length === 0) return [];
    const result = await client.query<{ id: string; tenant_id: string; product_id: string; expiration_date: string; warehouse_id: string | null }>(
      `SELECT b.id, b.tenant_id, b.product_id, b.expiration_date,
              (SELECT sb.warehouse_id FROM wms.stock_balance sb WHERE sb.batch_id = b.id AND sb.qty_available > 0 LIMIT 1) AS warehouse_id
       FROM wms.batch b
       WHERE b.expiration_date IS NOT NULL
         AND (b.expiration_date - $1::date) = ANY($2::int[])
         AND EXISTS (SELECT 1 FROM wms.stock_balance sb WHERE sb.batch_id = b.id AND sb.qty_available > 0)`,
      [today, alertDays]
    );

    const alerted: string[] = [];
    for (const row of result.rows) {
      if (!row.warehouse_id) continue;
      await this.eventsService.publishInTransaction(client, {
        event_type: 'estoque.lote_a_vencer',
        tenant_id: row.tenant_id,
        warehouse_id: row.warehouse_id,
        payload: { batch_id: row.id, product_id: row.product_id, expiration_date: row.expiration_date },
      });
      alerted.push(row.id);
    }
    return alerted;
  }

  /** RN-EST-014: saldo VENCIDO (expiration_date < hoje) — bloqueia TODO qty_available via BLOQUEIO/VENCIDO. */
  private async blockExpiredBalances(client: PoolClient, today: string): Promise<string[]> {
    const result = await client.query<ExpiredBalanceRow>(
      `SELECT sb.id, sb.tenant_id, sb.warehouse_id, sb.product_id, sb.batch_id, sb.location_id, sb.pallet_id, sb.qty_available
       FROM wms.stock_balance sb
       JOIN wms.batch b ON b.id = sb.batch_id
       WHERE b.expiration_date IS NOT NULL AND b.expiration_date < $1::date AND sb.qty_available > 0`,
      [today]
    );

    const blockedBatches = new Map<string, { tenant_id: string; warehouse_id: string; product_id: string }>();
    for (const row of result.rows) {
      await this.stockMovementService.apply(client, {
        tenantId: row.tenant_id,
        warehouseId: row.warehouse_id,
        movementType: 'BLOQUEIO',
        productId: row.product_id,
        batchId: row.batch_id,
        qty: Number(row.qty_available),
        locationIdFrom: row.location_id,
        palletIdFrom: row.pallet_id,
        locationIdTo: row.location_id,
        palletIdTo: row.pallet_id,
        blockReasonCode: 'VENCIDO',
        actorUserId: SYSTEM_ACTOR,
      });
      blockedBatches.set(row.batch_id, { tenant_id: row.tenant_id, warehouse_id: row.warehouse_id, product_id: row.product_id });
    }

    for (const [batchId, info] of blockedBatches) {
      await this.eventsService.publishInTransaction(client, {
        event_type: 'estoque.lote_vencido_bloqueado',
        tenant_id: info.tenant_id,
        warehouse_id: info.warehouse_id,
        payload: { batch_id: batchId, product_id: info.product_id },
      });
    }

    return Array.from(blockedBatches.keys());
  }
}
