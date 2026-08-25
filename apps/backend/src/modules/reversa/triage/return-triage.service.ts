// DOC-07 §4.3/§4.5 — Triagem (RF-REV-020, RN-REV-021) e Destinação
// (RN-REV-022, RN-REV-023). Ver docs/PROMPT-SESSAO-9A-doc07-reversa-nucleo.md
// §5-7 para as decisões de reuso (shelf life, zonas, gancho fiscal).
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { StockBucket } from '../../estoque/movement/stock-movement-effects.util.js';
import { meetsMinimumShelfLife } from '../../estoque/selection/stock-selection.util.js';
import { FiscalModeService } from '../../fiscal/fiscal-mode/fiscal-mode.service.js';
import { StorageReturnInvoiceService } from '../../fiscal/storage-return-invoice/storage-return-invoice.service.js';
import { BatchService } from '../../cadastro/batch/batch.service.js';
import { Disposition, PhysicalState, suggestDisposition, validateDispositionOverride } from './disposition-matrix.util.js';
import { resolveReturnOrderTransition } from '../return-order/return-order-state-machine.util.js';

export interface RegisterTriageInput {
  tenantId: string;
  warehouseId: string;
  returnOrderId: string;
  returnOrderItemId: string;
  productId: string;
  qty: number;
  physicalState: PhysicalState;
  /** Lote lido (SKU/EAN + lote). Omitido/ilegível => lote provisório DEV-<ordem>-<seq> (RN-REV-020). */
  batchCode?: string | null;
  /** Fotos obrigatórias quando physicalState !== 'INTEGRO' (RF-REV-020) — chaves já existentes no storage. */
  photoKeys?: string[];
}

export interface ConfirmDispositionInput {
  tenantId: string;
  warehouseId: string;
  triageRecordId: string;
  confirmedDisposition: Disposition;
  /** RN-REV-021: "exceto decisão formal do cliente" — bypassa a regra de restritividade (nunca o bloqueio absoluto de reintegração vencida). */
  clientDecision?: boolean;
}

const ZONE_BY_BUCKET: Record<Extract<StockBucket, 'QUARANTINE' | 'DAMAGED'>, string> = {
  QUARANTINE: 'QUARANTINE',
  DAMAGED: 'DAMAGED',
};

const DISPOSITION_BUCKET: Record<Disposition, StockBucket> = {
  REINTEGRAR: 'AVAILABLE',
  QUARENTENA: 'QUARANTINE',
  AVARIA: 'DAMAGED',
  DESCARTE: 'BLOCKED',
  RETORNO_CLIENTE: 'BLOCKED',
};

