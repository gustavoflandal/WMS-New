// Scenario DOC-12 §6 — "Efeito suspensivo da exceção" (RN-SEG-042
// [INVIOLÁVEL]): enquanto a exceção estiver PENDING/ESCALATED, a operação
// de origem permanece bloqueada; aprovação/rejeição libera o bloqueio.
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

describe('OperationalExceptionService - DOC-12 RN-SEG-042 [INVIOLÁVEL] efeito suspensivo', () => {
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

  it('operação bloqueada enquanto PENDING; liberada após decisão (APPROVE de 1 passo)', async () => {
    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém efeito suspensivo', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente efeito suspensivo', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );

    const conferente = await createTestUser(testContext.databaseService, passwordService);
    const lider = await createTestUser(testContext.databaseService, passwordService);
    await assignRole(testContext.databaseService, { userId: lider.id, roleCode: 'LIDER_TURNO', warehouseId: warehouse.id, clientId: client.id });
    await grantApprovalAuthority(testContext.databaseService, {
      roleCode: 'LIDER_TURNO',
      exceptionType: 'REC.DIVERGENCIA_FALTA',
      warehouseId: warehouse.id,
      maxQty: 500,
    });

    const entityId = '00000000-0000-0000-0000-000000000055';

    // Antes de qualquer exceção: nada bloqueia a operação.
    expect(await service.isBlocking(client.id, 'inbound_order', entityId)).toBe(false);

    const exception = await service.create({
      tenantId: client.id,
      exceptionType: 'REC.DIVERGENCIA_FALTA',
      warehouseId: warehouse.id,
      entity: 'inbound_order',
      entityId,
      qty: 100,
      reasonRequest: 'Falta identificada',
      requestedBy: conferente.id,
    });
    expect(exception.status).toBe('PENDING');

    // RN-SEG-042: enquanto PENDING, a operação de origem fica bloqueada.
    expect(await service.isBlocking(client.id, 'inbound_order', entityId)).toBe(true);

    const decided = await service.decide(exception.id, client.id, warehouse.id, lider.id, 'APPROVE', 'Divergência confirmada e aceita');
    expect(decided.status).toBe('APPROVED');

    // Após a decisão final, a operação é liberada.
    expect(await service.isBlocking(client.id, 'inbound_order', entityId)).toBe(false);
  });

  it('rejeição também libera o bloqueio (operação devolvida ao estado anterior)', async () => {
    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém efeito suspensivo rejeição', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente efeito suspensivo rejeição', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );

    const conferente = await createTestUser(testContext.databaseService, passwordService);
    const lider = await createTestUser(testContext.databaseService, passwordService);
    await assignRole(testContext.databaseService, { userId: lider.id, roleCode: 'LIDER_TURNO', warehouseId: warehouse.id, clientId: client.id });
    await grantApprovalAuthority(testContext.databaseService, {
      roleCode: 'LIDER_TURNO',
      exceptionType: 'REC.DIVERGENCIA_FALTA',
      warehouseId: warehouse.id,
      maxQty: 500,
    });

    const entityId = '00000000-0000-0000-0000-000000000056';
    const exception = await service.create({
      tenantId: client.id,
      exceptionType: 'REC.DIVERGENCIA_FALTA',
      warehouseId: warehouse.id,
      entity: 'inbound_order',
      entityId,
      qty: 50,
      reasonRequest: 'Falta identificada',
      requestedBy: conferente.id,
    });
    expect(await service.isBlocking(client.id, 'inbound_order', entityId)).toBe(true);

    const decided = await service.decide(exception.id, client.id, warehouse.id, lider.id, 'REJECT', 'Divergência não confirmada, recontagem necessária');
    expect(decided.status).toBe('REJECTED');
    expect(await service.isBlocking(client.id, 'inbound_order', entityId)).toBe(false);
  });
});
