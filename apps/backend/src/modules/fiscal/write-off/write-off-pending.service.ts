// DOC-08 §4.8 RN-FIS-070 — Pendências documentais de descarte/ajuste
// negativo. Chamado DENTRO da MESMA transação de negócio dos dois pontos de
// gancho (stock-reclassification.service.ts::decideDiscard aprovado,
// inventory-count-execution.service.ts::decideAdjustment AJUSTE_INVENTARIO_
// NEG) — nunca abre a própria transação, para que a trava preventiva
// (qty_pending_writeoff) seja atômica com o efeito físico que a origina.
import { Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { EventsService } from '../../../core/events/events.service.js';
import { FiscalConsumptionService } from '../consumption/fiscal-consumption.service.js';

export interface ApplyPendingWriteoffInput {
  tenantId: string;
  warehouseId: string;
  productId: string;
  /** Quantidade FÍSICA descartada/ajustada — vira fiscal_pending_document.qty integralmente, mesmo se o crédito fiscal disponível for menor (ver relatório §decisões). */
  qty: number;
  origin: 'DESCARTE' | 'AJUSTE_INVENTARIO_NEG';
  originEntity: string;
  originEntityId: string;
  actorUserId: string;
}

export interface ApplyPendingWriteoffResult {
  /** false quando o produto não tem nenhum saldo em fiscal_stock_balance para este tenant/armazém (RN-FIS-070 só se aplica "quando o produto tem Estoque Fiscal"). */
  applied: boolean;
  pendingDocumentId?: string;
  qtyLockedOnFiscalBalance?: number;
}

@Injectable()
export class WriteOffPendingService {
  constructor(
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(FiscalConsumptionService) private readonly fiscalConsumptionService: FiscalConsumptionService
  ) {}

  async applyPendingWriteoffInTransaction(client: PoolClient, input: ApplyPendingWriteoffInput): Promise<ApplyPendingWriteoffResult> {
    const hasFiscalStock = await client.query(
      `SELECT 1 FROM wms.fiscal_stock_balance WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3 LIMIT 1`,
      [input.tenantId, input.warehouseId, input.productId]
    );
    if (hasFiscalStock.rows.length === 0) {
      return { applied: false };
    }

    // Mesma ordem de consumo do produto (RN-FIS-030) distribui a trava
    // preventiva entre as notas com saldo disponível — a pendência
    // documental (linha abaixo) registra a quantidade FÍSICA integral,
    // independentemente de o crédito fiscal cobrir tudo (capado pelo CHECK
    // qty_consumed + qty_pending_writeoff <= qty_credited de cada linha).
    const selection = await this.fiscalConsumptionService.selectForConsumption(client, {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      productId: input.productId,
      demandQty: input.qty,
    });

    let qtyLocked = 0;
    for (const allocation of selection.allocations) {
      await client.query(
        `UPDATE wms.fiscal_stock_balance SET qty_pending_writeoff = qty_pending_writeoff + $5, updated_at = now(), updated_by = $6
         WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3 AND storage_remittance_invoice_id = $4`,
        [input.tenantId, input.warehouseId, input.productId, allocation.candidate.storageFiscalDocumentId, allocation.qtyAllocated, input.actorUserId]
      );
      qtyLocked += allocation.qtyAllocated;
    }

    const pendingResult = await client.query(
      `INSERT INTO wms.fiscal_pending_document (tenant_id, warehouse_id, product_id, origin, origin_entity, origin_entity_id, qty, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8) RETURNING id`,
      [input.tenantId, input.warehouseId, input.productId, input.origin, input.originEntity, input.originEntityId, input.qty, input.actorUserId]
    );
    const pendingDocumentId = pendingResult.rows[0].id;

    await this.eventsService.publishInTransaction(client, {
      event_type: 'fiscal.pendencia_documental_criada',
      tenant_id: input.tenantId,
      warehouse_id: input.warehouseId,
      actor_user_id: input.actorUserId,
      payload: { pending_document_id: pendingDocumentId, product_id: input.productId, qty: input.qty, origin: input.origin, qty_locked_on_fiscal_balance: qtyLocked },
    });

    return { applied: true, pendingDocumentId, qtyLockedOnFiscalBalance: qtyLocked };
  }
}
