// DOC-02 §5.2 — zone (GLOBAL — RN-DAD-004)
import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateZoneInput {
  warehouse_id: string;
  code: string;
  name: string;
  zone_type: string;
  allowed_species?: string[];
  temperature_min_c?: number;
  temperature_max_c?: number;
  actor_user_id: string; // [LACUNA: RBAC DOC-12]
}

export interface UpdateZoneInput {
  name?: string;
  allowed_species?: string[];
  temperature_min_c?: number;
  temperature_max_c?: number;
  actor_user_id: string;
}

@Injectable()
export class ZoneService {
  constructor(private readonly db: DatabaseService) {}

  async create(input: CreateZoneInput) {
    try {
      const result = await this.db.queryGlobal(
        `INSERT INTO wms.zone (warehouse_id, code, name, zone_type, allowed_species, temperature_min_c, temperature_max_c, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          input.warehouse_id,
          input.code,
          input.name,
          input.zone_type,
          input.allowed_species ?? [],
          input.temperature_min_c ?? null,
          input.temperature_max_c ?? null,
          input.actor_user_id,
        ]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  async findById(id: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.zone WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`zone ${id} not found`);
    return result.rows[0];
  }

  async listByWarehouse(warehouseId: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.zone WHERE warehouse_id = $1 ORDER BY code', [warehouseId]);
    return result.rows;
  }

  async update(id: string, input: UpdateZoneInput) {
    await this.findById(id);
    try {
      const result = await this.db.queryGlobal(
        `UPDATE wms.zone SET
          name = COALESCE($2, name),
          allowed_species = COALESCE($3, allowed_species),
          temperature_min_c = COALESCE($4, temperature_min_c),
          temperature_max_c = COALESCE($5, temperature_max_c),
          updated_at = now(), updated_by = $6
         WHERE id = $1 RETURNING *`,
        [id, input.name ?? null, input.allowed_species ?? null, input.temperature_min_c ?? null, input.temperature_max_c ?? null, input.actor_user_id]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  /**
   * RF-DAD-051: valida vínculos entre as PRÓPRIAS tabelas (stock_balance e
   * documentos abertos ainda não existem — Sessão 2B+). Único vínculo
   * existente hoje: location.zone_id. Bloqueia se houver location ativo
   * apontando para esta zona.
   */
  async deactivate(id: string, actorUserId: string) {
    await this.findById(id);

    const pending = await this.db.queryGlobal(
      `SELECT code FROM wms.location WHERE zone_id = $1 AND status != 'INACTIVE'`,
      [id]
    );
    if (pending.rows.length > 0) {
      throw new ConflictException({
        error: 'ZONE_HAS_ACTIVE_LOCATIONS',
        detail: 'RF-DAD-051: cannot deactivate zone with active locations',
        pending_locations: pending.rows.map((r) => r.code),
      });
    }

    const result = await this.db.queryGlobal(
      `UPDATE wms.zone SET status = 'INACTIVE', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [id, actorUserId]
    );
    return result.rows[0];
  }
}