@Injectable()
export class ReturnTriageService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(OperationFlowService) private readonly operationFlowService: OperationFlowService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService,
    @Inject(FiscalModeService) private readonly fiscalModeService: FiscalModeService,
    @Inject(StorageReturnInvoiceService) private readonly storageReturnInvoiceService: StorageReturnInvoiceService,
    @Inject(BatchService) private readonly batchService: BatchService
  ) {}

  /** RF-REV-020/RN-REV-021 — registra um item triado, com destinação SUGERIDA (não confirmada). */
  async registerTriage(input: RegisterTriageInput, actorUserId: string) {
    const order = await this.loadOrder(input.returnOrderId, input.tenantId, input.warehouseId, actorUserId);
    if (order.status !== 'IN_TRIAGE') {
      throw new BadRequestException({ error: 'ORDER_NOT_IN_TRIAGE', detail: `return_order ${input.returnOrderId} não está IN_TRIAGE (atual: ${order.status})` });
    }
    if (input.physicalState !== 'INTEGRO' && (!input.photoKeys || input.photoKeys.length === 0)) {
      throw new BadRequestException({ error: 'PHOTOS_REQUIRED', detail: 'RF-REV-020: fotos obrigatórias quando o item não está íntegro' });
    }

    const ctx = { tenant_id: input.tenantId, user_id: actorUserId, warehouse_id: input.warehouseId };

    const productResult = await this.db.query<{ shelf_life_days: number | null; min_shelf_life_pct: string | null; species_code: string; requires_batch: boolean }>(
      ctx,
      `SELECT p.shelf_life_days, p.min_shelf_life_pct, p.species_code,
              COALESCE(cws.min_shelf_life_default_pct, p.min_shelf_life_pct) AS resolved_pct, ps.requires_batch
       FROM wms.product p
       LEFT JOIN wms.client_warehouse_settings cws ON cws.tenant_id = p.tenant_id AND cws.warehouse_id = $2
       LEFT JOIN wms.product_species ps ON ps.code = p.species_code
       WHERE p.id = $1 AND p.tenant_id = $3`,
      [input.productId, input.warehouseId, input.tenantId]
    );
    const product = productResult.rows[0];
    if (!product) throw new NotFoundException(`product ${input.productId} not found`);
    const isMedicamento = product.species_code === 'MEDICAMENTO';

    let batchId: string | null = null;
    let batchProvisional = false;
    let meetsShelfLife = true;

    if (input.batchCode) {
      const batchResult = await this.db.query(ctx, `SELECT id, expiration_date FROM wms.batch WHERE product_id = $1 AND batch_code = $2`, [
        input.productId,
        input.batchCode,
      ]);
      const batch = batchResult.rows[0];
      if (batch) {
        batchId = batch.id;
        if (input.physicalState === 'INTEGRO' && batch.expiration_date) {
          meetsShelfLife = meetsMinimumShelfLife({
            expirationDate: new Date(batch.expiration_date).toISOString().slice(0, 10),
            shelfLifeDays: product.shelf_life_days,
            minShelfLifePct: (product as any).resolved_pct ?? null,
            today: new Date().toISOString().slice(0, 10),
          });
        }
      }
    }

    if (!batchId) {
      // RN-REV-020: lote ilegível/ausente -> lote provisório DEV-<ordem>-<seq>, sempre tratado como QUARENTENA.
      batchProvisional = true;
      const seqResult = await this.db.query<{ n: string }>(ctx, `SELECT COUNT(*)::text AS n FROM wms.triage_record WHERE return_order_id = $1`, [
        input.returnOrderId,
      ]);
      const seq = Number(seqResult.rows[0].n) + 1;
      const provisionalCode = `DEV-${order.number}-${seq}`;
      const batch = await this.batchService.create({ tenant_id: input.tenantId, product_id: input.productId, batch_code: provisionalCode }, actorUserId);
      batchId = batch.id;
    }

    // RN-REV-020: lote ilegível/ausente -> QUARENTENA só se afetaria a
    // classificação (íntegro depende do lote para saber o shelf life);
    // DANIFICADO/VENCIDO/EMBALAGEM_VIOLADA já não dependem do lote para a
    // matriz e mantêm sua classificação normal mesmo com lote provisório.
    const dispositionSuggested =
      batchProvisional && input.physicalState === 'INTEGRO'
        ? 'QUARENTENA'
        : suggestDisposition({ physicalState: input.physicalState, meetsMinimumShelfLife: meetsShelfLife, isMedicamento });

    // RN-REV-021 [INVIOLÁVEL]: vencido, OU íntegro com lote real abaixo do
    // shelf life mínimo — nunca REINTEGRAR, nem por decisão do cliente.
    // MEDICAMENTO (força QUARENTENA por política, não por shelf life) e lote
    // provisório (dado insuficiente, não "abaixo do mínimo" comprovado) NÃO
    // ativam o bloqueio absoluto.
    const shelfLifeBlocksReintegration = input.physicalState === 'VENCIDO' || (input.physicalState === 'INTEGRO' && !batchProvisional && !isMedicamento && !meetsShelfLife);

    const result = await this.db.transaction(ctx, async (client) => {
      const inserted = await client.query(
        `INSERT INTO wms.triage_record (tenant_id, warehouse_id, return_order_id, return_order_item_id, product_id, batch_id, batch_provisional, qty, physical_state, photo_keys, disposition_suggested, shelf_life_blocks_reintegration, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          input.tenantId,
          input.warehouseId,
          input.returnOrderId,
          input.returnOrderItemId,
          input.productId,
          batchId,
          batchProvisional,
          input.qty,
          input.physicalState,
          input.photoKeys ?? [],
          dispositionSuggested,
          shelfLifeBlocksReintegration,
          actorUserId,
        ]
      );
      await this.eventsService.publishInTransaction(client, {
        event_type: 'reversa.triagem_item',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: actorUserId,
        payload: { return_order_id: input.returnOrderId, triage_record_id: inserted.rows[0].id, disposition_suggested: dispositionSuggested },
      });
      return inserted.rows[0];
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'triage_record',
      entityId: result.id,
      action: 'CREATE',
      requirementId: 'DOC-07 RF-REV-020',
      after: result,
    });

    return result;
  }

  /** RF-REV-010 — "todos os itens triados": soma de triage_record.qty por item atinge qty_authorized. */
  async completeTriage(returnOrderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const order = await this.loadOrder(returnOrderId, tenantId, warehouseId, actorUserId);
    resolveReturnOrderTransition(order.status, 'TRIAGEM_COMPLETA');

    const ctx = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const pending = await this.db.query<{ line_number: number; missing: string }>(
      ctx,
      `SELECT roi.line_number, (roi.qty_authorized - COALESCE(SUM(tr.qty), 0)) AS missing
       FROM wms.return_order_item roi
       LEFT JOIN wms.triage_record tr ON tr.return_order_item_id = roi.id
       WHERE roi.return_order_id = $1
       GROUP BY roi.id, roi.line_number, roi.qty_authorized
       HAVING (roi.qty_authorized - COALESCE(SUM(tr.qty), 0)) > 0`,
      [returnOrderId]
    );
    if (pending.rows.length > 0) {
      throw new BadRequestException({
        error: 'TRIAGE_INCOMPLETE',
        detail: `RF-REV-010: itens ainda sem triagem completa: linha(s) ${pending.rows.map((r) => r.line_number).join(', ')}`,
      });
    }

    const result = await this.db.transaction(ctx, async (client) => {
      const updated = await client.query(
        `UPDATE wms.return_order SET status = 'IN_DISPOSITION', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [returnOrderId, actorUserId]
      );
      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'return_order' AND entity_id = $1`, [returnOrderId]);
      await this.operationFlowService.completeStep(client, flow.rows[0].id, 'TRIAGEM', actorUserId);
      return updated.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'return_order',
      entityId: returnOrderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-07 RF-REV-010',
      before: order,
      after: result,
    });

    return result;
  }

  /** RN-REV-021 (validação) + RN-REV-022 (efeito de saldo). */
  async confirmDisposition(input: ConfirmDispositionInput, actorUserId: string) {
    const ctx = { tenant_id: input.tenantId, user_id: actorUserId, warehouse_id: input.warehouseId };
    const triageResult = await this.db.query(ctx, `SELECT * FROM wms.triage_record WHERE id = $1`, [input.triageRecordId]);
    const triage = triageResult.rows[0];
    if (!triage) throw new NotFoundException(`triage_record ${input.triageRecordId} not found`);
    if (triage.disposition_confirmed) {
      throw new ConflictException({ error: 'DISPOSITION_ALREADY_CONFIRMED', detail: `triage_record ${input.triageRecordId} já tem destinação confirmada` });
    }

    const order = await this.loadOrder(triage.return_order_id, input.tenantId, input.warehouseId, actorUserId);
    if (order.status !== 'IN_DISPOSITION') {
      throw new BadRequestException({ error: 'ORDER_NOT_IN_DISPOSITION', detail: `return_order ${order.id} não está IN_DISPOSITION (atual: ${order.status})` });
    }

    validateDispositionOverride({
      suggested: triage.disposition_suggested,
      confirmed: input.confirmedDisposition,
      physicalState: triage.physical_state,
      suggestionMetShelfLife: !triage.shelf_life_blocks_reintegration,
      clientDecision: input.clientDecision,
    });

    const locationId = await this.resolveCreditLocation(input.warehouseId, input.confirmedDisposition);
    const bucket = DISPOSITION_BUCKET[input.confirmedDisposition];

    const result = await this.db.transaction(ctx, async (client) => {
      await this.stockMovementService.apply(client, {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        movementType: 'ENTRADA_REVERSA',
        productId: triage.product_id,
        batchId: triage.batch_id,
        qty: Number(triage.qty),
        locationIdTo: locationId,
        bucketToOverride: bucket,
        documentRefType: 'return_order',
        documentRefId: order.id,
        actorUserId,
      });

      const updated = await client.query(
        `UPDATE wms.triage_record SET disposition_confirmed = $2, confirmed_by = $3, confirmed_at = now() WHERE id = $1 RETURNING *`,
        [input.triageRecordId, input.confirmedDisposition, actorUserId]
      );
      await client.query(`UPDATE wms.return_order_item SET qty_received = qty_received + $2 WHERE id = $1`, [triage.return_order_item_id, triage.qty]);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'reversa.destinacao_confirmada',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: actorUserId,
        payload: { return_order_id: order.id, triage_record_id: input.triageRecordId, disposition: input.confirmedDisposition },
      });
      if (input.confirmedDisposition === 'REINTEGRAR') {
        await this.eventsService.publishInTransaction(client, {
          event_type: 'reversa.reintegrado',
          tenant_id: input.tenantId,
          warehouse_id: input.warehouseId,
          actor_user_id: actorUserId,
          payload: { return_order_id: order.id, triage_record_id: input.triageRecordId, qty: Number(triage.qty) },
        });
      }

      return updated.rows[0];
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'triage_record',
      entityId: input.triageRecordId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-07 RN-REV-022',
      before: triage,
      after: result,
    });

    await this.tryCompleteOrder(order.id, input.tenantId, input.warehouseId, actorUserId);

    return result;
  }

  /**
   * RN-REV-023 — quando TODAS as destinações estiverem confirmadas, roda o
   * gancho fiscal (reverso de RN-FIS-041) e só então conclui a Ordem. Se
   * algum item ainda não foi destinado, não faz nada (fica IN_DISPOSITION).
   */
  private async tryCompleteOrder(returnOrderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const pending = await this.db.query<{ n: string }>(
      ctx,
      `SELECT COUNT(*)::text AS n FROM wms.triage_record WHERE return_order_id = $1 AND disposition_confirmed IS NULL`,
      [returnOrderId]
    );
    if (Number(pending.rows[0].n) > 0) return null;

    const order = await this.loadOrder(returnOrderId, tenantId, warehouseId, actorUserId);
    if (!order.fiscal_treatment_done) {
      await this.recomposeFiscal(order, actorUserId);
    }

    const finalOrder = await this.loadOrder(returnOrderId, tenantId, warehouseId, actorUserId);
    if (!finalOrder.fiscal_treatment_done) {
      // RN-REV-023: "a etapa Destinação SÓ conclui com o tratamento fiscal
      // registrado" — permanece IN_DISPOSITION (flow_step DESTINACAO fica
      // vermelho) até o gancho fiscal rodar com sucesso.
      return null;
    }

    const result = await this.db.transaction(ctx, async (client) => {
      const updated = await client.query(
        `UPDATE wms.return_order SET status = 'COMPLETED', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [returnOrderId, actorUserId]
      );
      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'return_order' AND entity_id = $1`, [returnOrderId]);
      await this.operationFlowService.completeStep(client, flow.rows[0].id, 'DESTINACAO', actorUserId);
      await this.operationFlowService.completeStep(client, flow.rows[0].id, 'FIM', actorUserId);
      await this.eventsService.publishInTransaction(client, {
        event_type: 'reversa.concluida',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { return_order_id: returnOrderId },
      });
      return updated.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'return_order',
      entityId: returnOrderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-07 RN-REV-023',
      before: order,
      after: result,
    });

    return result;
  }

  /** RN-REV-023 — reversão do Consumo Fiscal (RN-FIS-041) por produto, FIFO pelas alocações CONSUMIDA. */
  private async recomposeFiscal(order: { id: string; tenant_id: string; warehouse_id: string; source_outbound_order_id: string | null }, actorUserId: string) {
    const ctx = { tenant_id: order.tenant_id, user_id: actorUserId, warehouse_id: order.warehouse_id };

    if (!order.source_outbound_order_id) {
      // REVERSA_AVULSA: sem pedido de origem, sem consumo fiscal a reverter.
      await this.markFiscalTreatmentDone(order.id, ctx);
      return;
    }

    const fiscalMode = await this.fiscalModeService.getFiscalMode(order.tenant_id, order.warehouse_id, actorUserId);
    if (fiscalMode === 'INTEGRADO_ERP' || fiscalMode === null) {
      // RN-REV-023: dispensado — ERP externo é a fonte de verdade fiscal.
      await this.markFiscalTreatmentDone(order.id, ctx);
      return;
    }

    const qtyByProduct = await this.db.query<{ product_id: string; total_qty: string }>(
      ctx,
      `SELECT product_id, SUM(qty) AS total_qty FROM wms.triage_record WHERE return_order_id = $1 GROUP BY product_id`,
      [order.id]
    );

    for (const row of qtyByProduct.rows) {
      let remaining = Number(row.total_qty);
      const allocations = await this.db.query<{ id: string; qty: string; qty_reversed: string }>(
        ctx,
        `SELECT id, qty, qty_reversed FROM wms.fiscal_allocation
         WHERE outbound_order_id = $1 AND product_id = $2 AND status = 'CONSUMIDA'
         ORDER BY created_at ASC`,
        [order.source_outbound_order_id, row.product_id]
      );

      for (const allocation of allocations.rows) {
        if (remaining <= 0) break;
        const available = Number(allocation.qty) - Number(allocation.qty_reversed);
        if (available <= 0) continue;
        const take = Math.min(remaining, available);
        await this.storageReturnInvoiceService.reverseConsumption({
          tenantId: order.tenant_id,
          warehouseId: order.warehouse_id,
          fiscalAllocationId: allocation.id,
          qtyToReverse: take,
          actorUserId,
        });
        remaining -= take;
      }

      if (remaining > 0) {
        throw new ConflictException({
          error: 'FISCAL_CONSUMPTION_MISMATCH',
          detail: `DOC-07 RN-REV-023: ${remaining} unidade(s) do produto ${row.product_id} devolvidas sem consumo fiscal CONSUMIDA correspondente no pedido ${order.source_outbound_order_id}`,
        });
      }
    }

    await this.markFiscalTreatmentDone(order.id, ctx);
  }

  private async markFiscalTreatmentDone(returnOrderId: string, ctx: { tenant_id: string; user_id: string; warehouse_id: string }) {
    await this.db.query(ctx, `UPDATE wms.return_order SET fiscal_treatment_done = TRUE, updated_at = now() WHERE id = $1`, [returnOrderId]);
  }

  private async resolveCreditLocation(warehouseId: string, disposition: Disposition): Promise<string> {
    const bucket = DISPOSITION_BUCKET[disposition];
    const zoneType = bucket === 'AVAILABLE' || bucket === 'BLOCKED' ? 'RETURNS' : ZONE_BY_BUCKET[bucket as 'QUARANTINE' | 'DAMAGED'];

    // location/zone são GLOBAIS (RN-DAD-004, sem RLS) — mesmo padrão de putaway-engine.service.ts.
    const result = await this.db.queryGlobal<{ id: string }>(
      `SELECT l.id FROM wms.location l JOIN wms.zone z ON z.id = l.zone_id WHERE l.warehouse_id = $1 AND z.zone_type = $2 ORDER BY l.code LIMIT 1`,
      [warehouseId, zoneType]
    );
    const location = result.rows[0];
    if (!location) {
      throw new ConflictException({
        error: 'NO_LOCATION_FOR_DISPOSITION',
        detail: `DOC-07 RN-REV-022: nenhuma location cadastrada na zona ${zoneType} do armazém ${warehouseId} para receber a destinação ${disposition} — [DEBITO: 9A] sem putaway dirigido para REINTEGRAR, exige location na zona RETURNS/QUARANTINE/DAMAGED já cadastrada`,
      });
    }
    return location.id;
  }

  private async loadOrder(id: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const result = await this.db.query({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, `SELECT * FROM wms.return_order WHERE id = $1`, [id]);
    if (!result.rows[0]) throw new NotFoundException(`return_order ${id} not found`);
    return result.rows[0];
  }
}
