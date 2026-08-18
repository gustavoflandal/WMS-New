// Scenario ENTREGÁVEL 8 — DOC-02 §5.5: "É PROIBIDO UPDATE/DELETE nesta
// tabela" (stock_movement, append-only). Prova contra o Postgres real que
// wms_app não consegue UPDATE nem DELETE, mesmo dentro de contexto de
// tenant válido — não depende apenas da ausência de método no service.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { ClientService } from '../client/client.service.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { ZoneService } from '../zone/zone.service.js';
import { LocationService } from '../location/location.service.js';
import { ProductService } from '../product/product.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from './test-helpers.js';

describe('Cadastro - DOC-02 §5.5 stock_movement append-only', () => {
  let testContext: TestContext;
  let clientId: string;
  let warehouseId: string;
  let locationId: string;
  let productId: string;
  let movementId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    const clientService = new ClientService(testContext.databaseService, auditService);
    const warehouseService = new WarehouseService(testContext.databaseService, auditService);
    const zoneService = new ZoneService(testContext.databaseService, auditService);
    const locationService = new LocationService(testContext.databaseService, auditService);
    const productService = new ProductService(testContext.databaseService, auditService);

    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente stock_movement', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );
    clientId = client.id;

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém stock_movement', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
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
        aisle: 'F1',
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
      { tenant_id: clientId, sku: randomSku(), description: 'Produto stock_movement', species_code: 'GERAL', base_uom: 'UN' },
      SEED_ACTOR_ID
    );
    productId = product.id;

    // Nota: id sozinho já é único aqui (gen_random_uuid()) — o WHERE das
    // queries abaixo usa só `id`, não `occurred_at`. occurred_at é
    // TIMESTAMPTZ com precisão de microssegundos, mas o driver `pg` entrega
    // um JS Date (precisão de milissegundos); reenviar esse Date como
    // parâmetro perderia os microssegundos e o WHERE deixaria de casar.
    // 'ENTRADA_RECEBIMENTO' — catálogo fechado RN-EST-001 (DOC-05 §4.1,
    // migration 0044). Corrigido do placeholder 'RECEIVING_CREDIT' desta
    // sessão anterior (Sessão 2B), já que movement_type agora tem CHECK.
    const inserted = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `INSERT INTO wms.stock_movement (tenant_id, warehouse_id, movement_type, product_id, location_id_to, qty, created_by)
       VALUES ($1,$2,'ENTRADA_RECEBIMENTO',$3,$4,10,$5) RETURNING id`,
      [clientId, warehouseId, productId, locationId, SEED_ACTOR_ID]
    );
    movementId = inserted.rows[0].id;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('wms_app nao consegue UPDATE em stock_movement (42501)', async () => {
    await expect(
      testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID },
        `UPDATE wms.stock_movement SET qty = 999 WHERE id = $1`,
        [movementId]
      )
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('wms_app nao consegue DELETE em stock_movement (42501)', async () => {
    await expect(
      testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID }, `DELETE FROM wms.stock_movement WHERE id = $1`, [
        movementId,
      ])
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a linha permanece intacta apos as tentativas negadas', async () => {
    const result = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT qty FROM wms.stock_movement WHERE id = $1`,
      [movementId]
    );
    expect(Number(result.rows[0].qty)).toBe(10);
  });
});
