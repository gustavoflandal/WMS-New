// DOC-02 §5.2 — storage_equipment (GLOBAL — RN-DAD-004)
// access_policy é coluna GERADA no banco (derivada de equipment_type, RN-DAD-010)
// — não é aceita como input em create/update.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateStorageEquipmentInput {
  warehouse_id: string;
  code: string;
  equipment_type: string;
}

@Injectable()
export class StorageEquipmentService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável, e a resolução de DI do Nest
  // baseada só no tipo TS falha silenciosamente sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  async create(input: CreateStorageEquipmentInput, actorUserId: string) {
    try {
      const result = await this.db.queryGlobal(
        `INSERT INTO wms.storage_equipment (warehouse_id, code, equipment_type, created_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [input.warehouse_id, input.code, input.equipment_type, actorUserId]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  async findById(id: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.storage_equipment WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`storage_equipment ${id} not found`);
    return result.rows[0];
  }

  async listByWarehouse(warehouseId: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.storage_equipment WHERE warehouse_id = $1 ORDER BY code', [warehouseId]);
    return result.rows;
  }

  /** storage_equipment não está na lista de RF-DAD-051 — transição de status simples. */
  async setStatus(id: string, status: 'ACTIVE' | 'MAINTENANCE' | 'INACTIVE', actorUserId: string) {
    const before = await this.findById(id);
    try {
      const result = await this.db.queryGlobal(
        `UPDATE wms.storage_equipment SET status = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
        [id, status, actorUserId]
      );
      const after = result.rows[0];
      await this.auditService.record({
        tenantId: null,
        warehouseId: after.warehouse_id,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'storage_equipment',
        entityId: id,
        action: 'STATUS_CHANGE',
        requirementId: 'DOC-02 §5.2',
        before,
        after,
      });
      return after;
    } catch (error) {
      mapCadastroDbError(error);
    }
  }
}
