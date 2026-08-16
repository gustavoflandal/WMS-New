// Scenario ENTREGÁVEL 5 (5/6): RF-DAD-054 — geração em massa por intervalo
// de coordenadas. A1-A2 x módulos 001-003 x níveis 00-01 x vãos 01-02 = 24
// endereços, sem duplicidade (rodar duas vezes não cria 48).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { ZoneService } from '../zone/zone.service.js';
import { LocationService } from '../location/location.service.js';
import { generateValidCnpj, randomWarehouseCode, SEED_ACTOR_ID } from './test-helpers.js';

describe('Cadastro - RF-DAD-054 geração em massa de endereços', () => {
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

  it('A1-A2 x 001-003 x 00-01 x 01-02 cria exatamente 24 endereços, sem duplicidade ao repetir', async () => {
    const warehouse = await warehouseService.create({
      code: randomWarehouseCode(),
      name: 'Armazém de teste bulk-generate',
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

    const input = {
      warehouse_id: warehouse.id,
      zone_id: zone.id,
      location_type: 'STORAGE',
      aisle_from: 'A1',
      aisle_to: 'A2',
      module_from: '001',
      module_to: '003',
      level_from: '00',
      level_to: '01',
      slot_from: '01',
      slot_to: '02',
      max_weight_kg: 1000,
      max_volume_m3: 1.5,
      max_pallets: 1,
      max_height_m: 5,
      actor_user_id: SEED_ACTOR_ID,
    };

    const first = await locationService.bulkGenerate(input);
    expect(first.total_requested).toBe(24);
    expect(first.total_created).toBe(24);

    const second = await locationService.bulkGenerate(input);
    expect(second.total_requested).toBe(24);
    expect(second.total_created).toBe(0); // ON CONFLICT DO NOTHING — sem duplicidade

    const all = await locationService.listByWarehouse(warehouse.id);
    expect(all).toHaveLength(24);
  });
});
