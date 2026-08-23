// DOC-06 §4.4-§4.7 — Sessão 6B: Picking, Packing, Pesagem, Expedição
// documental, Carregamento e Saída, contra Postgres real. Cobre os cenários
// Gherkin do §6 desta parte e o ciclo COMPLETO ponta a ponta (teste de MARCO).
import { v4 as uuid } from 'uuid';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { ZoneService } from '../../cadastro/zone/zone.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { LpnService } from '../../cadastro/lpn/lpn.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { InventoryPlanningService } from '../../estoque/inventory/inventory-planning.service.js';
import { StockSelectionService } from '../../estoque/selection/stock-selection.service.js';
import { StockReservationService } from '../../estoque/selection/stock-reservation.service.js';
import { OutboundOrderService } from '../order/outbound-order.service.js';
import { OutboundFlowService } from '../order/outbound-flow.service.js';
import { OutboundReversalService } from '../order/outbound-reversal.service.js';
import { WaveService } from '../wave/wave.service.js';
import { PickingTaskService } from '../picking/picking-task.service.js';
import { PackageService } from '../packing/package.service.js';
import { DispatchService } from '../dispatch/dispatch.service.js';
import { LoadingService } from '../loading/loading.service.js';
import { SaidaService } from '../loading/saida.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole } from '../../../core/__tests__/security-test-helpers.js';
import { setupPortariaServices, generateValidCpf, randomMercosulPlate, buildTimeWindow } from '../../portaria/__tests__/test-helpers.js';

