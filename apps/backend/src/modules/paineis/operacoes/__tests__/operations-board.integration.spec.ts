// DOC-10 §4.1 — RF-PAI-001 (conteúdo do painel), RN-SEG-011 (RBAC filtra
// cartões pelos clientes autorizados), RN-PAI-004 (atraso por SLA). Cenário
// Gherkin do §6 "RBAC filtra cartões" coberto ponta a ponta contra Postgres
// real.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../../cadastro/product/product.service.js';
import { DocumentNumberingService } from '../../../cadastro/document-numbering/document-numbering.service.js';
import { AuditService } from '../../../../core/audit/audit.service.js';
import { EventsService } from '../../../../core/events/events.service.js';
import { OperationFlowService } from '../../../../core/operation-flow/operation-flow.service.js';
import { StockSelectionService } from '../../../estoque/selection/stock-selection.service.js';
import { StockReservationService } from '../../../estoque/selection/stock-reservation.service.js';
import { RbacService } from '../../../../core/rbac/rbac.service.js';
import { PasswordService } from '../../../../core/auth/password.service.js';
import { StockMovementService } from '../../../estoque/movement/stock-movement.service.js';
import { OutboundOrderService } from '../../../expedicao/order/outbound-order.service.js';
import { OutboundFlowService } from '../../../expedicao/order/outbound-flow.service.js';
import { OperationsBoardService } from '../operations-board.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole } from '../../../../core/__tests__/security-test-helpers.js';

