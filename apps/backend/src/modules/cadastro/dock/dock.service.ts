// DOC-02 §5.2 — dock (GLOBAL — RN-DAD-004)
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateDockInput {
  warehouse_id: string;
  code: string;
  dock_type: string;
  allowed_vehicle_types?: string[];
  has_leveler: boolean;
}

@Injectable()
export class DockService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async create(input: CreateDockInput, actorUserId: string) {
    try {
      const result = await this.db.queryGlobal(
        `INSERT INTO wms.dock (warehouse_id, code, dock_type, allowed_vehicle_types, has_leveler, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [input.warehouse_id, input.code, input.dock_type, input.allowed_vehicle_types ?? null, input.has_leveler, actorUserId]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  async findById(id: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.dock WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`dock ${id} not found`);
    return result.rows[0];
  }

  async listByWarehouse(warehouseId: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.dock WHERE warehouse_id = $1 ORDER BY code', [warehouseId]);
    return result.rows;
  }
}
