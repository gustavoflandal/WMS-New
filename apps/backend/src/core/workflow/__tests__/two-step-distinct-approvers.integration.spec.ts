// Scenario DOC-12 §6/RN-SEG-043 — "fluxo de 2 passos exige aprovadores
// distintos entre si e do solicitante". EST.QUEBRA_FEFO tem
// default_steps=2 (migration 0018).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../database/__tests__/test-setup.helper.js';
import { EventsService } from '../../events/events.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { ApprovalAuthorityService } from '../approval-authority.service.js';
import { OperationalExceptionService } from '../operational-exception.service.js';
import { PasswordService } from '../../auth/password.service.js';
import { WarehouseService } from '../../../modules/cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../modules/cadastro/client/client.service.js';
import { createTestUser, assignRole, grantApprovalAuthority, SEED_ACTOR_ID } from '../../__tests__/security-test-helpers.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode } from '../../../modules/cadastro/__tests__/test-helpers.js';
import { ForbiddenException } from '@nestjs/common';

describe('OperationalExceptionService - DOC-12 RN-SEG-043 fluxo de 2 passos', () => {
  let testContext: TestContext;
  let service: OperationalExceptionService;
  let warehouseService: WarehouseService;
  let clientService: ClientService;
  let passwordService: PasswordService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const approvalAuthorityService = new ApprovalAuthorityService(testContext.databaseService);
    const eventsService = new EventsService();
    const auditService = new AuditService(testContext.databaseService);
    service = new OperationalExceptionService(testContext.databaseService, approvalAuthorityService, eventsService, auditService);
    warehouseService = new WarehouseService(testContext.databaseService, auditService);
    clientService = new ClientService(testContext.databaseService, auditService);
    passwordService = new PasswordService(testContext.databaseService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('2 aprovadores DISTINTOS aprovam os 2 passos -> APPROVED; o mesmo aprovador repetido no passo 2 é negado', async () => {
    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém 2 passos', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente 2 passos', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );

    const solicitante = await createTestUser(testContext.databaseService, passwordService);
    const aprovador1 = await createTestUser(testContext.databaseService, passwordService);
    const aprovador2 = await createTestUser(testContext.databaseService, passwordService);
    for (const user of [aprovador1, aprovador2]) {
      await assignRole(testContext.databaseService, { userId: user.id, roleCode: 'GESTOR_ARMAZEM', warehouseId: warehouse.id, clientId: client.id });
    }
    await grantApprovalAuthority(testContext.databaseService, {
      roleCode: 'GESTOR_ARMAZEM',
      exceptionType: 'EST.QUEBRA_FEFO',
      warehouseId: warehouse.id,
      maxQty: 1000,
    });

    const exception = await service.create({
      tenantId: client.id,
      exceptionType: 'EST.QUEBRA_FEFO',
      warehouseId: warehouse.id,
      entity: 'stock_balance',
      entityId: '00000000-0000-0000-0000-000000000060',
      qty: 200,
      reasonRequest: 'Necessidade operacional',
      requestedBy: solicitante.id,
    });

    // Passo 1: aprovador1 aprova -> ainda PENDING (falta o passo 2).
    const afterStep1 = await service.decide(exception.id, client.id, warehouse.id, aprovador1.id, 'APPROVE', 'Passo 1 ok');
    expect(afterStep1.status).toBe('PENDING');
    expect(afterStep1.current_step).toBe(2);

    // aprovador1 tentando decidir o passo 2 também -> negado (RN-SEG-043: aprovadores distintos ENTRE SI).
    await expect(service.decide(exception.id, client.id, warehouse.id, aprovador1.id, 'APPROVE', 'Tentando decidir de novo')).rejects.toBeInstanceOf(
      ForbiddenException
    );

    // Passo 2: aprovador2 (distinto) aprova -> finaliza APPROVED.
    const final = await service.decide(exception.id, client.id, warehouse.id, aprovador2.id, 'APPROVE', 'Passo 2 ok');
    expect(final.status).toBe('APPROVED');
  });
});
