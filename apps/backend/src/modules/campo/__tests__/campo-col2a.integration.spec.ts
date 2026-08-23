// DOC-15 (Sessão COL-2A) — motor offline: Pacote de Turno (RF-ARQ-051), fila
// e resolução de conflitos (RF-ARQ-052/RN-ARQ-053, as 4 decisões), limite de
// fila não bloqueia (RNF-ARQ-054), gate de versão mínima (RNF-COL-050),
// telemetria (RNF-COL-051) e idempotência por operationId em
// CheckingService/StockTransferService/InventoryCountExecutionService
// (RNF-ARQ-050/RG-009, novo nesta sessão). Contra Postgres real.
import { v4 as uuid } from 'uuid';
import { ConfigService } from '@nestjs/config';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { ZoneService } from '../../cadastro/zone/zone.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { InboundOrderService } from '../../recebimento/inbound-order/inbound-order.service.js';
import { CheckingService } from '../../recebimento/checking/checking.service.js';
import { PutawayEngineService } from '../../recebimento/putaway/putaway-engine.service.js';
import { PutawayTaskService } from '../../recebimento/putaway/putaway-task.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { ReplenishmentTaskService } from '../../estoque/replenishment/replenishment-task.service.js';
import { StockTransferService } from '../../estoque/transfer/stock-transfer.service.js';
import { InventoryPlanningService } from '../../estoque/inventory/inventory-planning.service.js';
import { InventoryCountExecutionService } from '../../estoque/inventory/inventory-count-execution.service.js';
import { StockSelectionService } from '../../estoque/selection/stock-selection.service.js';
import { StockReservationService } from '../../estoque/selection/stock-reservation.service.js';
import { OutboundFlowService } from '../../expedicao/order/outbound-flow.service.js';
import { PickingTaskService } from '../../expedicao/picking/picking-task.service.js';
import { FieldDeviceService } from '../field-device/field-device.service.js';
import { ShiftPackageService } from '../shift-package/shift-package.service.js';
import { OfflineSyncService } from '../offline-sync/offline-sync.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';
import { createTestUser } from '../../../core/__tests__/security-test-helpers.js';

