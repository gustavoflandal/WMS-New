// DOC-03 §6 Cenário "No-show libera capacidade" (RN-POR-004).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode } from '../../cadastro/__tests__/test-helpers.js';
import { setupPortariaServices, PortariaServices } from './test-helpers.js';
import { SEED_ACTOR_ID } from '../../../core/__tests__/security-test-helpers.js';
import { NoShowWorkerImpl } from '../../../workers/no-show.worker.impl.js';
import { CacheService } from '../../../core/cache/cache.service.js';

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtTime(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

describe('Portaria - DOC-03 §6 No-show libera capacidade (RN-POR-004)', () => {
  let testContext: TestContext;
  let services: PortariaServices;
  let cacheService: CacheService;
  let warehouseId: string;
  let clientId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest([]);
    const auditService = new AuditService(testContext.databaseService);
    const warehouseService = new WarehouseService(testContext.databaseService, auditService);
    const clientService = new ClientService(testContext.databaseService, auditService);
    services = setupPortariaServices(testContext.databaseService);
    cacheService = new CacheService(testContext.configService);
    await cacheService.onModuleInit();

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém no-show', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente no-show', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('janela com capacidade 1 e 1 agendamento sem chegada: após janela + tolerância, worker marca NO_SHOW e libera a capacidade', async () => {
    const now = new Date();
    // Janela terminou há 90 minutos — excede a tolerância padrão de 60min (RN-POR-004).
    const windowEnd = new Date(now.getTime() - 90 * 60000);
    const windowStart = new Date(windowEnd.getTime() - 60 * 60000);

    const windowConfig = await services.windowConfigService.create(
      {
        warehouse_id: warehouseId,
        weekday: windowStart.getDay(),
        start_time: fmtTime(windowStart),
        end_time: fmtTime(windowEnd),
        direction: 'INBOUND',
        capacity: 1,
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
    expect(appointment.status).toBe('SCHEDULED');

    // Capacidade esgotada: uma segunda tentativa na MESMA janela é rejeitada (RN-POR-002).
    await expect(
      services.appointmentService.create(
        {
          tenant_id: clientId,
          warehouse_id: warehouseId,
          direction: 'INBOUND',
          window_config_id: windowConfig.id,
          window_date: fmtDate(windowStart),
          vehicle_type: 'TRUCK',
        },
        SEED_ACTOR_ID
      )
    ).rejects.toMatchObject({ response: { error: 'WINDOW_FULL' } });

    // Worker de no-show (mesmo padrão de eleição de líder do ExceptionExpiryWorkerImpl).
    const worker = new NoShowWorkerImpl(services.appointmentService, cacheService);
    const result = await worker.runOnce();

    expect(result.ranAsLeader).toBe(true);
    expect(result.noShowIds).toContain(appointment.id);

    const updated = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      'SELECT status FROM wms.appointment WHERE id = $1',
      [appointment.id]
    );
    expect(updated.rows[0].status).toBe('NO_SHOW');

    // Capacidade da janela liberada: uma nova criação na MESMA janela agora é aceita.
    const secondAppointment = await services.appointmentService.create(
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
    expect(secondAppointment.status).toBe('SCHEDULED');

    const occupancyResult = await testContext.databaseService.queryGlobal(
      'SELECT occupied_count FROM wms.appointment_window_occupancy WHERE window_config_id = $1 AND window_date = $2',
      [windowConfig.id, fmtDate(windowStart)]
    );
    expect(occupancyResult.rows[0].occupied_count).toBe(1); // 1 NO_SHOW liberado + 1 novo ocupado = 1
  });
});
