// DOC-03 §6 Cenário "Hazmat exige vaga dedicada" (RN-POR-013 [INVIOLÁVEL]).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode } from '../../cadastro/__tests__/test-helpers.js';
import { setupPortariaServices, PortariaServices, generateValidCpf, randomMercosulPlate } from './test-helpers.js';
import { SEED_ACTOR_ID } from '../../../core/__tests__/security-test-helpers.js';

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtTime(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

describe('Portaria - DOC-03 §6 Hazmat exige vaga dedicada (RN-POR-013 [INVIOLÁVEL])', () => {
  let testContext: TestContext;
  let services: PortariaServices;
  let warehouseId: string;
  let clientId: string;
  let hazmatSlotId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    const warehouseService = new WarehouseService(testContext.databaseService, auditService);
    const clientService = new ClientService(testContext.databaseService, auditService);
    services = setupPortariaServices(testContext.databaseService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém hazmat', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente hazmat', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    // Única vaga HAZMAT do armazém, já OCUPADA (simula "todas as vagas HAZMAT ocupadas").
    const slotResult = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, status, created_by) VALUES ($1,'HZ01','HAZMAT','OCCUPIED',$2) RETURNING id`,
      [warehouseId, SEED_ACTOR_ID]
    );
    hazmatSlotId = slotResult.rows[0].id;
    // Vaga comum também presente (não deve ser usada por um veículo HAZMAT).
    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'Y01','WAITING',$2)`,
      [warehouseId, SEED_ACTOR_ID]
    );
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('sem vaga HAZMAT livre: permanece AGUARDANDO_AUTORIZACAO, alerta publicado; ao liberar a vaga, conclui somente nela', async () => {
    const now = new Date();
    const start = new Date(now.getTime() - 60 * 60000);
    const end = new Date(now.getTime() + 60 * 60000);

    const windowConfig = await services.windowConfigService.create(
      { warehouse_id: warehouseId, weekday: now.getDay(), start_time: fmtTime(start), end_time: fmtTime(end), direction: 'INBOUND', capacity: 5 },
      SEED_ACTOR_ID
    );
    const appointment = await services.appointmentService.create(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        window_config_id: windowConfig.id,
        window_date: fmtDate(now),
        vehicle_type: 'TRUCK',
        contains_hazmat: true, // [LACUNA §4.1/§7: sem ASN real — declarado explicitamente]
      },
      SEED_ACTOR_ID
    );

    const visit = await services.gateInService.registerGateIn(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        plate: randomMercosulPlate(),
        vehicle_type: 'TANQUE',
        driver: { cpf: generateValidCpf(), name: 'Motorista Hazmat', cnh: 'CNH777888', cnh_validity: '2030-01-01' },
        appointment_id: appointment.id,
        hazmat_checklist_confirmed: true,
      },
      SEED_ACTOR_ID
    );

    expect(visit.status).toBe('AGUARDANDO_AUTORIZACAO');
    expect(visit.blocking_reason).toBe('SEM_VAGA_HAZMAT');
    expect(visit.yard_slot_id).toBeNull();

    // Alerta publicado no tópico "alertas" (via event_type portaria.vaga_indisponivel).
    const eventResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.event_outbox WHERE event_type = 'portaria.vaga_indisponivel' AND payload->>'vehicle_visit_id' = $1`,
      [visit.id]
    );
    expect(eventResult.rows).toHaveLength(1);
    expect(eventResult.rows[0].payload.hazmat).toBe(true);

    // Libera a vaga HAZMAT e tenta novamente: agora deve concluir, e SOMENTE na vaga HAZMAT.
    await testContext.databaseService.queryGlobal(`UPDATE wms.yard_slot SET status = 'FREE' WHERE id = $1`, [hazmatSlotId]);

    const retried = await services.gateInService.retrySlotAllocation(visit.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(retried.status).toBe('NO_PATIO');
    expect(retried.yard_slot_id).toBe(hazmatSlotId);
  });
});
