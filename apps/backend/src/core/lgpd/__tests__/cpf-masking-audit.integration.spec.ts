// Scenario DOC-12 §6 — "Mascaramento de CPF com auditoria de exibição
// completa": porteiro SEM POR.DADO_PESSOAL_COMPLETO vê o CPF mascarado;
// usuário COM a permissão vê o CPF completo E gera um registro de
// auditoria (action EXPORT — DOC-12 §6 aceita "EXPORT ou leitura sensível").
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../database/__tests__/test-setup.helper.js';
import { RbacService } from '../../rbac/rbac.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { PersonalDataAccessService } from '../personal-data-access.service.js';
import { PasswordService } from '../../auth/password.service.js';
import { WarehouseService } from '../../../modules/cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../modules/cadastro/client/client.service.js';
import { createTestUser, assignRole, SEED_ACTOR_ID } from '../../__tests__/security-test-helpers.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode } from '../../../modules/cadastro/__tests__/test-helpers.js';

describe('PersonalDataAccessService - DOC-12 RN-SEG-051 mascaramento de CPF + auditoria', () => {
  let testContext: TestContext;
  let service: PersonalDataAccessService;
  let auditService: AuditService;
  let warehouseService: WarehouseService;
  let clientService: ClientService;
  let passwordService: PasswordService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const rbacService = new RbacService(testContext.databaseService);
    auditService = new AuditService(testContext.databaseService);
    service = new PersonalDataAccessService(rbacService, auditService);
    warehouseService = new WarehouseService(testContext.databaseService, auditService);
    clientService = new ClientService(testContext.databaseService, auditService);
    passwordService = new PasswordService(testContext.databaseService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('porteiro sem POR.DADO_PESSOAL_COMPLETO vê o CPF mascarado', async () => {
    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém mascaramento CPF', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const porteiro = await createTestUser(testContext.databaseService, passwordService);
    await assignRole(testContext.databaseService, { userId: porteiro.id, roleCode: 'PORTEIRO', warehouseId: warehouse.id });

    const result = await service.reveal({
      userId: porteiro.id,
      value: '123.456.789-09',
      kind: 'CPF',
      entity: 'driver',
      entityId: 'driver-1',
      warehouseId: warehouse.id,
    });

    expect(result.wasMasked).toBe(true);
    expect(result.value).toBe('***.456.789-**');

    // Nenhuma leitura sensível deve ter sido auditada (não houve exibição completa).
    const audits = await auditService.query({ entity: 'driver' });
    expect(audits.some((a) => a.entity_id === 'driver-1')).toBe(false);
  });

  it('usuário com POR.DADO_PESSOAL_COMPLETO vê o CPF completo e gera auditoria', async () => {
    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém CPF completo', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente CPF completo', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );
    const admin = await createTestUser(testContext.databaseService, passwordService);
    await assignRole(testContext.databaseService, { userId: admin.id, roleCode: 'GESTOR_ARMAZEM', warehouseId: warehouse.id, clientId: client.id });

    const result = await service.reveal({
      userId: admin.id,
      value: '123.456.789-09',
      kind: 'CPF',
      entity: 'driver',
      entityId: 'driver-2',
      warehouseId: warehouse.id,
    });

    expect(result.wasMasked).toBe(false);
    expect(result.value).toBe('123.456.789-09');

    const audits = await auditService.query({ entity: 'driver' });
    const match = audits.find((a) => a.entity_id === 'driver-2');
    expect(match).toBeDefined();
    expect(match.action).toBe('EXPORT');
    expect(match.user_id).toBe(admin.id);
  });
});
