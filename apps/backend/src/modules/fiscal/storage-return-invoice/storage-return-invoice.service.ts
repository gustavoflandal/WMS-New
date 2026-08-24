// DOC-08 §4.5 RN-FIS-040 [INVIOLÁVEL] — Nota de Devolução de Armazenagem:
// montagem (dupla checagem de saldo #1) e "autorização" (dupla checagem #2
// + Consumo Fiscal). Nesta sessão (8A) a "autorização" é um MÉTODO
// EXPLÍCITO chamável — substituto testável do retorno real da SEFAZ, que
// só a Sessão 8B implementa (assinatura, transmissão, cStat 100). O Consumo
// Fiscal (`qty_consumed` +=) só é efetivado em authorize(), nunca em
// assemble() — exatamente RN-FIS-040 ("O Consumo Fiscal efetiva-se SOMENTE
// na AUTORIZAÇÃO").
//
// RN-FIS-041 — reverseConsumption(): método isolado, testável diretamente,
// SEM gatilho automático (DOC-07/Logística Reversa ainda não existe —
// decisão de escopo explícita, não [LACUNA]).
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { FiscalConsumptionService } from '../consumption/fiscal-consumption.service.js';
import { resolveOperationNature, resolveScopeType } from '../shared/operation-nature.util.js';
import { formatBrNumber } from '../shared/format-br-number.util.js';

export interface StorageReturnItemInput {
  productId: string;
  qty: number;
  /** RN-FIS-030 MANUAL: notas pré-selecionadas (fiscal_document.id da Nota de Armazenagem), na ordem desejada. */
  manualFiscalDocumentIds?: string[];
}

export interface AssembleStorageReturnInput {
  tenantId: string;
  warehouseId: string;
  outboundOrderId?: string | null;
  items: StorageReturnItemInput[];
  /** RN-FIS-030 MANUAL exige exceção FIS.CONSUMO_MANUAL aprovada — id da wms.operational_exception. */
  manualExceptionId?: string | null;
  actorUserId: string;
}

