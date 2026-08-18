// DOC-05 §4.5 — RF-EST-040 (estoque de segurança, cruzamento de limiar),
// RF-EST-041 (kanban, dedup de tarefa aberta) e RF-EST-042 (execução da
// reposição com dupla leitura + idempotência RNF-ARQ-050).
import { BadRequestException } from '@nestjs/common';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { ZoneService } from '../../cadastro/zone/zone.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { StockMovementService } from '../movement/stock-movement.service.js';
import { SafetyStockService } from '../replenishment/safety-stock.service.js';
import { KanbanService } from '../replenishment/kanban.service.js';
import { StockSelectionService } from '../selection/stock-selection.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ReplenishmentTaskService } from '../replenishment/replenishment-task.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';
import { v4 as uuid } from 'uuid';

describe('Estoque - DOC-05 §4.5 RF-EST-040/041/042 estoque de segurança, kanban e reposição', () => {
  let testContext: TestContext;
  let safetyStockService: SafetyStockService;
  let kanbanService: KanbanService;
  let replenishmentTaskService: ReplenishmentTaskService;
  let productService: ProductService;

  let clientId: string;
  let warehouseId: string;
  let storageLocation: any;
  let pickingLocation: any;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const stockMovementService = new StockMovementService(db);
    replenishmentTaskService = new ReplenishmentTaskService(db, eventsService, auditService, stockMovementService);
    safetyStockService = new SafetyStockService(db, eventsService);
    // Sessão 5B: o kanban passou a escolher a origem pela Seleção de Saldo
    // real (RF-EST-041/RN-EST-011), no lugar da heurística provisória da 5A.
    kanbanService = new KanbanService(db, eventsService, replenishmentTaskService, new StockSelectionService(db));

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém reposição', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente reposição', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    // Sessão 5B: o kanban agora resolve a política de giro por RG-006
    // (produto → cliente×armazém). Sem o cadastro cliente×armazém não há
    // política a resolver e a seleção recusa escolher uma — por isso o
    // fixture passou a criar as settings (que em operação real são
    // obrigatórias para o cliente operar no armazém).
    await new ClientWarehouseSettingsService(db, auditService).create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', blind_checking: true },
      SEED_ACTOR_ID
    );

    const storageZone = await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
    const pickingZone = await zoneService.create({ warehouse_id: warehouseId, code: 'PIK', name: 'Picking', zone_type: 'PICKING' }, SEED_ACTOR_ID);

    const storageResult = await db.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'A1','001','00','01','STORAGE',5000,100,5,5,'ACTIVE',$3) RETURNING *`,
      [warehouseId, storageZone.id, SEED_ACTOR_ID]
    );
    storageLocation = storageResult.rows[0];

    const pickingResult = await db.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'A1','002','00','01','PICKING',5000,100,5,5,'ACTIVE',$3) RETURNING *`,
      [warehouseId, pickingZone.id, SEED_ACTOR_ID]
    );
    pickingLocation = pickingResult.rows[0];
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function seedProduct(): Promise<any> {
    return productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto reposição', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1 },
      SEED_ACTOR_ID
    );
  }

  async function seedBalance(productId: string, locationId: string, qty: number) {
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    await rawAuthorizedQuery(
      testContext.databaseService,
      ctx,
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

  it('RF-EST-040: alerta na travessia do limiar (não repete enquanto permanece abaixo; reseta e pode alertar de novo)', async () => {
    const product = await seedProduct();
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.product_warehouse_parameter (tenant_id, product_id, warehouse_id, safety_stock_qty, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [clientId, product.id, warehouseId, 20, SEED_ACTOR_ID]
    );
    await seedBalance(product.id, storageLocation.id, 15); // abaixo de 20

    const first = await safetyStockService.checkSafetyStock();
    expect(first.violatedProductIds).toContain(product.id);

    // Continua abaixo — 2ª checagem NÃO deve re-violar (já ativo).
    const second = await safetyStockService.checkSafetyStock();
    expect(second.violatedProductIds).not.toContain(product.id);

    // Recupera acima do limiar — reseta o alerta (sem notificar recuperação).
    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(`SELECT set_config('app.stock_movement_authorized', 'true', true)`);
      await client.query(`UPDATE wms.stock_balance SET qty_available = 25 WHERE tenant_id = $1 AND product_id = $2`, [clientId, product.id]);
    });
    const third = await safetyStockService.checkSafetyStock();
    expect(third.recoveredProductIds).toContain(product.id);

    // Cai abaixo de novo — é um NOVO cruzamento, deve alertar de novo.
    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(`SELECT set_config('app.stock_movement_authorized', 'true', true)`);
      await client.query(`UPDATE wms.stock_balance SET qty_available = 5 WHERE tenant_id = $1 AND product_id = $2`, [clientId, product.id]);
    });
    const fourth = await safetyStockService.checkSafetyStock();
    expect(fourth.violatedProductIds).toContain(product.id);
  });

  it('RF-EST-041/042: kanban gera reposição, não duplica enquanto aberta, e a execução move storage -> picking', async () => {
    const product = await seedProduct();
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.product_warehouse_parameter (tenant_id, product_id, warehouse_id, kanban_enabled, kanban_trigger_qty, kanban_replenish_qty, default_picking_location_id, created_by)
       VALUES ($1,$2,$3,TRUE,$4,$5,$6,$7)`,
      [clientId, product.id, warehouseId, 15, 30, pickingLocation.id, SEED_ACTOR_ID]
    );
    await seedBalance(product.id, storageLocation.id, 100);
    await seedBalance(product.id, pickingLocation.id, 10); // <= kanban_trigger_qty (15)

    const first = await kanbanService.checkKanban();
    expect(first.generatedTaskIds).toHaveLength(1);

    // Reposição já aberta — 2ª checagem não gera outra (dedup RF-EST-041).
    const second = await kanbanService.checkKanban();
    expect(second.generatedTaskIds).toHaveLength(0);
    expect(second.skippedProductIds).toContain(product.id);

    const taskId = first.generatedTaskIds[0];
    const operador = SEED_ACTOR_ID;
    await replenishmentTaskService.assignTask(taskId, operador, clientId, warehouseId, SEED_ACTOR_ID);

    // Leitura divergente (origem trocada) -> REJECTED_SCAN.
    await expect(
      replenishmentTaskService.executeTask(taskId, { operationId: uuid(), scannedLocationCodeFrom: pickingLocation.code, scannedLocationCodeTo: pickingLocation.code }, clientId, warehouseId, SEED_ACTOR_ID)
    ).rejects.toBeInstanceOf(BadRequestException);

    // Reatribui (REJECTED_SCAN -> ASSIGNED) e executa corretamente.
    await replenishmentTaskService.assignTask(taskId, operador, clientId, warehouseId, SEED_ACTOR_ID);
    const operationId = uuid();
    const executed = await replenishmentTaskService.executeTask(
      taskId,
      { operationId, scannedLocationCodeFrom: storageLocation.code, scannedLocationCodeTo: pickingLocation.code },
      clientId,
      warehouseId,
      SEED_ACTOR_ID
    );
    expect(executed.task.status).toBe('DONE');
    expect(executed.idempotent_replay).toBe(false);

    expect(await readAvailable(product.id, storageLocation.id)).toBe(70); // 100 - 30
    expect(await readAvailable(product.id, pickingLocation.id)).toBe(40); // 10 + 30

    // Replay idempotente (RNF-ARQ-050): mesma operationId não move saldo de novo.
    const replay = await replenishmentTaskService.executeTask(
      taskId,
      { operationId, scannedLocationCodeFrom: storageLocation.code, scannedLocationCodeTo: pickingLocation.code },
      clientId,
      warehouseId,
      SEED_ACTOR_ID
    );
    expect(replay.idempotent_replay).toBe(true);
    expect(await readAvailable(product.id, storageLocation.id)).toBe(70);
    expect(await readAvailable(product.id, pickingLocation.id)).toBe(40);
  });
});
