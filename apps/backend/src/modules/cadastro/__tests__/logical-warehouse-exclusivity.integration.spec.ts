// Scenario ENTREGÁVEL 5 (2/6): Exclusividade RG-015 — um location_id não
// pode ser vinculado a dois armazéns lógicos (UNIQUE(location_id) global em
// wms.logical_warehouse_location, mesmo com RLS por tenant).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { ClientService } from '../client/client.service.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { ZoneService } from '../zone/zone.service.js';
import { LocationService } from '../location/location.service.js';
import { LogicalWarehouseService } from '../logical-warehouse/logical-warehouse.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { ConflictException } from '@nestjs/common';
import { generateValidCnpj, randomWarehouseCode, SEED_ACTOR_ID } from './test-helpers.js';

describe('Cadastro - RG-015 exclusividade de vínculo location <-> logical_warehouse', () => {
  let testContext: TestContext;
  let clientService: ClientService;
  let warehouseService: WarehouseService;
  let zoneService: ZoneService;
  let locationService: LocationService;
  let logicalWarehouseService: LogicalWarehouseService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    clientService = new ClientService(testContext.databaseService, auditService);
    warehouseService = new WarehouseService(testContext.databaseService, auditService);
    zoneService = new ZoneService(testContext.databaseService, auditService);
    locationService = new LocationService(testContext.databaseService, auditService);
    logicalWarehouseService = new LogicalWarehouseService(testContext.databaseService, auditService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('vincular o mesmo location a um segundo logical_warehouse é rejeitado', async () => {
    const warehouse = await warehouseService.create(
      {
        code: randomWarehouseCode(),
        name: 'Armazém de teste RG-015',
        cnpj: generateValidCnpj(),
        timezone: 'America/Sao_Paulo',
      },
      SEED_ACTOR_ID
    );
    const zone = await zoneService.create(
      {
        warehouse_id: warehouse.id,
        code: 'STO',
        name: 'Armazenagem',
        zone_type: 'STORAGE',
      },
      SEED_ACTOR_ID
    );
    const location = await locationService.create(
      {
        warehouse_id: warehouse.id,
        zone_id: zone.id,
        aisle: 'B1',
        module: '001',
        level: '00',
        slot: '01',
        location_type: 'STORAGE',
        max_weight_kg: 500,
        max_volume_m3: 1,
        max_pallets: 1,
        max_height_m: 2,
      },
      SEED_ACTOR_ID
    );

    // Dois tenants distintos, cada um com seu próprio logical_warehouse no MESMO warehouse físico.
    const clientA = await clientService.create(
      {
        code: 'RGA',
        legal_name: 'Cliente RG-015 A',
        cnpj: generateValidCnpj(),
      },
      SEED_ACTOR_ID
    );
    const clientB = await clientService.create(
      {
        code: 'RGB',
        legal_name: 'Cliente RG-015 B',
        cnpj: generateValidCnpj(),
      },
      SEED_ACTOR_ID
    );
    const lwA = await logicalWarehouseService.create(
      {
        tenant_id: clientA.id,
        warehouse_id: warehouse.id,
        code: 'LWRGA',
        name: 'Armazém lógico RG-015 A',
      },
      SEED_ACTOR_ID
    );
    const lwB = await logicalWarehouseService.create(
      {
        tenant_id: clientB.id,
        warehouse_id: warehouse.id,
        code: 'LWRGB',
        name: 'Armazém lógico RG-015 B',
      },
      SEED_ACTOR_ID
    );

    await logicalWarehouseService.link(lwA.id, location.id, clientA.id, SEED_ACTOR_ID);

    await expect(logicalWarehouseService.link(lwB.id, location.id, clientB.id, SEED_ACTOR_ID)).rejects.toBeInstanceOf(ConflictException);
  });
});
