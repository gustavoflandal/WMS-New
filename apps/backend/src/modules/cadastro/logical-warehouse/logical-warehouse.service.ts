// DOC-02 §5.1 — logical_warehouse (DE TENANT — RG-015) + vínculos
// logical_warehouse_location. RF-DAD-051: logical_warehouse está na lista de
// entidades com validação de desativação segura — bloqueia se ainda houver
// endereços vinculados (RG-015 item 4).
import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateLogicalWarehouseInput {
  tenant_id: string;
  warehouse_id: string;
  code: string;
  name: string;
  actor_user_id: string; // [LACUNA: RBAC DOC-12]
}

export interface UpdateLogicalWarehouseInput {
  name?: string;
  actor_user_id: string;
}

@Injectable()
export class LogicalWarehouseService {
  constructor(private readonly db: DatabaseService) {}

  private context(tenantId: string, actorUserId: string): TenantContext {
    return { tenant_id: tenantId, user_id: actorUserId };
  }

  async create(input: CreateLogicalWarehouseInput) {
    try {
      const result = await this.db.query(
        this.context(input.tenant_id, input.actor_user_id),
        `INSERT INTO wms.logical_warehouse (tenant_id, warehouse_id, code, name, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [input.tenant_id, input.warehouse_id, input.code, input.name, input.actor_user_id]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  async findById(id: string, tenantId: string, actorUserId: string) {
    const result = await this.db.query(this.context(tenantId, actorUserId), 'SELECT * FROM wms.logical_warehouse WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`logical_warehouse ${id} not found`);
    return result.rows[0];
  }

  async listByTenant(tenantId: string, actorUserId: string) {
    const result = await this.db.query(
      this.context(tenantId, actorUserId),
      'SELECT * FROM wms.logical_warehouse WHERE tenant_id = $1 ORDER BY code',
      [tenantId]
    );
    return result.rows;
  }

  async update(id: string, tenantId: string, input: UpdateLogicalWarehouseInput) {
    await this.findById(id, tenantId, input.actor_user_id);
    try {
      const result = await this.db.query(
        this.context(tenantId, input.actor_user_id),
        `UPDATE wms.logical_warehouse SET name = COALESCE($3, name), updated_at = now(), updated_by = $4
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [id, tenantId, input.name ?? null, input.actor_user_id]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  /**
   * RF-DAD-051 + RG-015 item 4: bloqueia desativação enquanto houver
   * endereços vinculados. [DEBITO: transição via status DEACTIVATING +
   * validação de saldo zero quando stock_balance existir, Sessão 2B+] — por
   * ora a transição é direta ACTIVE -> INACTIVE, sem etapa intermediária.
   */
  async deactivate(id: string, tenantId: string, actorUserId: string) {
    await this.findById(id, tenantId, actorUserId);

    const context = this.context(tenantId, actorUserId);
    const linked = await this.db.query(
      context,
      `SELECT location_id FROM wms.logical_warehouse_location WHERE logical_warehouse_id = $1`,
      [id]
    );
    if (linked.rows.length > 0) {
      throw new ConflictException({
        error: 'LOGICAL_WAREHOUSE_HAS_LINKED_LOCATIONS',
        detail: 'RG-015 item 4: unlink all locations before deactivating',
        linked_location_count: linked.rows.length,
      });
    }

    const result = await this.db.query(
      context,
      `UPDATE wms.logical_warehouse SET status = 'INACTIVE', updated_at = now(), updated_by = $3
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, actorUserId]
    );
    return result.rows[0];
  }

  /** RG-015: um endereço pertence a no máximo 1 armazém lógico (UNIQUE(location_id) global). */
  async link(logicalWarehouseId: string, locationId: string, tenantId: string, actorUserId: string) {
    await this.findById(logicalWarehouseId, tenantId, actorUserId);
    try {
      const result = await this.db.query(
        this.context(tenantId, actorUserId),
        `INSERT INTO wms.logical_warehouse_location (tenant_id, logical_warehouse_id, location_id, linked_by, created_by)
         VALUES ($1,$2,$3,$4,$4) RETURNING *`,
        [tenantId, logicalWarehouseId, locationId, actorUserId]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  /**
   * [DEBITO: validar saldo zero no unlink de logical_warehouse_location,
   * Sessão 2B] — stock_balance não existe ainda nesta sessão, então o unlink
   * em si é livre por ora. DELETE físico permitido por RN-DAD-003 (vínculo
   * N:N de configuração).
   */
  async unlink(logicalWarehouseId: string, locationId: string, tenantId: string, actorUserId: string) {
    const result = await this.db.query(
      this.context(tenantId, actorUserId),
      `DELETE FROM wms.logical_warehouse_location
       WHERE logical_warehouse_id = $1 AND location_id = $2 AND tenant_id = $3
       RETURNING *`,
      [logicalWarehouseId, locationId, tenantId]
    );
    if (result.rows.length === 0) {
      throw new NotFoundException(`link between logical_warehouse ${logicalWarehouseId} and location ${locationId} not found`);
    }
    return result.rows[0];
  }
}
