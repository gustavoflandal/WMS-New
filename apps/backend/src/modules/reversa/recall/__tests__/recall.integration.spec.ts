// DOC-07 §4.4/§6 RF-REV-030 — Recall de lote (Sessão 9B). Cenário Gherkin:
// "Recall bloqueia em todos os armazéns" (DOC-07 §6) — números EXATOS do
// enunciado (300 UN em SP01, 120 UN em RJ01, reserva de 50 UN).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../../cadastro/product/product.service.js';
import { BatchService } from '../../../cadastro/batch/batch.service.js';
import { DocumentNumberingService } from '../../../cadastro/document-numbering/document-numbering.service.js';
import { AuditService } from '../../../../core/audit/audit.service.js';
import { EventsService } from '../../../../core/events/events.service.js';
import { ApprovalAuthorityService } from '../../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../../core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../../../../core/operation-flow/operation-flow.service.js';
import { RbacService } from '../../../../core/rbac/rbac.service.js';
import { StockMovementService } from '../../../estoque/movement/stock-movement.service.js';
import { StockBlockService } from '../../../estoque/blocking/stock-block.service.js';
import { StockSelectionService } from '../../../estoque/selection/stock-selection.service.js';
import { StockReservationService } from '../../../estoque/selection/stock-reservation.service.js';
import { ReturnOrderService } from '../../return-order/return-order.service.js';
import { RecallService } from '../recall.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../../cadastro/__tests__/test-helpers.js';

