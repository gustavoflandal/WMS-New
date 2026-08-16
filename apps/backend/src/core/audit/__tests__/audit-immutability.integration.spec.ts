// Scenario DOC-12 §6 — "Imutabilidade da auditoria" (RN-SEG-031
// [INVIOLÁVEL]): nenhum papel, nem ADMIN_SISTEMA, pode alterar/excluir um
// registro pela aplicação; o usuário de banco (wms_app) possui apenas
// INSERT e SELECT — provado contra o Postgres real (42501).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../database/__tests__/test-setup.helper.js';
import { AuditService } from '../audit.service.js';
import { createTestUser, SEED_ACTOR_ID } from '../../__tests__/security-test-helpers.js';
import { PasswordService } from '../../auth/password.service.js';
import { WarehouseService } from '../../../modules/cadastro/warehouse/warehouse.service.js';
import { generateValidCnpj, randomWarehouseCode } from '../../../modules/cadastro/__tests__/test-helpers.js';

describe('AuditService - DOC-12 RN-SEG-031 [INVIOLÁVEL] imutabilidade de audit_log', () => {
  let testContext: TestContext;
  let auditService: AuditService;
  let recordId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    auditService = new AuditService(testContext.databaseService);
    const passwordService = new PasswordService(testContext.databaseService);
    const warehouseService = new WarehouseService(testContext.databaseService, auditService);
    const user = await createTestUser(testContext.databaseService, passwordService);
    const warehouse = await warehouseService.create(
      {
        code: randomWarehouseCode(),
        name: 'Armazém audit immutability',
        cnpj: generateValidCnpj(),
        timezone: 'America/Sao_Paulo',
      },
      SEED_ACTOR_ID
    );

    await auditService.record({
      warehouseId: warehouse.id,
      userId: user.id,
      origin: 'API',
      entity: 'test_entity',
      entityId: 'test-entity-1',
      action: 'CREATE',
      after: { field: 'value' },
    });

    const rows = await testContext.databaseService.queryGlobal('SELECT id FROM wms.audit_log WHERE entity_id = $1', ['test-entity-1']);
    recordId = rows.rows[0].id;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('wms_app não consegue UPDATE em audit_log (42501)', async () => {
    await expect(testContext.databaseService.queryGlobal(`UPDATE wms.audit_log SET reason = 'forjado' WHERE id = $1`, [recordId])).rejects.toMatchObject(
      { code: '42501' }
    );
  });

  it('wms_app não consegue DELETE em audit_log (42501)', async () => {
    await expect(testContext.databaseService.queryGlobal(`DELETE FROM wms.audit_log WHERE id = $1`, [recordId])).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('o registro permanece intacto e consultável (SELECT continua permitido)', async () => {
    const result = await auditService.query({ entity: 'test_entity' });
    expect(result.some((r) => r.entity_id === 'test-entity-1')).toBe(true);
  });
});
