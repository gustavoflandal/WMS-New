// DOC-02 §5.1 — client_warehouse_settings (DE TENANT — RN-DAD-004). Não está
// na lista RF-DAD-051, então update/desativação não exigem checagem de
// vínculo — status é apenas mais um campo editável.
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateClientWarehouseSettingsInput {
  tenant_id: string;
  warehouse_id: string;
  fiscal_mode: string;
  inbound_invoice_deadline_days?: number;
  logical_warehouse_enabled?: boolean;
  default_giro_policy: string;
  min_shelf_life_default_pct?: number;
  blind_checking?: boolean;
  actor_user_id: string; // [LACUNA: RBAC DOC-12]
}

export interface UpdateClientWarehouseSettingsInput {
  fiscal_mode?: string;
  inbound_invoice_deadline_days?: number;
  logical_warehouse_enabled?: boolean;
  default_giro_policy?: string;
  min_shelf_life_default_pct?: number;
  blind_checking?: boolean;
  status?: 'ACTIVE' | 'SUSPENDED';
  actor_user_id: string;
}

@Injectable()
export class ClientWarehouseSettingsService {
  constructor(private readonly db: DatabaseService) {}

  private context(tenantId: string, actorUserId: string): TenantContext {
    return { tenant_id: tenantId, user_id: actorUserId };
  }

  async create(input: CreateClientWarehouseSettingsInput) {
    try {
      const result = await this.db.query(
        this.context(input.tenant_id, input.actor_user_id),
        `INSERT INTO wms.client_warehouse_settings (
          tenant_id, warehouse_id, fiscal_mode, inbound_invoice_deadline_days,
          logical_warehouse_enabled, default_giro_policy, min_shelf_life_default_pct,
          blind_checking, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          input.tenant_id,
          input.warehouse_id,
          input.fiscal_mode,
          input.inbound_invoice_deadline_days ?? null,
          input.logical_warehouse_enabled ?? false,
          input.default_giro_policy,
          input.min_shelf_life_default_pct ?? null,
          input.blind_checking ?? true,
          input.actor_user_id,
        ]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  async findById(id: string, tenantId: string, actorUserId: string) {
    const result = await this.db.query(this.context(tenantId, actorUserId), 'SELECT * FROM wms.client_warehouse_settings WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`client_warehouse_settings ${id} not found`);
    return result.rows[0];
  }

  async listByTenant(tenantId: string, actorUserId: string) {
    const result = await this.db.query(
      this.context(tenantId, actorUserId),
      'SELECT * FROM wms.client_warehouse_settings WHERE tenant_id = $1 ORDER BY warehouse_id',
      [tenantId]
    );
    return result.rows;
  }

  async update(id: string, tenantId: string, input: UpdateClientWarehouseSettingsInput) {
    await this.findById(id, tenantId, input.actor_user_id);
    try {
      const result = await this.db.query(
        this.context(tenantId, input.actor_user_id),
        `UPDATE wms.client_warehouse_settings SET
          fiscal_mode = COALESCE($3, fiscal_mode),
          inbound_invoice_deadline_days = COALESCE($4, inbound_invoice_deadline_days),
          logical_warehouse_enabled = COALESCE($5, logical_warehouse_enabled),
          default_giro_policy = COALESCE($6, default_giro_policy),
          min_shelf_life_default_pct = COALESCE($7, min_shelf_life_default_pct),
          blind_checking = COALESCE($8, blind_checking),
          status = COALESCE($9, status),
          updated_at = now(), updated_by = $10
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [
          id,
          tenantId,
          input.fiscal_mode ?? null,
          input.inbound_invoice_deadline_days ?? null,
          input.logical_warehouse_enabled ?? null,
          input.default_giro_policy ?? null,
          input.min_shelf_life_default_pct ?? null,
          input.blind_checking ?? null,
          input.status ?? null,
          input.actor_user_id,
        ]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }
}
