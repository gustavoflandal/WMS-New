// Scenario DOC-12 §4.5/§5.1 — RN-SEG-042: "Expiração por auto_expire_hours
// equivale a rejeição automática com motivo EXPIRADA". Testa o worker do
// scheduler que expira exceções PENDING/ESCALATED vencidas.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../core/database/__tests__/test-setup.helper.js';
import { CacheModule } from '../../core/cache/cache.module.js';
import { CacheService } from '../../core/cache/cache.service.js';
import { EventsService } from '../../core/events/events.service.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { ApprovalAuthorityService } from '../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../core/workflow/operational-exception.service.js';
import { ExceptionExpiryWorkerImpl } from '../exception-expiry.worker.impl.js';
import { WarehouseService } from '../../modules/cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../modules/cadastro/client/client.service.js';
import { createTestUser, grantApprovalAuthority, SEED_ACTOR_ID } from '../../core/__tests__/security-test-helpers.js';
import { PasswordService } from '../../core/auth/password.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode } from '../../modules/cadastro/__tests__/test-helpers.js';

describe('ExceptionExpiryWorkerImpl - DOC-12 RN-SEG-042 expiração automática', () => {
  let testContext: TestContext;
  let cacheService: CacheService;
  let operationalExceptionService: OperationalExceptionService;
  let warehouseService: WarehouseService;
  let clientService: ClientService;
  let passwordService: PasswordService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest([CacheModule]);
    cacheService = testContext.module.get<CacheService>(CacheService);
    const approvalAuthorityService = new ApprovalAuthorityService(testContext.databaseService);
    const eventsService = new EventsService();
    const auditService = new AuditService(testContext.databaseService);
    operationalExceptionService = new OperationalExceptionService(testContext.databaseService, approvalAuthorityService, eventsService, auditService);
    warehouseService = new WarehouseService(testContext.databaseService, auditService);
    clientService = new ClientService(testContext.databaseService, auditService);
    passwordService = new PasswordService(testContext.databaseService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('exceção PENDING vencida (created_at além de auto_expire_hours) é expirada pelo worker', async () => {
    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém expiração', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente expiração', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );
    const solicitante = await createTestUser(testContext.databaseService, passwordService);
    // Alçada configurada para não escalar (foco deste teste é expiração, não escalonamento).
    await grantApprovalAuthority(testContext.databaseService, {
      roleCode: 'LIDER_TURNO',
      exceptionType: 'REC.DIVERGENCIA_FALTA',
      warehouseId: warehouse.id,
      maxQty: 500,
    });

    const exception = await operationalExceptionService.create({
      tenantId: client.id,
      exceptionType: 'REC.DIVERGENCIA_FALTA', // auto_expire_hours = 24 (migration 0018)
      warehouseId: warehouse.id,
      entity: 'inbound_order',
      entityId: '00000000-0000-0000-0000-000000000070',
      qty: 10,
      reasonRequest: 'Falta pequena, para teste de expiração',
      requestedBy: solicitante.id,
    });
    expect(exception.status).toBe('PENDING');

    // Força created_at para 25h atrás (além das 24h de auto_expire_hours).
    // UPDATE direto via superuser de teste (bypassa RLS/append-only não se
    // aplica aqui, operational_exception não é append-only).
    await testContext.databaseService.query(
      { tenant_id: client.id, user_id: SEED_ACTOR_ID },
      `UPDATE wms.operational_exception SET created_at = now() - INTERVAL '25 hours' WHERE id = $1`,
      [exception.id]
    );

    const worker = new ExceptionExpiryWorkerImpl(operationalExceptionService, cacheService);
    const result = await worker.runOnce();

    expect(result.ranAsLeader).toBe(true);
    expect(result.expiredIds).toContain(exception.id);

    const updated = await testContext.databaseService.query(
      { tenant_id: client.id, user_id: SEED_ACTOR_ID },
      `SELECT status, reason_decision FROM wms.operational_exception WHERE id = $1`,
      [exception.id]
    );
    expect(updated.rows[0].status).toBe('EXPIRED');
    expect(updated.rows[0].reason_decision).toBe('EXPIRADA');
  });

  it('exceção PENDING recente (dentro de auto_expire_hours) NÃO é expirada', async () => {
    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém sem expiração', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente sem expiração', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );
    const solicitante = await createTestUser(testContext.databaseService, passwordService);

    const exception = await operationalExceptionService.create({
      tenantId: client.id,
      exceptionType: 'REC.DIVERGENCIA_FALTA',
      warehouseId: warehouse.id,
      entity: 'inbound_order',
      entityId: '00000000-0000-0000-0000-000000000071',
      qty: 10,
      reasonRequest: 'Falta pequena, recente',
      requestedBy: solicitante.id,
    });

    const worker = new ExceptionExpiryWorkerImpl(operationalExceptionService, cacheService);
    const result = await worker.runOnce();

    expect(result.expiredIds).not.toContain(exception.id);
  });

  it('eleição de líder: duas réplicas concorrentes -- só uma expira por ciclo', async () => {
    const cacheServiceReplicaA = new CacheService(testContext.configService);
    const cacheServiceReplicaB = new CacheService(testContext.configService);
    await cacheServiceReplicaA.onModuleInit();
    await cacheServiceReplicaB.onModuleInit();

    try {
      const workerA = new ExceptionExpiryWorkerImpl(operationalExceptionService, cacheServiceReplicaA);
      const workerB = new ExceptionExpiryWorkerImpl(operationalExceptionService, cacheServiceReplicaB);

      const [resultA, resultB] = await Promise.all([workerA.runOnce(), workerB.runOnce()]);
      const leaders = [resultA, resultB].filter((r) => r.ranAsLeader);
      expect(leaders).toHaveLength(1);
    } finally {
      await cacheServiceReplicaA.onApplicationShutdown();
      await cacheServiceReplicaB.onApplicationShutdown();
    }
  });
});