describe('Expedição - DOC-06 §4.4-§4.7 picking, packing, pesagem, carregamento, saída (Sessão 6B)', () => {
  let testContext: TestContext;

  let orderService: OutboundOrderService;
  let flowService: OutboundFlowService;
  let reversalService: OutboundReversalService;
  let waveService: WaveService;
  let pickingTaskService: PickingTaskService;
  let packageService: PackageService;
  let dispatchService: DispatchService;
  let loadingService: LoadingService;
  let saidaService: SaidaService;
  let exceptionService: OperationalExceptionService;
  let productService: ProductService;
  let portaria: ReturnType<typeof setupPortariaServices>;

  let clientId: string;
  let warehouseId: string;
  let storageZoneId: string;

  /** LIDER_TURNO — EXP.ONDA_GERIR/ESTORNO/PICKING_EXECUTAR/PACKING_EXECUTAR/PESO_MANUAL. */
  let lider: { id: string };
  /** GESTOR_ARMAZEM — decide exceções ESCALATED (sem alçada configurada = RN-SEG-021). */
  let gestor1: { id: string };
  let gestor2: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const rbacService = new RbacService(db);
    const operationFlowService = new OperationFlowService(db);
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    exceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    const stockMovementService = new StockMovementService(db);
    const selectionService = new StockSelectionService(db);
    const reservationService = new StockReservationService(db, eventsService, auditService, rbacService, selectionService, stockMovementService);
    const documentNumberingService = new DocumentNumberingService(db);
    const lpnService = new LpnService(documentNumberingService);

    flowService = new OutboundFlowService(db, eventsService, operationFlowService);
    orderService = new OutboundOrderService(db, eventsService, auditService, documentNumberingService, selectionService, reservationService, flowService);
    reversalService = new OutboundReversalService(db, eventsService, auditService, rbacService, stockMovementService, flowService);
    const inventoryPlanningService = new InventoryPlanningService(db, eventsService, documentNumberingService);
    pickingTaskService = new PickingTaskService(
      db,
      eventsService,
      auditService,
      rbacService,
      operationFlowService,
      exceptionService,
      stockMovementService,
      reservationService,
      inventoryPlanningService,
      flowService
    );
    waveService = new WaveService(db, eventsService, auditService, pickingTaskService);
    packageService = new PackageService(db, eventsService, auditService, rbacService, operationFlowService, exceptionService, flowService, lpnService);
    dispatchService = new DispatchService(db, eventsService, auditService, flowService);
    loadingService = new LoadingService(db, eventsService, auditService, stockMovementService, flowService);
    saidaService = new SaidaService(db, eventsService, auditService, flowService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);
    const passwordService = new PasswordService(db);
    portaria = setupPortariaServices(db);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém 6B', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente 6B', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'INTEGRADO_ERP', default_giro_policy: 'FEFO', blind_checking: true },
      SEED_ACTOR_ID
    );
    storageZoneId = (await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID)).id;
    // RN-POR-012/DOC-03: gate-in exige vaga de pátio livre para NO_PATIO.
    await db.queryGlobal(`INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'Y01','WAITING',$2)`, [warehouseId, SEED_ACTOR_ID]);
    const packingZone = await zoneService.create({ warehouse_id: warehouseId, code: 'PCK', name: 'Packing', zone_type: 'PACKING' }, SEED_ACTOR_ID);
    await db.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'P1','001','00','01','STORAGE',5000,100,5,5,'ACTIVE',$3)`,
      [warehouseId, packingZone.id, SEED_ACTOR_ID]
    );

    lider = await createTestUser(db, passwordService);
    gestor1 = await createTestUser(db, passwordService);
    gestor2 = await createTestUser(db, passwordService);
    await assignRole(db, { userId: lider.id, roleCode: 'LIDER_TURNO', warehouseId, clientId });
    await assignRole(db, { userId: gestor1.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
    await assignRole(db, { userId: gestor2.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  let locationSeq = 0;
  async function createLocation() {
    locationSeq += 1;
    const result = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'A1',$3,'00','01','STORAGE',5000,100,5,5,'ACTIVE',$4) RETURNING *`,
      [warehouseId, storageZoneId, String(locationSeq).padStart(3, '0'), SEED_ACTOR_ID]
    );
    return result.rows[0];
  }

  async function createProduct(grossWeightKg = 1) {
    return productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto 6B', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: grossWeightKg, length_m: 0.1, width_m: 0.1, height_m: 0.1, giro_policy: 'FEFO' },
      SEED_ACTOR_ID
    );
  }

  async function seedBalance(productId: string, locationId: string, qty: number) {
    await rawAuthorizedQuery(
      testContext.databaseService,
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [clientId, warehouseId, productId, locationId, qty, SEED_ACTOR_ID]
    );
  }

  /** Cria produto+endereço+saldo+pedido liberado+onda unitária implícita (gera as tarefas de picking). */
  async function buildOrderReadyForPicking(qty: number, grossWeightKg = 1) {
    const product = await createProduct(grossWeightKg);
    const location = await createLocation();
    await seedBalance(product.id, location.id, qty);

    const created = await orderService.create({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qty }], actorUserId: SEED_ACTOR_ID });
    await orderService.release(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    await waveService.releaseImplicit(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);

    const tasks = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.picking_task WHERE outbound_order_id = $1 ORDER BY route_sequence ASC`,
      [created.order.id]
    );

    return { orderId: created.order.id, itemId: created.items[0].id, productId: product.id, locationId: location.id, tasks: tasks.rows };
  }

  async function pickFully(taskId: string, qty: number) {
    return pickingTaskService.executeTask(
      taskId,
      clientId,
      warehouseId,
      { operationId: uuid(), scannedLocationCode: (await loadTaskLocationCode(taskId)), scannedProductCode: await loadTaskScanCode(taskId), qtyConfirmed: qty },
      SEED_ACTOR_ID
    );
  }

  async function loadTaskLocationCode(taskId: string): Promise<string> {
    const result = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT l.code FROM wms.picking_task pt JOIN wms.location l ON l.id = pt.location_id_from WHERE pt.id = $1`,
      [taskId]
    );
    return result.rows[0].code;
  }

  async function loadTaskScanCode(taskId: string): Promise<string> {
    const taskResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT product_id FROM wms.picking_task WHERE id = $1`,
      [taskId]
    );
    const productId = taskResult.rows[0].product_id;
    const barcode = `EAN-${productId}`;
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.product_barcode (tenant_id, product_id, barcode, barcode_type, created_by)
       VALUES ($1,$2,$3,'INTERNAL',$4) ON CONFLICT (barcode) DO NOTHING`,
      [clientId, productId, barcode, SEED_ACTOR_ID]
    );
    return barcode;
  }

  /** Aprova exceção de 1 passo (ESCALATED, sem alçada configurada — RN-SEG-021) com um GESTOR_ARMAZEM distinto do requerente. */
  async function approveOneStep(exceptionId: string) {
    return exceptionService.decide(exceptionId, clientId, warehouseId, gestor1.id, 'APPROVE', 'Aprovado');
  }

  /** Aprova exceção de 2 passos (ESCALATED) com dois GESTOR_ARMAZEM distintos. */
  async function approveTwoSteps(exceptionId: string) {
    await exceptionService.decide(exceptionId, clientId, warehouseId, gestor1.id, 'APPROVE', 'Passo 1');
    return exceptionService.decide(exceptionId, clientId, warehouseId, gestor2.id, 'APPROVE', 'Passo 2');
  }

  // ───────────────────────────────────────────────────────────────────────
  // §6 — "Corte bloqueia saldo e agenda contagem"
  // ───────────────────────────────────────────────────────────────────────
  it('§6 RN-EXP-032: corte de 8 UN (50 sugeridas, 42 físicas) abre EXP.CORTE_PICKING, bloqueia o saldo e agenda contagem POR_ENDERECO', async () => {
    const { orderId, tasks, locationId, productId } = await buildOrderReadyForPicking(50);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];

    const result = await pickingTaskService.executeTask(
      task.id,
      clientId,
      warehouseId,
      {
        operationId: uuid(),
        scannedLocationCode: await loadTaskLocationCode(task.id),
        scannedProductCode: await loadTaskScanCode(task.id),
        qtyConfirmed: 42,
        reasonCode: 'DIVERGENCIA_FISICA',
        reasonText: 'Físico encontrado 42, sistema apontava 50',
      },
      SEED_ACTOR_ID
    );

    expect(result.task.status).toBe('SHORT_REPORTED');
    expect(Number(result.task.qty_short)).toBe(8);
    expect(result.task.short_exception_id).toBeTruthy();

    const exception = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.operational_exception WHERE id = $1`,
      [result.task.short_exception_id]
    );
    expect(exception.rows[0].exception_type).toBe('EXP.CORTE_PICKING');
    expect(['PENDING', 'ESCALATED']).toContain(exception.rows[0].status);

    const balance = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_reserved, qty_blocked FROM wms.stock_balance WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId]
    );
    expect(Number(balance.rows[0].qty_blocked)).toBe(8);
    expect(Number(balance.rows[0].qty_reserved)).toBe(42);

    const count = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.inventory_count_location WHERE location_id = $1`,
      [locationId]
    );
    expect(count.rows).toHaveLength(1);
    expect(count.rows[0].count_type).toBe('POR_ENDERECO');
    // DOC-05 5C: createAndFreezeSingleLocation cria o cabeçalho já IN_PROGRESS
    // e a célula já COUNTING (congelada, pronta para a 1ª rodada) — não fica
    // PENDING (esse status é só para inventários PLANNED aguardando início).
    expect(count.rows[0].status).toBe('COUNTING');
    expect(count.rows[0].header_id).toBeTruthy();

    const header = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.inventory_count WHERE id = $1`,
      [count.rows[0].header_id]
    );
    expect(header.rows[0].count_type).toBe('POR_ENDERECO');
    expect(header.rows[0].status).toBe('IN_PROGRESS');

    const location = await testContext.databaseService.queryGlobal(`SELECT status FROM wms.location WHERE id = $1`, [locationId]);
    expect(location.rows[0].status).toBe('INVENTORY');

    // Etapa Picking permanece vermelha (bloqueada) enquanto a exceção não é decidida.
    const state = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    const picking = state.steps.find((s: any) => s.step_code === 'PICKING');
    expect(picking.status).toBe('PENDING');
    expect(picking.is_blocked).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // §6 — "Re-seleção após corte aprovado"
  // ───────────────────────────────────────────────────────────────────────
  it('§6 RN-EXP-032(c): decisão RESELECT gera nova tarefa de 8 UN no próximo saldo FEFO; etapa conclui após a nova tarefa', async () => {
    const { orderId, tasks, productId } = await buildOrderReadyForPicking(50);
    const task = tasks[0];

    // Segundo saldo do MESMO produto para a re-seleção encontrar candidato.
    const location2 = await createLocation();
    await seedBalance(productId, location2.id, 20);

    const short = await pickingTaskService.executeTask(
      task.id,
      clientId,
      warehouseId,
      { operationId: uuid(), scannedLocationCode: await loadTaskLocationCode(task.id), scannedProductCode: await loadTaskScanCode(task.id), qtyConfirmed: 42, reasonCode: 'DIVERGENCIA' },
      SEED_ACTOR_ID
    );
    await approveOneStep(short.task.short_exception_id);

    const decision = await pickingTaskService.applyShortDecision(task.id, 'RESELECT', clientId, warehouseId, lider.id);
    expect(decision.newTasks).toBe(1);

    const newTask = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.picking_task WHERE outbound_order_id = $1 AND status = 'CREATED'`,
      [orderId]
    );
    expect(newTask.rows).toHaveLength(1);
    expect(Number(newTask.rows[0].qty_suggested)).toBe(8);
    expect(newTask.rows[0].location_id_from).toBe(location2.id);

    // Etapa Picking ainda PENDING (nova tarefa não executada) e já não bloqueada por exceção.
    const midState = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    const pickingMid = midState.steps.find((s: any) => s.step_code === 'PICKING');
    expect(pickingMid.is_blocked).toBe(false);

    await pickFully(newTask.rows[0].id, 8);

    const finalState = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    expect(finalState.steps.find((s: any) => s.step_code === 'PICKING').status).toBe('DONE');
    expect(finalState.order.persisted_status).toBe('PICKED');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Picking com dupla leitura rejeitando endereço divergente
  // ───────────────────────────────────────────────────────────────────────
  it('RF-EXP-031: dupla leitura rejeita endereço divergente (ADDRESS_MISMATCH)', async () => {
    const { tasks } = await buildOrderReadyForPicking(10);
    const task = tasks[0];

    await expect(
      pickingTaskService.executeTask(
        task.id,
        clientId,
        warehouseId,
        { operationId: uuid(), scannedLocationCode: 'ZZ-999-99-99', scannedProductCode: await loadTaskScanCode(task.id), qtyConfirmed: 10 },
        SEED_ACTOR_ID
      )
    ).rejects.toMatchObject({ response: { error: 'ADDRESS_MISMATCH' } });
  });

  it('RF-EXP-031: idempotência — reenviar a MESMA operationId devolve o mesmo resultado sem reaplicar', async () => {
    const { tasks } = await buildOrderReadyForPicking(10);
    const task = tasks[0];
    const operationId = uuid();
    const input = { operationId, scannedLocationCode: await loadTaskLocationCode(task.id), scannedProductCode: await loadTaskScanCode(task.id), qtyConfirmed: 10 };

    const first = await pickingTaskService.executeTask(task.id, clientId, warehouseId, input, SEED_ACTOR_ID);
    expect(first.idempotentReplay).toBe(false);
    expect(first.task.status).toBe('DONE');

    const replay = await pickingTaskService.executeTask(task.id, clientId, warehouseId, input, SEED_ACTOR_ID);
    expect(replay.idempotentReplay).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // §6 — "Packing valida conteúdo exato"
  // ───────────────────────────────────────────────────────────────────────
  it('§6 RF-EXP-040: declarar 118 de 120 não conclui (diferença de 2); declarar os 120 conclui', async () => {
    const { orderId, tasks, productId } = await buildOrderReadyForPicking(120);
    await pickFully(tasks[0].id, 120);

    const pkg = await packageService.openPackage({ tenantId: clientId, warehouseId, outboundOrderId: orderId, packageTypeCode: 'CAIXA_PADRAO', actorUserId: SEED_ACTOR_ID });
    await packageService.declareContent({ packageId: pkg.id, tenantId: clientId, warehouseId, productId, qty: 118, actorUserId: SEED_ACTOR_ID });
    await packageService.closePackage(pkg.id, clientId, warehouseId, SEED_ACTOR_ID);

    const attempt1 = await packageService.attemptCompletePackingStep(orderId, clientId, warehouseId, SEED_ACTOR_ID);
    expect(attempt1.completed).toBe(false);
    expect(attempt1.differences).toEqual([expect.objectContaining({ productId, expected: 120, declared: 118, diff: -2 })]);

    const pkg2 = await packageService.openPackage({ tenantId: clientId, warehouseId, outboundOrderId: orderId, packageTypeCode: 'CAIXA_PADRAO', actorUserId: SEED_ACTOR_ID });
    await packageService.declareContent({ packageId: pkg2.id, tenantId: clientId, warehouseId, productId, qty: 2, actorUserId: SEED_ACTOR_ID });
    await packageService.closePackage(pkg2.id, clientId, warehouseId, SEED_ACTOR_ID);

    const attempt2 = await packageService.attemptCompletePackingStep(orderId, clientId, warehouseId, SEED_ACTOR_ID);
    expect(attempt2.completed).toBe(true);

    const state = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    expect(state.steps.find((s: any) => s.step_code === 'EMBALAGEM').status).toBe('DONE');
    expect(state.order.persisted_status).toBe('PACKED');
  });

  // ───────────────────────────────────────────────────────────────────────
  // §6 — "Tolerância de pesagem" (exemplo normativo RN-EXP-051)
  // ───────────────────────────────────────────────────────────────────────
  it('§6 RN-EXP-051: 12,480 kg (teórico 12,350, tolerância 2%) é aprovado', async () => {
    const { orderId, tasks, productId } = await buildOrderReadyForPicking(10, 1.2);
    await pickFully(tasks[0].id, 10);
    const pkg = await packageService.openPackage({ tenantId: clientId, warehouseId, outboundOrderId: orderId, packageTypeCode: 'CAIXA_PADRAO', actorUserId: SEED_ACTOR_ID });
    await packageService.declareContent({ packageId: pkg.id, tenantId: clientId, warehouseId, productId, qty: 10, actorUserId: SEED_ACTOR_ID });
    const closed = await packageService.closePackage(pkg.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(Number(closed.theoretical_weight_kg)).toBeCloseTo(12.35, 3);
    await packageService.attemptCompletePackingStep(orderId, clientId, warehouseId, SEED_ACTOR_ID);

    const weighed = await packageService.weighPackage({ packageId: pkg.id, tenantId: clientId, warehouseId, weightKg: 12.48, source: 'SCALE', actorUserId: SEED_ACTOR_ID });
    expect(weighed.status).toBe('WEIGHED');
  });

  it('§6 RN-EXP-051: 12,900 kg abre EXP.DIVERGENCIA_PESO e bloqueia a etapa Pesagem', async () => {
    const { orderId, tasks, productId } = await buildOrderReadyForPicking(10, 1.2);
    await pickFully(tasks[0].id, 10);
    const pkg = await packageService.openPackage({ tenantId: clientId, warehouseId, outboundOrderId: orderId, packageTypeCode: 'CAIXA_PADRAO', actorUserId: SEED_ACTOR_ID });
    await packageService.declareContent({ packageId: pkg.id, tenantId: clientId, warehouseId, productId, qty: 10, actorUserId: SEED_ACTOR_ID });
    await packageService.closePackage(pkg.id, clientId, warehouseId, SEED_ACTOR_ID);
    await packageService.attemptCompletePackingStep(orderId, clientId, warehouseId, SEED_ACTOR_ID);

    const weighed = await packageService.weighPackage({ packageId: pkg.id, tenantId: clientId, warehouseId, weightKg: 12.9, source: 'SCALE', actorUserId: SEED_ACTOR_ID });
    expect(weighed.status).toBe('WEIGHT_DIVERGENT');

    const state = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    const pesagem = state.steps.find((s: any) => s.step_code === 'PESAGEM');
    expect(pesagem.is_blocked).toBe(true);
    expect(pesagem.blocking_exception.type).toBe('EXP.DIVERGENCIA_PESO');

    // Decisão: aceitar o lido.
    await approveOneStep(weighed.weight_exception_id);
    const accepted = await packageService.decideWeightDivergence(pkg.id, 'ACCEPT', 'Divergência aceita pelo líder', clientId, warehouseId, lider.id);
    expect(accepted.status).toBe('WEIGHED');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Ciclo completo até Carregamento — fixture compartilhada pelos dois
  // cenários abaixo (volume estranho + estorno de carregamento).
  // ───────────────────────────────────────────────────────────────────────
  async function buildOrderReadyForLoading(qty = 5) {
    const { orderId, tasks, productId } = await buildOrderReadyForPicking(qty, 1);
    await pickFully(tasks[0].id, qty);

    const pkg = await packageService.openPackage({ tenantId: clientId, warehouseId, outboundOrderId: orderId, packageTypeCode: 'CAIXA_PADRAO', actorUserId: SEED_ACTOR_ID });
    await packageService.declareContent({ packageId: pkg.id, tenantId: clientId, warehouseId, productId, qty, actorUserId: SEED_ACTOR_ID });
    const closed = await packageService.closePackage(pkg.id, clientId, warehouseId, SEED_ACTOR_ID);
    await packageService.attemptCompletePackingStep(orderId, clientId, warehouseId, SEED_ACTOR_ID);
    // Pesa EXATAMENTE no teórico (qty × gross_weight_kg=1 + tara CAIXA_PADRAO=0,350) — dentro da tolerância por construção.
    await packageService.weighPackage({ packageId: pkg.id, tenantId: clientId, warehouseId, weightKg: Number(closed.theoretical_weight_kg), source: 'SCALE', actorUserId: SEED_ACTOR_ID });
    await dispatchService.scanForStaging(pkg.id, clientId, warehouseId, SEED_ACTOR_ID);
    await dispatchService.confirmFiscalDocuments(orderId, clientId, warehouseId, SEED_ACTOR_ID);
    const dispatchResult = await dispatchService.attemptCompleteDispatchStep(orderId, clientId, warehouseId, SEED_ACTOR_ID);
    expect(dispatchResult.completed).toBe(true);

    return { orderId, packageId: pkg.id, lpn: pkg.lpn, productId };
  }

  // ───────────────────────────────────────────────────────────────────────
  // §6 — "Volume estranho no carregamento"
  // ───────────────────────────────────────────────────────────────────────
  it('§6 RF-EXP-061: volume de outro pedido é recusado no ato identificando o pedido de origem', async () => {
    const orderA = await buildOrderReadyForLoading(5);
    const orderB = await buildOrderReadyForLoading(5);

    const loading = await loadingService.openLoading({ tenantId: clientId, warehouseId, orderIds: [orderA.orderId], actorUserId: SEED_ACTOR_ID });

    await expect(loadingService.scanPackage(loading.id, orderB.lpn, clientId, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'FOREIGN_PACKAGE', originOrderId: orderB.orderId },
    });

    const orderBNumber = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT number FROM wms.outbound_order WHERE id = $1`,
      [orderB.orderId]
    );
    const scanRow = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT result, rejection_detail, outbound_order_id FROM wms.loading_scan WHERE loading_id = $1 AND scanned_lpn = $2`,
      [loading.id, orderB.lpn]
    );
    expect(scanRow.rows[0].result).toBe('REJECTED_FOREIGN');
    expect(scanRow.rows[0].outbound_order_id).toBe(orderB.orderId);
    expect(scanRow.rows[0].rejection_detail).toContain(orderBNumber.rows[0].number);
  });

  // ───────────────────────────────────────────────────────────────────────
  // §6 — "Estorno de carregamento desfaz baixa"
  // ───────────────────────────────────────────────────────────────────────
  it('§6 RN-EXP-070: estorno de carregamento reverte SAIDA_EXPEDICAO integralmente e volta a IN_DISPATCH', async () => {
    const { orderId, packageId, lpn, productId } = await buildOrderReadyForLoading(5);
    const loading = await loadingService.openLoading({ tenantId: clientId, warehouseId, orderIds: [orderId], actorUserId: SEED_ACTOR_ID });

    const scan = await loadingService.scanPackage(loading.id, lpn, clientId, warehouseId, SEED_ACTOR_ID);
    expect(scan.order_completed).toBe(true);

    const stateLoaded = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    expect(stateLoaded.order.persisted_status).toBe('LOADED');

    const balanceBefore = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT SUM(qty_reserved) AS reserved FROM wms.stock_balance WHERE product_id = $1`,
      [productId]
    );
    expect(Number(balanceBefore.rows[0].reserved ?? 0)).toBe(0); // SAIDA_EXPEDICAO já debitou

    const exception = await exceptionService.create({
      tenantId: clientId,
      warehouseId,
      exceptionType: 'EXP.ESTORNO_POS_FISCAL',
      entity: 'outbound_order',
      entityId: orderId,
      reasonRequest: 'Cliente recusou a carga na doca',
      requestedBy: lider.id,
    });
    await approveTwoSteps(exception.id);

    const reverted = await reversalService.reverseStep({
      orderId,
      tenantId: clientId,
      warehouseId,
      step: 'CARREGAMENTO',
      reason: 'Estorno pós-fiscal',
      reversalExceptionId: exception.id,
      actorUserId: lider.id,
    });

    expect(reverted.order.status).toBe('IN_DISPATCH');
    expect(reverted.packages_unloaded).toBe(1);
    expect(reverted.shipment_reversed).toBe(1);

    const balanceAfter = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT SUM(qty_reserved) AS reserved FROM wms.stock_balance WHERE product_id = $1`,
      [productId]
    );
    expect(Number(balanceAfter.rows[0].reserved)).toBe(5); // integralmente revertida

    const state = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    expect(state.steps.find((s: any) => s.step_code === 'CARREGAMENTO').status).toBe('PENDING');

    const pkgRow = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT status FROM wms.package WHERE id = $1`,
      [packageId]
    );
    expect(pkgRow.rows[0].status).toBe('WEIGHED');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Ciclo COMPLETO ponta a ponta — TESTE DE MARCO.
  // Pedido → liberação → picking → packing → pesagem → expedição →
  // carregamento → gate-out (DOC-03) → COMPLETED, publicando o evento.
  // ───────────────────────────────────────────────────────────────────────
  it('TESTE DE MARCO: ciclo completo pedido → liberação → picking → packing → pesagem → expedição → carregamento → gate-out → COMPLETED', async () => {
    const qty = 5;
    const { orderId, lpn } = await buildOrderReadyForLoading(qty);

    // ── Carregamento: veículo real via DOC-03 (gate-in COM agendamento —
    // RN-POR-012 recusa gate-in sem agendamento, ver §6 "Veículo sem
    // agendamento recusado" — sem dependência de doca). ──
    const window = buildTimeWindow(-60, 60);
    const windowConfig = await portaria.windowConfigService.create(
      {
        warehouse_id: warehouseId,
        weekday: window.weekday,
        start_time: window.start_time,
        end_time: window.end_time,
        direction: 'OUTBOUND',
        capacity: 5,
      },
      SEED_ACTOR_ID
    );
    const appointment = await portaria.appointmentService.create(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'OUTBOUND',
        window_config_id: windowConfig.id,
        window_date: window.window_date,
        vehicle_type: 'TRUCK',
      },
      SEED_ACTOR_ID
    );

    const gateInVisit = await portaria.gateInService.registerGateIn(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'OUTBOUND',
        plate: randomMercosulPlate(),
        vehicle_type: 'TRUCK',
        driver: { cpf: generateValidCpf(), name: 'Motorista Marco 6B', cnh: 'CNH6B0001', cnh_validity: '2030-01-01' },
        appointment_id: appointment.id,
      },
      SEED_ACTOR_ID
    );
    expect(gateInVisit.status).toBe('NO_PATIO');

    const loading = await loadingService.openLoading({ tenantId: clientId, warehouseId, vehicleVisitId: gateInVisit.id, orderIds: [orderId], actorUserId: SEED_ACTOR_ID });
    const scan = await loadingService.scanPackage(loading.id, lpn, clientId, warehouseId, SEED_ACTOR_ID);
    expect(scan.order_completed).toBe(true);

    const stateLoaded = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    expect(stateLoaded.order.persisted_status).toBe('LOADED');

    // ── Saída: gate-out real (DOC-03/RN-POR-040) — a visita não tem
    // Fluxo Operacional PRÓPRIO instanciado nesta suíte (fora de escopo do
    // DOC-06), então marcamos operation_flow_completed diretamente, mesmo
    // padrão já usado pelos testes de portaria (seal-divergence spec) para
    // isolar a regra sob teste sem reconstruir o DOC-04 inteiro.
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `UPDATE wms.vehicle_visit SET operation_flow_completed = TRUE WHERE id = $1`,
      [gateInVisit.id]
    );
    const gateOutResult = await portaria.gateOutService.requestGateOut(gateInVisit.id, { tenant_id: clientId, warehouse_id: warehouseId }, SEED_ACTOR_ID);
    expect(gateOutResult.status).toBe('ENCERRADA');

    const completed = await saidaService.completeExit(orderId, clientId, warehouseId, SEED_ACTOR_ID);
    expect(completed.fim.order.status).toBe('COMPLETED');

    const finalState = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    expect(finalState.steps.every((s: any) => s.status === 'DONE')).toBe(true);
    expect(finalState.order.persisted_status).toBe('COMPLETED');

    // Evento expedicao.pedido_concluido publicado (§4.9/RF-EXP-062).
    const event = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT payload FROM wms.event_outbox WHERE event_type = 'expedicao.pedido_concluido' AND payload->>'outbound_order_id' = $1`,
      [orderId]
    );
    expect(event.rows).toHaveLength(1);
  });
});
