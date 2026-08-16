// Scenario ENTREGÁVEL 8 / DOC-02 §7 Gherkin "Espécie exige lote e validade":
// produto MEDICAMENTO sem lote é rejeitado (trigger em stock_balance,
// RN-DAD-020); lote sem validade é rejeitado (trigger em batch, RN-DAD-020).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { ClientService } from '../client/client.service.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { ZoneService } from '../zone/zone.service.js';
import { LocationService } from '../location/location.service.js';
import { ProductService } from '../product/product.service.js';
import { BatchService } from '../batch/batch.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from './test-helpers.js';

describe('Cadastro - RN-DAD-020 especie exige lote e validade', () => {
  let testContext: TestContext;
  let clientService: ClientService;
  let warehouseService: WarehouseService;
  let zoneService: ZoneService;
  let locationService: LocationService;
  let productService: ProductService;
  let batchService: BatchService;

  let clientId: string;
  let warehouseId: string;
  let locationId: string;
  let medicamentoProductId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    clientService = new ClientService(testContext.databaseService, auditService);
    warehouseService = new WarehouseService(testContext.databaseService, auditService);
    zoneService = new ZoneService(testContext.databaseService, auditService);
    locationService = new LocationService(testContext.databaseService, auditService);
    productService = new ProductService(testContext.databaseService, auditService);
    batchService = new BatchService(testContext.databaseService, auditService);

    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente especie/lote', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );
    clientId = client.id;

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém especie/lote', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;

    const zone = await zoneService.create(
      { warehouse_id: warehouseId, code: 'QUA', name: 'Quarentena', zone_type: 'QUARANTINE' },
      SEED_ACTOR_ID
    );

    const location = await locationService.create(
      {
        warehouse_id: warehouseId,
        zone_id: zone.id,
        aisle: 'D1',
        module: '001',
        level: '00',
        slot: '01',
        location_type: 'QUARANTINE',
        max_weight_kg: 1000,
        max_volume_m3: 1.5,
        max_pallets: 1,
        max_height_m: 5,
      },
      SEED_ACTOR_ID
    );
    locationId = location.id;

    const medicamento = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto espécie MEDICAMENTO', species_code: 'MEDICAMENTO', base_uom: 'UN' },
      SEED_ACTOR_ID
    );
    medicamentoProductId = medicamento.id;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('produto MEDICAMENTO sem lote e rejeitado ao creditar saldo', async () => {
    await expect(
      testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID },
        `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [clientId, warehouseId, medicamentoProductId, locationId, 10, SEED_ACTOR_ID]
      )
    ).rejects.toThrow(/RN-DAD-020: batch is required/);
  });

  it('lote de produto MEDICAMENTO sem validade e rejeitado', async () => {
    await expect(
      batchService.create(
        {
          tenant_id: clientId,
          product_id: medicamentoProductId,
          batch_code: 'LOTE-SEM-VALIDADE',
          manufacture_date: '2026-01-01',
        },
        SEED_ACTOR_ID
      )
    ).rejects.toBeTruthy();
  });

  it('lote de produto MEDICAMENTO com validade e aceito, e o saldo com esse lote e aceito', async () => {
    const batch = await batchService.create(
      {
        tenant_id: clientId,
        product_id: medicamentoProductId,
        batch_code: 'LOTE-COM-VALIDADE',
        manufacture_date: '2026-01-01',
        expiration_date: '2027-01-01',
      },
      SEED_ACTOR_ID
    );
    expect(batch.batch_code).toBe('LOTE-COM-VALIDADE');

    const result = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, batch_id, location_id, qty_available, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [clientId, warehouseId, medicamentoProductId, batch.id, locationId, 10, SEED_ACTOR_ID]
    );
    expect(Number(result.rows[0].qty_available)).toBe(10);
  });
});
