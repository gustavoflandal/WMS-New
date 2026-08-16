// DOC-02 §5.2 — zone (GLOBAL — RN-DAD-004)
import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateZoneInput {
  warehouse_id: string;
  code: string;
  name: string;
  zone_type: string;
  allowed_species?: string[];
  temperature_min_c?: number;
  temperature_max_c?: number;
}

export interface UpdateZoneInput {
  name?: string;
  allowed_species?: string[];
  temperature_min_c?: number;
  temperature_max_c?: number;
}

@Injectable()
export class ZoneService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável, e a resolução de DI do Nest
  // baseada só no tipo TS falha silenciosamente sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  async create(input: CreateZoneInput, actorUserId: string) {
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
          actorUserId,
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

  async update(id: string, input: UpdateZoneInput, actorUserId: string) {
    const before = await this.findById(id);
    try {
      const result = await this.db.queryGlobal(
        `UPDATE wms.zone SET
          name = COALESCE($2, name),
          allowed_species = COALESCE($3, allowed_species),
          temperature_min_c = COALESCE($4, temperature_min_c),
          temperature_max_c = COALESCE($5, temperature_max_c),
          updated_at = now(), updated_by = $6
         WHERE id = $1 RETURNING *`,
        [id, input.name ?? null, input.allowed_species ?? null, input.temperature_min_c ?? null, input.temperature_max_c ?? null, actorUserId]
      );
      const after = result.rows[0];
      await this.auditService.record({
        tenantId: null,
        warehouseId: after.warehouse_id,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'zone',
        entityId: id,
        action: 'UPDATE',
        requirementId: 'DOC-02 §5.2',
        before,
        after,
      });
      return after;
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
    const before = await this.findById(id);

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
    const after = result.rows[0];
    await this.auditService.record({
      tenantId: null,
      warehouseId: after.warehouse_id,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'zone',
      entityId: id,
      action: 'STATUS_CHANGE',
      requirementId: 'RF-DAD-051',
      before,
      after,
    });
    return after;
  }
}
