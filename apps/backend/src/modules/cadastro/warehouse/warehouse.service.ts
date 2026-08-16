// DOC-02 §5.2 — warehouse (GLOBAL, sem tenant_id, sem RLS — RN-DAD-004)
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateWarehouseInput {
  code: string;
  name: string;
  cnpj: string;
  timezone: string;
  address_street?: string;
  address_number?: string;
  address_complement?: string;
  address_district?: string;
  address_city?: string;
  address_city_ibge_code?: string;
  address_state?: string;
  address_zip_code?: string;
}

export interface UpdateWarehouseInput {
  name?: string;
  cnpj?: string;
  timezone?: string;
  address_street?: string;
  address_number?: string;
  address_complement?: string;
  address_district?: string;
  address_city?: string;
  address_city_ibge_code?: string;
  address_state?: string;
  address_zip_code?: string;
}

@Injectable()
export class WarehouseService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável, e a resolução de DI do Nest
  // baseada só no tipo TS falha silenciosamente sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  async create(input: CreateWarehouseInput, actorUserId: string) {
    try {
      const result = await this.db.queryGlobal(
        `INSERT INTO wms.warehouse (
          code, name, cnpj, timezone, address_street, address_number,
          address_complement, address_district, address_city,
          address_city_ibge_code, address_state, address_zip_code, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING *`,
        [
          input.code,
          input.name,
          input.cnpj,
          input.timezone,
          input.address_street ?? null,
          input.address_number ?? null,
          input.address_complement ?? null,
          input.address_district ?? null,
          input.address_city ?? null,
          input.address_city_ibge_code ?? null,
          input.address_state ?? null,
          input.address_zip_code ?? null,
          actorUserId,
        ]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  async findById(id: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.warehouse WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      throw new NotFoundException(`warehouse ${id} not found`);
    }
    return result.rows[0];
  }

  async list() {
    const result = await this.db.queryGlobal('SELECT * FROM wms.warehouse ORDER BY code');
    return result.rows;
  }

  /** RF-DAD-050: code is intentionally NOT accepted here — immutable after creation (also enforced by DB trigger). */
  async update(id: string, input: UpdateWarehouseInput, actorUserId: string) {
    const before = await this.findById(id);
    try {
      const result = await this.db.queryGlobal(
        `UPDATE wms.warehouse SET
          name = COALESCE($2, name),
          cnpj = COALESCE($3, cnpj),
          timezone = COALESCE($4, timezone),
          address_street = COALESCE($5, address_street),
          address_number = COALESCE($6, address_number),
          address_complement = COALESCE($7, address_complement),
          address_district = COALESCE($8, address_district),
          address_city = COALESCE($9, address_city),
          address_city_ibge_code = COALESCE($10, address_city_ibge_code),
          address_state = COALESCE($11, address_state),
          address_zip_code = COALESCE($12, address_zip_code),
          updated_at = now(),
          updated_by = $13
        WHERE id = $1
        RETURNING *`,
        [
          id,
          input.name ?? null,
          input.cnpj ?? null,
          input.timezone ?? null,
          input.address_street ?? null,
          input.address_number ?? null,
          input.address_complement ?? null,
          input.address_district ?? null,
          input.address_city ?? null,
          input.address_city_ibge_code ?? null,
          input.address_state ?? null,
          input.address_zip_code ?? null,
          actorUserId,
        ]
      );
      const after = result.rows[0];
      await this.auditService.record({
        tenantId: null,
        warehouseId: after.id,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'warehouse',
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
   * RF-DAD-051 lists location/zone/logical_warehouse/product/client as needing
   * dependency validation on deactivation — warehouse itself is not in that
   * list. Deactivation here is a plain status transition.
   */
  async deactivate(id: string, actorUserId: string) {
    const before = await this.findById(id);
    const result = await this.db.queryGlobal(
      `UPDATE wms.warehouse SET status = 'INACTIVE', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [id, actorUserId]
    );
    const after = result.rows[0];
    await this.auditService.record({
      tenantId: null,
      warehouseId: after.id,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'warehouse',
      entityId: id,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-02 §5.2',
      before,
      after,
    });
    return after;
  }
}
