// Scenario DOC-12 §6 — "Solicitante não aprova a própria exceção"
// (RN-SEG-043 [INVIOLÁVEL]): Maria com alçada para EST.QUEBRA_FEFO até
// 1000 unidades solicita uma exceção de 200 unidades e tenta aprová-la —
// deve ser negado por segregação de funções.
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

describe('OperationalExceptionService - DOC-12 RN-SEG-043 [INVIOLÁVEL] segregação de funções', () => {
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

  it('Maria não pode aprovar a própria exceção EST.QUEBRA_FEFO, mesmo com alçada suficiente', async () => {
    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém self-approval', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente self-approval', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );

    const maria = await createTestUser(testContext.databaseService, passwordService);
    await assignRole(testContext.databaseService, { userId: maria.id, roleCode: 'GESTOR_ARMAZEM', warehouseId: warehouse.id, clientId: client.id });
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
      entityId: '00000000-0000-0000-0000-000000000042',
      qty: 200,
      reasonRequest: 'Necessidade operacional urgente',
      requestedBy: maria.id,
    });
    expect(exception.status).toBe('PENDING');

    await expect(service.decide(exception.id, client.id, warehouse.id, maria.id, 'APPROVE', 'Autoaprovação indevida')).rejects.toBeInstanceOf(
      ForbiddenException
    );

    // A exceção continua PENDING — a tentativa negada não altera o estado.
    const stillPending = await testContext.databaseService.query(
      { tenant_id: client.id, user_id: SEED_ACTOR_ID },
      'SELECT status FROM wms.operational_exception WHERE id = $1',
      [exception.id]
    );
    expect(stillPending.rows[0].status).toBe('PENDING');
  });
});
