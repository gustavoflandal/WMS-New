// DOC-03 RF-POR-020 — decisão de negócio registrada no fechamento da Sessão
// 4: a fila de pátio é um recurso FÍSICO do armazém, compartilhado por
// TODOS os clientes que operam ali — o porteiro precisa ver a fila inteira
// para gerenciar o pátio. Isso é intencional e legítimo (não uma falha de
// RN-SEG-011), MAS só para quem tem POR.FILA_CONSULTAR (WAREHOUSE,
// migration 0032) — nunca para papéis de cliente. Este teste prova as duas
// pontas: (1) o porteiro vê veículos de clientes DIFERENTES na mesma fila;
// (2) quem não tem a permissão é negado; (3) a listagem nunca expõe dado de
// estoque/pedido de nenhum cliente (a query não faz join com essas tabelas).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode } from '../../cadastro/__tests__/test-helpers.js';
import { setupPortariaServices, PortariaServices, generateValidCpf, randomMercosulPlate } from './test-helpers.js';
import { createTestUser, assignRole, SEED_ACTOR_ID } from '../../../core/__tests__/security-test-helpers.js';

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtTime(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

describe('Portaria - DOC-03 RF-POR-020 fila cross-tenant é decisão de negócio deliberada, gated por POR.FILA_CONSULTAR', () => {
  let testContext: TestContext;
  let services: PortariaServices;
  let rbacService: RbacService;
  let warehouseId: string;
  let clientAId: string;
  let clientBId: string;
  let porteiroId: string;
  let clienteOperacaoId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    const passwordService = new PasswordService(testContext.databaseService);
    const warehouseService = new WarehouseService(testContext.databaseService, auditService);
    const clientService = new ClientService(testContext.databaseService, auditService);
    services = setupPortariaServices(testContext.databaseService);
    rbacService = new RbacService(testContext.databaseService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém fila multi-cliente', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;

    const clientA = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente A da fila', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientAId = clientA.id;
    const clientB = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente B da fila', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientBId = clientB.id;

    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'Y01','WAITING',$2)`,
      [warehouseId, SEED_ACTOR_ID]
    );
    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'Y02','WAITING',$2)`,
      [warehouseId, SEED_ACTOR_ID]
    );

    // POR.FILA_CONSULTAR concedida ao PORTEIRO (migration 0032).
    const porteiro = await createTestUser(testContext.databaseService, passwordService);
    porteiroId = porteiro.id;
    await assignRole(testContext.databaseService, { userId: porteiroId, roleCode: 'PORTEIRO', warehouseId });

    // CLIENTE_OPERACAO NÃO recebe POR.FILA_CONSULTAR — não deve enxergar a fila do armazém.
    const clienteOperacao = await createTestUser(testContext.databaseService, passwordService, { area: 'CLIENT_PORTAL', clientId: clientAId });
    clienteOperacaoId = clienteOperacao.id;
    await assignRole(testContext.databaseService, { userId: clienteOperacaoId, roleCode: 'CLIENTE_OPERACAO', warehouseId, clientId: clientAId });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('porteiro com POR.FILA_CONSULTAR vê veículos de clientes DIFERENTES na mesma fila do armazém', async () => {
    const now = new Date();
    const start = new Date(now.getTime() - 60 * 60000);
    const end = new Date(now.getTime() + 60 * 60000);
    const windowConfig = await services.windowConfigService.create(
      { warehouse_id: warehouseId, weekday: now.getDay(), start_time: fmtTime(start), end_time: fmtTime(end), direction: 'INBOUND', capacity: 10 },
      SEED_ACTOR_ID
    );

    const apptA = await services.appointmentService.create(
      { tenant_id: clientAId, warehouse_id: warehouseId, direction: 'INBOUND', window_config_id: windowConfig.id, window_date: fmtDate(now), vehicle_type: 'TRUCK' },
      SEED_ACTOR_ID
    );
    const visitA = await services.gateInService.registerGateIn(
      {
        tenant_id: clientAId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        plate: randomMercosulPlate(),
        vehicle_type: 'TRUCK',
        driver: { cpf: generateValidCpf(), name: 'Motorista Cliente A', cnh: 'CNHCTA001', cnh_validity: '2030-01-01' },
        appointment_id: apptA.id,
      },
      SEED_ACTOR_ID
    );
    expect(visitA.status).toBe('NO_PATIO');

    const apptB = await services.appointmentService.create(
      { tenant_id: clientBId, warehouse_id: warehouseId, direction: 'INBOUND', window_config_id: windowConfig.id, window_date: fmtDate(now), vehicle_type: 'TRUCK' },
      SEED_ACTOR_ID
    );
    const visitB = await services.gateInService.registerGateIn(
      {
        tenant_id: clientBId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        plate: randomMercosulPlate(),
        vehicle_type: 'TRUCK',
        driver: { cpf: generateValidCpf(), name: 'Motorista Cliente B', cnh: 'CNHCTB001', cnh_validity: '2030-01-01' },
        appointment_id: apptB.id,
      },
      SEED_ACTOR_ID
    );
    expect(visitB.status).toBe('NO_PATIO');

    // (1) POR.FILA_CONSULTAR concede a visão cross-tenant, deliberadamente.
    const porteiroCanView = await rbacService.hasPermission(porteiroId, 'POR.FILA_CONSULTAR', { warehouseId });
    expect(porteiroCanView).toBe(true);

    const queue = await services.yardQueueService.listQueue(warehouseId, 'INBOUND');
    const tenantIdsInQueue = new Set(queue.map((q: any) => q.tenant_id));
    expect(tenantIdsInQueue.has(clientAId)).toBe(true);
    expect(tenantIdsInQueue.has(clientBId)).toBe(true);
    expect(queue.some((q: any) => q.vehicle_visit_id === visitA.id)).toBe(true);
    expect(queue.some((q: any) => q.vehicle_visit_id === visitB.id)).toBe(true);

    // (2) CLIENTE_OPERACAO (papel de portal, vinculado só ao cliente A) NÃO
    // tem POR.FILA_CONSULTAR — RN-SEG-012 nega por padrão.
    const clienteCanView = await rbacService.hasPermission(clienteOperacaoId, 'POR.FILA_CONSULTAR', { warehouseId });
    expect(clienteCanView).toBe(false);

    // (3) A listagem da fila nunca inclui dado de estoque/pedido — a query
    // de listQueue() só faz JOIN com vehicle_visit/vehicle (RF-POR-020), sem
    // tocar wms.stock_balance/wms.product/pedidos de nenhum cliente.
    const forbiddenKeys = ['sku', 'product_id', 'stock_balance', 'qty_available', 'order_id', 'order_reference'];
    for (const entry of queue) {
      for (const key of forbiddenKeys) {
        expect(Object.prototype.hasOwnProperty.call(entry, key)).toBe(false);
      }
    }
  });
});
