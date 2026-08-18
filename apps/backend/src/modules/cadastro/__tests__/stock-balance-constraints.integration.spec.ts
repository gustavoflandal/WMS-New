// Scenario ENTREGÁVEL 8 — RG-004 [INVIOLÁVEL]: stock_balance com qualquer
// parcela negativa é rejeitado pelo CHECK do banco. RG-014: fiscal_stock_balance
// com qty_consumed > qty_credited é rejeitado pelo CHECK do banco.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { ClientService } from '../client/client.service.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { ZoneService } from '../zone/zone.service.js';
import { LocationService } from '../location/location.service.js';
import { ProductService } from '../product/product.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID, rawAuthorizedQuery } from './test-helpers.js';

describe('Cadastro - RG-004/RG-014 CHECKs de saldo', () => {
  let testContext: TestContext;
  let clientId: string;
  let warehouseId: string;
  let locationId: string;
  let productId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    const clientService = new ClientService(testContext.databaseService, auditService);
    const warehouseService = new WarehouseService(testContext.databaseService, auditService);
    const zoneService = new ZoneService(testContext.databaseService, auditService);
    const locationService = new LocationService(testContext.databaseService, auditService);
    const productService = new ProductService(testContext.databaseService, auditService);

    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente CHECKs saldo', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );
    clientId = client.id;

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém CHECKs saldo', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;

    const zone = await zoneService.create(
      { warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' },
      SEED_ACTOR_ID
    );

    const location = await locationService.create(
      {
        warehouse_id: warehouseId,
        zone_id: zone.id,
        aisle: 'E1',
        module: '001',
        level: '00',
        slot: '01',
        location_type: 'STORAGE',
        max_weight_kg: 1000,
        max_volume_m3: 1.5,
        max_pallets: 1,
        max_height_m: 5,
      },
      SEED_ACTOR_ID
    );
    locationId = location.id;

    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto CHECKs saldo', species_code: 'GERAL', base_uom: 'UN' },
      SEED_ACTOR_ID
    );
    productId = product.id;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('RG-004: qty_available negativo e rejeitado pelo CHECK', async () => {
    await expect(
      rawAuthorizedQuery(
        testContext.databaseService,
        { tenant_id: clientId, user_id: SEED_ACTOR_ID },
        `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [clientId, warehouseId, productId, locationId, -1, SEED_ACTOR_ID]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('RG-004: qty_blocked negativo (qualquer parcela) e rejeitado pelo CHECK', async () => {
    await expect(
      rawAuthorizedQuery(
        testContext.databaseService,
        { tenant_id: clientId, user_id: SEED_ACTOR_ID },
        `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_blocked, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [clientId, warehouseId, productId, locationId, -5, SEED_ACTOR_ID]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('RG-014: fiscal_stock_balance com qty_consumed > qty_credited e rejeitado pelo CHECK', async () => {
    await expect(
      testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID },
        `INSERT INTO wms.fiscal_stock_balance (tenant_id, warehouse_id, product_id, storage_remittance_invoice_id, qty_credited, qty_consumed, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [clientId, warehouseId, productId, '00000000-0000-0000-0000-000000000099', 100, 101, SEED_ACTOR_ID]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('RG-014: fiscal_stock_balance com qty_consumed <= qty_credited e aceito', async () => {
    const result = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `INSERT INTO wms.fiscal_stock_balance (tenant_id, warehouse_id, product_id, storage_remittance_invoice_id, qty_credited, qty_consumed, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [clientId, warehouseId, productId, '00000000-0000-0000-0000-000000000098', 100, 60, SEED_ACTOR_ID]
    );
    expect(Number(result.rows[0].qty_credited) - Number(result.rows[0].qty_consumed)).toBe(40);
  });
});
