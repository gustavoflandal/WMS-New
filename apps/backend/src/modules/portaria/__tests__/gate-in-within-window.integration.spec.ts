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

    // Vaga de pátio livre (RF-POR-020) e Edge Agent ONLINE (RF-POR-014).
    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'Y01','WAITING',$2)`,
      [warehouseId, SEED_ACTOR_ID]
    );
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `INSERT INTO wms.edge_agent (tenant_id, warehouse_id, device_name, token, status) VALUES ($1,$2,'Cancela Gate 1','tok-' || gen_random_uuid(),'ONLINE')`,
      [clientId, warehouseId]
    );
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('AGD-...-00000010 janela hoje, veículo chega às 08:40 (dentro): gate-in sem exceção, vaga livre e job de cancela enviado', async () => {
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

    // Job de abertura de cancela enviado ao Edge Agent (RF-POR-014).
    expect(visit.cancela_job_id).not.toBeNull();
    const jobResult = await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID }, 'SELECT * FROM wms.edge_agent_job WHERE job_id = $1', [
      visit.cancela_job_id,
    ]);
    expect(jobResult.rows[0].job_type).toBe('CANCELA_ABRIR');

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
