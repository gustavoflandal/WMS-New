// DOC-05 §4.4 RF-EST-030 — Bloqueio/desbloqueio manual de saldo. Usuário com
// EST.BLOQUEAR_SALDO move available -> blocked (e inverso com
// EST.DESBLOQUEAR_SALDO), sempre com motivo tipificado (RD-EST-004,
// wms.stock_block_reason). Efeito de saldo delegado ao ÚNICO caminho
// permitido (RN-EST-001): StockMovementService.applyStandalone().
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { StockMovementService, StockMovementRecord } from '../movement/stock-movement.service.js';

export interface BlockStockInput {
  tenantId: string;
  warehouseId: string;
  productId: string;
  batchId?: string | null;
  locationId?: string | null;
  palletId?: string | null;
  qty: number;
  reasonCode: string;
  reasonText?: string | null;
  actorUserId: string;
}

@Injectable()
export class StockBlockService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste (mesmo padrão do resto do módulo).
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  async block(input: BlockStockInput): Promise<StockMovementRecord> {
    return this.apply('BLOQUEIO', input);
  }

  async unblock(input: BlockStockInput): Promise<StockMovementRecord> {
    return this.apply('DESBLOQUEIO', input);
  }

  private async apply(movementType: 'BLOQUEIO' | 'DESBLOQUEIO', input: BlockStockInput): Promise<StockMovementRecord> {
    await this.validateReason(input.reasonCode, input.reasonText);

    const record = await this.stockMovementService.applyStandalone(
      { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId },
      {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        movementType,
        productId: input.productId,
        batchId: input.batchId ?? null,
        qty: input.qty,
        locationIdFrom: input.locationId ?? null,
        palletIdFrom: input.palletId ?? null,
        locationIdTo: input.locationId ?? null,
        palletIdTo: input.palletId ?? null,
        blockReasonCode: input.reasonCode,
        blockReasonText: input.reasonText ?? null,
        actorUserId: input.actorUserId,
      }
    );

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'stock_balance',
      entityId: input.productId,
      action: movementType === 'BLOQUEIO' ? 'STATUS_CHANGE' : 'STATUS_CHANGE',
      requirementId: 'DOC-05 RF-EST-030',
      reason: input.reasonText ?? input.reasonCode,
      after: { movementType, ...record },
    });

    return record;
  }

  /** RD-EST-004: motivo precisa existir no catálogo; OUTRO exige texto livre. */
  private async validateReason(reasonCode: string, reasonText: string | null | undefined): Promise<void> {
    const result = await this.db.queryGlobal<{ requires_text: boolean }>('SELECT requires_text FROM wms.stock_block_reason WHERE code = $1', [reasonCode]);
    const reason = result.rows[0];
    if (!reason) {
      throw new BadRequestException({ error: 'UNKNOWN_BLOCK_REASON', detail: `RD-EST-004: motivo '${reasonCode}' não existe no catálogo wms.stock_block_reason` });
    }
    if (reason.requires_text && !reasonText) {
      throw new BadRequestException({ error: 'BLOCK_REASON_TEXT_REQUIRED', detail: `RF-EST-030: motivo '${reasonCode}' exige texto livre (reasonText)` });
    }
  }
}
