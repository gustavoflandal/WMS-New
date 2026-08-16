// Scenario ENTREGÁVEL 8 — RN-DAD-021: conversão única pela qty_in_base_uom.
// Exemplo normativo do DOC-02 §7: produto base UN, embalagem CX12 (fator
// 12); 10 CX12 credita 120 UN. Sem motor de recebimento nesta sessão
// (DOC-04/05) — a conversão em si (fator persistido em
// product_packaging.qty_in_base_uom) é testada ponta a ponta creditando o
// resultado em stock_balance, a estrutura de saldo que ESTÁ no escopo desta
// sessão (DOC-02 §5.5).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { ClientService } from '../client/client.service.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { ZoneService } from '../zone/zone.service.js';
import { LocationService } from '../location/location.service.js';
import { ProductService } from '../product/product.service.js';
import { ProductPackagingService } from '../product-packaging/product-packaging.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from './test-helpers.js';

describe('Cadastro - RN-DAD-021 conversao de embalagem pela qty_in_base_uom', () => {
  let testContext: TestContext;
  let clientService: ClientService;
  let warehouseService: WarehouseService;
  let zoneService: ZoneService;
  let locationService: LocationService;
  let productService: ProductService;
  let packagingService: ProductPackagingService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    clientService = new ClientService(testContext.databaseService, auditService);
    warehouseService = new WarehouseService(testContext.databaseService, auditService);
    zoneService = new ZoneService(testContext.databaseService, auditService);
    locationService = new LocationService(testContext.databaseService, auditService);
    productService = new ProductService(testContext.databaseService, auditService);
    packagingService = new ProductPackagingService(testContext.databaseService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('10 CX12 (fator 12) credita 120 UN em stock_balance', async () => {
    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente conversao UOM', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );
    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém conversao UOM', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const zone = await zoneService.create(
      { warehouse_id: warehouse.id, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' },
      SEED_ACTOR_ID
    );
    const location = await locationService.create(
      {
        warehouse_id: warehouse.id,
        zone_id: zone.id,
        aisle: 'C1',
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
    const product = await productService.create(
      { tenant_id: client.id, sku: randomSku(), description: 'Produto base UN com embalagem CX12', species_code: 'GERAL', base_uom: 'UN' },
      SEED_ACTOR_ID
    );
    const packaging = await packagingService.create(
      {
        tenant_id: client.id,
        product_id: product.id,
        code: 'CX12',
        description: 'Caixa com 12 unidades',
        qty_in_base_uom: 12,
        is_default_receiving: true,
      },
      SEED_ACTOR_ID
    );

    const receivedPackages = 10;
    const convertedQtyBaseUom = receivedPackages * Number(packaging.qty_in_base_uom);
    expect(convertedQtyBaseUom).toBe(120);

    const result = await testContext.databaseService.query(
      { tenant_id: client.id, user_id: SEED_ACTOR_ID },
      `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING qty_available`,
      [client.id, warehouse.id, product.id, location.id, convertedQtyBaseUom, SEED_ACTOR_ID]
    );

    expect(Number(result.rows[0].qty_available)).toBe(120);
  });
});
