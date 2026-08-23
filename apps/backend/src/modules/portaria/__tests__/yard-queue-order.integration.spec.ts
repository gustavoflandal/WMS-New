// DOC-03 §6 Cenário "Ordem determinística da fila" (RN-POR-021, exemplo
// normativo — pesos padrão P1=4 P2=3 P3=2 P4=8; A=7, B=2, C=12; ordem C,A,B
// — valor de regressão permanente, não alterado aqui).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode } from '../../cadastro/__tests__/test-helpers.js';
import { setupPortariaServices, PortariaServices, generateValidCpf, randomMercosulPlate, buildTimeWindow } from './test-helpers.js';
import { createTestUser, assignRole, SEED_ACTOR_ID } from '../../../core/__tests__/security-test-helpers.js';

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtTime(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

describe('Portaria - DOC-03 §6 Ordem determinística da fila (RN-POR-021)', () => {
  let testContext: TestContext;
  let services: PortariaServices;
  let warehouseId: string;
  let clientId: string;
  let prioritizerId: string;
  let approverId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    const passwordService = new PasswordService(testContext.databaseService);
    const warehouseService = new WarehouseService(testContext.databaseService, auditService);
    const clientService = new ClientService(testContext.databaseService, auditService);
    services = setupPortariaServices(testContext.databaseService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém fila', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente fila', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'Y01','WAITING',$2)`,
      [warehouseId, SEED_ACTOR_ID]
    );
    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'Y02','WAITING',$2)`,
      [warehouseId, SEED_ACTOR_ID]
    );
    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'HZ01','HAZMAT',$2)`,
      [warehouseId, SEED_ACTOR_ID]
    );

    // LIDER_TURNO: POR.FILA_PRIORIZAR (migration 0023). GESTOR_ARMAZEM: SEG.APROVACAO_EXCECAO (migration 0016).
    const prioritizer = await createTestUser(testContext.databaseService, passwordService);
    prioritizerId = prioritizer.id;
    await assignRole(testContext.databaseService, { userId: prioritizerId, roleCode: 'LIDER_TURNO', warehouseId, clientId });

    const approver = await createTestUser(testContext.databaseService, passwordService);
    approverId = approver.id;
    await assignRole(testContext.databaseService, { userId: approverId, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('pesos padrão: A (no horário, perecível)=7, B (fora da janela, hazmat)=2, C (no horário, prioridade manual)=12 — ordem C, A, B', async () => {
    const now = new Date();
    const window = buildTimeWindow(-60, 60, now);
    const windowConfig = await services.windowConfigService.create(
      { warehouse_id: warehouseId, weekday: window.weekday, start_time: window.start_time, end_time: window.end_time, direction: 'INBOUND', capacity: 10 },
      SEED_ACTOR_ID
    );

    // Veículo A: no horário + perecível.
    const apptA = await services.appointmentService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, direction: 'INBOUND', window_config_id: windowConfig.id, window_date: window.window_date, vehicle_type: 'TRUCK', contains_perishable: true },
      SEED_ACTOR_ID
    );
    const visitA = await services.gateInService.registerGateIn(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        plate: randomMercosulPlate(),
        vehicle_type: 'TRUCK',
        driver: { cpf: generateValidCpf(), name: 'Motorista A', cnh: 'CNHAAA111', cnh_validity: '2030-01-01' },
        appointment_id: apptA.id,
      },
      SEED_ACTOR_ID
    );
    expect(visitA.status).toBe('NO_PATIO');

    // Veículo B: fora da janela (135min após o fim de uma janela distinta) + hazmat, aprovado depois.
    const windowEndB = new Date(now.getTime() - 135 * 60000);
    const windowStartB = new Date(windowEndB.getTime() - 60 * 60000);
    const windowConfigB = await services.windowConfigService.create(
      { warehouse_id: warehouseId, weekday: windowStartB.getDay(), start_time: fmtTime(windowStartB), end_time: fmtTime(windowEndB), direction: 'INBOUND', capacity: 10 },
      SEED_ACTOR_ID
    );
    const apptB = await services.appointmentService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, direction: 'INBOUND', window_config_id: windowConfigB.id, window_date: fmtDate(windowStartB), vehicle_type: 'TANQUE', contains_hazmat: true },
      SEED_ACTOR_ID
    );
    const visitB = await services.gateInService.registerGateIn(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        plate: randomMercosulPlate(),
        vehicle_type: 'TANQUE',
        driver: { cpf: generateValidCpf(), name: 'Motorista B', cnh: 'CNHBBB222', cnh_validity: '2030-01-01' },
        appointment_id: apptB.id,
        hazmat_checklist_confirmed: true,
      },
      SEED_ACTOR_ID
    );
    expect(visitB.status).toBe('AGUARDANDO_AUTORIZACAO');
    expect(visitB.blocking_reason).toBe('FORA_DA_JANELA');

    const exceptionBResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.operational_exception WHERE entity = 'vehicle_visit' AND entity_id = $1`,
      [visitB.id]
    );
    await services.operationalExceptionService.decide(exceptionBResult.rows[0].id, clientId, warehouseId, approverId, 'APPROVE', 'Atraso justificado pelo cliente');
    const resumedB = await services.gateInService.resumeAfterExceptionDecision(visitB.id, clientId, warehouseId, approverId);
    expect(resumedB.status).toBe('NO_PATIO');

    // Veículo C: no horário, sem perecível/hazmat — prioridade manual aplicada depois via POR.FILA_PRIORIZAR.
    const apptC = await services.appointmentService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, direction: 'INBOUND', window_config_id: windowConfig.id, window_date: fmtDate(now), vehicle_type: 'TRUCK' },
      SEED_ACTOR_ID
    );
    const visitC = await services.gateInService.registerGateIn(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        plate: randomMercosulPlate(),
        vehicle_type: 'TRUCK',
        driver: { cpf: generateValidCpf(), name: 'Motorista C', cnh: 'CNHCCC333', cnh_validity: '2030-01-01' },
        appointment_id: apptC.id,
      },
      SEED_ACTOR_ID
    );
    expect(visitC.status).toBe('NO_PATIO');

    const entryCResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT id FROM wms.yard_queue_entry WHERE vehicle_visit_id = $1`,
      [visitC.id]
    );
    await services.yardQueueService.setManualPriority(entryCResult.rows[0].id, warehouseId, 'Cliente VIP — liberação prioritária', prioritizerId);

    // Verifica os 3 scores e a ordem final da fila.
    const queue = await services.yardQueueService.listQueue(warehouseId, 'INBOUND');
    const byVisit = new Map(queue.map((q: any) => [q.vehicle_visit_id, q]));

    expect(Number(byVisit.get(visitA.id).score)).toBe(7);
    expect(Number(byVisit.get(visitB.id).score)).toBe(2);
    expect(Number(byVisit.get(visitC.id).score)).toBe(12);

    const orderedIds = queue.map((q: any) => q.vehicle_visit_id);
    const positionOf = (id: string) => orderedIds.indexOf(id);
    expect(positionOf(visitC.id)).toBeLessThan(positionOf(visitA.id));
    expect(positionOf(visitA.id)).toBeLessThan(positionOf(visitB.id));
  });
});
