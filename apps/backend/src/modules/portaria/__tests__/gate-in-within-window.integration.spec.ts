// DOC-03 §6 Cenário "Gate-in dentro da janela".
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode } from '../../cadastro/__tests__/test-helpers.js';
import { setupPortariaServices, PortariaServices, generateValidCpf, randomMercosulPlate, buildTimeWindow } from './test-helpers.js';
import { SEED_ACTOR_ID } from '../../../core/__tests__/security-test-helpers.js';

// GateInService compara janelas com `new Date(`${window_date}T${end_time}`)`
// (sem 'Z' — interpretado como horário LOCAL do processo). O fixture
// precisa construir window_date/start_time/end_time todos em horário LOCAL
// também, para não misturar data UTC (toISOString) com hora local
// (toTimeString), que diverge sempre que o timezone do processo != UTC.
function windowCoveringNow(marginMinutes = 60) {
  return buildTimeWindow(-marginMinutes, marginMinutes);
}

describe('Portaria - DOC-03 §6 Gate-in dentro da janela', () => {
  let testContext: TestContext;
  let services: PortariaServices;
  let warehouseId: string;
  let clientId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    const warehouseService = new WarehouseService(testContext.databaseService, auditService);
    const clientService = new ClientService(testContext.databaseService, auditService);
    services = setupPortariaServices(testContext.databaseService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém gate-in janela', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente gate-in janela', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    // Vaga de pátio livre (RF-POR-020) e um dispositivo CANCELA cadastrado
    // (RF-POR-014) — DOC-11 (Sessão 8): edge_agent é GLOBAL (sem tenant_id/
    // RLS, ver migration 0063) e o job real (GATE_OPEN) só é ENVIADO com um
    // Edge Agent CONECTADO de verdade (EdgeAgentConnectionRegistry); este
    // teste não sobe um simulador (isso é coberto pela suíte dedicada de
    // periféricos), então o cenário esperado aqui é o fallback documentado
    // por RF-POR-014: job criado, DEVICE_OFFLINE, manual_required=true.
    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'Y01','WAITING',$2)`,
      [warehouseId, SEED_ACTOR_ID]
    );
    const edgeAgentResult = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.edge_agent (warehouse_id, device_name, token_hash, status) VALUES ($1,'Cancela Gate 1', encode(sha256(gen_random_uuid()::text::bytea),'hex'),'OFFLINE') RETURNING edge_agent_id`,
      [warehouseId]
    );
    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.peripheral_device (warehouse_id, edge_agent_id, device_code, function, driver_code, created_by)
       VALUES ($1,$2,'CANCELA-GATE1','CANCELA','RELE_IP',$3)`,
      [warehouseId, edgeAgentResult.rows[0].edge_agent_id, SEED_ACTOR_ID]
    );
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('AGD-...-00000010 janela hoje, veículo chega às 08:40 (dentro): gate-in sem exceção, vaga livre, job de cancela criado (DEVICE_OFFLINE sem agent conectado)', async () => {
    const window = windowCoveringNow(60);
    const windowConfig = await services.windowConfigService.create(
      { warehouse_id: warehouseId, weekday: window.weekday, start_time: window.start_time, end_time: window.end_time, direction: 'INBOUND', capacity: 5 },
      SEED_ACTOR_ID
    );

    const appointment = await services.appointmentService.create(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        window_config_id: windowConfig.id,
        window_date: window.window_date,
        vehicle_type: 'TRUCK',
      },
      SEED_ACTOR_ID
    );
    expect(appointment.number).toMatch(/^AGD-/);

    const plate = randomMercosulPlate();
    const visit = await services.gateInService.registerGateIn(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        plate,
        vehicle_type: 'TRUCK',
        driver: { cpf: generateValidCpf(), name: 'Motorista Teste', cnh: 'CNH123456', cnh_validity: '2030-01-01' },
        appointment_id: appointment.id,
      },
      SEED_ACTOR_ID
    );

    // Gate-in concluído sem exceção: NO_PATIO, sem blocking_reason.
    expect(visit.status).toBe('NO_PATIO');
    expect(visit.blocking_reason).toBeNull();
    expect(visit.yard_slot_id).not.toBeNull();

    // RF-POR-014: job GATE_OPEN criado; sem Edge Agent conectado de verdade
    // (nenhum simulador nesta suíte), fica FALHA/DEVICE_OFFLINE — a
    // interface deve orientar o fallback manual (ver
    // GateInController.confirmManualCancelaOverride).
    expect(visit.cancela_job_id).not.toBeNull();
    expect(visit.cancela_manual_required).toBe(true);
    const jobResult = await testContext.databaseService.queryGlobal('SELECT * FROM wms.peripheral_job WHERE job_id = $1', [visit.cancela_job_id]);
    expect(jobResult.rows[0].job_type).toBe('GATE_OPEN');
    expect(jobResult.rows[0].state).toBe('FALHA');
    expect(jobResult.rows[0].error_code).toBe('DEVICE_OFFLINE');

    // Vaga sugerida está livre e compatível.
    const slotResult = await testContext.databaseService.queryGlobal('SELECT * FROM wms.yard_slot WHERE id = $1', [visit.yard_slot_id]);
    expect(slotResult.rows[0].status).toBe('OCCUPIED'); // ocupada por ESTA visita, era livre antes da alocação
    expect(slotResult.rows[0].slot_type).toBe('WAITING');

    // Agendamento confirmado.
    const apptResult = await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID }, 'SELECT status FROM wms.appointment WHERE id = $1', [
      appointment.id,
    ]);
    expect(apptResult.rows[0].status).toBe('CONFIRMED_ARRIVAL');
  });
});
