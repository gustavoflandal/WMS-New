// DOC-15 §4.5 T7 (Consulta) — busca de saldo por SKU/código de barras/LPN,
// somente leitura. Exige conexão (DOC-15: "NÃO offline"). DE TENANT
// (stock_balance tem RLS) — COL.CONSULTA_SALDO é CLIENT_WAREHOUSE, então o
// chamador sempre informa tenant_id+warehouse_id.
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';

export interface StockSearchRow {
  locationCode: string;
  zoneCode: string;
  productSku: string;
  productDescription: string;
  batchCode: string | null;
  expirationDate: string | null;
  qtyAvailable: number | null;
  locationStatus: string;
  frozenByInventory: boolean;
}

@Injectable()
export class StockSearchService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /**
   * RF-COL-062/DOC-05 RN-EST-061: endereço em INVENTORY nunca expõe
   * qty_available na consulta — mesma regra de congelamento do motor de
   * inventário (Sessão 5C), aplicada aqui do lado da leitura.
   */
  async search(code: string, tenantId: string, warehouseId: string, actorUserId: string): Promise<StockSearchRow[]> {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const result = await this.db.query(
      ctx,
      `SELECT l.code AS location_code, z.code AS zone_code, p.sku AS product_sku, p.description AS product_description,
              b.batch_code, b.expiration_date, sb.qty_available, l.status AS location_status
       FROM wms.stock_balance sb
       JOIN wms.product p ON p.id = sb.product_id
       JOIN wms.location l ON l.id = sb.location_id
       JOIN wms.zone z ON z.id = l.zone_id
       LEFT JOIN wms.batch b ON b.id = sb.batch_id
       LEFT JOIN wms.product_barcode pb ON pb.product_id = p.id
       WHERE sb.tenant_id = $1 AND sb.warehouse_id = $2
         AND (p.sku ILIKE $3 OR pb.barcode = $4)
         AND (sb.qty_available > 0 OR sb.qty_reserved > 0 OR sb.qty_blocked > 0 OR sb.qty_quarantine > 0)
       ORDER BY l.code`,
      [tenantId, warehouseId, `%${code}%`, code]
    );

    return result.rows.map((row) => {
      const frozen = row.location_status === 'INVENTORY';
      return {
        locationCode: row.location_code,
        zoneCode: row.zone_code,
        productSku: row.product_sku,
        productDescription: row.product_description,
        batchCode: row.batch_code,
        expirationDate: row.expiration_date,
        // RN-EST-061: endereço congelado nunca revela qty_available na consulta.
        qtyAvailable: frozen ? null : Number(row.qty_available),
        locationStatus: row.location_status,
        frozenByInventory: frozen,
      };
    });
  }
}
