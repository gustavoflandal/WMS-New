// DOC-02 §5.3 — product (DE TENANT). sku imutável (RF-DAD-050, também
// protegido por trigger no banco). species_code é atualizável no app —
// bloqueio de troca com saldo > 0 é responsabilidade do trigger
// wms.prevent_species_change_with_balance (migration 0014, RN-DAD-020).
import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateProductInput {
  tenant_id: string;
  sku: string;
  description: string;
  species_code: string;
  commercial_category_id?: string;
  base_uom: string;
  is_weight_variable?: boolean;
  net_weight_kg?: number;
  gross_weight_kg?: number;
  length_m?: number;
  width_m?: number;
  height_m?: number;
  giro_policy?: string;
  min_shelf_life_pct?: number;
  shelf_life_days?: number;
  ncm?: string;
  actor_user_id: string; // [LACUNA: RBAC DOC-12]
}

export interface UpdateProductInput {
  description?: string;
  species_code?: string;
  commercial_category_id?: string;
  base_uom?: string;
  is_weight_variable?: boolean;
  net_weight_kg?: number;
  gross_weight_kg?: number;
  length_m?: number;
  width_m?: number;
  height_m?: number;
  giro_policy?: string;
  min_shelf_life_pct?: number;
  shelf_life_days?: number;
  ncm?: string;
  actor_user_id: string;
}

@Injectable()
export class ProductService {
  constructor(private readonly db: DatabaseService) {}

  private context(tenantId: string, actorUserId: string) {
    return { tenant_id: tenantId, user_id: actorUserId };
  }

  async create(input: CreateProductInput) {
    try {
      const result = await this.db.query(
        this.context(input.tenant_id, input.actor_user_id),
        `INSERT INTO wms.product (
          tenant_id, sku, description, species_code, commercial_category_id, base_uom,
          is_weight_variable, net_weight_kg, gross_weight_kg, length_m, width_m, height_m,
          giro_policy, min_shelf_life_pct, shelf_life_days, ncm, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING *`,
        [
          input.tenant_id,
          input.sku,
          input.description,
          input.species_code,
          input.commercial_category_id ?? null,
          input.base_uom,
          input.is_weight_variable ?? false,
          input.net_weight_kg ?? null,
          input.gross_weight_kg ?? null,
          input.length_m ?? null,
          input.width_m ?? null,
          input.height_m ?? null,
          input.giro_policy ?? null,
          input.min_shelf_life_pct ?? null,
          input.shelf_life_days ?? null,
          input.ncm ?? null,
          input.actor_user_id,
        ]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  async findById(id: string, tenantId: string, actorUserId: string) {
    const result = await this.db.query(this.context(tenantId, actorUserId), 'SELECT * FROM wms.product WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`product ${id} not found`);
    return result.rows[0];
  }

  async findBySku(tenantId: string, actorUserId: string, sku: string) {
    const result = await this.db.query(this.context(tenantId, actorUserId), 'SELECT * FROM wms.product WHERE sku = $1', [sku]);
    if (result.rows.length === 0) throw new NotFoundException(`product with sku ${sku} not found`);
    return result.rows[0];
  }

  async listByTenant(tenantId: string, actorUserId: string) {
    const result = await this.db.query(this.context(tenantId, actorUserId), 'SELECT * FROM wms.product WHERE tenant_id = $1 ORDER BY sku', [
      tenantId,
    ]);
    return result.rows;
  }

  async update(id: string, tenantId: string, input: UpdateProductInput) {
    await this.findById(id, tenantId, input.actor_user_id);
    try {
      const result = await this.db.query(
        this.context(tenantId, input.actor_user_id),
        `UPDATE wms.product SET
          description = COALESCE($3, description),
          species_code = COALESCE($4, species_code),
          commercial_category_id = COALESCE($5, commercial_category_id),
          base_uom = COALESCE($6, base_uom),
          is_weight_variable = COALESCE($7, is_weight_variable),
          net_weight_kg = COALESCE($8, net_weight_kg),
          gross_weight_kg = COALESCE($9, gross_weight_kg),
          length_m = COALESCE($10, length_m),
          width_m = COALESCE($11, width_m),
          height_m = COALESCE($12, height_m),
          giro_policy = COALESCE($13, giro_policy),
          min_shelf_life_pct = COALESCE($14, min_shelf_life_pct),
          shelf_life_days = COALESCE($15, shelf_life_days),
          ncm = COALESCE($16, ncm),
          updated_at = now(), updated_by = $17
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [
          id,
          tenantId,
          input.description ?? null,
          input.species_code ?? null,
          input.commercial_category_id ?? null,
          input.base_uom ?? null,
          input.is_weight_variable ?? null,
          input.net_weight_kg ?? null,
          input.gross_weight_kg ?? null,
          input.length_m ?? null,
          input.width_m ?? null,
          input.height_m ?? null,
          input.giro_policy ?? null,
          input.min_shelf_life_pct ?? null,
          input.shelf_life_days ?? null,
          input.ncm ?? null,
          input.actor_user_id,
        ]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  /**
   * RF-DAD-051: product está na lista de entidades com validação de
   * desativação segura. Vínculo verificado nesta sessão: stock_balance com
   * qualquer parcela > 0. [DEBITO: validar documentos abertos quando essas
   * tabelas existirem, Sessão 3+].
   */
  async deactivate(id: string, tenantId: string, actorUserId: string) {
    await this.findById(id, tenantId, actorUserId);

    const context = this.context(tenantId, actorUserId);
    const pending = await this.db.query(
      context,
      `SELECT id FROM wms.stock_balance
       WHERE product_id = $1
         AND (qty_available + qty_reserved + qty_blocked + qty_quarantine + qty_damaged + qty_in_transit) > 0`,
      [id]
    );
    if (pending.rows.length > 0) {
      throw new ConflictException({
        error: 'PRODUCT_HAS_STOCK_BALANCE',
        detail: 'RF-DAD-051: cannot deactivate product with non-zero stock balance',
      });
    }

    const result = await this.db.query(
      context,
      `UPDATE wms.product SET status = 'DISCONTINUED', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [id, actorUserId]
    );
    return result.rows[0];
  }
}
