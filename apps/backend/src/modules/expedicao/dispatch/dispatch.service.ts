// DOC-06 §4.7 RF-EXP-060 — Etapa Expedição (documental): consolidação em
// staging DISPATCH por leitura + gatilho fiscal conforme `fiscal_mode`.
//
// "A emissão e a alocação por nota são do DOC-08: implemente o ponto de
// integração e, enquanto não existir, fiscal_mode = INTEGRADO_ERP conclui a
// etapa com confirmação manual registrada e EMISSAO_PROPRIA/HIBRIDO ficam
// bloqueados com [LACUNA: DOC-08] explícito na etapa — nunca conclua sem
// documento" (prompt, entregável 5).
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { OutboundFlowService } from '../order/outbound-flow.service.js';
import { isFirstPendingStep } from '../order/flow-step-guard.util.js';
import { StorageReturnInvoiceService } from '../../fiscal/storage-return-invoice/storage-return-invoice.service.js';

@Injectable()
export class DispatchService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(OutboundFlowService) private readonly outboundFlowService: OutboundFlowService,
    @Inject(StorageReturnInvoiceService) private readonly storageReturnInvoiceService: StorageReturnInvoiceService
  ) {}

  /** RF-EXP-060 — leitura de conferência do volume na consolidação em staging DISPATCH. */
  async scanForStaging(packageId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const pkgResult = await this.db.query(ctx, `SELECT * FROM wms.package WHERE id = $1`, [packageId]);
    const pkg = pkgResult.rows[0];
    if (!pkg) throw new NotFoundException(`package ${packageId} not found`);
    if (pkg.status !== 'WEIGHED') {
      throw new ConflictException({ error: 'PACKAGE_NOT_WEIGHED', detail: `RF-EXP-060: volume ${packageId} não está WEIGHED (status atual: ${pkg.status})` });
    }

    const result = await this.db.query(
      ctx,
      `UPDATE wms.package SET staged_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [packageId, actorUserId]
    );
    return result.rows[0];
  }

  /**
   * RF-EXP-060 — gatilho fiscal. `fiscal_mode = INTEGRADO_ERP`: confirmação
   * MANUAL registrada conclui (integração real é DOC-13, fora de escopo).
   * `EMISSAO_PROPRIA`/`HIBRIDO`: desde a Sessão 8B, esta chamada SÓ monta
   * (`assemble()`) a Nota de Devolução de Armazenagem — deixa
   * `fiscal_documents_authorized_at` NULL e retorna. A autorização real
   * (assinatura + transmissão SEFAZ/simulador) é assíncrona, feita por
   * `FiscalEmissionWorkerImpl`/`FiscalEmissionService` (perfil `worker`),
   * que grava `fiscal_documents_authorized_at` diretamente ao chegar em
   * AUTHORIZED. `attemptCompleteDispatchStep()` (abaixo) já é um gate
   * desacoplado que só checa essa coluna — não importa quando/quem a
   * preenche, então nenhuma mudança foi necessária nele.
   */
  async confirmFiscalDocuments(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const fiscalMode = await this.resolveFiscalMode(ctx, warehouseId);

    const existing = await this.db.query(ctx, `SELECT * FROM wms.outbound_order WHERE id = $1`, [orderId]);
    const order = existing.rows[0];
    if (!order) throw new NotFoundException(`outbound_order ${orderId} not found`);
    if (order.fiscal_documents_authorized_at) {
      return order;
    }

    if (fiscalMode === 'INTEGRADO_ERP') {
      const result = await this.db.query(
        ctx,
        `UPDATE wms.outbound_order SET fiscal_documents_authorized_at = now(), fiscal_rejection_detail = NULL, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [orderId, actorUserId]
      );
      return result.rows[0];
    }

    // EMISSAO_PROPRIA/HIBRIDO — idempotência estendida (8B): o pedido já
    // pode ter um fiscal_document em andamento de uma chamada anterior.
    if (order.fiscal_document_id) {
      const docResult = await this.db.query(ctx, `SELECT status FROM wms.fiscal_document WHERE id = $1`, [order.fiscal_document_id]);
      const status = docResult.rows[0]?.status;
      if (status === 'DRAFT' || status === 'SIGNED' || status === 'TRANSMITTED') {
        // Ainda em processamento pelo worker — não monta um segundo documento.
        return order;
      }
      if (status === 'REJECTED') {
        // §5.1 DOC-08: "REJECTED->DRAFT: correção e reenvio, MESMO número".
        // Volta o MESMO documento para DRAFT (mantém nfe_number já reservado)
        // — o worker o pega de novo no próximo poll.
        const retried = await this.db.query(
          ctx,
          `UPDATE wms.fiscal_document SET status = 'DRAFT', rejection_detail = NULL, cstat = NULL, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
          [order.fiscal_document_id, actorUserId]
        );
        const cleared = await this.db.query(
          ctx,
          `UPDATE wms.outbound_order SET fiscal_rejection_detail = NULL, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
          [orderId, actorUserId]
        );
        void retried;
        return cleared.rows[0];
      }
      if (status === 'DENIED') {
        // §5.1 DOC-08: "número consumido, pedido bloqueado p/ tratamento" —
        // sem workflow de recuperação definido pela especificação
        // ([LACUNA: DOC-08]). Bloqueia explicitamente em vez de inventar um
        // fluxo de correção não especificado.
        throw new ConflictException({
          error: 'FISCAL_NFE_DENIED_BLOCKED',
          detail: `RNF-FIS-060/§5.1: nota do pedido ${orderId} foi DENEGADA pela SEFAZ — pedido bloqueado, requer tratamento manual ([LACUNA: DOC-08] sem fluxo de recuperação definido)`,
        });
      }
      // status === 'AUTHORIZED' mas fiscal_documents_authorized_at está NULL
      // (ex.: revertido por outbound-reversal.service.ts::undoExpedicao) —
      // o documento já está genuinamente autorizado, então re-estampa em vez
      // de bloquear ou remontar (evitaria emissão dupla).
      const restamped = await this.db.query(
        ctx,
        `UPDATE wms.outbound_order SET fiscal_documents_authorized_at = now(), fiscal_rejection_detail = NULL, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [orderId, actorUserId]
      );
      return restamped.rows[0];
    }

    try {
      const fiscalDocument = await this.storageReturnInvoiceService.assemble({
        tenantId,
        warehouseId,
        outboundOrderId: orderId,
        items: await this.loadReservedItems(ctx, orderId),
        actorUserId,
      });
      const result = await this.db.query(ctx, `UPDATE wms.outbound_order SET fiscal_document_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`, [
        orderId,
        fiscalDocument.id,
        actorUserId,
      ]);
      return result.rows[0];
    } catch (error) {
      const detail = error instanceof BadRequestException ? String((error.getResponse() as any)?.detail ?? error.message) : (error as Error).message;
      await this.db.query(ctx, `UPDATE wms.outbound_order SET fiscal_rejection_detail = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [
        orderId,
        detail,
        actorUserId,
      ]);
      throw error;
    }
  }

  private async loadReservedItems(ctx: TenantContext, orderId: string): Promise<{ productId: string; qty: number }[]> {
    const itemsResult = await this.db.query<{ product_id: string; qty_reserved: string }>(
      ctx,
      `SELECT product_id, qty_reserved FROM wms.outbound_order_item WHERE outbound_order_id = $1 AND qty_reserved > 0 AND moved_to_order_id IS NULL`,
      [orderId]
    );
    if (itemsResult.rows.length === 0) {
      throw new BadRequestException({ error: 'NO_RESERVED_ITEMS', detail: `RN-FIS-040: pedido ${orderId} não tem itens reservados para gerar Nota de Devolução` });
    }
    return itemsResult.rows.map((r) => ({ productId: r.product_id, qty: Number(r.qty_reserved) }));
  }

  /** RF-EXP-060 — conclui a etapa Expedição: staging completo + documentos autorizados. */
  async attemptCompleteDispatchStep(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };

    const orderResult = await this.db.query(ctx, `SELECT * FROM wms.outbound_order WHERE id = $1`, [orderId]);
    const order = orderResult.rows[0];
    if (!order) throw new NotFoundException(`outbound_order ${orderId} not found`);
    if (!order.fiscal_documents_authorized_at) {
      return { completed: false, reason: 'FISCAL_DOCUMENTS_NOT_AUTHORIZED', rejectionDetail: order.fiscal_rejection_detail };
    }

    const stagingResult = await this.db.query(
      ctx,
      `SELECT COUNT(*) FILTER (WHERE staged_at IS NULL) AS pending FROM wms.package WHERE outbound_order_id = $1 AND status != 'CANCELLED'`,
      [orderId]
    );
    if (Number(stagingResult.rows[0].pending) > 0) {
      return { completed: false, reason: 'STAGING_PENDING' };
    }

    const result = await this.db.transaction(ctx, async (client) => {
      if (!(await isFirstPendingStep(client, orderId, 'EXPEDICAO'))) return { alreadyCompleted: true };

      const completed = await this.outboundFlowService.completeOrderStep(client, { tenantId, warehouseId, orderId, step: 'EXPEDICAO' }, actorUserId);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'expedicao.documentos_autorizados',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { outbound_order_id: orderId },
      });

      return { step: completed.step, order: completed.order };
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'outbound_order',
      entityId: orderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-06 RF-EXP-060',
      after: result,
    });

    return { completed: true, ...result };
  }

  /** [LACUNA: nem DOC-06 nem DOC-02 definem a flag — mesma inferência de outbound-order.service.ts (6A). */
  private async resolveFiscalMode(ctx: TenantContext, warehouseId: string): Promise<string | null> {
    const result = await this.db.query<{ fiscal_mode: string }>(
      ctx,
      `SELECT fiscal_mode FROM wms.client_warehouse_settings WHERE tenant_id = $1 AND warehouse_id = $2`,
      [ctx.tenant_id, warehouseId]
    );
    return result.rows[0]?.fiscal_mode ?? null;
  }
}
