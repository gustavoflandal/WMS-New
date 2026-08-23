// DOC-03 §6 Cenário "Bloqueio de gate-out com pendência" (RN-POR-040 [INVIOLÁVEL]).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode } from '../../cadastro/__tests__/test-helpers.js';
import { setupPortariaServices, PortariaServices, generateValidCpf, randomMercosulPlate, buildTimeWindow } from './test-helpers.js';
import { createTestUser, assignRole, grantApprovalAuthority, SEED_ACTOR_ID } from '../../../core/__tests__/security-test-helpers.js';

describe('Portaria - DOC-03 §6 Bloqueio de gate-out com pendência (RN-POR-040 [INVIOLÁVEL])', () => {
  let testContext: TestContext;
  let services: PortariaServices;
  let warehouseId: string;
  let clientId: string;
  let approver1Id: string;
  let approver2Id: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    const passwordService = new PasswordService(testContext.databaseService);
    const warehouseService = new WarehouseService(testContext.databaseService, auditService);
    const clientService = new ClientService(testContext.databaseService, auditService);
    services = setupPortariaServices(testContext.databaseService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém gate-out bloqueio', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente gate-out bloqueio', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'Y01','WAITING',$2)`,
      [warehouseId, SEED_ACTOR_ID]
    );

    // RN-POR-040/POR.SAIDA_COM_PENDENCIA exige 2 aprovadores DISTINTOS
    // (RN-SEG-043, default_steps=2 desde a migration 0023) — GESTOR_ARMAZEM
    // e LIDER_TURNO ambos têm SEG.APROVACAO_EXCECAO.
    const approver1 = await createTestUser(testContext.databaseService, passwordService);
    approver1Id = approver1.id;
    await assignRole(testContext.databaseService, { userId: approver1Id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
    const approver2 = await createTestUser(testContext.databaseService, passwordService);
    approver2Id = approver2.id;
    await assignRole(testContext.databaseService, { userId: approver2Id, roleCode: 'LIDER_TURNO', warehouseId, clientId });

    // Alçada configurada para os dois papéis (sem limite) — sem isso a
    // exceção escalaria (RN-SEG-021: "sem alçada configurada = excede
    // tudo"), e uma exceção ESCALATED só pode ser decidida por
    // GESTOR_ARMAZEM em qualquer passo (operational-exception.service.ts),
    // impedindo o segundo aprovador de ser LIDER_TURNO como pretende este
    // teste (2 aprovadores DISTINTOS, não necessariamente do mesmo papel).
    await grantApprovalAuthority(testContext.databaseService, { roleCode: 'GESTOR_ARMAZEM', exceptionType: 'POR.SAIDA_COM_PENDENCIA', warehouseId, maxQty: null, maxValueBrl: null });
    await grantApprovalAuthority(testContext.databaseService, { roleCode: 'LIDER_TURNO', exceptionType: 'POR.SAIDA_COM_PENDENCIA', warehouseId, maxQty: null, maxValueBrl: null });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('visita outbound com etapa Carregamento pendente: gate-out bloqueado listando a pendência; saída forçada exige POR.SAIDA_COM_PENDENCIA com 2 aprovadores distintos', async () => {
    const window = buildTimeWindow(-60, 60);
    const windowConfig = await services.windowConfigService.create(
      { warehouse_id: warehouseId, weekday: window.weekday, start_time: window.start_time, end_time: window.end_time, direction: 'OUTBOUND', capacity: 5 },
      SEED_ACTOR_ID
    );
    const appointment = await services.appointmentService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, direction: 'OUTBOUND', window_config_id: windowConfig.id, window_date: window.window_date, vehicle_type: 'TRUCK' },
      SEED_ACTOR_ID
    );

    const visit = await services.gateInService.registerGateIn(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'OUTBOUND',
        plate: randomMercosulPlate(),
        vehicle_type: 'TRUCK',
        driver: { cpf: generateValidCpf(), name: 'Motorista Outbound', cnh: 'CNHOUT001', cnh_validity: '2030-01-01' },
        appointment_id: appointment.id,
      },
      SEED_ACTOR_ID
    );
    expect(visit.status).toBe('NO_PATIO');
    // operation_flow_completed permanece FALSE por padrão — "Carregamento pendente" (RN-POR-040 item 1).

    await expect(services.gateOutService.requestGateOut(visit.id, { tenant_id: clientId, warehouse_id: warehouseId }, SEED_ACTOR_ID)).rejects.toMatchObject({
      response: {
        error: 'GATE_OUT_BLOCKED',
        pendencies: expect.arrayContaining([expect.objectContaining({ code: 'OPERATION_FLOW_PENDING', detail: 'Carregamento pendente' })]),
      },
    });

    // Saída forçada: abre POR.SAIDA_COM_PENDENCIA (2 passos).
    const exception = await services.gateOutService.requestForcedGateOut(visit.id, clientId, warehouseId, 'Cliente autorizou retirada mesmo com pendência documental', SEED_ACTOR_ID);
    expect(exception.status).toBe('PENDING');

    const typeResult = await testContext.databaseService.queryGlobal(`SELECT default_steps FROM wms.exception_type WHERE code = 'POR.SAIDA_COM_PENDENCIA'`);
    expect(typeResult.rows[0].default_steps).toBe(2);

    // Passo 1: approver1 aprova -> ainda PENDING (falta o passo 2, aprovador distinto).
    const afterStep1 = await services.operationalExceptionService.decide(exception.id, clientId, warehouseId, approver1Id, 'APPROVE', 'Passo 1: confirmo liberação comercial');
    expect(afterStep1.status).toBe('PENDING');
    expect(afterStep1.current_step).toBe(2);

    // approver1 tentando decidir de novo (mesmo passo diferente): negado (RN-SEG-043).
    await expect(
      services.operationalExceptionService.decide(exception.id, clientId, warehouseId, approver1Id, 'APPROVE', 'Tentando decidir de novo')
    ).rejects.toBeTruthy();

    // Passo 2: approver2 (distinto) aprova -> finaliza APPROVED.
    const final = await services.operationalExceptionService.decide(exception.id, clientId, warehouseId, approver2Id, 'APPROVE', 'Passo 2: autorizado');
    expect(final.status).toBe('APPROVED');

    // Conclusão da saída forçada.
    const completed = await services.gateOutService.completeForcedGateOutAfterApproval(visit.id, clientId, warehouseId, approver2Id);
    expect(completed.status).toBe('ENCERRADA');
  });
});
