// Scenario ENTREGÁVEL 5 (1/6): Isolamento — cliente A não enxerga
// logical_warehouse do cliente B. DOC-02 §5.1, RG-001, RLS via client.id = tenant_id.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { ClientService } from '../client/client.service.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { LogicalWarehouseService } from '../logical-warehouse/logical-warehouse.service.js';
import { NotFoundException } from '@nestjs/common';
import { generateValidCnpj, randomWarehouseCode, SEED_ACTOR_ID } from './test-helpers.js';

describe('Cadastro - Isolamento de tenant (logical_warehouse)', () => {
  let testContext: TestContext;
  let clientService: ClientService;
  let warehouseService: WarehouseService;
  let logicalWarehouseService: LogicalWarehouseService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    clientService = new ClientService(testContext.databaseService);
    warehouseService = new WarehouseService(testContext.databaseService);
    logicalWarehouseService = new LogicalWarehouseService(testContext.databaseService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('cliente A não vê logical_warehouse do cliente B', async () => {
    const warehouse = await warehouseService.create({
      code: randomWarehouseCode(),
      name: 'Armazém de teste isolamento',
      cnpj: generateValidCnpj(),
      timezone: 'America/Sao_Paulo',
      actor_user_id: SEED_ACTOR_ID,
    });

    const clientA = await clientService.create({
      code: 'CLIA',
      legal_name: 'Cliente A Ltda',
      cnpj: generateValidCnpj(),
      actor_user_id: SEED_ACTOR_ID,
    });
    const clientB = await clientService.create({
      code: 'CLIB',
      legal_name: 'Cliente B Ltda',
      cnpj: generateValidCnpj(),
      actor_user_id: SEED_ACTOR_ID,
    });

    const lwA = await logicalWarehouseService.create({
      tenant_id: clientA.id,
      warehouse_id: warehouse.id,
      code: 'LWA',
      name: 'Armazém lógico A',
      actor_user_id: SEED_ACTOR_ID,
    });

    // Cliente B não consegue ver o logical_warehouse de A (RLS filtra por tenant_id)
    const listB = await logicalWarehouseService.listByTenant(clientB.id, SEED_ACTOR_ID);
    expect(listB).toHaveLength(0);

    await expect(logicalWarehouseService.findById(lwA.id, clientB.id, SEED_ACTOR_ID)).rejects.toBeInstanceOf(NotFoundException);

    // Cliente A continua vendo o próprio registro
    const listA = await logicalWarehouseService.listByTenant(clientA.id, SEED_ACTOR_ID);
    expect(listA).toHaveLength(1);
    expect(listA[0].id).toBe(lwA.id);
  });
});
