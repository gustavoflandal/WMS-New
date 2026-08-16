// DOC-02 §5.2 — yard_slot (GLOBAL — RN-DAD-004)
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateYardSlotInput {
  warehouse_id: string;
  code: string;
  slot_type: string;
  actor_user_id: string; // [LACUNA: RBAC DOC-12]
}

@Injectable()
export class YardSlotService {
  constructor(private readonly db: DatabaseService) {}

  async create(input: CreateYardSlotInput) {
    try {
      const result = await this.db.queryGlobal(
        `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [input.warehouse_id, input.code, input.slot_type, input.actor_user_id]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  async findById(id: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.yard_slot WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`yard_slot ${id} not found`);
    return result.rows[0];
  }

  async listByWarehouse(warehouseId: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.yard_slot WHERE warehouse_id = $1 ORDER BY code', [warehouseId]);
    return result.rows;
  }
}
