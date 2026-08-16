// DOC-03 §6 Cenário "Chegada fora da janela com tolerância excedida".
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

describe('Portaria - DOC-03 §6 Chegada fora da janela com tolerância excedida', () => {
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
      { code: randomWarehouseCode(), name: 'Armazém fora da janela', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente fora da janela', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'Y01','WAITING',$2)`,
      [warehouseId, SEED_ACTOR_ID]
    );
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('janela 08:00-09:00 (equivalente), tolerância 60min, chegada 135min após o fim: abre POR.FORA_DA_JANELA, AGUARDANDO_AUTORIZACAO', async () => {
    const now = new Date();
    // Janela terminou há 135 minutos — excede a tolerância padrão de 60min (RN-POR-004/012).
    const windowEnd = new Date(now.getTime() - 135 * 60000);
    const windowStart = new Date(windowEnd.getTime() - 60 * 60000);

    const windowConfig = await services.windowConfigService.create(
      {
        warehouse_id: warehouseId,
        weekday: windowStart.getDay(),
        start_time: fmtTime(windowStart),
        end_time: fmtTime(windowEnd),
        direction: 'INBOUND',
        capacity: 5,
      },
      SEED_ACTOR_ID
    );

    const appointment = await services.appointmentService.create(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        window_config_id: windowConfig.id,
        window_date: fmtDate(windowStart),
        vehicle_type: 'TRUCK',
      },
      SEED_ACTOR_ID
    );

    const visit = await services.gateInService.registerGateIn(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        plate: randomMercosulPlate(),
        vehicle_type: 'TRUCK',
        driver: { cpf: generateValidCpf(), name: 'Motorista Atrasado', cnh: 'CNH999999', cnh_validity: '2030-01-01' },
        appointment_id: appointment.id,
      },
      SEED_ACTOR_ID
    );

    expect(visit.status).toBe('AGUARDANDO_AUTORIZACAO');
    expect(visit.blocking_reason).toBe('FORA_DA_JANELA');
    expect(visit.yard_slot_id).toBeNull();

    // Exceção POR.FORA_DA_JANELA aberta e vinculada à visita.
    const exceptionResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.operational_exception WHERE entity = 'vehicle_visit' AND entity_id = $1`,
      [visit.id]
    );
    expect(exceptionResult.rows).toHaveLength(1);
    expect(exceptionResult.rows[0].exception_type).toBe('POR.FORA_DA_JANELA');
    expect(['PENDING', 'ESCALATED']).toContain(exceptionResult.rows[0].status);
  });
});
