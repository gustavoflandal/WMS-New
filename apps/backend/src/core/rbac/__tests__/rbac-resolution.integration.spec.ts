// Scenario DOC-12 §6 — "Resolução multi-dimensional de permissão"
// (RN-SEG-011 [INVIOLÁVEL]): 3 casos do documento. João com atribuição
// CONFERENTE no armazém SP01 para o cliente A: autorizado para A@SP01,
// negado para B@SP01, negado para A@RJ01 (outro armazém).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../database/__tests__/test-setup.helper.js';
import { RbacService } from '../rbac.service.js';
import { PasswordService } from '../../auth/password.service.js';
import { WarehouseService } from '../../../modules/cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../modules/cadastro/client/client.service.js';
import { createTestUser, assignRole, SEED_ACTOR_ID } from '../../__tests__/security-test-helpers.js';
import { AuditService } from '../../audit/audit.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode } from '../../../modules/cadastro/__tests__/test-helpers.js';

describe('RbacService - DOC-12 RN-SEG-011 resolução multi-dimensional [INVIOLÁVEL]', () => {
  let testContext: TestContext;
  let rbacService: RbacService;
  let passwordService: PasswordService;
  let warehouseService: WarehouseService;
  let clientService: ClientService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    rbacService = new RbacService(testContext.databaseService);
    passwordService = new PasswordService(testContext.databaseService);
    const auditService = new AuditService(testContext.databaseService);
    warehouseService = new WarehouseService(testContext.databaseService, auditService);
    clientService = new ClientService(testContext.databaseService, auditService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('CONFERENTE em SP01 para cliente A: autorizado para A@SP01, negado para B@SP01 e para A@RJ01', async () => {
    const sp01 = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém SP01 de teste RBAC', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const rj01 = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém RJ01 de teste RBAC', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const clientA = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente A RBAC', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );
    const clientB = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente B RBAC', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );

    const joao = await createTestUser(testContext.databaseService, passwordService);
    await assignRole(testContext.databaseService, {
      userId: joao.id,
      roleCode: 'CONFERENTE',
      warehouseId: sp01.id,
      clientId: clientA.id,
    });

    // Caso 1: cliente A, armazém SP01 -> autorizado.
    expect(await rbacService.hasPermission(joao.id, 'DAD.PRODUCT_CATALOG_MANAGE', { warehouseId: sp01.id, clientId: clientA.id })).toBe(true);

    // Caso 2: cliente B, mesmo armazém SP01 -> negado (RN-ARQ-013: sem curinga).
    expect(await rbacService.hasPermission(joao.id, 'DAD.PRODUCT_CATALOG_MANAGE', { warehouseId: sp01.id, clientId: clientB.id })).toBe(false);

    // Caso 3: cliente A, armazém RJ01 -> negado (atribuição é só para SP01).
    expect(await rbacService.hasPermission(joao.id, 'DAD.PRODUCT_CATALOG_MANAGE', { warehouseId: rj01.id, clientId: clientA.id })).toBe(false);
  });

  it('permissão GLOBAL ignora as dimensões armazém/cliente', async () => {
    // ADMIN_SISTEMA: só permissões de escopo GLOBAL (migration 0016) --
    // por isso pode ser atribuído sem warehouse_id/client_id (RD-SEG-010).
    const admin = await createTestUser(testContext.databaseService, passwordService);
    await assignRole(testContext.databaseService, { userId: admin.id, roleCode: 'ADMIN_SISTEMA' });

    expect(await rbacService.hasPermission(admin.id, 'SEG.GESTAO_PAPEIS')).toBe(true);
    expect(await rbacService.hasPermission(admin.id, 'SEG.GESTAO_PAPEIS', { warehouseId: '00000000-0000-0000-0000-000000000099' })).toBe(true);
  });

  it('usuário sem nenhuma atribuição não possui nenhuma permissão', async () => {
    const nobody = await createTestUser(testContext.databaseService, passwordService);
    expect(await rbacService.hasPermission(nobody.id, 'DAD.PRODUCT_CATALOG_MANAGE')).toBe(false);
    expect(await rbacService.hasAnyGlobalPermission(nobody.id)).toBe(false);
  });
});