describe('DOC-07 §4.4/§6 RF-REV-030 — Recall de lote (Sessão 9B)', () => {
  let testContext: TestContext;
  let db: TestContext['databaseService'];
  let recallService: RecallService;
  let stockReservationService: StockReservationService;
  let stockMovementService: StockMovementService;
  let productService: ProductService;
  let batchService: BatchService;
  let clientId: string;
  let warehouseSpId: string;
  let warehouseRjId: string;
  let locationSpId: string;
  let locationRjId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    const operationalExceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    const operationFlowService = new OperationFlowService(db);
    const documentNumberingService = new DocumentNumberingService(db);
    batchService = new BatchService(db, auditService);
    stockMovementService = new StockMovementService(db);
    const stockBlockService = new StockBlockService(db, stockMovementService, auditService);
    const stockSelectionService = new StockSelectionService(db);
    const rbacService = new RbacService(db);
    stockReservationService = new StockReservationService(db, eventsService, auditService, rbacService, stockSelectionService, stockMovementService);
    const returnOrderService = new ReturnOrderService(db, eventsService, auditService, operationalExceptionService, operationFlowService, documentNumberingService);
    recallService = new RecallService(db, eventsService, auditService, stockMovementService, stockBlockService, stockReservationService, batchService, returnOrderService);

    productService = new ProductService(db, auditService);
    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);

    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente recall', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    const warehouseSp = await warehouseService.create({ code: randomWarehouseCode(), name: 'SP01', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseSpId = warehouseSp.id;
    const warehouseRj = await warehouseService.create({ code: randomWarehouseCode(), name: 'RJ01', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseRjId = warehouseRj.id;

    for (const warehouseId of [warehouseSpId, warehouseRjId]) {
      await settingsService.create({ tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'INTEGRADO_ERP', default_giro_policy: 'FIFO' }, SEED_ACTOR_ID);
    }

    locationSpId = await createStorageLocation(db, warehouseSpId, 'SP');
    locationRjId = await createStorageLocation(db, warehouseRjId, 'RJ');
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function createStorageLocation(dbSvc: TestContext['databaseService'], warehouseId: string, tag: string): Promise<string> {
    return dbSvc.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      const zone = await client.query(`INSERT INTO wms.zone (warehouse_id, code, name, zone_type, created_by) VALUES ($1,$2,$3,'STORAGE',$4) RETURNING id`, [
        warehouseId,
        `Z-${tag}`,
        `Zona ${tag}`,
        SEED_ACTOR_ID,
      ]);
      const location = await client.query(
        `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, created_by)
         VALUES ($1,$2,$3,'001','00','01','STORAGE',1000,10,1,2,$4) RETURNING id`,
        [warehouseId, zone.rows[0].id, tag.slice(0, 2), SEED_ACTOR_ID]
      );
      return location.rows[0].id;
    });
  }

  async function creditAvailable(warehouseId: string, productId: string, batchId: string, locationId: string, qty: number) {
    await stockMovementService.applyStandalone(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      {
        tenantId: clientId,
        warehouseId,
        movementType: 'ENTRADA_RECEBIMENTO',
        productId,
        batchId,
        qty,
        locationIdTo: locationId,
        bucketToOverride: 'AVAILABLE',
        documentRefType: 'TEST_SEED',
        actorUserId: SEED_ACTOR_ID,
      }
    );
  }

  it('Cenário: Recall bloqueia em todos os armazéns', async () => {
    const product = await productService.create({ tenant_id: clientId, sku: randomSku(), description: 'Produto recall', species_code: 'GERAL', base_uom: 'UN' }, SEED_ACTOR_ID);
    const batch = await batchService.create({ tenant_id: clientId, product_id: product.id, batch_code: `L-${Date.now()}` }, SEED_ACTOR_ID);

    // Saldo: 300 UN em SP01, 120 UN em RJ01 (exemplo normativo DOC-07 §6).
    await creditAvailable(warehouseSpId, product.id, batch.id, locationSpId, 300);
    await creditAvailable(warehouseRjId, product.id, batch.id, locationRjId, 120);

    // Reserva não separada de 50 UN em SP01 — único saldo disponível no momento, garante que vem deste lote.
    const originalReservation = await stockReservationService.reserve({
      tenantId: clientId,
      warehouseId: warehouseSpId,
      productId: product.id,
      demandQty: 50,
      purpose: 'CLIENT_DISPATCH',
      demandRefType: 'OUTBOUND_ORDER_ITEM',
      demandRefId: '00000000-0000-0000-0000-000000000099',
      actorUserId: SEED_ACTOR_ID,
    });
    expect(originalReservation.qtyReserved).toBe(50);
    expect(originalReservation.reservations[0].qty).toBe(50);

    // Lote ALTERNATIVO com saldo em SP01 — para a re-seleção pós-recall ter de onde vir.
    const altBatch = await batchService.create({ tenant_id: clientId, product_id: product.id, batch_code: `L-ALT-${Date.now()}` }, SEED_ACTOR_ID);
    await creditAvailable(warehouseSpId, product.id, altBatch.id, locationSpId, 100);

    const result = await recallService.triggerRecall({ tenantId: clientId, triggeringWarehouseId: warehouseSpId, batchId: batch.id, reason: 'Contaminação identificada pelo fabricante' }, SEED_ACTOR_ID);

    // (1) lote RECALLED.
    const recalledBatch = await batchService.findById(batch.id, clientId, SEED_ACTOR_ID);
    expect(recalledBatch.status).toBe('RECALLED');

    // (2) 420 UN (300+120) movidas para blocked nos dois armazéns; available zerado.
    const balances = await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT warehouse_id, qty_available, qty_blocked FROM wms.stock_balance WHERE tenant_id = $1 AND batch_id = $2 ORDER BY warehouse_id`,
      [clientId, batch.id]
    );
    expect(balances.rows.length).toBeGreaterThan(0);
    const totalBlocked = balances.rows.reduce((sum: number, r: any) => sum + Number(r.qty_blocked), 0);
    const totalAvailable = balances.rows.reduce((sum: number, r: any) => sum + Number(r.qty_available), 0);
    expect(totalBlocked).toBe(420);
    expect(totalAvailable).toBe(0);
    expect(Number(result.recall.qty_blocked)).toBe(420);

    // (3) a reserva original de 50 UN foi cancelada e re-selecionada (lote alternativo).
    const originalReservationRow = await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT status FROM wms.stock_reservation WHERE id = $1`,
      [originalReservation.reservations[0].id]
    );
    expect(originalReservationRow.rows[0].status).toBe('CANCELLED');

    const newReservation = await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT * FROM wms.stock_reservation WHERE tenant_id = $1 AND batch_id = $2 AND status = 'ACTIVE' AND demand_ref_id = '00000000-0000-0000-0000-000000000099'`,
      [clientId, altBatch.id]
    );
    expect(newReservation.rows).toHaveLength(1);
    expect(Number(newReservation.rows[0].qty)).toBe(50);

    // (4) relatório de rastreabilidade existe (vazio aqui — nenhuma expedição real neste teste).
    expect(Array.isArray(result.recall.shipped_orders_report)).toBe(true);

    // (5) sem package_content para este lote (não foi expedido) -> nenhuma Ordem RECALL criada, comportamento correto.
    expect(result.returnOrders).toHaveLength(0);
  });

  it('rejeita acionar recall duas vezes para o mesmo lote', async () => {
    const product = await productService.create({ tenant_id: clientId, sku: randomSku(), description: 'Produto recall duplo', species_code: 'GERAL', base_uom: 'UN' }, SEED_ACTOR_ID);
    const batch = await batchService.create({ tenant_id: clientId, product_id: product.id, batch_code: `L-DUP-${Date.now()}` }, SEED_ACTOR_ID);
    await creditAvailable(warehouseSpId, product.id, batch.id, locationSpId, 10);

    await recallService.triggerRecall({ tenantId: clientId, triggeringWarehouseId: warehouseSpId, batchId: batch.id, reason: 'primeiro' }, SEED_ACTOR_ID);

    await expect(recallService.triggerRecall({ tenantId: clientId, triggeringWarehouseId: warehouseSpId, batchId: batch.id, reason: 'segundo' }, SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'ALREADY_RECALLED' },
    });
  });
});
