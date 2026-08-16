// DOC-02 §5.4 — batch (DE TENANT). batch_code imutável (RF-DAD-050, também
// protegido por trigger no banco). expiration_date obrigatória quando a
// espécie do produto exige (RN-DAD-020, aplicado por trigger — migration 0012).
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateBatchInput {
  tenant_id: string;
  product_id: string;
  batch_code: string;
  manufacture_date?: string;
  expiration_date?: string;
}

export interface UpdateBatchInput {
  status?: 'RELEASED' | 'QUARANTINE' | 'BLOCKED' | 'RECALLED';
  manufacture_date?: string;
  expiration_date?: string;
}

@Injectable()
export class BatchService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável, e a resolução de DI do Nest
  // baseada só no tipo TS falha silenciosamente sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  private context(tenantId: string, actorUserId: string) {
    return { tenant_id: tenantId, user_id: actorUserId };
  }

  async create(input: CreateBatchInput, actorUserId: string) {
    try {
      const result = await this.db.query(
        this.context(input.tenant_id, actorUserId),
        `INSERT INTO wms.batch (tenant_id, product_id, batch_code, manufacture_date, expiration_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          input.tenant_id,
          input.product_id,
          input.batch_code,
          input.manufacture_date ?? null,
          input.expiration_date ?? null,
          actorUserId,
        ]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  async findById(id: string, tenantId: string, actorUserId: string) {
    const result = await this.db.query(this.context(tenantId, actorUserId), 'SELECT * FROM wms.batch WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`batch ${id} not found`);
    return result.rows[0];
  }

  async findByCode(tenantId: string, actorUserId: string, productId: string, batchCode: string) {
    const result = await this.db.query(
      this.context(tenantId, actorUserId),
      'SELECT * FROM wms.batch WHERE product_id = $1 AND batch_code = $2',
      [productId, batchCode]
    );
    if (result.rows.length === 0) throw new NotFoundException(`batch ${batchCode} not found for product ${productId}`);
    return result.rows[0];
  }

  async listByProduct(tenantId: string, actorUserId: string, productId: string) {
    const result = await this.db.query(
      this.context(tenantId, actorUserId),
      'SELECT * FROM wms.batch WHERE product_id = $1 ORDER BY batch_code',
      [productId]
    );
    return result.rows;
  }

  /** RF-DAD-052: BLOCKED/QUARANTINE/RECALLED — transição de status simples (sem regra de dependência própria em RF-DAD-051, batch não está na lista). */
  async update(id: string, tenantId: string, input: UpdateBatchInput, actorUserId: string) {
    const before = await this.findById(id, tenantId, actorUserId);
    try {
      const result = await this.db.query(
        this.context(tenantId, actorUserId),
        `UPDATE wms.batch SET
          status = COALESCE($3, status),
          manufacture_date = COALESCE($4, manufacture_date),
          expiration_date = COALESCE($5, expiration_date),
          updated_at = now(), updated_by = $6
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [id, tenantId, input.status ?? null, input.manufacture_date ?? null, input.expiration_date ?? null, actorUserId]
      );
      const after = result.rows[0];
      await this.auditService.record({
        tenantId,
        warehouseId: null,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'batch',
        entityId: id,
        action: 'UPDATE',
        requirementId: 'RF-DAD-052',
        before,
        after,
      });
      return after;
    } catch (error) {
      mapCadastroDbError(error);
    }
  }
}