describe('Painel de Operações - DOC-10 §4.1 (Sessão 7)', () => {
  let testContext: TestContext;
  let boardService: OperationsBoardService;
  let orderService: OutboundOrderService;
  let productService: ProductService;

  let warehouseId: string;
  let clientAId: string;
  let clientBId: string;
  let productAId: string;
  let productBId: string;

  /** PAI.PAINEL_OPERACOES restrito ao cliente A neste armazém. */
  let userScopedToA: { id: string };
  /** PORTEIRO: só permissões WAREHOUSE (nenhuma CLIENT_WAREHOUSE) — pode ser
   * atribuído sem client_id (mesmo papel usado por
   * yard-queue-cross-tenant-visibility.integration.spec.ts para o mesmo
   * propósito: "vê todos os clientes do armazém"). GESTOR_ARMAZEM não serve
   * aqui: acumula permissões CLIENT_WAREHOUSE de outras sessões (RD-SEG-010
   * exige client_id sempre que o papel tiver QUALQUER permissão
   * CLIENT_WAREHOUSE, não só quando todas forem desse escopo). */
  let userUnrestricted: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const rbacService = new RbacService(db);
    const operationFlowService = new OperationFlowService(db);
    const stockMovementService = new StockMovementService(db);
    const selectionService = new StockSelectionService(db);
    const reservationService = new StockReservationService(db, eventsService, auditService, rbacService, selectionService, stockMovementService);
    const documentNumberingService = new DocumentNumberingService(db);
    const passwordService = new PasswordService(db);
    const flowService = new OutboundFlowService(db, eventsService, operationFlowService);
    orderService = new OutboundOrderService(db, eventsService, auditService, documentNumberingService, selectionService, reservationService, flowService);
    boardService = new OperationsBoardService(db, rbacService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém Painel', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;

    const clientA = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente A Painel', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientAId = clientA.id;
    const clientB = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente B Painel', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientBId = clientB.id;

    for (const tenantId of [clientAId, clientBId]) {
      await settingsService.create({ tenant_id: tenantId, warehouse_id: warehouseId, fiscal_mode: 'INTEGRADO_ERP', default_giro_policy: 'FEFO', blind_checking: true }, SEED_ACTOR_ID);
    }

    productAId = (await productService.create({ tenant_id: clientAId, sku: randomSku(), description: 'Produto A', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1, giro_policy: 'FEFO' }, SEED_ACTOR_ID)).id;
    productBId = (await productService.create({ tenant_id: clientBId, sku: randomSku(), description: 'Produto B', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1, giro_policy: 'FEFO' }, SEED_ACTOR_ID)).id;

    userScopedToA = await createTestUser(db, passwordService);
    userUnrestricted = await createTestUser(db, passwordService);
    await assignRole(db, { userId: userScopedToA.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId: clientAId });
    await assignRole(db, { userId: userUnrestricted.id, roleCode: 'PORTEIRO', warehouseId });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function createOrder(tenantId: string, productId: string) {
    const { order } = await orderService.create({
      tenantId,
      warehouseId,
      items: [{ productId, qty: 1 }],
      actorUserId: SEED_ACTOR_ID,
    });
    return order;
  }

  /** RN-PAI-004 diz "exceder" (>), não "atingir" (>=) — para testar atraso
   * deterministicamente sem esperar de verdade, recua started_at da etapa
   * atual para o passado. */
  async function backdateCurrentStep(tenantId: string, orderId: string, minutesAgo: number) {
    await testContext.databaseService.query(
      { tenant_id: tenantId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `UPDATE wms.flow_step SET started_at = now() - ($2 || ' minutes')::interval
       WHERE operation_flow_id = (SELECT id FROM wms.operation_flow WHERE entity = 'outbound_order' AND entity_id = $1)
         AND status = 'PENDING'`,
      [orderId, minutesAgo]
    );
  }

  it('RN-SEG-011: usuário restrito ao cliente A não vê cartões do cliente B', async () => {
    const orderA = await createOrder(clientAId, productAId);
    const orderB = await createOrder(clientBId, productBId);

    const cards = await boardService.listCards({ userId: userScopedToA.id, warehouseId });
    const flowEntityIds = cards.map((c) => c.entityId);

    expect(flowEntityIds).toContain(orderA.id);
    expect(flowEntityIds).not.toContain(orderB.id);
    expect(cards.every((c) => c.clientId === clientAId)).toBe(true);
  });

  it('usuário irrestrito (sem client_id na atribuição) vê cartões de ambos os clientes', async () => {
    const orderA = await createOrder(clientAId, productAId);
    const orderB = await createOrder(clientBId, productBId);

    const cards = await boardService.listCards({ userId: userUnrestricted.id, warehouseId });
    const flowEntityIds = cards.map((c) => c.entityId);

    expect(flowEntityIds).toContain(orderA.id);
    expect(flowEntityIds).toContain(orderB.id);
  });

  it('RF-PAI-001: cartão traz número do documento, cliente e etapa atual (PEDIDO, a 1ª pendente)', async () => {
    const order = await createOrder(clientAId, productAId);

    const cards = await boardService.listCards({ userId: userUnrestricted.id, warehouseId });
    const card = cards.find((c) => c.entityId === order.id);

    expect(card).toBeDefined();
    expect(card?.documentNumber).toBe(order.number);
    expect(card?.cardType).toBe('PEDIDO');
    expect(card?.currentStepCode).toBe('PEDIDO');
    expect(card?.stepStartedAt).not.toBeNull();
    expect(card?.hasPendingException).toBe(false);
  });

  it('RN-PAI-004: sem entrada em PAI.SLA_ETAPA_MIN para a etapa -> nunca atrasado', async () => {
    const order = await createOrder(clientAId, productAId);
    const cards = await boardService.listCards({ userId: userUnrestricted.id, warehouseId });
    const card = cards.find((c) => c.entityId === order.id);
    expect(card?.isLate).toBe(false);
  });

  it('RN-PAI-004: com PAI.SLA_ETAPA_MIN=0 para a etapa PEDIDO, o cartão fica atrasado imediatamente', async () => {
    await testContext.databaseService.query(
      { tenant_id: clientAId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.app_parameter (scope, name, value, warehouse_id) VALUES ('WAREHOUSE', 'PAI.SLA_ETAPA_MIN', $1, $2)
       ON CONFLICT DO NOTHING`,
      [JSON.stringify({ PEDIDO: 0 }), warehouseId]
    );

    const order = await createOrder(clientAId, productAId);
    await backdateCurrentStep(clientAId, order.id, 5);
    const cards = await boardService.listCards({ userId: userUnrestricted.id, warehouseId });
    const card = cards.find((c) => c.entityId === order.id);
    expect(card?.isLate).toBe(true);

    await testContext.databaseService.query(
      { tenant_id: clientAId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `DELETE FROM wms.app_parameter WHERE scope = 'WAREHOUSE' AND name = 'PAI.SLA_ETAPA_MIN' AND warehouse_id = $1`,
      [warehouseId]
    );
  });

  it('RF-PAI-002: ordenação padrão é atrasados primeiro, depois maior tempo na etapa', async () => {
    await testContext.databaseService.query(
      { tenant_id: clientAId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.app_parameter (scope, name, value, warehouse_id) VALUES ('WAREHOUSE', 'PAI.SLA_ETAPA_MIN', $1, $2)
       ON CONFLICT DO NOTHING`,
      [JSON.stringify({ PEDIDO: 0 }), warehouseId]
    );

    // Backdate bem maior que a de qualquer teste anterior no mesmo arquivo
    // (que também pode ter deixado cartões atrasados para trás, sem
    // teardown entre `it()`s) — garante que ESTE seja o mais antigo na
    // etapa, não por coincidência de milissegundos.
    const lateOrder = await createOrder(clientAId, productAId);
    await backdateCurrentStep(clientAId, lateOrder.id, 10_000);
    const cards = await boardService.listCards({ userId: userUnrestricted.id, warehouseId });
    expect(cards[0].entityId).toBe(lateOrder.id);
    expect(cards[0].isLate).toBe(true);

    await testContext.databaseService.query(
      { tenant_id: clientAId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `DELETE FROM wms.app_parameter WHERE scope = 'WAREHOUSE' AND name = 'PAI.SLA_ETAPA_MIN' AND warehouse_id = $1`,
      [warehouseId]
    );
  });
});
