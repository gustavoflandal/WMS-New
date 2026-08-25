// DOC-17 §5/§10 (Sessão 10A, Parte A) — RF-TEL-001/RN-TEL-002. Cenários
// Gherkin cobertos: "Etapa futura abre em modo previsão sem executar" e
// "Etapa concluída abre em consulta com quem e quando".
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { StockSelectionService } from '../../estoque/selection/stock-selection.service.js';
import { StockReservationService } from '../../estoque/selection/stock-reservation.service.js';
import { StepDetailService } from '../step-detail/step-detail.service.js';
import { OUTBOUND_FLOW_STEPS, OUTBOUND_FLOW_TYPE } from '../../expedicao/order/outbound-flow.util.js';
import { createTestUser, assignRole, SEED_ACTOR_ID } from '../../../core/__tests__/security-test-helpers.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku } from '../../cadastro/__tests__/test-helpers.js';

describe('DOC-17 §5/§10 — Sessão 10A: Detalhe de Etapa (Parte A)', () => {
  let testContext: TestContext;
  let db: TestContext['databaseService'];
  let stepDetailService: StepDetailService;
  let operationFlowService: OperationFlowService;
  let stockMovementService: StockMovementService;
  let stockReservationService: StockReservationService;
  let productService: ProductService;
  let clientId: string;
  let warehouseId: string;
  let pickerId: string;
  let locationFromId: string;
  let locationToId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const rbacService = new RbacService(db);
    operationFlowService = new OperationFlowService(db);
    stockMovementService = new StockMovementService(db);
    const stockSelectionService = new StockSelectionService(db);
    stockReservationService = new StockReservationService(db, eventsService, auditService, rbacService, stockSelectionService, stockMovementService);
    stepDetailService = new StepDetailService(db, operationFlowService);

    productService = new ProductService(db, auditService);
    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    const passwordService = new PasswordService(db);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém detalhe etapa', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente detalhe etapa', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create({ tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'INTEGRADO_ERP', default_giro_policy: 'FIFO' }, SEED_ACTOR_ID);

    const picker = await createTestUser(db, passwordService);
    pickerId = picker.id;
    await assignRole(db, { userId: pickerId, roleCode: 'OPERADOR_PICKING', warehouseId, clientId });

    [locationFromId, locationToId] = await Promise.all([createStorageLocation(db, clientId, warehouseId, SEED_ACTOR_ID, 'FR'), createStorageLocation(db, clientId, warehouseId, SEED_ACTOR_ID, 'TO')]);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function createStorageLocation(dbSvc: TestContext['databaseService'], tenantId: string, whId: string, actorUserId: string, tag: string): Promise<string> {
    return dbSvc.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: whId }, async (client) => {
      const zone = await client.query(`INSERT INTO wms.zone (warehouse_id, code, name, zone_type, created_by) VALUES ($1,$2,$3,'STORAGE',$4) RETURNING id`, [
        whId,
        `Z-${tag}`,
        `Zona ${tag}`,
        actorUserId,
      ]);
      const location = await client.query(
        `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, created_by)
         VALUES ($1,$2,$3,'001','00','01','STORAGE',1000,10,1,2,$4) RETURNING id`,
        [whId, zone.rows[0].id, tag.slice(0, 2), actorUserId]
      );
      return location.rows[0].id;
    });
  }

  it('Cenário: Etapa futura abre em modo previsão sem executar', async () => {
    const product = await productService.create({ tenant_id: clientId, sku: randomSku(), description: 'Produto detalhe', species_code: 'GERAL', base_uom: 'UN' }, SEED_ACTOR_ID);

    const { orderId, flowId } = await db.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      const order = await client.query(`INSERT INTO wms.outbound_order (tenant_id, warehouse_id, number, status, created_by) VALUES ($1,$2,$3,'IN_PACKING',$4) RETURNING id`, [
        clientId,
        warehouseId,
        `PED-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        SEED_ACTOR_ID,
      ]);
      const orderIdLocal = order.rows[0].id;
      await client.query(`INSERT INTO wms.outbound_order_item (tenant_id, outbound_order_id, product_id, line_number, qty_ordered, created_by) VALUES ($1,$2,$3,1,10,$4)`, [
        clientId,
        orderIdLocal,
        product.id,
        SEED_ACTOR_ID,
      ]);
      const pkg = await client.query(
        `INSERT INTO wms.package (tenant_id, warehouse_id, outbound_order_id, lpn, package_type_code, tare_kg, sequence_number, status, theoretical_weight_kg, created_by)
         VALUES ($1,$2,$3,$4,'CAIXA_PADRAO',0.35,1,'CLOSED',5.2,$5) RETURNING id`,
        [clientId, warehouseId, orderIdLocal, String(Math.floor(Math.random() * 1e17)).padStart(18, '0'), SEED_ACTOR_ID]
      );
      void pkg;

      const { flow } = await operationFlowService.createFlow(
        client,
        { tenantId: clientId, warehouseId, entity: 'outbound_order', entityId: orderIdLocal, flowType: OUTBOUND_FLOW_TYPE, stepCodes: [...OUTBOUND_FLOW_STEPS] },
        SEED_ACTOR_ID
      );
      await operationFlowService.completeStep(client, flow.id, 'PEDIDO', SEED_ACTOR_ID);
      await operationFlowService.completeStep(client, flow.id, 'PICKING', SEED_ACTOR_ID);
      // EMBALAGEM agora é a 1ª PENDING (acionável); PESAGEM é futura.
      return { orderId: orderIdLocal, flowId: flow.id };
    });

    const detail = await stepDetailService.getStepDetail(
      { tenantId: clientId, warehouseId, entity: 'outbound_order', entityId: orderId, stepCode: 'PESAGEM' },
      SEED_ACTOR_ID
    );

    expect(detail.mode).toBe('PREVISAO');
    expect(detail.actions).toEqual([]);
    const packages = (detail.content as any).packages;
    expect(packages.length).toBeGreaterThan(0);
    expect(Number(packages[0].theoretical_weight_kg)).toBe(5.2);
    expect(packages[0].actual_weight_kg).toBeNull();

    // "uma chamada de API de pesagem deve retornar FLOW_STEP_ORDER_VIOLATION"
    await expect(
      db.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, (client) => operationFlowService.completeStep(client, flowId, 'PESAGEM', SEED_ACTOR_ID))
    ).rejects.toMatchObject({ response: { error: 'FLOW_STEP_ORDER_VIOLATION' } });
  });

  it('Cenário: Etapa concluída abre em consulta com quem e quando', async () => {
    const product = await productService.create({ tenant_id: clientId, sku: randomSku(), description: 'Produto picking concluído', species_code: 'GERAL', base_uom: 'UN' }, SEED_ACTOR_ID);
    const batch = await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `INSERT INTO wms.batch (tenant_id, product_id, batch_code, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [clientId, product.id, `L-${Date.now()}`, SEED_ACTOR_ID]
    );
    const batchId = batch.rows[0].id;

    await stockMovementService.applyStandalone(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      { tenantId: clientId, warehouseId, movementType: 'ENTRADA_RECEBIMENTO', productId: product.id, batchId, qty: 20, locationIdTo: locationFromId, bucketToOverride: 'AVAILABLE', actorUserId: SEED_ACTOR_ID }
    );

    const { orderId, itemId } = await db.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      const order = await client.query(`INSERT INTO wms.outbound_order (tenant_id, warehouse_id, number, status, created_by) VALUES ($1,$2,$3,'IN_PICKING',$4) RETURNING id`, [
        clientId,
        warehouseId,
        `PED-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        SEED_ACTOR_ID,
      ]);
      const item = await client.query(`INSERT INTO wms.outbound_order_item (tenant_id, outbound_order_id, product_id, line_number, qty_ordered, created_by) VALUES ($1,$2,$3,1,8,$4) RETURNING id`, [
        clientId,
        order.rows[0].id,
        product.id,
        SEED_ACTOR_ID,
      ]);
      return { orderId: order.rows[0].id, itemId: item.rows[0].id };
    });

    const reservation = await stockReservationService.reserve({
      tenantId: clientId,
      warehouseId,
      productId: product.id,
      demandQty: 8,
      purpose: 'CLIENT_DISPATCH',
      demandRefType: 'OUTBOUND_ORDER_ITEM',
      demandRefId: itemId,
      actorUserId: SEED_ACTOR_ID,
    });
    expect(reservation.qtyReserved).toBe(8);

    const flowId = await db.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(
        `INSERT INTO wms.picking_task (tenant_id, warehouse_id, outbound_order_id, outbound_order_item_id, stock_reservation_id, product_id, batch_id,
                                        location_id_from, location_id_to, route_sequence, qty_suggested, qty_confirmed, status, assigned_to_user_id, completed_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,8,8,'DONE',$10,now(),$11)`,
        [clientId, warehouseId, orderId, itemId, reservation.reservations[0].id, product.id, batchId, locationFromId, locationToId, pickerId, SEED_ACTOR_ID]
      );
      const { flow } = await operationFlowService.createFlow(
        client,
        { tenantId: clientId, warehouseId, entity: 'outbound_order', entityId: orderId, flowType: OUTBOUND_FLOW_TYPE, stepCodes: [...OUTBOUND_FLOW_STEPS] },
        SEED_ACTOR_ID
      );
      await operationFlowService.completeStep(client, flow.id, 'PEDIDO', SEED_ACTOR_ID);
      await operationFlowService.completeStep(client, flow.id, 'PICKING', SEED_ACTOR_ID);
      return flow.id;
    });
    void flowId;

    const detail = await stepDetailService.getStepDetail({ tenantId: clientId, warehouseId, entity: 'outbound_order', entityId: orderId, stepCode: 'PICKING' }, SEED_ACTOR_ID);

    expect(detail.mode).toBe('CONSULTA');
    expect(detail.completed_by?.id).toBe(SEED_ACTOR_ID);
    expect(detail.completed_at).not.toBeNull();
    const tasks = (detail.content as any).tasks;
    expect(tasks).toHaveLength(1);
    expect(Number(tasks[0].qty_confirmed)).toBe(8);
    expect(tasks[0].batch_id).toBe(batchId);
    expect(tasks[0].assigned_to_user_id).toBe(pickerId);
    expect(detail.actions).toEqual([{ action: 'ESTORNAR', permission: 'EXP.ESTORNO' }]);
  });

  it('RF-PAI-020: hideExecutors oculta o executante do conteúdo e de completed_by', async () => {
    const product = await productService.create({ tenant_id: clientId, sku: randomSku(), description: 'Produto portal', species_code: 'GERAL', base_uom: 'UN' }, SEED_ACTOR_ID);
    const { orderId } = await db.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      const order = await client.query(`INSERT INTO wms.outbound_order (tenant_id, warehouse_id, number, status, created_by) VALUES ($1,$2,$3,'DRAFT',$4) RETURNING id`, [
        clientId,
        warehouseId,
        `PED-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        SEED_ACTOR_ID,
      ]);
      await client.query(`INSERT INTO wms.outbound_order_item (tenant_id, outbound_order_id, product_id, line_number, qty_ordered, created_by) VALUES ($1,$2,$3,1,3,$4)`, [
        clientId,
        order.rows[0].id,
        product.id,
        SEED_ACTOR_ID,
      ]);
      const { flow } = await operationFlowService.createFlow(
        client,
        { tenantId: clientId, warehouseId, entity: 'outbound_order', entityId: order.rows[0].id, flowType: OUTBOUND_FLOW_TYPE, stepCodes: [...OUTBOUND_FLOW_STEPS] },
        SEED_ACTOR_ID
      );
      await operationFlowService.completeStep(client, flow.id, 'PEDIDO', SEED_ACTOR_ID);
      return { orderId: order.rows[0].id };
    });

    const detail = await stepDetailService.getStepDetail(
      { tenantId: clientId, warehouseId, entity: 'outbound_order', entityId: orderId, stepCode: 'PEDIDO', hideExecutors: true },
      SEED_ACTOR_ID
    );
    expect(detail.completed_by).toBeNull();
  });
});
