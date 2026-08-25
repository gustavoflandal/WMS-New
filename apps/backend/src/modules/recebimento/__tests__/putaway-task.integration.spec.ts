// DOC-04 RF-REC-042 (execução com dupla leitura) + RF-REC-043 (conclusão da
// ordem) + RN-REC-041 (override) + RF-REC-051 (cancelamento de cross-docking
// devolve o palete ao putaway padrão — fecha o [DÉBITO: 4B] da Sessão 4A).
// Fluxo montado com os services REAIS (Ordem -> Conferência -> Etiquetagem),
// não por SQL cru, para que as etapas do Fluxo Operacional (RG-002) sejam
// exercitadas de verdade.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { ConfigService } from '@nestjs/config';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { ZoneService } from '../../cadastro/zone/zone.service.js';
import { BatchService } from '../../cadastro/batch/batch.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { LpnService } from '../../cadastro/lpn/lpn.service.js';
import { PalletService } from '../../cadastro/pallet/pallet.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { InboundOrderService } from '../inbound-order/inbound-order.service.js';
import { CheckingService } from '../checking/checking.service.js';
import { LabelingService } from '../labeling/labeling.service.js';
import { CrossDockService } from '../crossdock/crossdock.service.js';
import { PutawayEngineService } from '../putaway/putaway-engine.service.js';
import { PutawayTaskService } from '../putaway/putaway-task.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole } from '../../../core/__tests__/security-test-helpers.js';
import { v4 as uuid } from 'uuid';

