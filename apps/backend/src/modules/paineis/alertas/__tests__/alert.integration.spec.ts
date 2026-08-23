// DOC-10 §4.2 RF-PAI-010, §5.2 — centro de alertas contra Postgres real:
// consolidação a partir de eventos reais já publicados por outros módulos
// (exceção operacional, lote a vencer/vencido), dedup, resolução automática
// (§5.2), marcação de lido, e RN-SEG-011 (mesmo padrão do painel).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../cadastro/client/client.service.js';
import { AuditService } from '../../../../core/audit/audit.service.js';
import { EventsService } from '../../../../core/events/events.service.js';
import { RbacService } from '../../../../core/rbac/rbac.service.js';
import { PasswordService } from '../../../../core/auth/password.service.js';
import { AlertService } from '../alert.service.js';
import { AlertMaterializationService } from '../alert-materialization.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, SEED_ACTOR_ID } from '../../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole } from '../../../../core/__tests__/security-test-helpers.js';

describe('Alertas - DOC-10 §4.2 RF-PAI-010 (Sessão 7A)', () => {
  let testContext: TestContext;
  let alertService: AlertService;
  let alertMaterializationService: AlertMaterializationService;

  let warehouseId: string;
  let clientAId: string;
  let clientBId: string;
  let userScopedToA: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const passwordService = new PasswordService(db);

    alertService = new AlertService(db, eventsService);
    alertMaterializationService = new AlertMaterializationService(alertService, db);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém Alertas', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    clientAId = (await clientService.create({ code: randomClientCode(), legal_name: 'Cliente A Alertas', cnpj: generateValidCnpj() }, SEED_ACTOR_ID)).id;
    clientBId = (await clientService.create({ code: randomClientCode(), legal_name: 'Cliente B Alertas', cnpj: generateValidCnpj() }, SEED_ACTOR_ID)).id;

    userScopedToA = await createTestUser(db, passwordService);
    await assignRole(db, { userId: userScopedToA.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId: clientAId });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('RF-PAI-010: exceção criada consolida um alerta EXCECAO_AGUARDANDO; aprovada resolve (§5.2)', async () => {
    const exceptionId = crypto.randomUUID();
    await alertMaterializationService.applyEvent({
      event_id: crypto.randomUUID(),
      event_type: 'seguranca.excecao_criada',
      tenant_id: clientAId,
      warehouse_id: warehouseId,
      payload: { exception_id: exceptionId, exception_type: 'EST.QUEBRA_FEFO', status: 'PENDING' },
    });

    const openAlerts = await alertService.list({ warehouseId, authorizedClientIds: null, status: 'EMITIDO' });
    const alert = openAlerts.find((a) => a.source_entity_id === exceptionId);
    expect(alert).toBeDefined();
    expect(alert?.alert_type).toBe('EXCECAO_AGUARDANDO');
    expect(alert?.severity).toBe('WARN');

    await alertMaterializationService.applyEvent({
      event_id: crypto.randomUUID(),
      event_type: 'seguranca.excecao_aprovada',
      tenant_id: clientAId,
      warehouse_id: warehouseId,
      payload: { exception_id: exceptionId, status: 'APPROVED' },
    });

    const stillOpen = await alertService.list({ warehouseId, authorizedClientIds: null, status: 'EMITIDO' });
    expect(stillOpen.find((a) => a.source_entity_id === exceptionId)).toBeUndefined();

    const resolved = await alertService.list({ warehouseId, authorizedClientIds: null, status: 'RESOLVIDO' });
    expect(resolved.find((a) => a.source_entity_id === exceptionId)).toBeDefined();
  });

  it('RF-PAI-010: mesmo evento de origem não duplica alerta (dedup por origem, ON CONFLICT)', async () => {
    const exceptionId = crypto.randomUUID();
    const publish = () =>
      alertMaterializationService.applyEvent({
        event_id: crypto.randomUUID(),
        event_type: 'seguranca.excecao_criada',
        tenant_id: clientAId,
        warehouse_id: warehouseId,
        payload: { exception_id: exceptionId, exception_type: 'EST.QUEBRA_FEFO', status: 'PENDING' },
      });
    await publish();
    await publish();
    await publish();

    const alerts = await alertService.list({ warehouseId, authorizedClientIds: null, status: 'EMITIDO' });
    const matches = alerts.filter((a) => a.source_entity_id === exceptionId);
    expect(matches).toHaveLength(1);
  });

  it('RN-EST-014: lote vencido resolve o alerta "a vencer" anterior e abre um CRIT novo', async () => {
    const batchId = crypto.randomUUID();
    await alertMaterializationService.applyEvent({
      event_id: crypto.randomUUID(),
      event_type: 'estoque.lote_a_vencer',
      tenant_id: clientAId,
      warehouse_id: warehouseId,
      payload: { batch_id: batchId, product_id: crypto.randomUUID(), expiration_date: '2026-09-01' },
    });
    await alertMaterializationService.applyEvent({
      event_id: crypto.randomUUID(),
      event_type: 'estoque.lote_vencido_bloqueado',
      tenant_id: clientAId,
      warehouse_id: warehouseId,
      payload: { batch_id: batchId, product_id: crypto.randomUUID() },
    });

    const open = await alertService.list({ warehouseId, authorizedClientIds: null, status: 'EMITIDO' });
    const openForBatch = open.filter((a) => a.source_entity_id === batchId);
    expect(openForBatch).toHaveLength(1);
    expect(openForBatch[0].alert_type).toBe('LOTE_VENCIDO');
    expect(openForBatch[0].severity).toBe('CRIT');
  });

  it('RN-SEG-011: usuário restrito ao cliente A não vê alerta do cliente B', async () => {
    const exceptionIdA = crypto.randomUUID();
    const exceptionIdB = crypto.randomUUID();
    await alertMaterializationService.applyEvent({
      event_id: crypto.randomUUID(),
      event_type: 'seguranca.excecao_criada',
      tenant_id: clientAId,
      warehouse_id: warehouseId,
      payload: { exception_id: exceptionIdA, exception_type: 'EST.QUEBRA_FEFO', status: 'PENDING' },
    });
    await alertMaterializationService.applyEvent({
      event_id: crypto.randomUUID(),
      event_type: 'seguranca.excecao_criada',
      tenant_id: clientBId,
      warehouse_id: warehouseId,
      payload: { exception_id: exceptionIdB, exception_type: 'EST.QUEBRA_FEFO', status: 'PENDING' },
    });

    const alerts = await alertService.list({ warehouseId, authorizedClientIds: [clientAId], status: 'EMITIDO' });
    const ids = alerts.map((a) => a.source_entity_id);
    expect(ids).toContain(exceptionIdA);
    expect(ids).not.toContain(exceptionIdB);
  });

  it('RF-PAI-010: marcar lido — badge de não-lidos decresce', async () => {
    const exceptionId = crypto.randomUUID();
    const { alertId } = await alertService.create({
      tenantId: clientAId,
      warehouseId,
      severity: 'WARN',
      alertType: 'EXCECAO_AGUARDANDO',
      title: 'Teste badge',
      sourceEntity: 'operational_exception',
      sourceEntityId: exceptionId,
    });

    const before = await alertService.countUnread(warehouseId, [clientAId], userScopedToA.id);
    await alertService.markRead(alertId as string, userScopedToA.id, clientAId, warehouseId);
    const after = await alertService.countUnread(warehouseId, [clientAId], userScopedToA.id);

    expect(after).toBe(before - 1);
  });

  it('RF-PAI-010: list() com userId (LEFT JOIN alert_read) não quebra por coluna ambígua — is_read reflete markRead', async () => {
    // wms.alert_read TAMBÉM tem warehouse_id/tenant_id (RLS própria, migration
    // 0055) — list() SEM userId nunca faz o LEFT JOIN, então os testes acima
    // nunca exercitam essa combinação; o controller real sempre passa userId.
    const exceptionId = crypto.randomUUID();
    const { alertId } = await alertService.create({
      tenantId: clientAId,
      warehouseId,
      severity: 'WARN',
      alertType: 'EXCECAO_AGUARDANDO',
      title: 'Teste list() com userId',
      sourceEntity: 'operational_exception',
      sourceEntityId: exceptionId,
    });

    const beforeRead = await alertService.list({ warehouseId, authorizedClientIds: [clientAId], status: 'EMITIDO', userId: userScopedToA.id });
    const beforeRow = beforeRead.find((a) => a.id === alertId);
    expect(beforeRow?.is_read).toBe(false);

    await alertService.markRead(alertId as string, userScopedToA.id, clientAId, warehouseId);

    const afterRead = await alertService.list({ warehouseId, authorizedClientIds: [clientAId], status: 'EMITIDO', userId: userScopedToA.id });
    const afterRow = afterRead.find((a) => a.id === alertId);
    expect(afterRow?.is_read).toBe(true);
  });
});
