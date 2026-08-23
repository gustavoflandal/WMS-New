// DOC-03 §6 Cenário "Divergência de lacre" (RF-POR-041).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode } from '../../cadastro/__tests__/test-helpers.js';
import { setupPortariaServices, PortariaServices, generateValidCpf, randomMercosulPlate, buildTimeWindow } from './test-helpers.js';
import { SEED_ACTOR_ID } from '../../../core/__tests__/security-test-helpers.js';

describe('Portaria - DOC-03 §6 Divergência de lacre (RF-POR-041)', () => {
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
      { code: randomWarehouseCode(), name: 'Armazém lacre', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente lacre', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'Y01','WAITING',$2)`,
      [warehouseId, SEED_ACTOR_ID]
    );

    // RF-POR-041 exige conferência de lacre quando POR.EXIGE_LACRE_SAIDA
    // está ativo. test-setup.helper.ts (setupIntegrationTest -> cleanTestData)
    // executa `DELETE FROM wms.app_parameter` a CADA arquivo de teste, depois
    // das migrations rodarem — ou seja, os valores semeados pelas migrations
    // 0021/0023 NUNCA sobrevivem no ambiente de teste de integração; todo
    // código que os lê cai no fallback hardcoded do próprio service (bug de
    // infraestrutura de teste pré-existente, não desta sessão — documentado
    // no relatório). Por isso o parâmetro é inserido aqui diretamente, no
    // mesmo padrão já usado por lpn-generation.integration.spec.ts (Sessão 2B)
    // para GS1_PREFIX, em vez de um UPDATE que encontraria zero linhas.
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', 'POR.EXIGE_LACRE_SAIDA', 'true')`
    );
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('lacre registrado "L-778899" diverge do lacre físico conferido "L-778890": abre POR.DIVERGENCIA_LACRE e bloqueia o gate-out', async () => {
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
        driver: { cpf: generateValidCpf(), name: 'Motorista Lacre', cnh: 'CNHLAC001', cnh_validity: '2030-01-01' },
        appointment_id: appointment.id,
      },
      SEED_ACTOR_ID
    );

    // Simula: lacre "L-778899" já registrado (ex.: no carregamento, DOC-06 —
    // fora de escopo desta sessão) e Fluxo Operacional já concluído, para
    // isolar APENAS a divergência de lacre como pendência.
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `UPDATE wms.vehicle_visit SET seals_out = ARRAY['L-778899'], operation_flow_completed = TRUE WHERE id = $1`,
      [visit.id]
    );

    await expect(
      services.gateOutService.requestGateOut(visit.id, { tenant_id: clientId, warehouse_id: warehouseId, checked_seal: 'L-778890' }, SEED_ACTOR_ID)
    ).rejects.toMatchObject({
      response: {
        error: 'GATE_OUT_BLOCKED',
        pendencies: expect.arrayContaining([expect.objectContaining({ code: 'SEAL_MISMATCH' })]),
      },
    });

    const exceptionResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.operational_exception WHERE entity = 'vehicle_visit' AND entity_id = $1 AND exception_type = 'POR.DIVERGENCIA_LACRE'`,
      [visit.id]
    );
    expect(exceptionResult.rows).toHaveLength(1);
    expect(['PENDING', 'ESCALATED']).toContain(exceptionResult.rows[0].status);

    // Gate-out permanece bloqueado até a decisão (RN-POR-040 item 3: exceção pendente).
    const stillVisit = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT status FROM wms.vehicle_visit WHERE id = $1`,
      [visit.id]
    );
    expect(stillVisit.rows[0].status).not.toBe('ENCERRADA');
  });
});
