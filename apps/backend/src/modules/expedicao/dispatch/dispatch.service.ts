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
   * `EMISSAO_PROPRIA`/`HIBRIDO` (Sessão 8A, DOC-08 RN-FIS-040): monta E
   * "autoriza" (método explícito desta sessão, substituto testável do
   * retorno real da SEFAZ — Sessão 8B troca por AUTHORIZED de verdade) a
   * Nota de Devolução de Armazenagem via StorageReturnInvoiceService —
   * NUNCA conclui sem documento (RG-014).
   */
  async confirmFiscalDocuments(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const fiscalMode = await this.resolveFiscalMode(ctx, warehouseId);

    // Idempotência: uma chamada repetida sobre um pedido já confirmado não
    // deve tentar montar uma NOVA Nota de Devolução (a 1ª já consumiu o
    // Estoque Fiscal) — devolve o pedido como está.
    const existing = await this.db.query(ctx, `SELECT * FROM wms.outbound_order WHERE id = $1`, [orderId]);
    if (!existing.rows[0]) throw new NotFoundException(`outbound_order ${orderId} not found`);
    if (existing.rows[0].fiscal_documents_authorized_at) {
      return existing.rows[0];
    }

    if (fiscalMode === 'INTEGRADO_ERP') {
      const result = await this.db.query(
        ctx,
        `UPDATE wms.outbound_order SET fiscal_documents_authorized_at = now(), fiscal_rejection_detail = NULL, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [orderId, actorUserId]
      );
      return result.rows[0];
    }

    try {
      const fiscalDocument = await this.storageReturnInvoiceService.assembleAndAuthorizeForOrder(orderId, tenantId, warehouseId, actorUserId);
      const result = await this.db.query(
        ctx,
        `UPDATE wms.outbound_order SET fiscal_document_id = $2, fiscal_documents_authorized_at = now(), fiscal_rejection_detail = NULL, updated_at = now(), updated_by = $3
         WHERE id = $1 RETURNING *`,
        [orderId, fiscalDocument.id, actorUserId]
      );
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
