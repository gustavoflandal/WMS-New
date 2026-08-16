// DOC-03 §6 Cenário "Veículo sem agendamento recusado".
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode } from '../../cadastro/__tests__/test-helpers.js';
import { setupPortariaServices, PortariaServices, generateValidCpf, randomMercosulPlate } from './test-helpers.js';
import { createTestUser, assignRole, SEED_ACTOR_ID } from '../../../core/__tests__/security-test-helpers.js';

describe('Portaria - DOC-03 §6 Veículo sem agendamento recusado', () => {
  let testContext: TestContext;
  let services: PortariaServices;
  let warehouseId: string;
  let clientId: string;
  let approverId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    const passwordService = new PasswordService(testContext.databaseService);
    const warehouseService = new WarehouseService(testContext.databaseService, auditService);
    const clientService = new ClientService(testContext.databaseService, auditService);
    services = setupPortariaServices(testContext.databaseService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém sem agendamento', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente sem agendamento', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'Y01','WAITING',$2)`,
      [warehouseId, SEED_ACTOR_ID]
    );

    // GESTOR_ARMAZEM: já tem SEG.APROVACAO_EXCECAO desde a Sessão 3 (migration 0016).
    const approver = await createTestUser(testContext.databaseService, passwordService);
    approverId = approver.id;
    await assignRole(testContext.databaseService, { userId: approverId, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('gate-in sem appointment_id abre POR.VEICULO_SEM_AGENDAMENTO; rejeitada -> visita RECUSADO, nenhuma vaga ocupada', async () => {
    const visit = await services.gateInService.registerGateIn(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        plate: randomMercosulPlate(),
        vehicle_type: 'TRUCK',
        driver: { cpf: generateValidCpf(), name: 'Motorista Sem Agenda', cnh: 'CNH000111', cnh_validity: '2030-01-01' },
      },
      SEED_ACTOR_ID
    );

    expect(visit.status).toBe('AGUARDANDO_AUTORIZACAO');
    expect(visit.blocking_reason).toBe('SEM_AGENDAMENTO');
    expect(visit.yard_slot_id).toBeNull();

    const exceptionResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.operational_exception WHERE entity = 'vehicle_visit' AND entity_id = $1`,
      [visit.id]
    );
    expect(exceptionResult.rows).toHaveLength(1);
    const exception = exceptionResult.rows[0];
    expect(exception.exception_type).toBe('POR.VEICULO_SEM_AGENDAMENTO');

    // Decisão: REJECT por um aprovador distinto do solicitante (RN-SEG-043).
    await services.operationalExceptionService.decide(exception.id, clientId, warehouseId, approverId, 'REJECT', 'Sem justificativa aceitável');

    const resumed = await services.gateInService.resumeAfterExceptionDecision(visit.id, clientId, warehouseId, approverId);

    expect(resumed.status).toBe('RECUSADO');

    // Nenhuma vaga de pátio deve ter sido ocupada.
    const slotsResult = await testContext.databaseService.queryGlobal('SELECT * FROM wms.yard_slot WHERE warehouse_id = $1', [warehouseId]);
    expect(slotsResult.rows.every((s: { status: string }) => s.status === 'FREE')).toBe(true);
  });
});
