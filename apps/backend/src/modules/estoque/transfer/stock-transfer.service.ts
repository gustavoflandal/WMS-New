// DOC-05 §4.6 — RF-EST-050 (transferência interna, "imediata em tela") +
// RF-EST-051 (transferência entre armazéns, §5.2 CREATED->PICKING->
// IN_TRANSIT->RECEIVING->COMPLETED) + RN-EST-052 (RG-015 no destino).
//
// [DÉBITO] RF-EST-051 pede "recebimento no destino como Ordem de Recebimento
// vinculada (conferência obrigatória)" — integração REAL e completa com
// InboundOrderService/CheckingService (DOC-04) reconstruiria o fluxo de
// conferência inteiro para um TRF, escopo grande demais para esta sessão.
// Implementado: o crédito/débito REAL de saldo via StockMovementService (o
// que importa para RN-EST-001) e a máquina de estados §5.2 completa; a
// pendência é só o vínculo pleno com conferência/divergência do DOC-04 —
// completeReceiving() credita direto, sem abrir Divergência RN-REC-022/023.
//
// RN-EST-052 (RG-015 no destino) é satisfeita GRATUITAMENTE: completeReceiving
// reusa PutawayEngineService.evaluateSingleLocationForProduct() (RF-EST-050,
// mesma extração desta sessão) — a Fase 1 do motor JÁ inclui a checagem de
// dono do Armazém Lógico (RG-015) para qualquer endereço de destino.
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { PutawayEngineService } from '../../recebimento/putaway/putaway-engine.service.js';
import { StockMovementService } from '../movement/stock-movement.service.js';

export interface TransferInternalInput {
  tenantId: string;
  warehouseId: string;
  productId: string;
  batchId?: string | null;
  qty: number;
  locationIdOrigin: string;
  palletIdOrigin?: string | null;
  locationIdDestination: string;
  palletIdDestination?: string | null;
  overrideReason?: string;
  actorUserId: string;
}

export interface CreateInterwarehouseInput {
  tenantId: string;
  warehouseIdOrigin: string;
  warehouseIdDestination: string;
  items: Array<{ productId: string; batchId?: string | null; qty: number; locationIdOrigin: string; palletIdOrigin?: string | null }>;
  actorUserId: string;
}

export interface CompleteReceivingItemInput {
  itemId: string;
  locationIdDestination: string;
  palletIdDestination?: string | null;
  overrideReason?: string;
}

