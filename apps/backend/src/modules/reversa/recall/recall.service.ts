// DOC-07 §4.4 RF-REV-030 — Recall de lote (Sessão 9B). Ver
// docs/PROMPT-SESSAO-9B-doc07-reversa-integracao-recall.md §4 para as
// decisões de implementação (bloqueio via BLOQUEIO/LIBERACAO_QUARENTENA
// encadeados — não existe um 19º tipo de movimentação para
// QUARANTINE->BLOCKED direto no catálogo fechado RN-EST-001).
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { StockBlockService } from '../../estoque/blocking/stock-block.service.js';
import { StockReservationService } from '../../estoque/selection/stock-reservation.service.js';
import { SelectionPurpose } from '../../estoque/selection/stock-selection.port.js';
import { BatchService } from '../../cadastro/batch/batch.service.js';
import { ReturnOrderService } from '../return-order/return-order.service.js';

export interface TriggerRecallInput {
  tenantId: string;
  /** Armazém de onde a ação foi disparada (contexto de permissão CLIENT_WAREHOUSE) — o EFEITO alcança todos os armazéns do lote (RN-REV-030). */
  triggeringWarehouseId: string;
  batchId: string;
  reason: string;
}

@Injectable()
export class RecallService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService,
    @Inject(StockBlockService) private readonly stockBlockService: StockBlockService,
    @Inject(StockReservationService) private readonly stockReservationService: StockReservationService,
    @Inject(BatchService) private readonly batchService: BatchService,
    @Inject(ReturnOrderService) private readonly returnOrderService: ReturnOrderService
  ) {}

  async triggerRecall(input: TriggerRecallInput, actorUserId: string) {
    const ctx0 = { tenant_id: input.tenantId, user_id: actorUserId, warehouse_id: input.triggeringWarehouseId };
    const batchResult = await this.db.query<{ id: string; product_id: string; status: string }>(
      ctx0,
      `SELECT id, product_id, status FROM wms.batch WHERE id = $1 AND tenant_id = $2`,
      [input.batchId, input.tenantId]
    );
    const batch = batchResult.rows[0];
    if (!batch) throw new NotFoundException(`batch ${input.batchId} not found`);
    if (batch.status === 'RECALLED') {
      throw new BadRequestException({ error: 'ALREADY_RECALLED', detail: `RF-REV-030: lote ${input.batchId} já está RECALLED` });
    }

    // (1) batch.status = RECALLED — em TODOS os armazéns por construção (batch é TENANT, sem coluna de armazém).
    await this.batchService.update(input.batchId, input.tenantId, input.triggeringWarehouseId, { status: 'RECALLED' }, actorUserId);

    // (2) bloqueia saldo em TODOS os armazéns. RLS de stock_balance filtra só
    // por tenant_id (confirmado na pesquisa da sessão) — a leitura cross-armazém é válida.
    // ANTES do cancelamento de reserva (3): a quantidade RESERVED do lote
    // ainda não é AVAILABLE aqui, então este passo só cobre available/quarantine
    // "livres". A quantidade liberada pelo cancelamento de reserva em (3) é
    // bloqueada ali mesmo (senão ficaria elegível para reseleção do próprio lote).
    let qtyBlocked = await this.blockAllBalances(input.tenantId, batch.product_id, input.batchId, input.reason, actorUserId);

    // (3) cancela reserva NÃO separada, bloqueia a quantidade liberada (para
    // não sobrar disponível do próprio lote recalled) e SÓ ENTÃO re-seleciona
    // pela política de giro — a demanda tem que achar outro lote.
    const { qtyCancelled, qtyBlockedFromReservations } = await this.cancelAndReselectReservations(input.tenantId, batch.product_id, input.batchId, input.reason, actorUserId);
    qtyBlocked += qtyBlockedFromReservations;
    const qtyReservationsCancelled = qtyCancelled;

    // (4) relatório de pedidos já expedidos com o lote (RF-REV-030 item 4).
    const shippedResult = await this.db.query<{ document_ref_id: string }>(
      ctx0,
      `SELECT DISTINCT document_ref_id FROM wms.stock_movement WHERE tenant_id = $1 AND batch_id = $2 AND movement_type = 'SAIDA_EXPEDICAO' AND document_ref_type = 'OUTBOUND_ORDER'`,
      [input.tenantId, input.batchId]
    );
    const shippedOrderIds = shippedResult.rows.map((r) => r.document_ref_id);

    const recallResult = await this.db.transaction(ctx0, async (client) => {
      const inserted = await client.query(
        `INSERT INTO wms.recall (tenant_id, batch_id, triggering_warehouse_id, reason, shipped_orders_report, qty_blocked, qty_reservations_cancelled, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [input.tenantId, input.batchId, input.triggeringWarehouseId, input.reason, JSON.stringify(shippedOrderIds), qtyBlocked, qtyReservationsCancelled, actorUserId]
      );
      await this.eventsService.publishInTransaction(client, {
        event_type: 'reversa.recall_acionado',
        tenant_id: input.tenantId,
        warehouse_id: input.triggeringWarehouseId,
        actor_user_id: actorUserId,
        payload: { recall_id: inserted.rows[0].id, batch_id: input.batchId, qty_blocked: qtyBlocked, shipped_order_ids: shippedOrderIds },
      });
      return inserted.rows[0];
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.triggeringWarehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'recall',
      entityId: recallResult.id,
      action: 'CREATE',
      requirementId: 'DOC-07 RF-REV-030',
      reason: input.reason,
      after: recallResult,
    });

    // (5) cria Ordem(ns) de Devolução tipo RECALL — uma por armazém com item(ns) já expedido(s) deste lote.
    const createdReturnOrders = await this.createRecallReturnOrders(input.tenantId, input.batchId, actorUserId);

    return { recall: recallResult, returnOrders: createdReturnOrders };
  }

  /** RF-REV-030 item 2 — AVAILABLE e QUARANTINE, todos os armazéns. */
  private async blockAllBalances(tenantId: string, productId: string, batchId: string, reason: string, actorUserId: string): Promise<number> {
    const ctx0 = { tenant_id: tenantId, user_id: actorUserId };
    const balances = await this.db.query<{
      warehouse_id: string;
      location_id: string | null;
      pallet_id: string | null;
      qty_available: string;
      qty_quarantine: string;
    }>(
      ctx0,
      `SELECT warehouse_id, location_id, pallet_id, qty_available, qty_quarantine
       FROM wms.stock_balance WHERE tenant_id = $1 AND batch_id = $2 AND (qty_available > 0 OR qty_quarantine > 0)`,
      [tenantId, batchId]
    );

    let qtyBlocked = 0;
    for (const row of balances.rows) {
      const rowCtx = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: row.warehouse_id };

      if (Number(row.qty_quarantine) > 0) {
        // Não existe QUARANTINE->BLOCKED direto no catálogo fechado (RN-EST-001)
        // — encadeia LIBERACAO_QUARENTENA (QUARANTINE->AVAILABLE) + BLOQUEIO
        // (AVAILABLE->BLOCKED) na mesma transação, mesmo efeito líquido.
        await this.db.transaction(rowCtx, (client) =>
          this.stockMovementService.apply(client, {
            tenantId,
            warehouseId: row.warehouse_id,
            movementType: 'LIBERACAO_QUARENTENA',
            productId,
            batchId,
            qty: Number(row.qty_quarantine),
            locationIdFrom: row.location_id,
            palletIdFrom: row.pallet_id,
            locationIdTo: row.location_id,
            palletIdTo: row.pallet_id,
            actorUserId,
          })
        );
        await this.stockBlockService.block({
          tenantId,
          warehouseId: row.warehouse_id,
          productId,
          batchId,
          qty: Number(row.qty_quarantine),
          locationId: row.location_id ?? undefined,
          palletId: row.pallet_id ?? undefined,
          reasonCode: 'ORDEM_CLIENTE',
          reasonText: `DOC-07 RF-REV-030: recall — ${reason}`,
          actorUserId,
        });
        qtyBlocked += Number(row.qty_quarantine);
      }

      if (Number(row.qty_available) > 0) {
        await this.stockBlockService.block({
          tenantId,
          warehouseId: row.warehouse_id,
          productId,
          batchId,
          qty: Number(row.qty_available),
          locationId: row.location_id ?? undefined,
          palletId: row.pallet_id ?? undefined,
          reasonCode: 'ORDEM_CLIENTE',
          reasonText: `DOC-07 RF-REV-030: recall — ${reason}`,
          actorUserId,
        });
        qtyBlocked += Number(row.qty_available);
      }
    }

    return qtyBlocked;
  }

  /** RF-REV-030 item 3 — cancela ACTIVE do lote, re-seleciona pela política de giro (RG-006), demanda intacta. */
  private async cancelAndReselectReservations(
    tenantId: string,
    productId: string,
    batchId: string,
    reason: string,
    actorUserId: string
  ): Promise<{ qtyCancelled: number; qtyBlockedFromReservations: number }> {
    const ctx0 = { tenant_id: tenantId, user_id: actorUserId };
    const reservations = await this.db.query<{
      id: string;
      warehouse_id: string;
      qty: string;
      location_id: string | null;
      pallet_id: string | null;
      purpose: SelectionPurpose;
      demand_ref_type: string;
      demand_ref_id: string;
    }>(ctx0, `SELECT id, warehouse_id, qty, location_id, pallet_id, purpose, demand_ref_type, demand_ref_id FROM wms.stock_reservation WHERE tenant_id = $1 AND batch_id = $2 AND status = 'ACTIVE'`, [
      tenantId,
      batchId,
    ]);

    let qtyCancelled = 0;
    let qtyBlockedFromReservations = 0;
    for (const reservation of reservations.rows) {
      const rowCtx = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: reservation.warehouse_id };
      await this.db.transaction(rowCtx, async (client) => {
        await client.query(`UPDATE wms.stock_reservation SET status = 'CANCELLED', updated_at = now(), updated_by = $2 WHERE id = $1`, [reservation.id, actorUserId]);
        await this.stockMovementService.apply(client, {
          tenantId,
          warehouseId: reservation.warehouse_id,
          movementType: 'LIBERACAO_RESERVA',
          productId,
          batchId,
          qty: Number(reservation.qty),
          locationIdFrom: reservation.location_id,
          palletIdFrom: reservation.pallet_id,
          locationIdTo: reservation.location_id,
          palletIdTo: reservation.pallet_id,
          actorUserId,
        });
        // A quantidade liberada é do LOTE RECALLED — bloqueia ANTES de
        // re-selecionar, senão ficaria disponível para o próprio lote se
        // re-selecionar (RN-EST-013/RG-006 não sabem "evitar este lote").
        await this.stockMovementService.apply(client, {
          tenantId,
          warehouseId: reservation.warehouse_id,
          movementType: 'BLOQUEIO',
          productId,
          batchId,
          qty: Number(reservation.qty),
          locationIdFrom: reservation.location_id,
          palletIdFrom: reservation.pallet_id,
          locationIdTo: reservation.location_id,
          palletIdTo: reservation.pallet_id,
          blockReasonCode: 'ORDEM_CLIENTE',
          blockReasonText: `DOC-07 RF-REV-030: recall — ${reason}`,
          actorUserId,
        });
        await this.stockReservationService.reserveInTransaction(client, {
          tenantId,
          warehouseId: reservation.warehouse_id,
          productId,
          demandQty: Number(reservation.qty),
          purpose: reservation.purpose,
          demandRefType: reservation.demand_ref_type,
          demandRefId: reservation.demand_ref_id,
          allowPartial: true,
          actorUserId,
        });
      });
      qtyCancelled += Number(reservation.qty);
      qtyBlockedFromReservations += Number(reservation.qty);
    }

    return { qtyCancelled, qtyBlockedFromReservations };
  }

  /** RF-REV-030 item 5 — uma Ordem tipo RECALL por armazém com item(ns) já expedido(s) deste lote. */
  private async createRecallReturnOrders(tenantId: string, batchId: string, actorUserId: string) {
    const ctx0 = { tenant_id: tenantId, user_id: actorUserId };
    const rows = await this.db.query<{ outbound_order_item_id: string; product_id: string; qty: string; warehouse_id: string }>(
      ctx0,
      `SELECT pc.outbound_order_item_id, pc.product_id, SUM(pc.qty) AS qty, oo.warehouse_id
       FROM wms.package_content pc
       JOIN wms.outbound_order_item oi ON oi.id = pc.outbound_order_item_id
       JOIN wms.outbound_order oo ON oo.id = oi.outbound_order_id
       WHERE pc.batch_id = $1
       GROUP BY pc.outbound_order_item_id, pc.product_id, oo.warehouse_id`,
      [batchId]
    );

    const byWarehouse = new Map<string, Array<{ productId: string; qty: number; sourceOutboundOrderItemId: string }>>();
    for (const row of rows.rows) {
      const items = byWarehouse.get(row.warehouse_id) ?? [];
      items.push({ productId: row.product_id, qty: Number(row.qty), sourceOutboundOrderItemId: row.outbound_order_item_id });
      byWarehouse.set(row.warehouse_id, items);
    }

    const created = [];
    for (const [warehouseId, items] of byWarehouse) {
      created.push(await this.returnOrderService.createForRecall({ tenantId, warehouseId, items }, actorUserId));
    }
    return created;
  }
}
