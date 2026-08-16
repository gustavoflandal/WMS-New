// Scenario ENTREGÁVEL 8 / DOC-02 §7 Gherkin "Unicidade de SKU por cliente":
// SKU duplicado no mesmo cliente é rejeitado; o mesmo SKU em cliente
// diferente é aceito (UNIQUE(tenant_id, sku), não UNIQUE(sku) global).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { ClientService } from '../client/client.service.js';
import { ProductService } from '../product/product.service.js';
import { generateValidCnpj, randomClientCode, SEED_ACTOR_ID } from './test-helpers.js';

describe('Cadastro - unicidade de SKU por cliente', () => {
  let testContext: TestContext;
  let clientService: ClientService;
  let productService: ProductService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    clientService = new ClientService(testContext.databaseService);
    productService = new ProductService(testContext.databaseService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('SKU duplicado no mesmo cliente e rejeitado; mesmo SKU em cliente diferente e aceito', async () => {
    const clientA = await clientService.create({
      code: randomClientCode(),
      legal_name: 'Cliente A SKU',
      cnpj: generateValidCnpj(),
      actor_user_id: SEED_ACTOR_ID,
    });
    const clientB = await clientService.create({
      code: randomClientCode(),
      legal_name: 'Cliente B SKU',
      cnpj: generateValidCnpj(),
      actor_user_id: SEED_ACTOR_ID,
    });

    const sku = 'ABC-1';

    const productA = await productService.create({
      tenant_id: clientA.id,
      sku,
      description: 'Produto do cliente A',
      species_code: 'GERAL',
      base_uom: 'UN',
      actor_user_id: SEED_ACTOR_ID,
    });
    expect(productA.sku).toBe(sku);

    // Mesmo SKU, cliente B: DEVE ser aceito (DOC-02 §7 Gherkin).
    const productB = await productService.create({
      tenant_id: clientB.id,
      sku,
      description: 'Produto do cliente B',
      species_code: 'GERAL',
      base_uom: 'UN',
      actor_user_id: SEED_ACTOR_ID,
    });
    expect(productB.sku).toBe(sku);
    expect(productB.tenant_id).toBe(clientB.id);

    // Mesmo SKU, MESMO cliente A de novo: DEVE ser rejeitado.
    await expect(
      productService.create({
        tenant_id: clientA.id,
        sku,
        description: 'Produto duplicado do cliente A',
        species_code: 'GERAL',
        base_uom: 'UN',
        actor_user_id: SEED_ACTOR_ID,
      })
    ).rejects.toBeTruthy();
  });
});
