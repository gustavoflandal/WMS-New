// DOC-08 §4.1 RN-FIS-001 [INVIOLÁVEL] — Comportamento por modo fiscal.
// `client_warehouse_settings.fiscal_mode` já existe e é livremente editável
// via ClientWarehouseSettingsService (DOC-02, CRUD genérico) — este service
// ADICIONA a trava de imutabilidade que RN-FIS-001 exige ("o modo é
// imutável com documentos fiscais em aberto — troca exige zerar
// pendências"), sem duplicar o CRUD.
//
// "Documentos fiscais em aberto" (RN-FIS-001), nesta implementação: (a)
// wms.fiscal_document em estado não-terminal do ciclo desta sessão (DRAFT/
// SIGNED/TRANSMITTED — ainda sendo montado/assinado/transmitido); (b)
// wms.fiscal_pending_document com status PENDING (RN-FIS-070: baixa fiscal
// do cliente ainda não registrada); (c) crédito de Estoque Fiscal ainda
// disponível em wms.fiscal_stock_balance (qty_credited - qty_consumed -
// qty_pending_writeoff > 0) — "zerar pendências" inclui não deixar lastro
// fiscal órfão ao mudar quem passa a controlá-lo.
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';

export const FISCAL_MODES = ['EMISSAO_PROPRIA', 'INTEGRADO_ERP', 'HIBRIDO'] as const;
export type FiscalMode = (typeof FISCAL_MODES)[number];

export function isFiscalMode(value: string): value is FiscalMode {
  return (FISCAL_MODES as readonly string[]).includes(value);
}

@Injectable()
export class FiscalModeService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  async getFiscalMode(tenantId: string, warehouseId: string, actorUserId: string): Promise<FiscalMode | null> {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const result = await this.db.query<{ fiscal_mode: FiscalMode }>(
      ctx,
      `SELECT fiscal_mode FROM wms.client_warehouse_settings WHERE tenant_id = $1 AND warehouse_id = $2`,
      [tenantId, warehouseId]
    );
    return result.rows[0]?.fiscal_mode ?? null;
  }

  /** RN-FIS-001 — troca de modo, com a trava de imutabilidade. */
  async changeFiscalMode(tenantId: string, warehouseId: string, newMode: string, actorUserId: string) {
    if (!isFiscalMode(newMode)) {
      throw new BadRequestException({ error: 'INVALID_FISCAL_MODE', detail: `RN-FIS-001: fiscal_mode inválido: ${newMode}` });
    }
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };

    const settingsResult = await this.db.query(ctx, `SELECT * FROM wms.client_warehouse_settings WHERE tenant_id = $1 AND warehouse_id = $2`, [
      tenantId,
      warehouseId,
    ]);
    const settings = settingsResult.rows[0];
    if (!settings) throw new NotFoundException(`client_warehouse_settings não encontrado para tenant ${tenantId} / warehouse ${warehouseId}`);

    if (settings.fiscal_mode === newMode) {
      return settings; // sem mudança — sem necessidade de checar pendências
    }

    const openDocuments = await this.db.query<{ n: string }>(
      ctx,
      `SELECT COUNT(*) AS n FROM wms.fiscal_document WHERE tenant_id = $1 AND warehouse_id = $2 AND status IN ('DRAFT', 'SIGNED', 'TRANSMITTED')`,
      [tenantId, warehouseId]
    );
    const openPendingDocs = await this.db.query<{ n: string }>(
      ctx,
      `SELECT COUNT(*) AS n FROM wms.fiscal_pending_document WHERE tenant_id = $1 AND warehouse_id = $2 AND status = 'PENDING'`,
      [tenantId, warehouseId]
    );
    const remainingCredit = await this.db.query<{ n: string }>(
      ctx,
      `SELECT COUNT(*) AS n FROM wms.fiscal_stock_balance
       WHERE tenant_id = $1 AND warehouse_id = $2 AND (qty_credited - qty_consumed - qty_pending_writeoff) > 0`,
      [tenantId, warehouseId]
    );

    const blockers = Number(openDocuments.rows[0].n) + Number(openPendingDocs.rows[0].n) + Number(remainingCredit.rows[0].n);
    if (blockers > 0) {
      throw new ConflictException({
        error: 'FISCAL_MODE_IMMUTABLE_WITH_OPEN_DOCUMENTS',
        detail:
          `RN-FIS-001: o modo fiscal é imutável com documentos fiscais em aberto — troca exige zerar pendências ` +
          `(documentos em aberto: ${openDocuments.rows[0].n}; pendências documentais: ${openPendingDocs.rows[0].n}; ` +
          `crédito fiscal remanescente em ${remainingCredit.rows[0].n} nota(s))`,
      });
    }

    const result = await this.db.query(
      ctx,
      `UPDATE wms.client_warehouse_settings SET fiscal_mode = $3, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND warehouse_id = $2 RETURNING *`,
      [tenantId, warehouseId, newMode, actorUserId]
    );
    const after = result.rows[0];

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'client_warehouse_settings',
      entityId: settings.id,
      action: 'UPDATE',
      requirementId: 'DOC-08 RN-FIS-001',
      before: settings,
      after,
    });

    return after;
  }
}
