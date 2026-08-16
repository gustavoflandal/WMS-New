// DOC-02 §5.2 — storage_equipment (GLOBAL — RN-DAD-004)
// access_policy é coluna GERADA no banco (derivada de equipment_type, RN-DAD-010)
// — não é aceita como input em create/update.
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateStorageEquipmentInput {
  warehouse_id: string;
  code: string;
  equipment_type: string;
  actor_user_id: string; // [LACUNA: RBAC DOC-12]
}

@Injectable()
export class StorageEquipmentService {
  constructor(private readonly db: DatabaseService) {}

  async create(input: CreateStorageEquipmentInput) {
    try {
      const result = await this.db.queryGlobal(
        `INSERT INTO wms.storage_equipment (warehouse_id, code, equipment_type, created_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [input.warehouse_id, input.code, input.equipment_type, input.actor_user_id]
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
    await this.findById(id);
    try {
      const result = await this.db.queryGlobal(
        `UPDATE wms.storage_equipment SET status = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
        [id, status, actorUserId]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }
}
