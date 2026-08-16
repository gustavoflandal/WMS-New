// DOC-02 §5.3 — product_packaging (DE TENANT). qty_in_base_uom > 0
// (RN-DAD-021 — base de toda conversão de unidades).
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateProductPackagingInput {
  tenant_id: string;
  product_id: string;
  code: string;
  description: string;
  qty_in_base_uom: number;
  is_default_receiving?: boolean;
  is_default_picking?: boolean;
  ballast?: number;
  layers?: number;
  actor_user_id: string; // [LACUNA: RBAC DOC-12]
}

@Injectable()
export class ProductPackagingService {
  constructor(private readonly db: DatabaseService) {}

  private context(tenantId: string, actorUserId: string) {
    return { tenant_id: tenantId, user_id: actorUserId };
  }

  async create(input: CreateProductPackagingInput) {
    try {
      const result = await this.db.query(
        this.context(input.tenant_id, input.actor_user_id),
        `INSERT INTO wms.product_packaging (
          tenant_id, product_id, code, description, qty_in_base_uom,
          is_default_receiving, is_default_picking, ballast, layers, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          input.tenant_id,
          input.product_id,
          input.code,
          input.description,
          input.qty_in_base_uom,
          input.is_default_receiving ?? false,
          input.is_default_picking ?? false,
          input.ballast ?? null,
          input.layers ?? null,
          input.actor_user_id,
        ]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  async findById(id: string, tenantId: string, actorUserId: string) {
    const result = await this.db.query(this.context(tenantId, actorUserId), 'SELECT * FROM wms.product_packaging WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`product_packaging ${id} not found`);
    return result.rows[0];
  }

  async listByProduct(tenantId: string, actorUserId: string, productId: string) {
    const result = await this.db.query(
      this.context(tenantId, actorUserId),
      'SELECT * FROM wms.product_packaging WHERE product_id = $1 ORDER BY code',
      [productId]
    );
    return result.rows;
  }
}