describe('Recebimento - DOC-04 RF-REC-042/043 execução de putaway', () => {
  let testContext: TestContext;
  let inboundOrderService: InboundOrderService;
  let checkingService: CheckingService;
  let labelingService: LabelingService;
  let crossDockService: CrossDockService;
  let taskService: PutawayTaskService;
  let operationFlowService: OperationFlowService;
  let productService: ProductService;
  let zoneService: ZoneService;

  let clientId: string;
  let warehouseId: string;
  let dockId: string;
  let storageZoneId: string;
  let locationA: any;
  let locationB: any;
  /** OPERADOR_EMPILHADEIRA — executa, mas NÃO tem EST.PUTAWAY_OVERRIDE. */
  let operador: { id: string };
  /** GESTOR_ARMAZEM — tem EST.PUTAWAY_OVERRIDE (migration 0016). */
  let gestor: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const rbacService = new RbacService(db);
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    const operationalExceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    operationFlowService = new OperationFlowService(db);
    const documentNumberingService = new DocumentNumberingService(db);
    const fileStorageService = new FileStorageService(testContext.configService as ConfigService);
    fileStorageService.onModuleInit();
    const lpnService = new LpnService(documentNumberingService);
    const palletService = new PalletService(db, lpnService);
    const batchService = new BatchService(db, auditService);
    const engine = new PutawayEngineService(db);
    const stockMovementService = new StockMovementService(db);

    inboundOrderService = new InboundOrderService(db, eventsService, auditService, operationalExceptionService, operationFlowService, fileStorageService, documentNumberingService);
    checkingService = new CheckingService(db, eventsService, auditService, operationalExceptionService, operationFlowService);
    labelingService = new LabelingService(db, eventsService, auditService, palletService, batchService);
    taskService = new PutawayTaskService(db, eventsService, auditService, rbacService, operationFlowService, engine, stockMovementService, operationalExceptionService);
    crossDockService = new CrossDockService(db, eventsService, auditService, palletService, taskService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    zoneService = new ZoneService(db, auditService);
    const passwordService = new PasswordService(db);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém putaway task', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente putaway task', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', blind_checking: true },
      SEED_ACTOR_ID
    );

    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    await db.query(ctx, `INSERT INTO wms.app_parameter (scope, name, value, warehouse_id) VALUES ('WAREHOUSE', 'GS1_PREFIX', '7420002', $1)`, [warehouseId]);
    await db.query(ctx, `INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', 'REC.CRITERIOS_PUTAWAY', '["MENOR_NIVEL"]')`);

    const zone = await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
    storageZoneId = zone.id;
    locationA = await createLocation('A1', '001', '00', '01');
    locationB = await createLocation('A1', '001', '01', '01');

    const dockResult = await db.queryGlobal(
      `INSERT INTO wms.dock (warehouse_id, code, dock_type, has_leveler, status, created_by) VALUES ($1,'D1','BOTH',TRUE,'OCCUPIED',$2) RETURNING *`,
      [warehouseId, SEED_ACTOR_ID]
    );
    dockId = dockResult.rows[0].id;

    operador = await createTestUser(db, passwordService);
    gestor = await createTestUser(db, passwordService);
    await assignRole(db, { userId: operador.id, roleCode: 'OPERADOR_EMPILHADEIRA', warehouseId, clientId });
    await assignRole(db, { userId: gestor.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function createLocation(aisle: string, module: string, level: string, slot: string) {
    const result = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type,
                                 max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'STORAGE',5000,100,5,5,'ACTIVE',$7) RETURNING *`,
      [warehouseId, storageZoneId, aisle, module, level, slot, SEED_ACTOR_ID]
    );
    return result.rows[0];
  }

  /** Ordem manual -> conferência -> etiquetagem, devolvendo a ordem em LABELING com 1 palete formado. */
  async function orderWithPallet(qty = 10) {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto putaway', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1 },
      SEED_ACTOR_ID
    );
    const created = await inboundOrderService.createManual({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qtyExpected: qty }] }, SEED_ACTOR_ID);

    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(`UPDATE wms.inbound_order SET status = 'AT_DOCK', dock_id = $2 WHERE id = $1`, [created.order.id, dockId]);
      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [created.order.id]);
      await operationFlowService.completeStep(client, flow.rows[0].id, 'DOCA', SEED_ACTOR_ID);
    });

    await checkingService.startUnloading(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    const checking = await checkingService.startChecking(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    await checkingService.countFirstRound(checking.id, created.items[0].id, qty, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID);
    await checkingService.closeChecking(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    await labelingService.startLabeling(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    const pallet = await labelingService.formPallet(created.order.id, clientId, warehouseId, 'PBR', [{ inboundOrderItemId: created.items[0].id, qty }], SEED_ACTOR_ID);

    return { order: created.order, item: created.items[0], product, pallet };
  }

  it('RF-REC-042/043 caminho completo: gera tarefa, atribui, executa com dupla leitura, credita saldo e CONCLUI a ordem', async () => {
    const { order, product, pallet } = await orderWithPallet(10);

    const tasks = await taskService.generateTasksForOrder(order.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('CREATED');

    // §5.1: LABELING -> PUTAWAY_IN_PROGRESS
    const afterGen = await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID }, `SELECT status FROM wms.inbound_order WHERE id = $1`, [order.id]);
    expect(afterGen.rows[0].status).toBe('PUTAWAY_IN_PROGRESS');

    const assigned = await taskService.assignTask(tasks[0].id, operador.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(assigned.task.status).toBe('ASSIGNED');
    expect(assigned.suggestion.locationId).toBe(locationA.id); // MENOR_NIVEL: '00' antes de '01'

    const executed = await taskService.executeTask(
      tasks[0].id,
      { operationId: uuid(), scannedLpn: pallet.lpn, scannedLocationCode: locationA.code },
      clientId,
      warehouseId,
      operador.id
    );
    expect(executed.task.status).toBe('DONE');
    expect(executed.override_applied).toBe(false);

    // Saldo creditado na parcela AVAILABLE (lote RELEASED / sem lote).
    const balance = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT * FROM wms.stock_balance WHERE location_id = $1 AND product_id = $2`,
      [locationA.id, product.id]
    );
    expect(Number(balance.rows[0].qty_available)).toBe(10);

    // stock_movement tipo PUTAWAY registrado.
    const movement = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT * FROM wms.stock_movement WHERE task_id = $1`,
      [tasks[0].id]
    );
    expect(movement.rows[0].movement_type).toBe('PUTAWAY');
    expect(movement.rows[0].location_id_to).toBe(locationA.id);
    expect(movement.rows[0].balance_bucket_to).toBe('AVAILABLE');

    // RF-REC-043: ordem COMPLETED, fluxo concluído, doca liberada, evento publicado.
    const finalOrder = await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID }, `SELECT status FROM wms.inbound_order WHERE id = $1`, [order.id]);
    expect(finalOrder.rows[0].status).toBe('COMPLETED');

    const steps = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT fs.step_code, fs.status FROM wms.flow_step fs
       JOIN wms.operation_flow f ON f.id = fs.operation_flow_id
       WHERE f.entity = 'inbound_order' AND f.entity_id = $1 ORDER BY fs.sequence_order`,
      [order.id]
    );
    expect(steps.rows.every((s: any) => s.status === 'DONE')).toBe(true);
    expect(steps.rows.map((s: any) => s.step_code)).toEqual(['CHEGADA', 'DOCA', 'DESCARGA', 'CONFERENCIA', 'ETIQUETAGEM', 'PUTAWAY', 'FIM']);

    const dock = await testContext.databaseService.queryGlobal(`SELECT status FROM wms.dock WHERE id = $1`, [dockId]);
    expect(dock.rows[0].status).toBe('FREE');

    const event = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT * FROM wms.event_outbox WHERE event_type = 'recebimento.concluido' AND payload->>'inbound_order_id' = $1`,
      [order.id]
    );
    expect(event.rows).toHaveLength(1);
  });

  it('DUPLA LEITURA: endereço lido diferente do designado, SEM override, é rejeitado NO ATO e a tarefa permanece pendente', async () => {
    const { order, pallet } = await orderWithPallet(5);
    const [task] = await taskService.generateTasksForOrder(order.id, clientId, warehouseId, SEED_ACTOR_ID);
    await taskService.assignTask(task.id, operador.id, clientId, warehouseId, SEED_ACTOR_ID);

    await expect(
      taskService.executeTask(
        task.id,
        { operationId: uuid(), scannedLpn: pallet.lpn, scannedLocationCode: locationB.code },
        clientId,
        warehouseId,
        operador.id // OPERADOR_EMPILHADEIRA não tem EST.PUTAWAY_OVERRIDE
      )
    ).rejects.toMatchObject({ response: { error: 'SCAN_LOCATION_MISMATCH' } });

    // "a tarefa deve permanecer pendente no endereço designado" (§6/§5.2).
    const after = await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID }, `SELECT * FROM wms.putaway_task WHERE id = $1`, [task.id]);
    expect(after.rows[0].status).toBe('ASSIGNED');
    expect(after.rows[0].location_id_designated).toBe(locationA.id);
    expect(after.rows[0].location_id_executed).toBeNull();

    // Nenhum saldo creditado no endereço lido por engano.
    const balance = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT COUNT(*) AS n FROM wms.stock_movement WHERE task_id = $1`,
      [task.id]
    );
    expect(Number(balance.rows[0].n)).toBe(0);
  });

  it('LPN divergente é rejeitado antes de qualquer efeito (RG-007)', async () => {
    const { order } = await orderWithPallet(5);
    const [task] = await taskService.generateTasksForOrder(order.id, clientId, warehouseId, SEED_ACTOR_ID);
    await taskService.assignTask(task.id, operador.id, clientId, warehouseId, SEED_ACTOR_ID);

    await expect(
      taskService.executeTask(task.id, { operationId: uuid(), scannedLpn: '000000000000000000', scannedLocationCode: locationA.code }, clientId, warehouseId, operador.id)
    ).rejects.toMatchObject({ response: { error: 'LPN_MISMATCH' } });
  });

  it('RN-REC-041: override COM permissão + motivo em endereço aprovado na Fase 1 é aceito e auditado como OVERRIDE', async () => {
    const { order, pallet } = await orderWithPallet(5);
    const [task] = await taskService.generateTasksForOrder(order.id, clientId, warehouseId, SEED_ACTOR_ID);
    await taskService.assignTask(task.id, gestor.id, clientId, warehouseId, SEED_ACTOR_ID);

    // Sem motivo: rejeitado.
    await expect(
      taskService.executeTask(task.id, { operationId: uuid(), scannedLpn: pallet.lpn, scannedLocationCode: locationB.code }, clientId, warehouseId, gestor.id)
    ).rejects.toMatchObject({ response: { error: 'OVERRIDE_REASON_REQUIRED' } });

    const executed = await taskService.executeTask(
      task.id,
      { operationId: uuid(), scannedLpn: pallet.lpn, scannedLocationCode: locationB.code, overrideReason: 'Corredor A1 nível 00 bloqueado por empilhadeira avariada' },
      clientId,
      warehouseId,
      gestor.id
    );
    expect(executed.override_applied).toBe(true);
    expect(executed.location_id).toBe(locationB.id);

    const audit = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT * FROM wms.audit_log WHERE entity = 'putaway_task' AND entity_id = $1 AND action = 'OVERRIDE'`,
      [task.id]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].reason).toMatch(/empilhadeira avariada/);
  });

  it('RN-REC-040 [INVIOLÁVEL]: override NÃO vence reprovação de Fase 1 (endereço INACTIVE)', async () => {
    const { order, pallet } = await orderWithPallet(5);
    const [task] = await taskService.generateTasksForOrder(order.id, clientId, warehouseId, SEED_ACTOR_ID);
    await taskService.assignTask(task.id, gestor.id, clientId, warehouseId, SEED_ACTOR_ID);

    const bloqueado = await createLocation('Z9', '001', '00', '01');
    await testContext.databaseService.queryGlobal(`UPDATE wms.location SET status = 'INACTIVE' WHERE id = $1`, [bloqueado.id]);

    await expect(
      taskService.executeTask(
        task.id,
        { operationId: uuid(), scannedLpn: pallet.lpn, scannedLocationCode: bloqueado.code, overrideReason: 'tentativa de forçar endereço inativo' },
        clientId,
        warehouseId,
        gestor.id // TEM EST.PUTAWAY_OVERRIDE — e ainda assim não passa
      )
    ).rejects.toMatchObject({ response: { error: 'PHASE1_VIOLATION_NO_OVERRIDE' } });
  });

  it('RNF-ARQ-050: mesma operation_id reenviada devolve o mesmo resultado e NÃO credita saldo duas vezes', async () => {
    const { order, product, pallet } = await orderWithPallet(7);
    const [task] = await taskService.generateTasksForOrder(order.id, clientId, warehouseId, SEED_ACTOR_ID);
    await taskService.assignTask(task.id, operador.id, clientId, warehouseId, SEED_ACTOR_ID);

    const operationId = uuid();
    const first = await taskService.executeTask(task.id, { operationId, scannedLpn: pallet.lpn, scannedLocationCode: locationA.code }, clientId, warehouseId, operador.id);
    expect(first.idempotent_replay).toBe(false);

    const replay = await taskService.executeTask(task.id, { operationId, scannedLpn: pallet.lpn, scannedLocationCode: locationA.code }, clientId, warehouseId, operador.id);
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.putaway_task_id).toBe(first.putaway_task_id);

    // Saldo creditado UMA vez só.
    const balance = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT qty_available FROM wms.stock_balance WHERE location_id = $1 AND product_id = $2`,
      [locationA.id, product.id]
    );
    expect(Number(balance.rows[0].qty_available)).toBe(7);

    const movements = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT COUNT(*) AS n FROM wms.stock_movement WHERE task_id = $1`,
      [task.id]
    );
    expect(Number(movements.rows[0].n)).toBe(1);
  });

  it('RF-REC-051: cancelamento do Pedido de cross-docking gera tarefa de putaway padrão (fecha o DÉBITO 4B)', async () => {
    // Zona/endereço de CROSS_DOCKING para o palete de cross-dock.
    const xdkZone = await zoneService.create({ warehouse_id: warehouseId, code: 'XDK', name: 'Cross-dock', zone_type: 'CROSS_DOCKING' }, SEED_ACTOR_ID);
    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type,
                                 max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'X1','001','00','01','CROSS_DOCK',5000,100,10,5,'ACTIVE',$3)`,
      [warehouseId, xdkZone.id, SEED_ACTOR_ID]
    );

    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto cross-dock', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1 },
      SEED_ACTOR_ID
    );
    const created = await inboundOrderService.createManual({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qtyExpected: 20 }] }, SEED_ACTOR_ID);

    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(`UPDATE wms.inbound_order SET status = 'AT_DOCK', dock_id = $2 WHERE id = $1`, [created.order.id, dockId]);
      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [created.order.id]);
      await operationFlowService.completeStep(client, flow.rows[0].id, 'DOCA', SEED_ACTOR_ID);
    });
    await checkingService.startUnloading(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    const checking = await checkingService.startChecking(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);

    // RN-REC-050: vínculo ANTES da conferência.
    const link = await crossDockService.linkToOutboundOrder(created.items[0].id, clientId, warehouseId, 'PED-SP01-00000900', 20, SEED_ACTOR_ID);
    await checkingService.countFirstRound(checking.id, created.items[0].id, 20, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID);
    const xdkPallet = await crossDockService.formCrossDockPallet(clientId, warehouseId, 'PBR', [link.id], SEED_ACTOR_ID);

    // Nenhuma tarefa de putaway ainda — RF-REC-051: "sem putaway de armazenagem".
    const before = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT COUNT(*) AS n FROM wms.putaway_task WHERE pallet_id = $1`,
      [xdkPallet.id]
    );
    expect(Number(before.rows[0].n)).toBe(0);

    // Pedido cancelado -> reserva desfeita + tarefa de putaway padrão gerada.
    const cancelled = await crossDockService.cancelLink(link.id, clientId, warehouseId, 'Pedido de saída cancelado pelo cliente', SEED_ACTOR_ID);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.putaway_task_id).not.toBeNull();

    const task = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT * FROM wms.putaway_task WHERE id = $1`,
      [cancelled.putaway_task_id]
    );
    expect(task.rows[0].pallet_id).toBe(xdkPallet.id);
    expect(task.rows[0].crossdock_link_id).toBe(link.id);
    expect(task.rows[0].status).toBe('CREATED');

    // E a tarefa é executável pelo motor padrão (RN-REC-040): recebe endereço
    // de armazenagem normal, não mais a zona CROSS_DOCKING.
    const assigned = await taskService.assignTask(cancelled.putaway_task_id, operador.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(assigned.suggestion.locationId).toBeTruthy();
    expect(assigned.suggestion.zoneId).not.toBe(xdkZone.id);
  });

  it('RF-REC-020: etapa dinâmica DIVERGENCIAS é intercalada entre CONFERENCIA e ETIQUETAGEM quando há divergência', async () => {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto divergente', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1 },
      SEED_ACTOR_ID
    );
    const created = await inboundOrderService.createManual({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qtyExpected: 100 }] }, SEED_ACTOR_ID);
    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(`UPDATE wms.inbound_order SET status = 'AT_DOCK', dock_id = $2 WHERE id = $1`, [created.order.id, dockId]);
      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [created.order.id]);
      await operationFlowService.completeStep(client, flow.rows[0].id, 'DOCA', SEED_ACTOR_ID);
    });
    await checkingService.startUnloading(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    const checking = await checkingService.startChecking(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);

    // Avaria cria uma Divergência -> etapa dinâmica deve nascer.
    await checkingService.registerAvaria(checking.id, created.items[0].id, 5, ['discrepancy/foto.jpg'], clientId, warehouseId, SEED_ACTOR_ID);

    const steps = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT fs.step_code, fs.sequence_order FROM wms.flow_step fs
       JOIN wms.operation_flow f ON f.id = fs.operation_flow_id
       WHERE f.entity = 'inbound_order' AND f.entity_id = $1 ORDER BY fs.sequence_order`,
      [created.order.id]
    );
    const codes = steps.rows.map((s: any) => s.step_code);
    expect(codes).toContain('DIVERGENCIAS');
    // Intercalada ENTRE Conferência e Etiquetagem (RF-REC-020, literal).
    expect(codes.indexOf('DIVERGENCIAS')).toBeGreaterThan(codes.indexOf('CONFERENCIA'));
    expect(codes.indexOf('DIVERGENCIAS')).toBeLessThan(codes.indexOf('ETIQUETAGEM'));
  });
});
