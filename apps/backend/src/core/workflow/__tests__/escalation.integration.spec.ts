// Scenario DOC-12 §6 — "Escalonamento automático por alçada insuficiente"
// (RN-SEG-021): maior alçada configurada para REC.DIVERGENCIA_FALTA no
// armazém é 500 unidades; uma divergência de 800 unidades deve nascer
// ESCALATED, e a notificação (RF-SEG-044) deve ser publicada no pipeline
// outbox -> tópico "alertas" (event_type seguranca.excecao_escalada).
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

describe('OperationalExceptionService - DOC-12 RN-SEG-021 escalonamento automático', () => {
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

  it('divergência de 800un excede a alçada máxima de 500un configurada -> ESCALATED + notificação em alertas', async () => {
    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém escalonamento', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente escalonamento', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );

    const conferente = await createTestUser(testContext.databaseService, passwordService);
    await assignRole(testContext.databaseService, { userId: conferente.id, roleCode: 'CONFERENTE', warehouseId: warehouse.id, clientId: client.id });

    // Maior alçada configurada no armazém para REC.DIVERGENCIA_FALTA: 500un.
    await grantApprovalAuthority(testContext.databaseService, {
      roleCode: 'LIDER_TURNO',
      exceptionType: 'REC.DIVERGENCIA_FALTA',
      warehouseId: warehouse.id,
      maxQty: 500,
    });

    const exception = await service.create({
      tenantId: client.id,
      exceptionType: 'REC.DIVERGENCIA_FALTA',
      warehouseId: warehouse.id,
      entity: 'inbound_order',
      entityId: '00000000-0000-0000-0000-000000000043',
      qty: 800,
      reasonRequest: 'Falta de 800 unidades identificada na conferência',
      requestedBy: conferente.id,
    });

    expect(exception.status).toBe('ESCALATED');

    // RF-SEG-044: notificação em tempo real — publicada no outbox com o
    // event_type mapeado para o tópico "alertas" (realtime-topics.ts).
    const outboxResult = await testContext.databaseService.transactionAsWorker(async (client_) => {
      return client_.query(`SELECT event_type, tenant_id, warehouse_id, payload FROM wms.event_outbox WHERE payload->>'exception_id' = $1`, [
        exception.id,
      ]);
    });
    expect(outboxResult.rows).toHaveLength(1);
    expect(outboxResult.rows[0].event_type).toBe('seguranca.excecao_escalada');
  });

  it('divergência dentro da alçada configurada nasce PENDING, não ESCALATED', async () => {
    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém sem escalonamento', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente sem escalonamento', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );
    const conferente = await createTestUser(testContext.databaseService, passwordService);

    await grantApprovalAuthority(testContext.databaseService, {
      roleCode: 'LIDER_TURNO',
      exceptionType: 'REC.DIVERGENCIA_FALTA',
      warehouseId: warehouse.id,
      maxQty: 500,
    });

    const exception = await service.create({
      tenantId: client.id,
      exceptionType: 'REC.DIVERGENCIA_FALTA',
      warehouseId: warehouse.id,
      entity: 'inbound_order',
      entityId: '00000000-0000-0000-0000-000000000044',
      qty: 100,
      reasonRequest: 'Falta pequena',
      requestedBy: conferente.id,
    });

    expect(exception.status).toBe('PENDING');
  });
});
