// Scenario ENTREGÁVEL 5 (4/6): RF-DAD-050 — alterar warehouse.code ou
// client.code é rejeitado. Testado via UPDATE SQL direto (não via
// service — WarehouseService/ClientService já nem aceitam `code` no
// update()) para provar que a proteção real é o trigger no banco
// (wms.prevent_code_update), não apenas a omissão no DTO do app.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { ClientService } from '../client/client.service.js';
import { generateValidCnpj, randomWarehouseCode, SEED_ACTOR_ID } from './test-helpers.js';

describe('Cadastro - RF-DAD-050 imutabilidade de code', () => {
  let testContext: TestContext;
  let warehouseService: WarehouseService;
  let clientService: ClientService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    warehouseService = new WarehouseService(testContext.databaseService);
    clientService = new ClientService(testContext.databaseService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('UPDATE direto em warehouse.code é rejeitado pelo trigger', async () => {
    const warehouse = await warehouseService.create({
      code: randomWarehouseCode(),
      name: 'Armazém imutabilidade',
      cnpj: generateValidCnpj(),
      timezone: 'America/Sao_Paulo',
      actor_user_id: SEED_ACTOR_ID,
    });

    await expect(
      testContext.databaseService.queryGlobal('UPDATE wms.warehouse SET code = $2 WHERE id = $1', [warehouse.id, randomWarehouseCode()])
    ).rejects.toThrow(/RF-DAD-050/);
  });

  it('UPDATE direto em client.code é rejeitado pelo trigger', async () => {
    const client = await clientService.create({
      code: 'IMUT1',
      legal_name: 'Cliente imutabilidade',
      cnpj: generateValidCnpj(),
      actor_user_id: SEED_ACTOR_ID,
    });

    await expect(
      testContext.databaseService.query({ tenant_id: client.id, user_id: SEED_ACTOR_ID }, 'UPDATE wms.client SET code = $2 WHERE id = $1', [
        client.id,
        'IMUT2',
      ])
    ).rejects.toThrow(/RF-DAD-050/);
  });
});