@Injectable()
export class StorageReturnInvoiceService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(DocumentNumberingService) private readonly documentNumberingService: DocumentNumberingService,
    @Inject(FiscalConsumptionService) private readonly fiscalConsumptionService: FiscalConsumptionService
  ) {}

  /** RN-FIS-040 — montagem: 1ª checagem de saldo (RG-014 item 4), sem efeito de consumo. */
  async assemble(input: AssembleStorageReturnInput) {
    if (input.items.length === 0) {
      throw new BadRequestException({ error: 'EMPTY_ITEMS', detail: 'RN-FIS-040: Nota de Devolução de Armazenagem exige ao menos 1 item' });
    }
    for (const item of input.items) {
      if (item.qty <= 0) throw new BadRequestException({ error: 'INVALID_QTY', detail: `RN-FIS-040: quantidade deve ser > 0 (produto ${item.productId})` });
    }

    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };

    const result = await this.db.transaction(ctx, async (client) => {
      const clientResult = await client.query<{ cnpj: string; legal_name: string; address_state: string | null }>(
        `SELECT cnpj, legal_name, address_state FROM wms.client WHERE id = $1`,
        [input.tenantId]
      );
      const clientRow = clientResult.rows[0];
      if (!clientRow) throw new NotFoundException(`client ${input.tenantId} not found`);

      const warehouseResult = await client.query<{ cnpj: string; name: string; code: string; address_state: string | null }>(
        `SELECT cnpj, name, code, address_state FROM wms.warehouse WHERE id = $1`,
        [input.warehouseId]
      );
      const warehouseRow = warehouseResult.rows[0];
      if (!warehouseRow) throw new NotFoundException(`warehouse ${input.warehouseId} not found`);

      const scopeType = resolveScopeType(clientRow.address_state, warehouseRow.address_state);
      const nature = await resolveOperationNature(client, {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        documentType: 'NOTA_DEVOLUCAO_ARMAZENAGEM',
        scopeType,
      });

      // ── RG-014 item 4 / RN-FIS-030 — seleção + 1ª checagem de saldo ──────
      const itemAllocations: Array<{ productId: string; qty: number; allocations: { storageFiscalDocumentId: string; qtyAllocated: number }[] }> = [];
      for (const item of input.items) {
        if (item.manualFiscalDocumentIds && item.manualFiscalDocumentIds.length > 0) {
          await this.assertManualConsumptionAuthorized(client, input.tenantId, input.warehouseId, input.manualExceptionId ?? null);
        }
        const selection = await this.fiscalConsumptionService.selectForConsumption(client, {
          tenantId: input.tenantId,
          warehouseId: input.warehouseId,
          productId: item.productId,
          demandQty: item.qty,
          manualFiscalDocumentIds: item.manualFiscalDocumentIds,
        });
        if (selection.shortfall > 0) {
          // Texto EXATO do exemplo normativo RG-014/RN-FIS-030 (DOC-08 §6).
          throw new BadRequestException({
            error: 'FISCAL_STOCK_INSUFFICIENT',
            detail: `saldo fiscal disponível: ${formatBrNumber(selection.totalAvailable)}`,
          });
        }
        itemAllocations.push({
          productId: item.productId,
          qty: item.qty,
          allocations: selection.allocations.map((a) => ({ storageFiscalDocumentId: a.candidate.storageFiscalDocumentId, qtyAllocated: a.qtyAllocated })),
        });
      }

      const internalNumber = await this.documentNumberingService.generateDocumentNumber(
        client,
        'FISCAL_DOCUMENT',
        input.warehouseId,
        warehouseRow.code,
        input.actorUserId
      );

      const documentResult = await client.query(
        `INSERT INTO wms.fiscal_document (
           tenant_id, warehouse_id, document_type, status, internal_number,
           issuer_cnpj, issuer_name, recipient_cnpj, recipient_name, operation_nature_id, created_by
         ) VALUES ($1,$2,'NOTA_DEVOLUCAO_ARMAZENAGEM','DRAFT',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [input.tenantId, input.warehouseId, internalNumber, warehouseRow.cnpj, warehouseRow.name, clientRow.cnpj, clientRow.legal_name, nature.id, input.actorUserId]
      );
      const document = documentResult.rows[0];

      // ── RN-FIS-040: "uma linha por (produto × Nota de Armazenagem consumida)" ──
      let lineNumber = 1;
      for (const item of itemAllocations) {
        for (const allocation of item.allocations) {
          await client.query(
            `INSERT INTO wms.fiscal_document_item (tenant_id, fiscal_document_id, line_number, product_id, qty, reference_fiscal_document_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [input.tenantId, document.id, lineNumber, item.productId, allocation.qtyAllocated, allocation.storageFiscalDocumentId, input.actorUserId]
          );
          lineNumber += 1;

          await client.query(
            `INSERT INTO wms.fiscal_allocation (
               tenant_id, warehouse_id, product_id, storage_fiscal_document_id, return_fiscal_document_id, outbound_order_id, qty, status, created_by
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,'ALOCADA',$8)`,
            [input.tenantId, input.warehouseId, item.productId, allocation.storageFiscalDocumentId, document.id, input.outboundOrderId ?? null, allocation.qtyAllocated, input.actorUserId]
          );
        }
      }

      await this.eventsService.publishInTransaction(client, {
        event_type: 'fiscal.emissao_solicitada',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: input.actorUserId,
        payload: { fiscal_document_id: document.id, internal_number: internalNumber, outbound_order_id: input.outboundOrderId ?? null },
      });

      return document;
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'fiscal_document',
      entityId: result.id,
      action: 'CREATE',
      requirementId: 'DOC-08 RN-FIS-040',
      after: result,
    });

    return result;
  }

  private async assertManualConsumptionAuthorized(client: PoolClient, tenantId: string, warehouseId: string, exceptionId: string | null): Promise<void> {
    if (!exceptionId) {
      throw new BadRequestException({
        error: 'FIS_CONSUMO_MANUAL_EXCEPTION_REQUIRED',
        detail: 'RN-FIS-030: seleção manual de notas exige exceção FIS.CONSUMO_MANUAL aprovada',
      });
    }
    const result = await client.query<{ exception_type: string; status: string }>(
      `SELECT exception_type, status FROM wms.operational_exception WHERE id = $1 AND tenant_id = $2 AND warehouse_id = $3`,
      [exceptionId, tenantId, warehouseId]
    );
    const exception = result.rows[0];
    if (!exception || exception.exception_type !== 'FIS.CONSUMO_MANUAL' || exception.status !== 'APPROVED') {
      throw new ConflictException({
        error: 'FIS_CONSUMO_MANUAL_EXCEPTION_NOT_APPROVED',
        detail: 'RN-FIS-030: exceção FIS.CONSUMO_MANUAL informada não está aprovada para este tenant/armazém',
      });
    }
  }

  /**
   * RN-FIS-040 — "autorização": 2ª checagem de saldo (RG-014 item 4) +
   * Consumo Fiscal (`qty_consumed` +=). Substituto testável do retorno real
   * da SEFAZ (cStat 100) — a Sessão 8B troca este disparo manual pelo
   * disparo real via o motor de emissão.
   */
  async authorize(fiscalDocumentId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };

    const result = await this.db.transaction(ctx, async (client) => {
      const docResult = await client.query(`SELECT * FROM wms.fiscal_document WHERE id = $1 FOR UPDATE`, [fiscalDocumentId]);
      const document = docResult.rows[0];
      if (!document) throw new NotFoundException(`fiscal_document ${fiscalDocumentId} not found`);
      if (document.document_type !== 'NOTA_DEVOLUCAO_ARMAZENAGEM') {
        throw new BadRequestException({ error: 'NOT_A_RETURN_INVOICE', detail: `RN-FIS-040: ${fiscalDocumentId} não é NOTA_DEVOLUCAO_ARMAZENAGEM` });
      }
      if (document.status !== 'DRAFT') {
        throw new ConflictException({ error: 'FISCAL_DOCUMENT_NOT_DRAFT', detail: `RN-FIS-040: status atual ${document.status}, esperado DRAFT` });
      }

      const allocationsResult = await client.query(
        `SELECT * FROM wms.fiscal_allocation WHERE return_fiscal_document_id = $1 AND status = 'ALOCADA' FOR UPDATE`,
        [fiscalDocumentId]
      );
      const allocations = allocationsResult.rows;

      // ── RG-014 item 4 — 2ª checagem de saldo, imediatamente antes do consumo ──
      for (const allocation of allocations) {
        const balanceResult = await client.query<{ qty_credited: string; qty_consumed: string; qty_pending_writeoff: string }>(
          `SELECT qty_credited, qty_consumed, qty_pending_writeoff FROM wms.fiscal_stock_balance
           WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3 AND storage_remittance_invoice_id = $4 FOR UPDATE`,
          [tenantId, warehouseId, allocation.product_id, allocation.storage_fiscal_document_id]
        );
        const balance = balanceResult.rows[0];
        const available = balance ? Number(balance.qty_credited) - Number(balance.qty_consumed) - Number(balance.qty_pending_writeoff) : 0;
        if (available < Number(allocation.qty)) {
          // RN-FIS-040: "rejeição não consome" — lança e a transação inteira
          // faz ROLLBACK (nenhum qty_consumed é alterado, mesmo dos outros
          // itens já processados neste laço).
          throw new BadRequestException({
            error: 'FISCAL_STOCK_INSUFFICIENT_ON_AUTHORIZE',
            detail: `saldo fiscal disponível: ${formatBrNumber(available)}`,
          });
        }
      }

      for (const allocation of allocations) {
        await client.query(
          `UPDATE wms.fiscal_stock_balance SET qty_consumed = qty_consumed + $5, updated_at = now(), updated_by = $6
           WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3 AND storage_remittance_invoice_id = $4`,
          [tenantId, warehouseId, allocation.product_id, allocation.storage_fiscal_document_id, allocation.qty, actorUserId]
        );
        await client.query(`UPDATE wms.fiscal_allocation SET status = 'CONSUMIDA', updated_at = now(), updated_by = $2 WHERE id = $1`, [
          allocation.id,
          actorUserId,
        ]);
      }

      const updatedDocResult = await client.query(
        `UPDATE wms.fiscal_document SET status = 'AUTHORIZED', issued_at = now(), authorized_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [fiscalDocumentId, actorUserId]
      );
      const updatedDocument = updatedDocResult.rows[0];

      await this.eventsService.publishInTransaction(client, {
        event_type: 'fiscal.nota_autorizada',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { fiscal_document_id: fiscalDocumentId },
      });
      await this.eventsService.publishInTransaction(client, {
        event_type: 'fiscal.consumo_efetivado',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { fiscal_document_id: fiscalDocumentId, allocation_count: allocations.length },
      });

      return updatedDocument;
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'fiscal_document',
      entityId: fiscalDocumentId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-08 RN-FIS-040',
      after: result,
    });

    return result;
  }

  /** Conveniência usada por DispatchService.confirmFiscalDocuments — monta E autoriza numa chamada (padrão de teste/manual desta sessão). */
  async assembleAndAuthorizeForOrder(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const itemsResult = await this.db.query<{ product_id: string; qty_reserved: string }>(
      ctx,
      `SELECT product_id, qty_reserved FROM wms.outbound_order_item WHERE outbound_order_id = $1 AND qty_reserved > 0 AND moved_to_order_id IS NULL`,
      [orderId]
    );
    if (itemsResult.rows.length === 0) {
      throw new BadRequestException({ error: 'NO_RESERVED_ITEMS', detail: `RN-FIS-040: pedido ${orderId} não tem itens reservados para gerar Nota de Devolução` });
    }

    const document = await this.assemble({
      tenantId,
      warehouseId,
      outboundOrderId: orderId,
      items: itemsResult.rows.map((r) => ({ productId: r.product_id, qty: Number(r.qty_reserved) })),
      actorUserId,
    });

    return this.authorize(document.id, tenantId, warehouseId, actorUserId);
  }

  /**
   * RN-FIS-041 — recomposição por reversa (posição padrão: FIS.RECOMPOSICAO_
   * MODO = ESTORNO). Método ISOLADO, sem gatilho automático (DOC-07 não
   * existe ainda — decisão de escopo, ver relatório). Suporta estorno
   * PARCIAL (qty_reversed acumula; status só vira ESTORNADA quando o
   * acumulado atinge `qty` da alocação original).
   */
  async reverseConsumption(input: { tenantId: string; warehouseId: string; fiscalAllocationId: string; qtyToReverse: number; actorUserId: string }) {
    if (input.qtyToReverse <= 0) {
      throw new BadRequestException({ error: 'INVALID_QTY', detail: 'RN-FIS-041: quantidade a estornar deve ser > 0' });
    }
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };

    const result = await this.db.transaction(ctx, async (client) => {
      const allocationResult = await client.query(`SELECT * FROM wms.fiscal_allocation WHERE id = $1 FOR UPDATE`, [input.fiscalAllocationId]);
      const allocation = allocationResult.rows[0];
      if (!allocation) throw new NotFoundException(`fiscal_allocation ${input.fiscalAllocationId} not found`);
      if (allocation.status !== 'CONSUMIDA') {
        throw new ConflictException({ error: 'ALLOCATION_NOT_CONSUMED', detail: `RN-FIS-041: alocação ${input.fiscalAllocationId} está ${allocation.status}, esperado CONSUMIDA` });
      }
      const remainingToReverse = Number(allocation.qty) - Number(allocation.qty_reversed);
      if (input.qtyToReverse > remainingToReverse) {
        throw new BadRequestException({
          error: 'REVERSAL_EXCEEDS_CONSUMED',
          detail: `RN-FIS-041: estorno de ${input.qtyToReverse} excede o consumido ainda não estornado (${remainingToReverse})`,
        });
      }

      const balanceResult = await client.query(
        `UPDATE wms.fiscal_stock_balance SET qty_consumed = qty_consumed - $5, updated_at = now(), updated_by = $6
         WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3 AND storage_remittance_invoice_id = $4
         RETURNING qty_credited, qty_consumed, qty_pending_writeoff`,
        [input.tenantId, input.warehouseId, allocation.product_id, allocation.storage_fiscal_document_id, input.qtyToReverse, input.actorUserId]
      );
      const balance = balanceResult.rows[0];
      const availableAfter = Number(balance.qty_credited) - Number(balance.qty_consumed) - Number(balance.qty_pending_writeoff);

      const newQtyReversed = Number(allocation.qty_reversed) + input.qtyToReverse;
      const newStatus = newQtyReversed >= Number(allocation.qty) ? 'ESTORNADA' : 'CONSUMIDA';
      await client.query(`UPDATE wms.fiscal_allocation SET qty_reversed = $2, status = $3, updated_at = now(), updated_by = $4 WHERE id = $1`, [
        input.fiscalAllocationId,
        newQtyReversed,
        newStatus,
        input.actorUserId,
      ]);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'fiscal.consumo_estornado',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: input.actorUserId,
        payload: { fiscal_allocation_id: input.fiscalAllocationId, qty_reversed: input.qtyToReverse, available_after: availableAfter },
      });

      return { fiscalAllocationId: input.fiscalAllocationId, qtyReversed: newQtyReversed, status: newStatus, availableAfter };
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'fiscal_allocation',
      entityId: input.fiscalAllocationId,
      action: 'UPDATE',
      requirementId: 'DOC-08 RN-FIS-041',
      after: result,
    });

    return result;
  }
}
