// DOC-02 §5.3 — product_barcode (DE TENANT). barcode UNIQUE global.
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateProductBarcodeInput {
  tenant_id: string;
  product_id: string;
  barcode: string;
  barcode_type: string;
  packaging_id?: string;
  actor_user_id: string; // [LACUNA: RBAC DOC-12]
}

@Injectable()
export class ProductBarcodeService {
  constructor(private readonly db: DatabaseService) {}

  private context(tenantId: string, actorUserId: string) {
    return { tenant_id: tenantId, user_id: actorUserId };
  }

  async create(input: CreateProductBarcodeInput) {
    try {
      const result = await this.db.query(
        this.context(input.tenant_id, input.actor_user_id),
        `INSERT INTO wms.product_barcode (tenant_id, product_id, barcode, barcode_type, packaging_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [input.tenant_id, input.product_id, input.barcode, input.barcode_type, input.packaging_id ?? null, input.actor_user_id]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  async findByBarcode(tenantId: string, actorUserId: string, barcode: string) {
    const result = await this.db.query(this.context(tenantId, actorUserId), 'SELECT * FROM wms.product_barcode WHERE barcode = $1', [
      barcode,
    ]);
    if (result.rows.length === 0) throw new NotFoundException(`product_barcode ${barcode} not found`);
    return result.rows[0];
  }

  async listByProduct(tenantId: string, actorUserId: string, productId: string) {
    const result = await this.db.query(
      this.context(tenantId, actorUserId),
      'SELECT * FROM wms.product_barcode WHERE product_id = $1 ORDER BY barcode',
      [productId]
    );
    return result.rows;
  }
}