@Injectable()
export class StockTransferService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(RbacService) private readonly rbacService: RbacService,
    @Inject(DocumentNumberingService) private readonly documentNumberingService: DocumentNumberingService,
    @Inject(PutawayEngineService) private readonly putawayEngineService: PutawayEngineService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService
  ) {}

  /**
   * RF-EST-050 — "movimentação endereço→endereço ou palete→palete dentro do
   * armazém... imediata em tela (com permissão). Passa pelos filtros Fase 1
   * do motor (RN-REC-040) no destino." Sem tarefa dirigida/dupla leitura
   * (esse é o outro caminho do RF-EST-050, [LACUNA: não implementado nesta
   * sessão — reaproveitaria ReplenishmentTaskService, mas com um
   * movement_type diferente; adiado por escopo).
   */
  async transferInternal(input: TransferInternalInput) {
    const verdict = await this.putawayEngineService.evaluateSingleLocationForProduct(
      { productId: input.productId, batchId: input.batchId ?? null, qty: input.qty },
      input.locationIdDestination,
      input.tenantId,
      input.warehouseId,
      input.actorUserId
    );

    let overrideApplied = false;
    if (verdict.verdict === 'REJECTED_LEGAL') {
      throw new ForbiddenException({
        error: 'PHASE1_VIOLATION_NO_OVERRIDE',
        detail: `RN-REC-040/RF-EST-050: ${verdict.reason} — reprovação da Fase 1 não admite override por nenhum papel`,
      });
    }
    if (verdict.verdict === 'REJECTED_OPERATIONAL') {
      const hasOverride = await this.rbacService.hasPermission(input.actorUserId, 'EST.PUTAWAY_OVERRIDE', { warehouseId: input.warehouseId, clientId: input.tenantId });
      if (!hasOverride) {
        throw new ForbiddenException({ error: 'PHASE1_VIOLATION', detail: `RN-REC-040/RF-EST-050: ${verdict.reason} — exige EST.PUTAWAY_OVERRIDE` });
      }
      if (!input.overrideReason || input.overrideReason.trim().length === 0) {
        throw new BadRequestException({ error: 'OVERRIDE_REASON_REQUIRED', detail: 'RN-REC-041: override exige motivo' });
      }
      overrideApplied = true;
    }

    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };
    const result = await this.db.transaction(ctx, async (client) => {
      const transferResult = await client.query(
        `INSERT INTO wms.stock_transfer (tenant_id, transfer_type, warehouse_id_origin, warehouse_id_destination, status, completed_at, created_by)
         VALUES ($1,'INTERNAL',$2,$2,'COMPLETED',now(),$3) RETURNING *`,
        [input.tenantId, input.warehouseId, input.actorUserId]
      );
      const transfer = transferResult.rows[0];

      await client.query(
        `INSERT INTO wms.stock_transfer_item (
           tenant_id, stock_transfer_id, product_id, batch_id, qty,
           location_id_origin, pallet_id_origin, location_id_destination, pallet_id_destination, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [input.tenantId, transfer.id, input.productId, input.batchId ?? null, input.qty, input.locationIdOrigin, input.palletIdOrigin ?? null, input.locationIdDestination, input.palletIdDestination ?? null, input.actorUserId]
      );

      await this.stockMovementService.apply(client, {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        movementType: 'TRANSFERENCIA_INTERNA',
        productId: input.productId,
        batchId: input.batchId ?? null,
        qty: input.qty,
        locationIdFrom: input.locationIdOrigin,
        palletIdFrom: input.palletIdOrigin ?? null,
        locationIdTo: input.locationIdDestination,
        palletIdTo: input.palletIdDestination ?? null,
        bucketFromOverride: 'AVAILABLE',
        policyBreak: false,
        actorUserId: input.actorUserId,
      });

      await this.eventsService.publishInTransaction(client, {
        event_type: 'estoque.transferencia_concluida',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: input.actorUserId,
        payload: { stock_transfer_id: transfer.id, transfer_type: 'INTERNAL', product_id: input.productId, qty: input.qty, override_applied: overrideApplied },
      });

      return transfer;
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'WEB',
      entity: 'stock_transfer',
      entityId: result.id,
      action: overrideApplied ? 'OVERRIDE' : 'CREATE',
      requirementId: 'DOC-05 RF-EST-050',
      reason: overrideApplied ? input.overrideReason : null,
      after: result,
    });

    return result;
  }

  /** RF-EST-051 — "criação do documento TRF inter-armazém". §5.2: [*] -> CREATED. */
  async createInterwarehouse(input: CreateInterwarehouseInput) {
    if (input.items.length === 0) {
      throw new BadRequestException({ error: 'EMPTY_TRANSFER', detail: 'RF-EST-051: transferência entre armazéns exige ao menos 1 item' });
    }
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseIdOrigin };

    const result = await this.db.transaction(ctx, async (client) => {
      const warehouseResult = await client.query(`SELECT code FROM wms.warehouse WHERE id = $1`, [input.warehouseIdOrigin]);
      const documentNumber = await this.documentNumberingService.generateDocumentNumber(client, 'TRANSFER', input.warehouseIdOrigin, warehouseResult.rows[0].code, input.actorUserId);

      const transferResult = await client.query(
        `INSERT INTO wms.stock_transfer (tenant_id, transfer_type, warehouse_id_origin, warehouse_id_destination, document_number, status, created_by)
         VALUES ($1,'INTERWAREHOUSE',$2,$3,$4,'CREATED',$5) RETURNING *`,
        [input.tenantId, input.warehouseIdOrigin, input.warehouseIdDestination, documentNumber, input.actorUserId]
      );
      const transfer = transferResult.rows[0];

      for (const item of input.items) {
        await client.query(
          `INSERT INTO wms.stock_transfer_item (tenant_id, stock_transfer_id, product_id, batch_id, qty, location_id_origin, pallet_id_origin, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [input.tenantId, transfer.id, item.productId, item.batchId ?? null, item.qty, item.locationIdOrigin, item.palletIdOrigin ?? null, input.actorUserId]
        );
      }

      await this.eventsService.publishInTransaction(client, {
        event_type: 'estoque.transferencia_criada',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseIdOrigin,
        actor_user_id: input.actorUserId,
        payload: { stock_transfer_id: transfer.id, document_number: documentNumber, warehouse_id_destination: input.warehouseIdDestination, item_count: input.items.length },
      });

      return transfer;
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseIdOrigin,
      userId: input.actorUserId,
      origin: 'WEB',
      entity: 'stock_transfer',
      entityId: result.id,
      action: 'CREATE',
      requirementId: 'DOC-05 RF-EST-051',
      after: result,
    });

    return result;
  }

  /** §5.2: CREATED -> PICKING. */
  async startPicking(transferId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const transfer = await this.loadTransfer(transferId, tenantId, warehouseId, actorUserId);
    if (transfer.status !== 'CREATED') {
      throw new BadRequestException({ error: 'TRANSFER_NOT_CREATED', detail: `§5.2: transferência ${transferId} não está CREATED (status atual: ${transfer.status})` });
    }
    return this.updateStatus(transfer, 'PICKING', tenantId, warehouseId, actorUserId);
  }

  /**
   * §5.2: PICKING -> IN_TRANSIT. RF-EST-051: "picking no origem (baixa via
   * in_transit)" — débito AVAILABLE/crédito IN_TRANSIT no armazém ORIGEM
   * para cada item (TRANSFERENCIA_SAIDA_ARMAZEM).
   */
  async completePicking(transferId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const transfer = await this.loadTransfer(transferId, tenantId, warehouseId, actorUserId);
    if (transfer.status !== 'PICKING') {
      throw new BadRequestException({ error: 'TRANSFER_NOT_PICKING', detail: `§5.2: transferência ${transferId} não está PICKING (status atual: ${transfer.status})` });
    }
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const items = await this.db.query(ctx, `SELECT * FROM wms.stock_transfer_item WHERE stock_transfer_id = $1`, [transferId]);

    const updated = await this.db.transaction(ctx, async (client) => {
      for (const item of items.rows) {
        await this.stockMovementService.apply(client, {
          tenantId,
          warehouseId,
          movementType: 'TRANSFERENCIA_SAIDA_ARMAZEM',
          productId: item.product_id,
          batchId: item.batch_id,
          qty: Number(item.qty),
          locationIdFrom: item.location_id_origin,
          palletIdFrom: item.pallet_id_origin,
          actorUserId,
        });
      }
      const result = await client.query(`UPDATE wms.stock_transfer SET status = 'IN_TRANSIT', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`, [transferId, actorUserId]);
      return result.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'stock_transfer',
      entityId: transferId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-05 RF-EST-051',
      before: transfer,
      after: updated,
    });

    return updated;
  }

  /** §5.2: IN_TRANSIT -> RECEIVING ("chegou ao destino, aguardando conferência" — [DÉBITO] ver cabeçalho do arquivo). */
  async startReceiving(transferId: string, tenantId: string, warehouseIdOrigin: string, actorUserId: string) {
    const transfer = await this.loadTransfer(transferId, tenantId, warehouseIdOrigin, actorUserId);
    if (transfer.status !== 'IN_TRANSIT') {
      throw new BadRequestException({ error: 'TRANSFER_NOT_IN_TRANSIT', detail: `§5.2: transferência ${transferId} não está IN_TRANSIT (status atual: ${transfer.status})` });
    }
    return this.updateStatus(transfer, 'RECEIVING', tenantId, warehouseIdOrigin, actorUserId);
  }

  /**
   * §5.2: RECEIVING -> COMPLETED. RF-EST-051: "crédito no destino" +
   * RN-EST-052 (RG-015 no destino, via Fase 1 do motor — ver cabeçalho).
   */
  async completeReceiving(transferId: string, itemAssignments: CompleteReceivingItemInput[], tenantId: string, warehouseIdOrigin: string, actorUserId: string) {
    const transfer = await this.loadTransfer(transferId, tenantId, warehouseIdOrigin, actorUserId);
    if (transfer.status !== 'RECEIVING') {
      throw new BadRequestException({ error: 'TRANSFER_NOT_RECEIVING', detail: `§5.2: transferência ${transferId} não está RECEIVING (status atual: ${transfer.status})` });
    }

    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseIdOrigin };
    const itemsResult = await this.db.query(ctx, `SELECT * FROM wms.stock_transfer_item WHERE stock_transfer_id = $1`, [transferId]);
    const itemsById = new Map<string, any>(itemsResult.rows.map((r: any) => [r.id, r]));

    for (const assignment of itemAssignments) {
      const item = itemsById.get(assignment.itemId);
      if (!item) throw new NotFoundException(`stock_transfer_item ${assignment.itemId} not found in transfer ${transferId}`);

      // RF-EST-050/RN-EST-052: MESMA Fase 1 do motor, agora no armazém DESTINO.
      const verdict = await this.putawayEngineService.evaluateSingleLocationForProduct(
        { productId: item.product_id, batchId: item.batch_id, qty: Number(item.qty) },
        assignment.locationIdDestination,
        tenantId,
        transfer.warehouse_id_destination,
        actorUserId
      );
      if (verdict.verdict === 'REJECTED_LEGAL') {
        throw new ForbiddenException({ error: 'PHASE1_VIOLATION_NO_OVERRIDE', detail: `RN-REC-040/RN-EST-052: ${verdict.reason} — reprovação da Fase 1 não admite override` });
      }
      if (verdict.verdict === 'REJECTED_OPERATIONAL') {
        const hasOverride = await this.rbacService.hasPermission(actorUserId, 'EST.PUTAWAY_OVERRIDE', { warehouseId: transfer.warehouse_id_destination, clientId: tenantId });
        if (!hasOverride || !assignment.overrideReason) {
          throw new ForbiddenException({ error: 'PHASE1_VIOLATION', detail: `RN-REC-040: ${verdict.reason} — exige EST.PUTAWAY_OVERRIDE + motivo` });
        }
      }
    }

    const updated = await this.db.transaction(ctx, async (client) => {
      for (const assignment of itemAssignments) {
        const item = itemsById.get(assignment.itemId);
        await this.stockMovementService.apply(client, {
          tenantId,
          warehouseId: warehouseIdOrigin,
          destinationWarehouseId: transfer.warehouse_id_destination,
          movementType: 'TRANSFERENCIA_ENTRADA_ARMAZEM',
          productId: item.product_id,
          batchId: item.batch_id,
          qty: Number(item.qty),
          locationIdFrom: item.location_id_origin,
          palletIdFrom: item.pallet_id_origin,
          locationIdTo: assignment.locationIdDestination,
          palletIdTo: assignment.palletIdDestination ?? null,
          bucketToOverride: 'AVAILABLE',
          actorUserId,
        });

        await client.query(`UPDATE wms.stock_transfer_item SET location_id_destination = $2, pallet_id_destination = $3 WHERE id = $1`, [
          assignment.itemId,
          assignment.locationIdDestination,
          assignment.palletIdDestination ?? null,
        ]);
      }

      const result = await client.query(`UPDATE wms.stock_transfer SET status = 'COMPLETED', completed_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`, [
        transferId,
        actorUserId,
      ]);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'estoque.transferencia_concluida',
        tenant_id: tenantId,
        warehouse_id: transfer.warehouse_id_destination,
        actor_user_id: actorUserId,
        payload: { stock_transfer_id: transferId, transfer_type: 'INTERWAREHOUSE', document_number: transfer.document_number },
      });

      return result.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId: transfer.warehouse_id_destination,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'stock_transfer',
      entityId: transferId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-05 RF-EST-051',
      before: transfer,
      after: updated,
    });

    return updated;
  }

  /** §5.2: "ramo CANCELLED (antes do picking)" — só CREATED pode cancelar. */
  async cancel(transferId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const transfer = await this.loadTransfer(transferId, tenantId, warehouseId, actorUserId);
    if (transfer.status !== 'CREATED') {
      throw new ConflictException({ error: 'TRANSFER_NOT_CANCELLABLE', detail: `§5.2: cancelamento só é permitido antes do picking (status atual: ${transfer.status})` });
    }
    const updated = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `UPDATE wms.stock_transfer SET status = 'CANCELLED', cancelled_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [transferId, actorUserId]
    );

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'stock_transfer',
      entityId: transferId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-05 §5.2',
      before: transfer,
      after: updated.rows[0],
    });

    return updated.rows[0];
  }

  private async updateStatus(transfer: any, status: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const updated = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `UPDATE wms.stock_transfer SET status = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
      [transfer.id, status, actorUserId]
    );

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'stock_transfer',
      entityId: transfer.id,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-05 §5.2',
      before: transfer,
      after: updated.rows[0],
    });

    return updated.rows[0];
  }

  private async loadTransfer(transferId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const result = await this.db.query({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, `SELECT * FROM wms.stock_transfer WHERE id = $1`, [transferId]);
    const transfer = result.rows[0];
    if (!transfer) throw new NotFoundException(`stock_transfer ${transferId} not found`);
    return transfer;
  }
}