describe('DOC-15 Sessão COL-2A — motor offline: Pacote de Turno, fila e resolução de conflitos', () => {
  let testContext: TestContext;

  let checkingService: CheckingService;
  let inboundOrderService: InboundOrderService;
  let operationFlowService: OperationFlowService;
  let putawayTaskService: PutawayTaskService;
  let replenishmentTaskService: ReplenishmentTaskService;
  let stockTransferService: StockTransferService;
  let inventoryPlanningService: InventoryPlanningService;
  let inventoryCountExecutionService: InventoryCountExecutionService;
  let fieldDeviceService: FieldDeviceService;
  let shiftPackageService: ShiftPackageService;
  let offlineSyncService: OfflineSyncService;
  let productService: ProductService;

  let clientId: string;
  let warehouseId: string;
  let storageZoneId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const rbacService = new RbacService(db);
    operationFlowService = new OperationFlowService(db);
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    const operationalExceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    const documentNumberingService = new DocumentNumberingService(db);
    const fileStorageService = new FileStorageService(testContext.configService as ConfigService);
    fileStorageService.onModuleInit();
    const stockMovementService = new StockMovementService(db);
    const putawayEngineService = new PutawayEngineService(db);
    const selectionService = new StockSelectionService(db);
    const reservationService = new StockReservationService(db, eventsService, auditService, rbacService, selectionService, stockMovementService);
    const outboundFlowService = new OutboundFlowService(db, eventsService, operationFlowService);

    inboundOrderService = new InboundOrderService(db, eventsService, auditService, operationalExceptionService, operationFlowService, fileStorageService, documentNumberingService);
    checkingService = new CheckingService(db, eventsService, auditService, operationalExceptionService, operationFlowService);
    putawayTaskService = new PutawayTaskService(db, eventsService, auditService, rbacService, operationFlowService, putawayEngineService, stockMovementService);
    replenishmentTaskService = new ReplenishmentTaskService(db, eventsService, auditService, stockMovementService);
    stockTransferService = new StockTransferService(db, eventsService, auditService, rbacService, documentNumberingService, putawayEngineService, stockMovementService);
    inventoryPlanningService = new InventoryPlanningService(db, eventsService, documentNumberingService);
    inventoryCountExecutionService = new InventoryCountExecutionService(db, eventsService, auditService, operationalExceptionService, stockMovementService);
    fieldDeviceService = new FieldDeviceService(db, auditService, eventsService);
    shiftPackageService = new ShiftPackageService(db);

    // PICKING (T3): OfflineSyncService.executeTask() despacha para
    // PickingTaskService.executeTask() quando taskType='PICKING' — o
    // construtor real é usado para que a instância seja válida, mas nenhum
    // cenário desta suíte exercita o dispatch PICKING: a fixture completa
    // (onda -> reserva -> tarefa) tem o mesmo custo do arquivo inteiro de
    // picking-packing-carregamento.integration.spec.ts (DOC-06, Sessão 6B),
    // fora de escopo para esta sessão (COL-2A é o motor de sincronização, não
    // reteste do módulo de picking). PUTAWAY/REPOSICAO já provam as 4
    // decisões de RN-ARQ-053 em 2 tipos de tarefa distintos, conforme o
    // prompt desta sessão permite ("aceitável testar TRANSFERENCIA e deixar
    // PICKING coberto só estruturalmente"). [DÉBITO: cenários PICKING via
    // OfflineSyncService — sessão-alvo COL-2B ou futura sessão de regressão
    // de picking, quando a fixture completa já existir reutilizável.]
    const pickingTaskService = new PickingTaskService(
      db,
      eventsService,
      auditService,
      rbacService,
      operationFlowService,
      operationalExceptionService,
      stockMovementService,
      reservationService,
      inventoryPlanningService,
      outboundFlowService
    );

    offlineSyncService = new OfflineSyncService(
      db,
      eventsService,
      auditService,
      operationalExceptionService,
      fieldDeviceService,
      putawayTaskService,
      checkingService,
      replenishmentTaskService,
      stockTransferService,
      inventoryCountExecutionService,
      pickingTaskService
    );

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém COL-2A', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente COL-2A', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', blind_checking: true },
      SEED_ACTOR_ID
    );

    const zone = await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
    storageZoneId = zone.id;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  // ── Helpers de fixture ──────────────────────────────────────────────────
  let locationSeq = 0;
  async function createLocation() {
    locationSeq += 1;
    const result = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'A9',$3,'00','01','STORAGE',5000,100,5,5,'ACTIVE',$4) RETURNING *`,
      [warehouseId, storageZoneId, String(locationSeq).padStart(3, '0'), SEED_ACTOR_ID]
    );
    return result.rows[0];
  }

  async function createProduct(desc = 'Produto COL-2A') {
    return productService.create(
      { tenant_id: clientId, sku: randomSku(), description: desc, species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1 },
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

  async function readAvailable(productId: string, locationId: string): Promise<number> {
    const result = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available FROM wms.stock_balance WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3 AND location_id = $4`,
      [clientId, warehouseId, productId, locationId]
    );
    return Number(result.rows[0]?.qty_available ?? 0);
  }

  let palletSeq = 0;
  async function createPalletWithContent(productId: string, qty: number) {
    palletSeq += 1;
    const lpn = (Date.now().toString() + String(palletSeq).padStart(6, '0')).slice(-18).padStart(18, '0');
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    const palletResult = await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.pallet (tenant_id, lpn, pallet_type, status, created_by) VALUES ($1,$2,'PBR','IN_RECEIVING',$3) RETURNING *`,
      [clientId, lpn, SEED_ACTOR_ID]
    );
    const pallet = palletResult.rows[0];
    await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.pallet_content (tenant_id, pallet_id, product_id, qty, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [clientId, pallet.id, productId, qty, SEED_ACTOR_ID]
    );
    return pallet;
  }

  /** putaway_task ASSIGNED já pronta para OfflineSyncService/PutawayTaskService.executeTask (RG-007: pallet/location reais). */
  async function createPutawayTaskAssigned(productId: string, qty: number, location: any, operatorId = SEED_ACTOR_ID) {
    const pallet = await createPalletWithContent(productId, qty);
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    const taskResult = await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.putaway_task (tenant_id, warehouse_id, pallet_id, location_id_designated, assigned_to_user_id, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'ASSIGNED',$6) RETURNING *`,
      [clientId, warehouseId, pallet.id, location.id, operatorId, SEED_ACTOR_ID]
    );
    return { task: taskResult.rows[0], pallet };
  }

  /** replenishment_task ASSIGNED já pronta, com saldo real na origem. */
  async function createReplenishmentTaskAssigned(productId: string, qty: number, origin: any, destination: any, operatorId = SEED_ACTOR_ID) {
    await seedBalance(productId, origin.id, qty + 100);
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    const taskResult = await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.replenishment_task (tenant_id, warehouse_id, product_id, trigger_type, location_id_origin, location_id_destination, qty, assigned_to_user_id, status, created_by)
       VALUES ($1,$2,$3,'MANUAL',$4,$5,$6,$7,'ASSIGNED',$8) RETURNING *`,
      [clientId, warehouseId, productId, origin.id, destination.id, qty, operatorId, SEED_ACTOR_ID]
    );
    return taskResult.rows[0];
  }

  /** Ordem manual -> CHECKING (item CHECKING_PENDING), mesmo helper de checking.integration.spec.ts. */
  async function bringOrderToChecking(items: { sku: string; qty: number; description?: string }[]) {
    const productIds: string[] = [];
    for (const it of items) {
      const product = await productService.create(
        { tenant_id: clientId, sku: it.sku, description: it.description ?? `Produto ${it.sku}`, species_code: 'GERAL', base_uom: 'UN' },
        SEED_ACTOR_ID
      );
      productIds.push(product.id);
    }
    const created = await inboundOrderService.createManual(
      { tenantId: clientId, warehouseId, items: items.map((it, idx) => ({ productId: productIds[idx], qtyExpected: it.qty })) },
      SEED_ACTOR_ID
    );
    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(`UPDATE wms.inbound_order SET status = 'AT_DOCK' WHERE id = $1`, [created.order.id]);
      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [created.order.id]);
      await operationFlowService.completeStep(client, flow.rows[0].id, 'DOCA', SEED_ACTOR_ID);
    });
    await checkingService.startUnloading(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    const checking = await checkingService.startChecking(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    return { order: created.order, items: created.items, checking };
  }

  // =========================================================================
  // a) Idempotência de operationId — CheckingService/StockTransferService/
  //    InventoryCountExecutionService (novo nesta sessão)
  // =========================================================================
  describe('a) Idempotência de operationId (RNF-ARQ-050/RG-009) nos 3 services novos', () => {
    it('CheckingService.countFirstRound: reenvio com o mesmo operationId devolve idempotent_replay e NÃO duplica o round', async () => {
      const { items, checking } = await bringOrderToChecking([{ sku: randomSku(), qty: 20 }]);
      const operationId = uuid();

      const first = await checkingService.countFirstRound(checking.id, items[0].id, 20, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID, operationId);
      expect((first as any).idempotent_replay).toBeUndefined();
      expect(first.item.status).toBe('CHECKED');

      const replay = await checkingService.countFirstRound(checking.id, items[0].id, 20, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID, operationId);
      expect((replay as any).idempotent_replay).toBe(true);
      expect(replay.item.id).toBe(first.item.id);

      const rounds = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT * FROM wms.checking_item WHERE checking_id = $1 AND inbound_order_item_id = $2`,
        [checking.id, items[0].id]
      );
      expect(rounds.rows.length).toBeGreaterThan(0); // afirma não-vazio antes de fixar a contagem exata
      expect(rounds.rows).toHaveLength(1); // não duplicou
    });

    it('StockTransferService.transferInternal: reenvio com o mesmo operationId devolve idempotent_replay e NÃO cria uma 2ª stock_transfer', async () => {
      const product = await createProduct('Produto transfer idempotente');
      const origin = await createLocation();
      const destination = await createLocation();
      await seedBalance(product.id, origin.id, 50);
      const operationId = uuid();

      const first = await stockTransferService.transferInternal({
        tenantId: clientId,
        warehouseId,
        productId: product.id,
        qty: 15,
        locationIdOrigin: origin.id,
        locationIdDestination: destination.id,
        actorUserId: SEED_ACTOR_ID,
        operationId,
      });
      expect((first as any).idempotent_replay).toBeUndefined();

      const replay = await stockTransferService.transferInternal({
        tenantId: clientId,
        warehouseId,
        productId: product.id,
        qty: 15,
        locationIdOrigin: origin.id,
        locationIdDestination: destination.id,
        actorUserId: SEED_ACTOR_ID,
        operationId,
      });
      expect((replay as any).idempotent_replay).toBe(true);
      expect(replay.id).toBe(first.id);

      const items = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT * FROM wms.stock_transfer_item WHERE product_id = $1`,
        [product.id]
      );
      expect(items.rows.length).toBeGreaterThan(0);
      expect(items.rows).toHaveLength(1); // não duplicou

      expect(await readAvailable(product.id, origin.id)).toBe(35); // 50 - 15, uma única vez
      expect(await readAvailable(product.id, destination.id)).toBe(15);
    });

    it('InventoryCountExecutionService.submitRound: reenvio com o mesmo operationId devolve idempotentReplay e NÃO duplica a rodada', async () => {
      const product = await createProduct('Produto inventário idempotente');
      const loc = await createLocation();
      await seedBalance(product.id, loc.id, 40);
      const planned = await inventoryPlanningService.plan({ tenantId: clientId, warehouseId, countType: 'POR_ENDERECO', locationIds: [loc.id], actorUserId: SEED_ACTOR_ID });
      await inventoryPlanningService.start(clientId, warehouseId, planned.headerId, SEED_ACTOR_ID);
      const cellResult = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT * FROM wms.inventory_count_location WHERE header_id = $1`,
        [planned.headerId]
      );
      const cellId = cellResult.rows[0].id;
      const operationId = uuid();

      const first = await inventoryCountExecutionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 40, actorUserId: SEED_ACTOR_ID, operationId });
      expect(first).toEqual({ status: 'COMPLETED' });

      const replay = await inventoryCountExecutionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 40, actorUserId: SEED_ACTOR_ID, operationId });
      expect((replay as any).idempotentReplay).toBe(true);
      expect(replay.status).toBe('COMPLETED');

      const rounds = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT * FROM wms.inventory_count_round WHERE count_location_id = $1`,
        [cellId]
      );
      expect(rounds.rows.length).toBeGreaterThan(0);
      expect(rounds.rows).toHaveLength(1); // não duplicou
    });
  });

  // =========================================================================
  // b) As 4 decisões de RN-ARQ-053 via OfflineSyncService.sincronizar()
  // =========================================================================
  describe('b) RN-ARQ-053 — as 4 decisões via OfflineSyncService.sincronizar()', () => {
    it('Decisão 1 APLICADA — PUTAWAY: tarefa ASSIGNED válida sincroniza e credita o mesmo efeito de uma execução online', async () => {
      const product = await createProduct('Putaway decisão 1');
      const loc = await createLocation();
      const { task, pallet } = await createPutawayTaskAssigned(product.id, 10, loc);
      const operationId = uuid();

      const batch = await offlineSyncService.sincronizar({
        deviceId: uuid(),
        warehouseId,
        operations: [{ operationId, tenantId: clientId, taskType: 'PUTAWAY', taskId: task.id, payload: { scannedLpn: pallet.lpn, scannedLocationCode: loc.code } }],
        actorUserId: SEED_ACTOR_ID,
      });

      expect(batch.versionBlocked).toBe(false);
      expect(batch.results).toHaveLength(1);
      expect(batch.results[0].decision).toBe('APLICADA');

      expect(await readAvailable(product.id, loc.id)).toBe(10);

      const syncOp = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT status FROM wms.sync_operation WHERE idempotency_key = $1`,
        [operationId]
      );
      expect(syncOp.rows).toHaveLength(1);
      expect(syncOp.rows[0].status).toBe('APLICADA');
    });

    it('Decisão 1 APLICADA — REPOSICAO: tarefa ASSIGNED válida sincroniza e move saldo storage -> picking', async () => {
      const product = await createProduct('Reposição decisão 1');
      const origin = await createLocation();
      const destination = await createLocation();
      const task = await createReplenishmentTaskAssigned(product.id, 12, origin, destination);

      const batch = await offlineSyncService.sincronizar({
        deviceId: uuid(),
        warehouseId,
        operations: [
          { operationId: uuid(), tenantId: clientId, taskType: 'REPOSICAO', taskId: task.id, payload: { scannedLocationCodeFrom: origin.code, scannedLocationCodeTo: destination.code } },
        ],
        actorUserId: SEED_ACTOR_ID,
      });

      expect(batch.results[0].decision).toBe('APLICADA');
      expect(await readAvailable(product.id, destination.id)).toBe(12);
    });

    it('Decisão 2 DESCARTADA_DUPLICIDADE — PUTAWAY: tarefa já DONE (concluída por outro ator) é descartada sem efeito', async () => {
      const product = await createProduct('Putaway decisão 2');
      const loc = await createLocation();
      const { task, pallet } = await createPutawayTaskAssigned(product.id, 8, loc);

      // Simula "concluída por outro ator" ANTES desta sincronização chegar.
      await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `UPDATE wms.putaway_task SET status = 'DONE' WHERE id = $1`,
        [task.id]
      );

      const batch = await offlineSyncService.sincronizar({
        deviceId: uuid(),
        warehouseId,
        operations: [{ operationId: uuid(), tenantId: clientId, taskType: 'PUTAWAY', taskId: task.id, payload: { scannedLpn: pallet.lpn, scannedLocationCode: loc.code } }],
        actorUserId: SEED_ACTOR_ID,
      });

      expect(batch.results[0].decision).toBe('DESCARTADA_DUPLICIDADE');
      // Nenhum efeito de estoque desta sincronização (a tarefa nunca foi
      // realmente executada — status DONE foi forçado só para simular).
      const movements = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT COUNT(*) AS n FROM wms.stock_movement WHERE task_id = $1`,
        [task.id]
      );
      expect(Number(movements.rows[0].n)).toBe(0);
    });

    it('Decisão 3 REJEITADA_TAREFA_INVALIDA — REPOSICAO: tarefa cancelada após o aprovisionamento vira pendência de supervisão, sem efeito', async () => {
      const product = await createProduct('Reposição decisão 3');
      const origin = await createLocation();
      const destination = await createLocation();
      const task = await createReplenishmentTaskAssigned(product.id, 5, origin, destination);

      await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `UPDATE wms.replenishment_task SET status = 'CANCELLED' WHERE id = $1`,
        [task.id]
      );

      const batch = await offlineSyncService.sincronizar({
        deviceId: uuid(),
        warehouseId,
        operations: [
          { operationId: uuid(), tenantId: clientId, taskType: 'REPOSICAO', taskId: task.id, payload: { scannedLocationCodeFrom: origin.code, scannedLocationCodeTo: destination.code } },
        ],
        actorUserId: SEED_ACTOR_ID,
      });

      expect(batch.results[0].decision).toBe('REJEITADA_TAREFA_INVALIDA');
      expect(await readAvailable(product.id, destination.id)).toBe(0); // sem efeito
    });

    it('Decisão 4 REJEITADA_REGRA — REPOSICAO: leitura de origem divergente vira Divergência (COL.SINCRONIZACAO_REJEITADA), sem efeito', async () => {
      const product = await createProduct('Reposição decisão 4');
      const origin = await createLocation();
      const destination = await createLocation();
      const task = await createReplenishmentTaskAssigned(product.id, 6, origin, destination);

      const batch = await offlineSyncService.sincronizar({
        deviceId: uuid(),
        warehouseId,
        operations: [
          { operationId: uuid(), tenantId: clientId, taskType: 'REPOSICAO', taskId: task.id, payload: { scannedLocationCodeFrom: 'CODIGO-ERRADO', scannedLocationCodeTo: destination.code } },
        ],
        actorUserId: SEED_ACTOR_ID,
      });

      expect(batch.results[0].decision).toBe('REJEITADA_REGRA');
      expect(await readAvailable(product.id, destination.id)).toBe(0);

      const exception = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT * FROM wms.operational_exception WHERE exception_type = 'COL.SINCRONIZACAO_REJEITADA' AND entity = 'replenishment_task' AND entity_id = $1`,
        [task.id]
      );
      expect(exception.rows).toHaveLength(1);
    });

    it('Reenvio idempotente da sincronização (DOC-01 §6): mesmo operationId já APLICADA continua APLICADA, sem efeito duplicado', async () => {
      const product = await createProduct('Putaway reenvio idempotente');
      const loc = await createLocation();
      const { task, pallet } = await createPutawayTaskAssigned(product.id, 9, loc);
      const operationId = uuid();
      const op = { operationId, tenantId: clientId, taskType: 'PUTAWAY' as const, taskId: task.id, payload: { scannedLpn: pallet.lpn, scannedLocationCode: loc.code } };

      const first = await offlineSyncService.sincronizar({ deviceId: uuid(), warehouseId, operations: [op], actorUserId: SEED_ACTOR_ID });
      expect(first.results[0].decision).toBe('APLICADA');
      expect(await readAvailable(product.id, loc.id)).toBe(9);

      const replay = await offlineSyncService.sincronizar({ deviceId: uuid(), warehouseId, operations: [op], actorUserId: SEED_ACTOR_ID });
      expect(replay.results[0].decision).toBe('APLICADA');
      expect((replay.results[0].result as any)?.idempotent_replay).toBe(true);

      expect(await readAvailable(product.id, loc.id)).toBe(9); // não dobrou

      const movements = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT COUNT(*) AS n FROM wms.stock_movement WHERE task_id = $1`,
        [task.id]
      );
      expect(Number(movements.rows[0].n)).toBe(1);
    });

    it('TRANSFERENCIA (RF-EST-050 ad-hoc, sem taskId dirigido): APLICADA move saldo diretamente via StockTransferService', async () => {
      const product = await createProduct('Transferência offline');
      const origin = await createLocation();
      const destination = await createLocation();
      await seedBalance(product.id, origin.id, 30);

      const batch = await offlineSyncService.sincronizar({
        deviceId: uuid(),
        warehouseId,
        operations: [
          {
            operationId: uuid(),
            tenantId: clientId,
            taskType: 'TRANSFERENCIA',
            payload: { productId: product.id, qty: 20, locationIdOrigin: origin.id, locationIdDestination: destination.id },
          },
        ],
        actorUserId: SEED_ACTOR_ID,
      });

      expect(batch.results[0].decision).toBe('APLICADA');
      expect(await readAvailable(product.id, origin.id)).toBe(10);
      expect(await readAvailable(product.id, destination.id)).toBe(20);
    });
  });

  // =========================================================================
  // c) RNF-ARQ-054 — limite de fila não bloqueia a sincronização no servidor
  // =========================================================================
  describe('c) RNF-ARQ-054 — servidor processa a fila inteira, sem rejeição pelo tamanho', () => {
    it('lote com várias operações: todas processadas, nenhuma rejeitada só pelo tamanho do lote', async () => {
      const BATCH_SIZE = 6;
      const operations = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        const product = await createProduct(`Lote RNF-ARQ-054 #${i}`);
        const loc = await createLocation();
        const { task, pallet } = await createPutawayTaskAssigned(product.id, 3, loc);
        operations.push({ operationId: uuid(), tenantId: clientId, taskType: 'PUTAWAY' as const, taskId: task.id, payload: { scannedLpn: pallet.lpn, scannedLocationCode: loc.code } });
      }

      const batch = await offlineSyncService.sincronizar({ deviceId: uuid(), warehouseId, operations, actorUserId: SEED_ACTOR_ID });

      expect(batch.results).toHaveLength(BATCH_SIZE);
      const rejectedBySize = batch.results.filter((r) => r.decision !== 'APLICADA');
      expect(rejectedBySize).toHaveLength(0);
    });
  });

  // =========================================================================
  // d) ShiftPackageService respeita COL.PACOTE_TURNO_MAX
  // =========================================================================
  describe('d) RF-ARQ-051 — ShiftPackageService respeita COL.PACOTE_TURNO_MAX', () => {
    it('teto baixo: build() trunca e sinaliza truncated=true, taskCount=maxTasks', async () => {
      // cleanTestData() (test-setup.helper.ts) apaga wms.app_parameter no
      // setup do arquivo — o default de COL.PACOTE_TURNO_MAX (migration
      // 0068) não sobrevive; precisa ser inserido explicitamente (mesmo
      // achado do CLAUDE.md "app_parameter test gap").
      await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', 'COL.PACOTE_TURNO_MAX', '2')`
      );

      const operator = await createTestUser(testContext.databaseService, new PasswordService(testContext.databaseService));
      for (let i = 0; i < 5; i++) {
        const product = await createProduct(`Pacote turno #${i}`);
        const loc = await createLocation();
        await createPutawayTaskAssigned(product.id, 1, loc, operator.id);
      }

      const pkg = await shiftPackageService.build(warehouseId, operator.id);
      expect(pkg.maxTasks).toBe(2);
      expect(pkg.truncated).toBe(true);
      expect(pkg.taskCount).toBe(2);
      expect(pkg.tasks).toHaveLength(2);
    });
  });

  // =========================================================================
  // e) RNF-COL-050 — gate de versão mínima
  // =========================================================================
  describe('e) RNF-COL-050 — versão mínima bloqueia execução, nunca a sincronização', () => {
    it('isVersionBlocked: abaixo de COL.VERSAO_MINIMA bloqueia; igual/acima não', async () => {
      await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', 'COL.VERSAO_MINIMA', '1.0.0')`
      );

      expect(await fieldDeviceService.isVersionBlocked('0.9.0')).toBe(true);
      expect(await fieldDeviceService.isVersionBlocked('1.0.0')).toBe(false);
      expect(await fieldDeviceService.isVersionBlocked('2.0.0')).toBe(false);
    });

    it('registerOrTouch com versão antiga devolve versionBlocked=true mas NÃO lança erro (registro continua permitido)', async () => {
      const deviceId = uuid();
      const device = await fieldDeviceService.registerOrTouch({ deviceId, warehouseId, appVersion: '0.5.0', actorUserId: SEED_ACTOR_ID });
      expect(device.status).toBe('ACTIVE');
      expect((device as any).versionBlocked).toBe(true);
    });
  });

  // =========================================================================
  // f) RNF-COL-051 — telemetria com tamanho de fila e falhas de leitura
  // =========================================================================
  describe('f) RNF-COL-051 — telemetria (bateria, fila, falhas de leitura físico/câmera)', () => {
    it('recordTelemetry grava queue_size/read_failures_physical/read_failures_camera', async () => {
      const deviceId = uuid();
      await fieldDeviceService.registerOrTouch({ deviceId, warehouseId, actorUserId: SEED_ACTOR_ID });

      await fieldDeviceService.recordTelemetry(deviceId, 80, 5, 1, 0);

      const row = await testContext.databaseService.queryGlobal(
        `SELECT battery_pct, queue_size, read_failures_physical, read_failures_camera FROM wms.field_device WHERE device_id = $1`,
        [deviceId]
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].battery_pct).toBe(80);
      expect(row.rows[0].queue_size).toBe(5);
      expect(row.rows[0].read_failures_physical).toBe(1);
      expect(row.rows[0].read_failures_camera).toBe(0);
    });
  });
});
