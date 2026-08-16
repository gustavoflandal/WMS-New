// Scenario ENTREGÁVEL 5 (3/6): código de endereço gerado conforme RN-DAD-011
// [INVIOLÁVEL] (aisle-module-level-slot, ex. A1-012-03-02).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { ZoneService } from '../zone/zone.service.js';
import { LocationService } from '../location/location.service.js';
import { generateValidCnpj, randomWarehouseCode, SEED_ACTOR_ID } from './test-helpers.js';

describe('Cadastro - RN-DAD-011 geração de code em location', () => {
  let testContext: TestContext;
  let warehouseService: WarehouseService;
  let zoneService: ZoneService;
  let locationService: LocationService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    warehouseService = new WarehouseService(testContext.databaseService);
    zoneService = new ZoneService(testContext.databaseService);
    locationService = new LocationService(testContext.databaseService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('code = aisle-module-level-slot (ex. A1-012-03-02)', async () => {
    const warehouse = await warehouseService.create({
      code: randomWarehouseCode(),
      name: 'Armazém de teste RN-DAD-011',
      cnpj: generateValidCnpj(),
      timezone: 'America/Sao_Paulo',
      actor_user_id: SEED_ACTOR_ID,
    });
    const zone = await zoneService.create({
      warehouse_id: warehouse.id,
      code: 'STO',
      name: 'Armazenagem',
      zone_type: 'STORAGE',
      actor_user_id: SEED_ACTOR_ID,
    });

    const location = await locationService.create({
      warehouse_id: warehouse.id,
      zone_id: zone.id,
      aisle: 'A1',
      module: '012',
      level: '03',
      slot: '02',
      location_type: 'STORAGE',
      max_weight_kg: 1000,
      max_volume_m3: 1.5,
      max_pallets: 1,
      max_height_m: 5,
      actor_user_id: SEED_ACTOR_ID,
    });

    expect(location.code).toBe('A1-012-03-02');

    const found = await locationService.findByCode(warehouse.id, 'A1-012-03-02');
    expect(found.id).toBe(location.id);
  });
});
